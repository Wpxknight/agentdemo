import type { DurableRunRuntime, IdentityContext, RunStore } from '@aiop/control-contracts';
import { describe, expect, it } from 'vitest';

describe('@aiop/control-contracts', () => {
  it('exports stable control-plane contracts', () => {
    const identity: IdentityContext = { tenantId: 't1', actorId: 'u1', roles: [] };
    const contracts: [DurableRunRuntime, RunStore] | undefined = undefined;

    expect(identity.tenantId).toBe('t1');
    expect(contracts).toBeUndefined();
  });
});
