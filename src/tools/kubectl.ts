import type { ToolResult } from '../model/types.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';
import type { ClusterRegistry, ClusterInfo } from '../config/clusters.js';
import type { SandboxManagerLike } from '../sandbox/lifecycle.js';
import { isSandboxAcquirer } from '../sandbox/acquisition.js';
import { sandboxIdentityMetadata, sandboxScopedKey, type SandboxIdentity } from '../sandbox/keys.js';
import type { SandboxSpec } from '../sandbox/types.js';
import type { AuditSink } from '../audit/sink.js';
import { LogAuditSink } from '../audit/sink.js';
import { classifyKubectl, parseKubectlArgs } from '../ops/classify.js';

export interface KubectlToolOptions {
  clusters: ClusterRegistry;
  sandboxes: SandboxManagerLike;
  audit?: AuditSink;
}

/** 把集群信息映射为 in-cluster 沙箱规格（按 session×cluster 复用）。 */
function specFor(identity: SandboxIdentity, info: ClusterInfo): SandboxSpec {
  const metadata: Record<string, string> = { ...sandboxIdentityMetadata(identity), cluster: info.name };
  if (info.namespace) metadata.namespace = info.namespace;
  if (info.serviceAccount) metadata.serviceAccount = info.serviceAccount;
  return {
    key: sandboxScopedKey(identity, `cluster:${info.name}`),
    template: info.template,
    namespace: info.namespace,
    serviceAccount: info.serviceAccount,
    domain: info.e2bControl,
    metadata,
    envs: {
      AIOP_CLUSTER: info.name,
      ...(info.namespace ? { AIOP_NAMESPACE: info.namespace } : {}),
      ...(info.serviceAccount ? { AIOP_SERVICE_ACCOUNT: info.serviceAccount } : {}),
    },
  };
}

/** dry-run 时为变更命令追加 --dry-run=server。 */
function withDryRun(args: string[], dryRun: boolean): string[] {
  if (!dryRun) return args;
  if (args.some((a) => a.startsWith('--dry-run'))) return args;
  return [...args, '--dry-run=server'];
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * 统一 kubectl 工具：kubectl(cluster, args, dryRun)。
 * 在对应集群的 in-cluster 沙箱内执行（Pod ServiceAccount + in-cluster config，无 kubeconfig）。
 * 读写分离 / 危险命令 / 审批由 Policy 中间件在 dispatch 前把关。
 */
export function buildKubectlTool(opts: KubectlToolOptions): ToolHandler {
  const audit = opts.audit ?? new LogAuditSink();
  return {
    def: {
      name: 'kubectl',
      capability: 'non_idempotent_write',
      description:
        '在指定集群执行 kubectl。cluster=集群名，args=参数数组（如 ["get","pods","-A"]），dryRun=true 时变更命令以 --dry-run=server 试运行。只读集群拒绝变更，危险命令被拦截，生产变更需审批。',
      inputSchema: {
        type: 'object',
        properties: {
          cluster: { type: 'string', description: '目标集群名（见已注册集群）' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'kubectl 参数，如 ["get","pods","-n","kube-system"]',
          },
          dryRun: { type: 'boolean', description: '变更命令试运行' },
        },
        required: ['cluster', 'args'],
      },
    },
    async run(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const { cluster, args, dryRun } = parseKubectlArgs(rawArgs);
      if (!cluster) return { id: '', content: '缺少 cluster 参数', isError: true };
      const info = opts.clusters.get(cluster);
      if (!info) {
        return { id: '', content: `未知集群: ${cluster}。可用：${opts.clusters.names().join(', ') || '(无)'}`, isError: true };
      }
      if (!args.length) return { id: '', content: '缺少 kubectl 参数', isError: true };

      const cls = classifyKubectl(args);
      const finalArgs = withDryRun(args, dryRun);
      const command = `kubectl ${finalArgs.map(shellQuote).join(' ')}`;

      const spec = specFor(ctx, info);
      const sbx = isSandboxAcquirer(opts.sandboxes)
        ? (await opts.sandboxes.acquireSpec(ctx, spec)).handle
        : await opts.sandboxes.get(spec);
      const res = await sbx.runCommand(command, { onOutput: ctx.onOutput });

      await audit.record({
        kind: 'kubectl',
        action: 'exec',
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        cluster,
        tool: 'kubectl',
        detail: { verb: cls.verb, write: cls.write, dryRun, exitCode: res.exitCode },
      });

      const parts: string[] = [];
      if (res.stdout) parts.push(res.stdout.trimEnd());
      if (res.stderr) parts.push(`[stderr]\n${res.stderr.trimEnd()}`);
      if (res.error) parts.push(`[error]\n${res.error}`);
      const isError = Boolean(res.error) || (typeof res.exitCode === 'number' && res.exitCode !== 0);
      return { id: '', content: parts.join('\n\n') || '(no output)', isError };
    },
  };
}
