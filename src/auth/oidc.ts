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
  /** 服务端固定的 standalone Web 登录完成地址。 */
  webCallbackUrl?: string;
  scopes?: string[];
  allowInsecureHttp?: boolean;
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
    const redirect = new URL(opts.config.redirectUri);
    const webCallback = new URL(opts.config.webCallbackUrl ?? new URL('/', redirect));
    if (!['http:', 'https:'].includes(redirect.protocol) || redirect.username || redirect.password) {
      throw new Error('OIDC redirectUri 必须是无用户信息的 HTTP(S) URL');
    }
    if (!['http:', 'https:'].includes(webCallback.protocol) || webCallback.username || webCallback.password) {
      throw new Error('OIDC webCallbackUrl 必须是无用户信息的 HTTP(S) URL');
    }
    if (webCallback.origin !== redirect.origin) {
      throw new Error('OIDC webCallbackUrl 必须与 redirectUri 同源');
    }
    this.store = opts.store;
    this.secret = new TextEncoder().encode(opts.secret);
    this.cfg = opts.config;
    this.ttl = opts.ttl ?? '12h';
  }

  webCallbackUrl(): URL {
    return new URL(this.cfg.webCallbackUrl ?? new URL('/', this.cfg.redirectUri));
  }

  usesSecureCallback(): boolean {
    return new URL(this.cfg.redirectUri).protocol === 'https:';
  }

  private async config(): Promise<oidc.Configuration> {
    if (!this.discovered) {
      this.discovered = await oidc.discovery(
        new URL(this.cfg.issuer),
        this.cfg.clientId,
        undefined,
        this.cfg.clientSecret ? oidc.ClientSecretPost(this.cfg.clientSecret) : undefined,
        this.cfg.allowInsecureHttp ? { execute: [oidc.allowInsecureRequests] } : undefined,
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

  /** 处理回调：只信任配置的 callback origin/path，请求 URL 仅提供已解析的 OIDC query。 */
  async handleCallback(currentUrl: string, checks: { state: string; codeVerifier: string }): Promise<string> {
    const config = await this.config();
    const requestUrl = new URL(currentUrl);
    const callbackUrl = new URL(this.cfg.redirectUri);
    callbackUrl.search = new URLSearchParams(requestUrl.searchParams).toString();
    callbackUrl.hash = '';
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
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
        authProvider: 'oidc',
      });
      log.info({ tenantId, username }, 'JIT 建号');
      return { tenantId, userId: created.id, provider: 'oidc', role };
    }
    // 软删除/封禁的行仍占用 username：命中即拒绝，防止经 JIT 复活（§8.5 护栏）。
    if (user.status === 'disabled') throw new Error('账号已被禁用，请联系管理员');
    if (user.authProvider !== 'oidc') throw new Error('账号认证来源与 OIDC 不匹配');
    // IdP 是 OIDC 用户角色的可信来源；登录时同步本地状态，使新会话可通过 authenticate 的防降权校验。
    if (user.role !== role) {
      const updated = await this.store.updateUser(tenantId, user.id, { role });
      if (!updated || updated.status !== 'active' || updated.authProvider !== 'oidc') {
        throw new Error('OIDC 用户角色同步失败');
      }
      log.info({ tenantId, username, previousRole: user.role, role }, 'OIDC 用户角色已同步');
    }
    return { tenantId, userId: user.id, provider: 'oidc', role };
  }

  /** SSO 不走密码登录。 */
  async login(): Promise<string | undefined> {
    return undefined;
  }

  async authenticate(token: string): Promise<RequestContext | undefined> {
    const ctx = await verifySession(this.secret, token);
    if (!ctx || ctx.provider !== 'oidc') return undefined;
    const user = await this.store.getUser(ctx.tenantId, ctx.userId);
    if (!user || user.status !== 'active' || user.authProvider !== 'oidc' || user.role !== ctx.role) return undefined;
    return ctx;
  }
}
