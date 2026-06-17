import * as oidc from 'openid-client';
import { logger } from '../logger.js';
import type { Store } from '../db/store.js';
import type { AuthProvider } from './provider.js';
import type { RequestContext } from './types.js';
import { signSession, verifySession } from './session.js';
import { mapClaims } from './oidc-map.js';
import type { Claims, OidcMapping } from './oidc-map.js';

const log = logger.child({ mod: 'oidc' });

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: string[];
  mapping: OidcMapping;
}

export interface OidcAuthOptions {
  store: Store;
  secret: string;
  config: OidcProviderConfig;
  ttl?: string;
}

/** 发起登录所需的一次性参数（调用方需在回调时回传 state/codeVerifier）。 */
export interface AuthStart {
  url: string;
  state: string;
  codeVerifier: string;
}

/**
 * OIDC SSO（Authorization Code + PKCE）。登录走 IdP 重定向，回调换取 claims，
 * 按映射 JIT 建号并颁发本系统会话 token；authenticate 校验本系统 token。
 */
export class OidcAuthProvider implements AuthProvider {
  private readonly store: Store;
  private readonly secret: Uint8Array;
  private readonly cfg: OidcProviderConfig;
  private readonly ttl: string;
  private discovered?: oidc.Configuration;

  constructor(opts: OidcAuthOptions) {
    this.store = opts.store;
    this.secret = new TextEncoder().encode(opts.secret);
    this.cfg = opts.config;
    this.ttl = opts.ttl ?? '12h';
  }

  private async config(): Promise<oidc.Configuration> {
    if (!this.discovered) {
      this.discovered = await oidc.discovery(
        new URL(this.cfg.issuer),
        this.cfg.clientId,
        undefined,
        this.cfg.clientSecret ? oidc.ClientSecretPost(this.cfg.clientSecret) : undefined,
      );
    }
    return this.discovered;
  }

  /** 构造授权 URL（含 PKCE + state）。 */
  async authorizationUrl(): Promise<AuthStart> {
    const config = await this.config();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.cfg.redirectUri,
      scope: (this.cfg.scopes ?? ['openid', 'profile', 'email']).join(' '),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });
    return { url: url.href, state, codeVerifier };
  }

  /** 处理回调：换取 token → claims → JIT → 本系统会话 token。 */
  async handleCallback(currentUrl: string, checks: { state: string; codeVerifier: string }): Promise<string> {
    const config = await this.config();
    const tokens = await oidc.authorizationCodeGrant(config, new URL(currentUrl), {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('OIDC 回调缺少 ID Token claims');
    const ctx = await this.resolveIdentity(claims as Claims);
    return signSession(this.secret, ctx, this.ttl);
  }

  /** claims → 映射 → JIT 建号 → RequestContext（不含网络，便于测试）。 */
  async resolveIdentity(claims: Claims): Promise<RequestContext> {
    const { tenantId, username, role } = mapClaims(claims, this.cfg.mapping);
    await this.store.createTenant({ id: tenantId, name: tenantId }).catch(() => {});
    let user = await this.store.getUserByUsername(tenantId, username);
    if (!user) {
      const created = await this.store.createUser({
        tenantId,
        username,
        role,
        passwordHash: 'oidc', // SSO 用户无本地口令
      });
      log.info({ tenantId, username }, 'JIT 建号');
      return { tenantId, userId: created.id, role };
    }
    // 角色以 IdP 最新映射为准（反映 IdP 侧变更）
    return { tenantId, userId: user.id, role };
  }

  /** SSO 不走密码登录。 */
  async login(): Promise<string | undefined> {
    return undefined;
  }

  async authenticate(token: string): Promise<RequestContext | undefined> {
    return verifySession(this.secret, token);
  }
}
