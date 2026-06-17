import { describe, expect, it } from 'vitest';
import { OpsPolicy } from '../src/agent/policy.js';
import { ClusterRegistry } from '../src/config/clusters.js';
import { MemoryAuditSink } from '../src/audit/sink.js';
import type { ToolCall } from '../src/model/types.js';

function registry() {
  return new ClusterRegistry({
    dev: { access: 'rw', production: false },
    prod: { access: 'rw', production: true },
    ro: { access: 'ro', production: false },
  });
}

const admin = { sessionId: 's1', tenantId: 't1', userId: 'a', role: 'tenant_admin' as const };
const user = { sessionId: 's1', tenantId: 't1', userId: 'u', role: 'user' as const };
const call = (name: string, args: unknown): ToolCall => ({ id: 'c', name, args: args as never });

describe('OpsPolicy kubectl', () => {
  it('allows read on read-only cluster', async () => {
    const audit = new MemoryAuditSink();
    const p = new OpsPolicy({ clusters: registry(), audit });
    const d = await p.check(call('kubectl', { cluster: 'ro', args: ['get', 'pods'] }), user);
    expect(d.blocked).toBe(false);
    expect(audit.events.at(-1)?.action).toBe('allow');
  });

  it('blocks write on read-only cluster (for an admin)', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('kubectl', { cluster: 'ro', args: ['delete', 'pod', 'x'] }), admin);
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('只读');
  });

  it('blocks write for a regular user (no cluster:write)', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('kubectl', { cluster: 'dev', args: ['scale', 'deploy/api', '--replicas=3'] }), user);
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('变更权限');
  });

  it('blocks dangerous command even for admin on rw cluster', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('kubectl', { cluster: 'dev', args: ['delete', 'pods', '--all'] }), admin);
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('危险命令');
  });

  it('auto-approves production write for an admin (has approve)', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('kubectl', { cluster: 'prod', args: ['scale', 'deploy/api', '--replicas=3'] }), admin);
    expect(d.blocked).toBe(false);
    expect(d.needApproval).toBeFalsy();
  });

  it('blocks foreign tenant by cluster ACL', async () => {
    const clusters = new ClusterRegistry({
      dev: { access: 'rw', production: false, tenants: ['t1'] },
    });
    const p = new OpsPolicy({ clusters });
    const foreign = { ...admin, tenantId: 't2' };
    const d = await p.check(call('kubectl', { cluster: 'dev', args: ['get', 'pods'] }), foreign);
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('无权访问集群');
  });

  it('blocks unknown / missing cluster', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    expect((await p.check(call('kubectl', { cluster: 'nope', args: ['get', 'pods'] }), user)).blocked).toBe(true);
    expect((await p.check(call('kubectl', { args: ['get', 'pods'] }), user)).blocked).toBe(true);
  });
});

describe('OpsPolicy shell guard', () => {
  it('blocks rm -rf /', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('sbx__run_command', { command: 'rm -rf /' }), user);
    expect(d.blocked).toBe(true);
  });

  it('allows ordinary command', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('sbx__run_command', { command: 'ls -la' }), user);
    expect(d.blocked).toBe(false);
  });
});
