export type WebDeploymentMode = 'standalone' | 'aios-integrated';
export type WebAuthProvider = 'local' | 'oidc' | 'aios';

export interface LoginCredentials {
  tenantId: string;
  username: string;
  password: string;
}

/**
 * Stable boundary between the reusable AIoP Web Core and its host.
 * Hosts own token persistence, API location, login initiation and 401 routing.
 */
export interface WebHostAssets {
  logo: string;
  userAvatar: string;
}

export interface WebHostAdapter {
  readonly deploymentMode: WebDeploymentMode;
  readonly authProvider: WebAuthProvider;
  readonly apiBase: string;
  /** Host-owned URLs avoid coupling the reusable Core package to an absolute /assets root. */
  readonly assets?: Partial<WebHostAssets>;
  getToken(): string;
  setToken(token: string): void;
  subscribeToken?(listener: (token: string) => void): () => void;
  login?(credentials: LoginCredentials): Promise<string>;
  /** Consume the callback's one-time HttpOnly session cookie without exposing it to JavaScript. */
  consumeOidcSession?(): Promise<string | undefined>;
  startOidcLogin?(): Promise<void>;
  /** Integrated hosts wait for a replacement token; standalone OIDC hosts start a redirect. */
  onUnauthorized(): void | Promise<void>;
}

export function apiUrl(host: WebHostAdapter, path: string): string {
  const base = host.apiBase.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
