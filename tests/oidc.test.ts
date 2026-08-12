import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import * as oidc from 'openid-client';
import { mapClaims } from '../src/auth/oidc-map.js';

const oidcGrant = vi.hoisted(() => vi.fn());
vi.mock('openid-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('openid-client')>(),
  authorizationCodeGrant: oidcGrant,
}));
import type { OidcMapping } from '../src/auth/oidc-map.js';
import { OidcAuthProvider } from '../src/auth/oidc.js';
import { MemoryStore } from '../src/db/memory.js';
import { createHttpServer } from '../src/server/http.js';
import type { Runtime } from '../src/runtime.js';

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
    expect(ctx1).toMatchObject({ tenantId: 'acme', provider: 'oidc', role: 'tenant_admin' });
    expect(ctx1.userId).toMatch(/^[1-9][0-9]*$/);
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

  it('syncs a trusted IdP role change so the newly issued session authenticates', async () => {
    const { store, auth } = provider();
    const initial = await auth.resolveIdentity({ preferred_username: 'erin', tenant: 'acme', groups: [] });
    expect(initial.role).toBe('user');

    const elevated = await auth.resolveIdentity({ preferred_username: 'erin', tenant: 'acme', groups: ['aiop-admins'] });
    expect(elevated).toMatchObject({ userId: initial.userId, role: 'tenant_admin', provider: 'oidc' });
    expect((await store.getUser('acme', initial.userId))?.role).toBe('tenant_admin');

    const { signSession } = await import('../src/auth/session.js');
    const signed = await signSession(new TextEncoder().encode('oidc-secret'), elevated, '12h');
    expect(await auth.authenticate(signed)).toEqual(elevated);
  });

  it('login() returns undefined (SSO has no password path)', async () => {
    const { auth } = provider();
    expect(await auth.login()).toBeUndefined();
  });

  it.each([
    ['code/state', 'http://localhost/auth/callback?code=abc&state=expected'],
    ['error/state', 'http://localhost/auth/callback?error=access_denied&state=expected'],
  ])('uses configured callback URL for token exchange with parsed %s query', async (_case, requestUrl) => {
    const { auth } = provider();
    oidcGrant.mockResolvedValueOnce({
      claims: () => ({ preferred_username: 'callback-user', tenant: 'acme' }),
    });
    (auth as unknown as { discovered: oidc.Configuration }).discovered = {} as oidc.Configuration;

    await auth.handleCallback(requestUrl, { state: 'expected', codeVerifier: 'verifier' });

    const call = oidcGrant.mock.calls.at(-1)!;
    const callback = call[1] as URL;
    expect(callback.origin + callback.pathname).toBe('https://app/cb');
    expect(callback.search).toBe(new URL(requestUrl).search);
    expect(callback.href).not.toContain('localhost');
    expect(call[2]).toMatchObject({
      pkceCodeVerifier: 'verifier', expectedState: 'expected',
    });
  });

  it('atomically consumes persisted exchange codes and enforces expiry, tenant and provider binding', async () => {
    const store = new MemoryStore();
    const record = {
      codeHash: 'a'.repeat(64), tenantId: 'acme', provider: 'oidc' as const,
      sessionToken: 'signed-session', expiresAt: new Date(Date.now() + 60_000),
    };
    await store.putOidcExchangeCode(record);
    const claims = await Promise.all(Array.from({ length: 8 }, () => store.consumeOidcExchangeCode({
      codeHash: record.codeHash, tenantId: 'acme', provider: 'oidc', now: new Date(),
    })));
    expect(claims.filter(Boolean)).toEqual([{
      tenantId: 'acme', provider: 'oidc', sessionToken: 'signed-session',
    }]);

    await store.putOidcExchangeCode({ ...record, codeHash: 'b'.repeat(64), expiresAt: new Date(Date.now() - 1) });
    expect(await store.consumeOidcExchangeCode({
      codeHash: 'b'.repeat(64), tenantId: 'acme', provider: 'oidc', now: new Date(),
    })).toBeUndefined();
    await store.putOidcExchangeCode({ ...record, codeHash: 'c'.repeat(64) });
    expect(await store.consumeOidcExchangeCode({
      codeHash: 'c'.repeat(64), tenantId: 'other', provider: 'oidc', now: new Date(),
    })).toBeUndefined();
  });

  it('shares exchange state across server instances through the Store', async () => {
    const sharedStore = new MemoryStore();
    await sharedStore.putOidcExchangeCode({
      codeHash: 'd'.repeat(64), tenantId: 'acme', provider: 'oidc', sessionToken: 'token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const secondInstanceStore = sharedStore;
    expect(await secondInstanceStore.consumeOidcExchangeCode({
      codeHash: 'd'.repeat(64), provider: 'oidc', now: new Date(),
    })).toEqual({ tenantId: 'acme', provider: 'oidc', sessionToken: 'token' });
  });

  it('rejects cross-origin callback configuration even for programmatic construction', () => {
    expect(() => new OidcAuthProvider({
      store: new MemoryStore(),
      secret: 'oidc-secret',
      config: {
        issuer: 'https://idp.example.com', clientId: 'aiop',
        redirectUri: 'https://api.example.com/auth/callback',
        webCallbackUrl: 'https://web.example.com/chat', mapping,
      },
    })).toThrow(/webCallbackUrl.*redirectUri.*同源/);
  });

  it('completes same-origin start → callback redirect → one-time Web session exchange without URL tokens', async () => {
    const store = new MemoryStore();
    const auth = new OidcAuthProvider({
      store,
      secret: 'oidc-secret',
      config: {
        issuer: 'https://idp.example.com', clientId: 'aiop',
        redirectUri: 'https://app.example.com/auth/callback', webCallbackUrl: 'https://app.example.com/chat', mapping,
      },
    });
    vi.spyOn(auth, 'authorizationUrl').mockResolvedValue({ url: 'https://idp.example.com/authorize', state: 'state', codeVerifier: 'verifier' });
    const ctx = await auth.resolveIdentity({ preferred_username: 'web-user', tenant: 'acme' });
    const { signSession } = await import('../src/auth/session.js');
    const session = await signSession(new TextEncoder().encode('oidc-secret'), ctx, '12h');
    vi.spyOn(auth, 'handleCallback').mockResolvedValue(session);
    const server = createHttpServer({
      authProvider: auth, store, jwtSecret: 'oidc-secret', deploymentMode: 'standalone',
    } as unknown as Runtime);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const start = await fetch(`${base}/auth/oidc/start`);
      const stateCookie = start.headers.getSetCookie()[0]!;
      expect(stateCookie).toContain('HttpOnly');
      expect(stateCookie).toContain('Secure');
      expect(stateCookie).toContain('Path=/auth/callback');
      expect(start.headers.get('cache-control')).toBe('no-store');

      const callback = await fetch(`${base}/auth/callback?code=code&state=state`, {
        headers: { cookie: stateCookie.split(';')[0]! }, redirect: 'manual',
      });
      expect(callback.status).toBe(303);
      expect(callback.headers.get('location')).toBe('https://app.example.com/chat');
      expect(callback.headers.get('location')).not.toMatch(/token|session/i);
      expect(callback.headers.get('cache-control')).toBe('no-store');
      const callbackCookies = callback.headers.getSetCookie();
      expect(callbackCookies.some((cookie) => cookie.startsWith('aiop_oidc=')
        && cookie.includes('Max-Age=0') && cookie.includes('Path=/auth/callback'))).toBe(true);
      const sessionCookie = callbackCookies.find((cookie) => cookie.startsWith('aiop_oidc_session='))!;
      expect(sessionCookie).toContain('Path=/auth/oidc/session');
      expect(decodeURIComponent(sessionCookie.split(';')[0]!.split('=')[1]!)).not.toBe(session);
      expect(sessionCookie).not.toContain(session);

      const exchangeHeaders = {
        cookie: sessionCookie.split(';')[0]!,
        origin: 'https://app.example.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
      };
      const wrongOrigin = await fetch(`${base}/auth/oidc/session`, {
        method: 'POST', headers: { ...exchangeHeaders, origin: 'https://evil.web.example.com', 'sec-fetch-site': 'same-site' },
      });
      expect(wrongOrigin.status).toBe(403);
      const unprovenMissingOrigin = await fetch(`${base}/auth/oidc/session`, {
        method: 'POST', headers: { cookie: exchangeHeaders.cookie },
      });
      expect(unprovenMissingOrigin.status).toBe(403);

      const exchange = await fetch(`${base}/auth/oidc/session`, { method: 'POST', headers: exchangeHeaders });
      expect(exchange.status).toBe(200);
      expect(exchange.headers.get('cache-control')).toBe('no-store');
      expect(await exchange.json()).toEqual({ token: session });
      expect(exchange.headers.getSetCookie()[0]).toContain('Max-Age=0');
      expect(exchange.headers.getSetCookie()[0]).toContain('Path=/auth/oidc/session');

      const replay = await fetch(`${base}/auth/oidc/session`, { method: 'POST', headers: exchangeHeaders });
      expect(replay.status).toBe(401);

      // Some same-origin browser POSTs omit Origin; explicit Fetch Metadata is the only accepted fallback.
      const fallbackCode = 'same-origin-fallback';
      const { createHash } = await import('node:crypto');
      await store.putOidcExchangeCode({
        codeHash: createHash('sha256').update(fallbackCode).digest('hex'),
        tenantId: 'acme', provider: 'oidc', sessionToken: session,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const missingOriginSameOrigin = await fetch(`${base}/auth/oidc/session`, {
        method: 'POST',
        headers: { cookie: `aiop_oidc_session=${fallbackCode}`, 'sec-fetch-site': 'same-origin' },
      });
      expect(missingOriginSameOrigin.status).toBe(200);
      expect(await missingOriginSameOrigin.json()).toEqual({ token: session });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
