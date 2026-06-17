import { describe, expect, it } from 'vitest';
import { mapClaims } from '../src/auth/oidc-map.js';
import type { OidcMapping } from '../src/auth/oidc-map.js';
import { OidcAuthProvider } from '../src/auth/oidc.js';
import { MemoryStore } from '../src/db/memory.js';

const mapping: OidcMapping = {
  usernameClaim: 'preferred_username',
  tenantClaim: 'tenant',
  defaultTenant: 'default',
  roleClaim: 'groups',
  roleMap: { 'aiop-admins': 'tenant_admin', 'aiop-platform': 'platform_admin' },
  defaultRole: 'user',
};

describe('mapClaims', () => {
  it('maps tenant, username and role from claims', () => {
    const r = mapClaims(
      { preferred_username: 'alice', tenant: 'acme', groups: ['x', 'aiop-admins'] },
      mapping,
    );
    expect(r).toEqual({ tenantId: 'acme', username: 'alice', role: 'tenant_admin' });
  });

  it('falls back to defaults when claims missing', () => {
    const r = mapClaims({ sub: 'sub-1' }, mapping);
    expect(r).toEqual({ tenantId: 'default', username: 'sub-1', role: 'user' });
  });

  it('handles scalar role claim', () => {
    const r = mapClaims({ preferred_username: 'bob', groups: 'aiop-platform' }, mapping);
    expect(r.role).toBe('platform_admin');
  });
});

describe('OidcAuthProvider JIT + session', () => {
  function provider(store = new MemoryStore()) {
    return {
      store,
      auth: new OidcAuthProvider({
        store,
        secret: 'oidc-secret',
        config: {
          issuer: 'https://idp.example.com',
          clientId: 'aiop',
          redirectUri: 'https://app/cb',
          mapping,
        },
      }),
    };
  }

  it('JIT-provisions a user once, reuses afterwards', async () => {
    const { store, auth } = provider();
    const claims = { preferred_username: 'carol', tenant: 'acme', groups: ['aiop-admins'] };

    const ctx1 = await auth.resolveIdentity(claims);
    expect(ctx1).toMatchObject({ tenantId: 'acme', role: 'tenant_admin' });
    const u = await store.getUserByUsername('acme', 'carol');
    expect(u).toBeDefined();

    const ctx2 = await auth.resolveIdentity(claims);
    expect(ctx2.userId).toBe(ctx1.userId); // 复用，不重复建号
  });

  it('issued session token authenticates back to the same context', async () => {
    const { auth } = provider();
    const ctx = await auth.resolveIdentity({ preferred_username: 'dan', tenant: 'acme', groups: [] });
    const { signSession } = await import('../src/auth/session.js');
    const signed = await signSession(new TextEncoder().encode('oidc-secret'), ctx, '12h');
    expect(await auth.authenticate(signed)).toEqual(ctx);
  });

  it('login() returns undefined (SSO has no password path)', async () => {
    const { auth } = provider();
    expect(await auth.login()).toBeUndefined();
  });
});
