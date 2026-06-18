import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/db/memory.js';

const h = vi.hoisted(() => ({
  discovery: vi.fn(),
  allowInsecureRequests: vi.fn(),
}));

vi.mock('openid-client', () => ({
  discovery: h.discovery,
  allowInsecureRequests: h.allowInsecureRequests,
  ClientSecretPost: vi.fn((secret: string) => ({ secret })),
  randomPKCECodeVerifier: vi.fn(() => 'verifier'),
  calculatePKCECodeChallenge: vi.fn(async () => 'challenge'),
  randomState: vi.fn(() => 'state'),
  buildAuthorizationUrl: vi.fn(() => new URL('http://idp/auth')),
}));

const { OidcAuthProvider } = await import('../src/auth/oidc.js');

beforeEach(() => {
  h.discovery.mockReset();
  h.allowInsecureRequests.mockReset();
  h.discovery.mockResolvedValue({ issuer: 'http://idp' });
});

describe('OidcAuthProvider insecure HTTP discovery', () => {
  it('passes allowInsecureRequests only when explicitly enabled', async () => {
    const auth = new OidcAuthProvider({
      store: new MemoryStore(),
      secret: 'secret',
      config: {
        issuer: 'http://idp.example.test',
        clientId: 'aiop',
        redirectUri: 'http://app/callback',
        allowInsecureHttp: true,
        mapping: { usernameClaim: 'email', defaultRole: 'user' },
      },
    });

    await auth.authorizationUrl();

    expect(h.discovery.mock.calls[0]![4]).toEqual({ execute: [h.allowInsecureRequests] });
  });
});
