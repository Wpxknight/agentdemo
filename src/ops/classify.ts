import type { JsonValue } from '../model/types.js';

/** 只读类 verb（不改变集群状态）。 */
const READ_VERBS = new Set([
  'get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions',
  'version', 'cluster-info', 'config', 'auth', 'wait', 'events', 'diff',
]);

/** 变更类 verb。 */
const WRITE_VERBS = new Set([
  'apply', 'create', 'delete', 'edit', 'patch', 'replace', 'scale', 'set',
  'annotate', 'label', 'cordon', 'uncordon', 'drain', 'taint', 'rollout',
  'expose', 'autoscale', 'run', 'attach', 'cp',
]);

export interface KubectlClass {
  verb: string;
  /** 是否变更类操作。 */
  write: boolean;
  /** 是否高危（即便在 rw 集群也应拦截 / 强制审批）。 */
  dangerous: boolean;
  reason?: string;
}

/** 这些前置全局 flag 会带一个独立的值 token（需一并跳过）。 */
const VALUE_FLAGS = new Set([
  '-n', '--namespace', '--context', '--cluster', '--kubeconfig',
  '--as', '--as-group', '-s', '--server', '--token', '--user',
]);

/** 取 verb：跳过前置 flag 及其值（`-n ns logs ...` → logs）。 */
function firstVerb(args: string[]): string {
  return positionals(args)[0] ?? '';
}

/** 提取位置参数（跳过所有 flag 及带值 flag 的值），第一个是 verb，其余是目标。 */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) {
      out.push(a);
      continue;
    }
    if (!a.includes('=') && VALUE_FLAGS.has(a)) i++; // 跳过 `-n value` 的 value
  }
  return out;
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
}

/** 取某个带值 flag 的值（支持 `--ns=x` 与 `--ns x` 两种写法）。 */
function flagValue(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const f of flags) {
      if (a === f) return args[i + 1];
      if (a.startsWith(`${f}=`)) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

export interface KubectlScope {
  /** 显式 `-n/--namespace` 指定的命名空间（未指定为 undefined）。 */
  namespace?: string;
  /** 是否使用了 `-A/--all-namespaces`（跨全部命名空间）。 */
  allNamespaces: boolean;
}

/** 解析 kubectl 命令的命名空间作用域（供白名单校验）。 */
export function kubectlScope(args: string[]): KubectlScope {
  return {
    namespace: flagValue(args, '-n', '--namespace'),
    allNamespaces: hasFlag(args, '-A', '--all-namespaces'),
  };
}

const CLUSTER_SCOPED = /\b(namespace|namespaces|ns|node|nodes|no|pv|persistentvolume|crd|customresourcedefinition|clusterrole|clusterrolebinding)\b/;

/** 对 kubectl 参数做读写 / 危险性分类。 */
export function classifyKubectl(args: string[]): KubectlClass {
  const verb = firstVerb(args);
  const write = WRITE_VERBS.has(verb);
  const read = READ_VERBS.has(verb);

  let dangerous = false;
  let reason: string | undefined;

  if (verb === 'delete') {
    if (hasFlag(args, '--all', '--all-namespaces', '-A')) {
      dangerous = true;
      reason = 'delete --all/--all-namespaces 批量删除';
    } else if (args.some((a) => CLUSTER_SCOPED.test(a))) {
      dangerous = true;
      reason = '删除集群级资源（namespace/node/pv/crd 等）';
    }
  }
  if (verb === 'drain') {
    dangerous = true;
    reason = 'drain 驱逐节点上的 Pod';
  }
  if (verb === 'exec' || verb === 'attach') {
    dangerous = true;
    reason = `${verb} 在容器内执行任意命令`;
  }
  if (hasFlag(args, '--force') && hasFlag(args, '--grace-period')) {
    dangerous = true;
    reason = '--force --grace-period=0 强制删除';
  }

  return {
    verb,
    // exec/cp 之类不在 WRITE_VERBS 但也非只读；未知 verb 当作非只读保守处理
    write: write || (!read && verb !== 'exec' && verb !== ''),
    dangerous,
    reason,
  };
}

export interface ParsedKubectl {
  cluster?: string;
  args: string[];
  dryRun: boolean;
}

/** 从工具调用参数中解析出 cluster / args / dryRun。 */
export function parseKubectlArgs(raw: JsonValue): ParsedKubectl {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clusterV = (o as Record<string, JsonValue>).cluster;
  const argsV = (o as Record<string, JsonValue>).args;
  const dryRunV = (o as Record<string, JsonValue>).dryRun;

  let args: string[] = [];
  if (Array.isArray(argsV)) {
    args = argsV.filter((x): x is string => typeof x === 'string');
  } else if (typeof argsV === 'string') {
    args = argsV.trim().split(/\s+/).filter(Boolean);
  }

  return {
    cluster: typeof clusterV === 'string' ? clusterV : undefined,
    args,
    dryRun: dryRunV === true,
  };
}
