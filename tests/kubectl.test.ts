import { describe, expect, it, vi } from 'vitest';
import { buildKubectlTool } from '../src/tools/kubectl.js';
import { classifyKubectl, parseKubectlArgs } from '../src/ops/classify.js';
import { ClusterRegistry } from '../src/config/clusters.js';
import { SandboxManager } from '../src/sandbox/lifecycle.js';
import { MemoryAuditSink } from '../src/audit/sink.js';
import type { ExecResult, SandboxHandle, SandboxProvider } from '../src/sandbox/types.js';

/** mock provider：runCommand 回显命令，便于断言拼装。 */
function echoManager() {
  const lastCmd: { value?: string } = {};
  const handle: SandboxHandle = {
    sandboxId: 'sb',
    runCode: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '' })),
    runCommand: vi.fn(async (cmd: string): Promise<ExecResult> => {
      lastCmd.value = cmd;
      return { stdout: `OK: ${cmd}`, stderr: '', exitCode: 0 };
    }),
    setTimeout: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
  };
  const provider: SandboxProvider = {
    create: vi.fn(async () => handle),
    connect: vi.fn(async () => handle),
  };
  return { manager: new SandboxManager({ provider }), lastCmd };
}

const ctx = { sessionId: 's1' };

describe('classifyKubectl', () => {
  it('classifies read vs write verbs', () => {
    expect(classifyKubectl(['get', 'pods']).write).toBe(false);
    expect(classifyKubectl(['apply', '-f', 'x.yaml']).write).toBe(true);
    expect(classifyKubectl(['-n', 'kube-system', 'logs', 'pod']).verb).toBe('logs');
  });

  it('flags dangerous commands', () => {
    expect(classifyKubectl(['delete', 'pods', '--all']).dangerous).toBe(true);
    expect(classifyKubectl(['delete', 'namespace', 'prod']).dangerous).toBe(true);
    expect(classifyKubectl(['drain', 'node-1']).dangerous).toBe(true);
    expect(classifyKubectl(['get', 'pods']).dangerous).toBe(false);
  });
});

describe('parseKubectlArgs', () => {
  it('accepts string args and splits', () => {
    expect(parseKubectlArgs({ cluster: 'dev', args: 'get pods -A' })).toEqual({
      cluster: 'dev',
      args: ['get', 'pods', '-A'],
      dryRun: false,
    });
  });
});

describe('kubectl tool', () => {
  const clusters = new ClusterRegistry({ dev: { access: 'rw', production: false, template: 'k8s' } });

  it('runs kubectl in cluster sandbox and audits', async () => {
    const { manager, lastCmd } = echoManager();
    const audit = new MemoryAuditSink();
    const tool = buildKubectlTool({ clusters, sandboxes: manager, audit });

    const res = await tool.run({ cluster: 'dev', args: ['get', 'pods'] }, ctx);

    expect(lastCmd.value).toBe('kubectl get pods');
    expect(res.content).toContain('OK: kubectl get pods');
    expect(res.isError).toBe(false);
    expect(audit.events.at(-1)).toMatchObject({ kind: 'kubectl', cluster: 'dev' });
  });

  it('appends --dry-run=server when dryRun', async () => {
    const { manager, lastCmd } = echoManager();
    const tool = buildKubectlTool({ clusters, sandboxes: manager });
    await tool.run({ cluster: 'dev', args: ['apply', '-f', 'x.yaml'], dryRun: true }, ctx);
    expect(lastCmd.value).toContain('--dry-run=server');
  });

  it('errors on unknown cluster', async () => {
    const { manager } = echoManager();
    const tool = buildKubectlTool({ clusters, sandboxes: manager });
    const res = await tool.run({ cluster: 'ghost', args: ['get', 'pods'] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('未知集群');
  });

  it('passes cluster namespace and serviceAccount into sandbox spec', async () => {
    const specs: unknown[] = [];
    const handle: SandboxHandle = {
      sandboxId: 'sb',
      runCode: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '' })),
      runCommand: vi.fn(async (): Promise<ExecResult> => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
      setTimeout: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
    };
    const provider: SandboxProvider = {
      create: vi.fn(async (spec) => {
        specs.push(spec);
        return handle;
      }),
      connect: vi.fn(async () => handle),
    };
    const withSa = new ClusterRegistry({
      dev: {
        access: 'rw',
        production: false,
        template: 'kubectl:latest',
        namespace: 'aiop',
        serviceAccount: 'aiop-ops',
        e2bControl: 'e2b.aiop.svc:80',
      },
    });
    const tool = buildKubectlTool({ clusters: withSa, sandboxes: new SandboxManager({ provider }) });

    await tool.run({ cluster: 'dev', args: ['get', 'pods', '-n', 'aiop'] }, ctx);

    expect(specs[0]).toMatchObject({
      template: 'kubectl:latest',
      namespace: 'aiop',
      serviceAccount: 'aiop-ops',
      domain: 'e2b.aiop.svc:80',
      metadata: { cluster: 'dev', namespace: 'aiop', serviceAccount: 'aiop-ops' },
    });
  });
});
