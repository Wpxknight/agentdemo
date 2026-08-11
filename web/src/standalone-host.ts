import { apiUrl, type LoginCredentials, type WebAuthProvider, type WebHostAdapter } from './host-adapter';

const TOKEN_KEY = 'aiop_token';

function configuredApiBase(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.VITE_AIOP_API_BASE?.trim() ?? '';
}

function configuredProvider(): WebAuthProvider {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.VITE_AIOP_AUTH_PROVIDER === 'oidc' ? 'oidc' : 'local';
}

export function createStandaloneHost(): WebHostAdapter {
  const host: WebHostAdapter = {
    deploymentMode: 'standalone',
    authProvider: configuredProvider(),
    apiBase: configuredApiBase(),
    getToken: () => typeof localStorage === 'undefined' ? '' : localStorage.getItem(TOKEN_KEY) || '',
    setToken: (token) => {
      if (typeof localStorage !== 'undefined') localStorage.setItem(TOKEN_KEY, token);
    },
    async login(credentials: LoginCredentials): Promise<string> {
      const response = await fetch(apiUrl(host, '/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      if (!response.ok) throw new Error('登录失败，请检查用户名或密码。');
      const body = await response.json() as { token: string };
      host.setToken(body.token);
      return body.token;
    },
    async consumeOidcSession(): Promise<string | undefined> {
      if (host.authProvider !== 'oidc') return undefined;
      const response = await fetch(apiUrl(host, '/auth/oidc/session'), { method: 'POST', credentials: 'include' });
      if (response.status === 401) return undefined;
      if (!response.ok) throw new Error('OIDC 登录会话获取失败');
      const body = await response.json() as { token: string };
      host.setToken(body.token);
      return body.token;
    },
    async startOidcLogin(): Promise<void> {
      const response = await fetch(apiUrl(host, '/auth/oidc/start'), { credentials: 'include' });
      if (!response.ok) throw new Error('OIDC 登录启动失败');
      const body = await response.json() as { url: string };
      window.location.assign(body.url);
    },
    async onUnauthorized(): Promise<void> {
      host.setToken('');
      if (host.authProvider === 'oidc') await host.startOidcLogin?.();
    },
  };
  return host;
}
