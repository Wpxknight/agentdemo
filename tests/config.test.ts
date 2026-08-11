import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { DEFAULT_MEMORY_CLI_PRINCIPAL_ID, parsePrincipalId } from '../src/auth/types.js';
import { resolveCliPrincipalId } from '../src/runtime.js';

const model = '"models":{"mock":{"protocol":"openai","baseURL":"http://localhost/v1","apiKey":"x","model":"mock"}},"defaultModel":"mock"';

function config(extra: string) {
  return parseConfig(`{${model},${extra}}`);
}

describe('dual deployment identity configuration', () => {
  it.each([
    ['standalone', 'local'],
    ['standalone', 'oidc'],
    ['aios-integrated', 'aios'],
  ] as const)('accepts %s with %s', (deploymentMode, provider) => {
    const oidc = provider === 'oidc'
      ? ',"oidc":{"issuer":"https://idp.example.com","clientId":"aiop","redirectUri":"https://app/cb","mapping":{}}'
      : '';
    const aios = provider === 'aios'
      ? ',"aios":{"verify":"userinfo","userinfoUrl":"https://aios.example.com/userinfo"}'
      : '';
    expect(config(`"deploymentMode":"${deploymentMode}","auth":{"provider":"${provider}"${oidc}${aios}}`))
      .toMatchObject({ deploymentMode, auth: { provider } });
  });

  it.each([
    ['standalone', 'aios'],
    ['aios-integrated', 'local'],
    ['aios-integrated', 'oidc'],
  ] as const)('rejects %s with %s without falling back', (deploymentMode, provider) => {
    expect(() => config(`"deploymentMode":"${deploymentMode}","auth":{"provider":"${provider}"}`))
      .toThrow(/deploymentMode|provider/);
  });

  it('requires an explicit provider in integrated mode', () => {
    expect(() => config('"deploymentMode":"aios-integrated","auth":{}')).toThrow(/provider/);
  });
});

describe('OIDC public origin configuration', () => {
  const oidc = (redirectUri: string, webCallbackUrl?: string) => JSON.stringify({
    provider: 'oidc',
    oidc: {
      issuer: 'https://idp.example.com', clientId: 'aiop', redirectUri,
      ...(webCallbackUrl ? { webCallbackUrl } : {}), mapping: {},
    },
  });

  it('uses redirectUri origin as the API/Web public origin when webCallbackUrl is omitted', () => {
    expect(config(`"auth":${oidc('https://app.example.com/auth/callback')}`)).toMatchObject({
      auth: { oidc: { redirectUri: 'https://app.example.com/auth/callback' } },
    });
  });

  it('accepts a same-origin Web callback and rejects a cross-origin callback', () => {
    expect(config(`"auth":${oidc(
      'https://app.example.com/auth/callback', 'https://app.example.com/chat',
    )}`)).toMatchObject({ auth: { oidc: { webCallbackUrl: 'https://app.example.com/chat' } } });
    expect(() => config(`"auth":${oidc(
      'https://api.example.com/auth/callback', 'https://web.example.com/chat',
    )}`)).toThrow(/webCallbackUrl.*redirectUri.*同源/);
  });
});

describe('PrincipalId', () => {
  it.each(['1', '42', '9007199254740993', '18446744073709551615'])('accepts canonical bigint %s', (value) => {
    expect(parsePrincipalId(value)).toBe(value);
  });

  it.each(['', '0', '-1', '+1', '01', '1.0', '1e3', '18446744073709551616'])('rejects %s', (value) => {
    expect(() => parsePrincipalId(value)).toThrow(/PrincipalId/);
  });

  it('requires a configured existing durable principal only when CLI execution is requested', async () => {
    await expect(resolveCliPrincipalId(undefined, false)).resolves.toBe(DEFAULT_MEMORY_CLI_PRINCIPAL_ID);
    await expect(resolveCliPrincipalId(undefined, true)).rejects.toThrow(/AIOP_CLI_USER_ID is required/);
    await expect(resolveCliPrincipalId('42', true, async () => undefined)).rejects.toThrow(/existing active user/);
    await expect(resolveCliPrincipalId('42', true, async () => ({ status: 'disabled' }))).rejects.toThrow(/existing active user/);
    await expect(resolveCliPrincipalId('42', true, async () => ({ status: 'active' }))).resolves.toBe('42');
  });
});
