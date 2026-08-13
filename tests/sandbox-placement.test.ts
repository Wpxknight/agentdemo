import { describe, expect, it } from 'vitest';
import { normalizeSandboxPlacement, withSandboxPlacement } from '../packages/sandbox-runtime/src/placement.js';

describe('sandbox placement', () => {
  it('normalizes cluster names and defaults namespace without changing case', () => {
    expect(normalizeSandboxPlacement({ clusterName: ' Cluster-PC1 ' })).toEqual({
      placement: { clusterName: 'Cluster-PC1', namespace: 'aios-system' },
      cacheSuffix: ':placement:["clusterName","Cluster-PC1","aios-system"]',
      metadata: {
        placementSelector: 'clusterName',
        placementCluster: 'Cluster-PC1',
        placementNamespace: 'aios-system',
      },
    });
  });

  it('supports cluster IDs and isolates selectors, values and namespaces in keys', () => {
    const base = { key: '["tenant","user","session"]', metadata: { sessionId: 'session' } };
    const byName = withSandboxPlacement(base, { clusterName: 'pc1' });
    const byId = withSandboxPlacement(base, { clusterId: 'pc1' });
    const quoted = withSandboxPlacement(base, { clusterName: 'pc1:\"x', namespace: 'ns:y' });
    expect(new Set([byName.key, byId.key, quoted.key])).toHaveLength(3);
    expect(byName.metadata).toMatchObject({ sessionId: 'session', placementSelector: 'clusterName' });
  });

  it('rejects conflicting, empty and namespace-only dynamic placement', () => {
    expect(() => normalizeSandboxPlacement({ clusterName: 'pc1', clusterId: '1' })).toThrow(/只能提供一个/);
    expect(() => normalizeSandboxPlacement({})).toThrow(/必须提供/);
    expect(() => normalizeSandboxPlacement({ namespace: 'aios-system' })).toThrow(/不能只提供 namespace/);
  });

  it('uses legacy fallback only when dynamic placement is absent', () => {
    expect(normalizeSandboxPlacement(undefined, { clusterId: '35', namespace: 'legacy-ns' })?.placement)
      .toEqual({ clusterId: '35', namespace: 'legacy-ns' });
    expect(normalizeSandboxPlacement({ clusterName: 'pc1' }, { clusterId: '35', namespace: 'legacy-ns' })?.placement)
      .toEqual({ clusterName: 'pc1', namespace: 'aios-system' });
  });
});
