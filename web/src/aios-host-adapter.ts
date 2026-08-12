import { apiUrl, type WebHostAdapter } from './host-adapter';

export interface AiosHostAdapterOptions {
  apiBase: string;
  parentOrigin: string;
  initialToken?: string;
}

export interface AiosExchangeCredential {
  token: string;
  refreshToken?: string;
  expiredTime?: string;
}

/** Host adapter consumed by paas-web after it obtains a trusted AIOS credential. */
export class AiosHostAdapter implements WebHostAdapter {
  readonly deploymentMode = 'aios-integrated' as const;
  readonly authProvider = 'aios' as const;
  readonly apiBase: string;
  readonly parentOrigin: string;
  private token: string;
  private readonly listeners = new Set<(token: string) => void>();

  constructor(options: AiosHostAdapterOptions) {
    this.apiBase = options.apiBase;
    this.parentOrigin = options.parentOrigin;
    this.token = options.initialToken ?? '';
  }

  getToken(): string {
    return this.token;
  }

  setToken(token: string): void {
    this.token = token;
    for (const listener of this.listeners) listener(token);
  }

  subscribeToken(listener: (token: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async exchange(credential: AiosExchangeCredential): Promise<string> {
    const response = await fetch(apiUrl(this, '/auth/aios/exchange'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credential),
    });
    if (!response.ok) throw new Error('AIOS 登录凭据校验失败');
    const body = await response.json() as { token: string };
    this.setToken(body.token);
    return body.token;
  }

  onUnauthorized(): void {
    this.setToken('');
    if (typeof window !== 'undefined' && window.parent !== window) {
      window.parent.postMessage({ type: 'aiop:unauthorized' }, this.parentOrigin);
    }
  }
}
