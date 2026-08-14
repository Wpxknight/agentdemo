import type { SandboxSpec } from './types.js';

export const DEFAULT_SANDBOX_PLACEMENT_NAMESPACE = 'aios-system';
export const DEFAULT_SANDBOX_PLACEMENT_CLUSTER_ID = '1';

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
  if (!input && !fallback) return undefined;
  const inputClusterId = trimmed(input?.clusterId);
  const inputClusterName = trimmed(input?.clusterName);
  const fallbackClusterId = trimmed(fallback?.clusterId);
  const fallbackClusterName = trimmed(fallback?.clusterName);
  const clusterId = inputClusterId ?? (inputClusterName ? undefined : fallbackClusterId);
  const clusterName = clusterId
    ? undefined
    : inputClusterName ?? fallbackClusterName;
  const namespace = trimmed(input?.namespace)
    ?? trimmed(fallback?.namespace)
    ?? DEFAULT_SANDBOX_PLACEMENT_NAMESPACE;
  if (!clusterName && !clusterId) {
    throw new Error('Sandbox placement 必须提供 clusterName 或 clusterId');
  }
  const selector = clusterName ? 'clusterName' : 'clusterId';
  const cluster = clusterName ?? clusterId!;
  return {
    placement: {
      ...(clusterName ? { clusterName } : { clusterId }),
      namespace,
    },
    cacheSuffix: `:placement:${JSON.stringify([selector, cluster, namespace])}`,
    metadata: {
      placementSelector: selector,
      placementCluster: cluster,
      placementNamespace: namespace,
    },
  };
}

export function withSandboxPlacement(
  spec: SandboxSpec,
  input?: SandboxPlacementInput,
  fallback?: SandboxPlacementInput,
): SandboxSpec {
  if (input === undefined && fallback === undefined) return spec;
  const normalized = normalizeSandboxPlacement(input, fallback);
  if (!normalized) return spec;
  return {
    ...spec,
    key: `${spec.key}${normalized.cacheSuffix}`,
    placement: normalized.placement,
    metadata: { ...spec.metadata, ...normalized.metadata },
  };
}
