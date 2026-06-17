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

const ctx = { sessionId: 's1' };
const call = (name: string, args: unknown): ToolCall => ({ id: 'c', name, args: args as never });

describe('OpsPolicy kubectl', () => {
  it('allows read on read-only cluster', async () => {
    const audit = new MemoryAuditSink();
    const p = new OpsPolicy({ clusters: registry(), audit });
    const d = await p.check(call('kubectl', { cluster: 'ro', args: ['get', 'pods'] }), ctx);
    expect(d.blocked).toBe(false);
    expect(audit.events.at(-1)?.action).toBe('allow');
  });

  it('blocks write on read-only cluster', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('kubectl', { cluster: 'ro', args: ['delete', 'pod', 'x'] }), ctx);
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('只读');
  });

  it('blocks dangerous command even on rw cluster', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('kubectl', { cluster: 'dev', args: ['delete', 'pods', '--all'] }), ctx);
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('危险命令');
  });

  it('requires approval for write on production', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('kubectl', { cluster: 'prod', args: ['scale', 'deploy/api', '--replicas=3'] }), ctx);
    expect(d.blocked).toBe(false);
    expect(d.needApproval).toBe(true);
  });

  it('preApproved downgrades production approval to allow', async () => {
    const p = new OpsPolicy({ clusters: registry(), preApproved: true });
    const d = await p.check(call('kubectl', { cluster: 'prod', args: ['scale', 'deploy/api', '--replicas=3'] }), ctx);
    expect(d.blocked).toBe(false);
    expect(d.needApproval).toBeFalsy();
  });

  it('blocks unknown / missing cluster', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    expect((await p.check(call('kubectl', { cluster: 'nope', args: ['get', 'pods'] }), ctx)).blocked).toBe(true);
    expect((await p.check(call('kubectl', { args: ['get', 'pods'] }), ctx)).blocked).toBe(true);
  });
});

describe('OpsPolicy shell guard', () => {
  it('blocks rm -rf /', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('sbx__run_command', { command: 'rm -rf /' }), ctx);
    expect(d.blocked).toBe(true);
  });

  it('allows ordinary command', async () => {
    const p = new OpsPolicy({ clusters: registry() });
    const d = await p.check(call('sbx__run_command', { command: 'ls -la' }), ctx);
    expect(d.blocked).toBe(false);
  });
});
