import type { SandboxSpec } from './types.js';

export const DEFAULT_SANDBOX_PLACEMENT_NAMESPACE = 'aios-system';

export interface SandboxPlacementInput {
  clusterName?: string;
  clusterId?: string;
  namespace?: string;
}

export interface SandboxPlacement {
  clusterName?: string;
  clusterId?: string;
  namespace: string;
}

export interface NormalizedSandboxPlacement {
  placement: SandboxPlacement;
  cacheSuffix: string;
  metadata: Record<string, string>;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

export function normalizeSandboxPlacement(
  input?: SandboxPlacementInput,
  fallback?: SandboxPlacementInput,
): NormalizedSandboxPlacement | undefined {
  const supplied = input !== undefined;
  const source = supplied ? input : fallback;
  if (!source) return undefined;
  const clusterName = trimmed(source.clusterName);
  const clusterId = trimmed(source.clusterId);
  const namespace = trimmed(source.namespace);
  if (clusterName && clusterId) {
    throw new Error('Sandbox placement 的 clusterName 与 clusterId 只能提供一个');
  }
  if (!clusterName && !clusterId) {
    throw new Error(supplied && namespace
      ? 'Sandbox placement 不能只提供 namespace，必须提供 clusterName 或 clusterId'
      : 'Sandbox placement 必须提供 clusterName 或 clusterId');
  }
  const selector = clusterName ? 'clusterName' : 'clusterId';
  const cluster = clusterName ?? clusterId!;
  const resolvedNamespace = namespace ?? DEFAULT_SANDBOX_PLACEMENT_NAMESPACE;
  return {
    placement: {
      ...(clusterName ? { clusterName } : { clusterId }),
      namespace: resolvedNamespace,
    },
    cacheSuffix: `:placement:${JSON.stringify([selector, cluster, resolvedNamespace])}`,
    metadata: {
      placementSelector: selector,
      placementCluster: cluster,
      placementNamespace: resolvedNamespace,
    },
  };
}

export function withSandboxPlacement(
  spec: SandboxSpec,
  input?: SandboxPlacementInput,
): SandboxSpec {
  if (input === undefined) return spec;
  const normalized = normalizeSandboxPlacement(input);
  if (!normalized) return spec;
  return {
    ...spec,
    key: `${spec.key}${normalized.cacheSuffix}`,
    placement: normalized.placement,
    metadata: { ...spec.metadata, ...normalized.metadata },
  };
}
