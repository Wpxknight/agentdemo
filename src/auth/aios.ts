import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { logger } from '../logger.js';
import type { Store } from '../db/store.js';
import type { AiosConfigSchema } from '../config/schema.js';
import type { AuthProvider } from './provider.js';
import type { RequestContext, Role, User } from './types.js';
import { signSession, verifySession } from './session.js';
import type { UserCredentials } from './credentials.js';

const log = logger.child({ mod: 'aios-auth' });

export type AiosConfig = z.infer<typeof AiosConfigSchema>;

/** AIOS token 数据（宿主页 localStorage / 登录接口返回的形态；与技能 token.json 同构）。 */
export interface AiosTokenData {
  token: string;
  refreshToken?: string;
  /** ISO 时间串（AIOS 常见 "+0800" 时区写法已兼容）。 */
  expiredTime?: string;
  [key: string]: unknown;
}

/** 从 AIOS 侧解析出的身份（映射前）。 */
export interface AiosIdentity {
  /** 稳定唯一标识（作为 aiop username）。 */
  externalId: string;
  displayName?: string;
  roles: string[];
}

/** 认证失败（token 无效 / 账号禁用等）：HTTP 层映射为 401。 */
export class AiosAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiosAuthError';
  }
}

export interface AiosAuthOptions {
  store: Store;
  secret: string;
  config: AiosConfig;
  credentials: UserCredentials;
  ttl?: string;
  /** 可注入 fetch，便于测试。 */
  fetchImpl?: typeof fetch;
}

/** 兼容 "+0800" 写法的 ISO 时间解析；无效返回 undefined。 */
export function parseAiosExpiry(expiredTime: string | undefined): Date | undefined {
  if (!expiredTime) return undefined;
  const normalized = expiredTime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 按点路径取字段；顶层取不到时回退 data.<path>（AIOS 接口常见 {code, data:{...}} 包装）。 */
function pick(obj: unknown, path: string): unknown {
  const dig = (root: unknown): unknown => {
    let cur = root;
    for (const part of path.split('.')) {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  };
  const direct = dig(obj);
  if (direct !== undefined) return direct;
  const data = obj && typeof obj === 'object' ? (obj as Record<string, unknown>).data : undefined;
  return data !== undefined ? dig(data) : undefined;
}

function asRoles(value: unknown): string[] {
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

const DEFAULT_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * AIOS 嵌入登录（token exchange，DESIGN-aios-integration §2）：
 * 宿主页 postMessage 传来 AIOS token → 服务端验证（userinfo 回调或 JWKS 验签）→
 * JIT 建号（复用 OIDC 模式）→ 签发 aiop JWT，并把 AIOS token 写入该用户的服务端凭据缓存（P3 用）。
 *
 * 与 Local/Oidc provider 并存：aiop 用户体系不依赖 AIOS（§2.5），本 provider 只是又一种登录方式。
 * 身份映射用 AIOS 稳定唯一标识（配置 fields.userId），永不来自请求方自报的用户名。
 */
export class AiosAuthProvider implements AuthProvider {
  private readonly store: Store;
  private readonly secret: Uint8Array;
  private readonly cfg: AiosConfig;
  private readonly credentials: UserCredentials;
  private readonly ttl: string;
  private readonly fetchImpl: typeof fetch;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(opts: AiosAuthOptions) {
    this.store = opts.store;
    this.secret = new TextEncoder().encode(opts.secret);
    this.cfg = opts.config;
    this.credentials = opts.credentials;
    this.ttl = opts.ttl ?? '2h';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  allowedParentOrigins(): string[] {
    return this.cfg.allowedParentOrigins;
  }

  /** AIOS token → 验证 → JIT → aiop JWT + 凭据缓存。 */
  async exchange(tokenData: AiosTokenData): Promise<{ token: string; ctx: RequestContext; user: User }> {
    if (!tokenData.token) throw new AiosAuthError('缺少 AIOS token');
    const identity = await this.verify(tokenData.token);
    const { ctx, user } = await this.resolveIdentity(identity);
    // 凭据缓存：过期时间取 AIOS 的 expiredTime，缺失时用兜底 TTL。
    const expiresAt = parseAiosExpiry(tokenData.expiredTime)
      ?? new Date(Date.now() + (this.cfg.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS));
    await this.credentials.set(ctx.tenantId, ctx.userId, 'aios', tokenData, expiresAt);
    const token = await signSession(this.secret, ctx, this.ttl);
    return { token, ctx, user };
  }

  /** 验证 AIOS token 真伪并取回身份。 */
  private async verify(aiosToken: string): Promise<AiosIdentity> {
    const claims = this.cfg.verify === 'jwks'
      ? await this.verifyJwks(aiosToken)
      : await this.verifyUserinfo(aiosToken);
    const externalId = pick(claims, this.cfg.fields.userId);
    if (externalId === undefined || externalId === null || externalId === '') {
      throw new AiosAuthError(`AIOS 用户信息缺少稳定标识字段 ${this.cfg.fields.userId}`);
    }
    const displayName = pick(claims, this.cfg.fields.displayName);
    return {
      externalId: String(externalId),
      displayName: typeof displayName === 'string' && displayName ? displayName : undefined,
      roles: asRoles(pick(claims, this.cfg.fields.roles)),
    };
  }

  private async verifyUserinfo(aiosToken: string): Promise<unknown> {
    const url = this.cfg.userinfoUrl;
    if (!url) throw new AiosAuthError('未配置 auth.aios.userinfoUrl');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: {
          token: aiosToken,
          authorization: `Bearer ${aiosToken}`,
          systemId: this.cfg.systemId,
          accept: 'application/json',
        },
      });
    } catch (err) {
      log.error({ err: String(err) }, 'AIOS userinfo 请求失败');
      throw new AiosAuthError('AIOS 用户信息接口不可达');
    }
    if (!res.ok) throw new AiosAuthError(`AIOS token 校验失败（HTTP ${res.status}）`);
    const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body) throw new AiosAuthError('AIOS 用户信息接口返回非 JSON');
    return body;
  }

  private async verifyJwks(aiosToken: string): Promise<unknown> {
    const jwksCfg = this.cfg.jwks;
    if (!jwksCfg) throw new AiosAuthError('未配置 auth.aios.jwks');
    this.jwks ??= createRemoteJWKSet(new URL(jwksCfg.url));
    try {
      const { payload } = await jwtVerify(aiosToken, this.jwks, {
        ...(jwksCfg.issuer ? { issuer: jwksCfg.issuer } : {}),
        ...(jwksCfg.audience ? { audience: jwksCfg.audience } : {}),
      });
      return payload;
    } catch {
      throw new AiosAuthError('AIOS token 验签失败');
    }
  }

  /** identity → JIT 建号（复用 OIDC 模式）→ RequestContext；disabled 行即封禁（§8.5 竞态护栏）。 */
  async resolveIdentity(identity: AiosIdentity): Promise<{ ctx: RequestContext; user: User }> {
    const tenantId = this.cfg.tenantId;
    // AIOS 角色只映射 tenant_admin/user，永不产生 platform_admin。
    const role: Role = identity.roles.some((r) => this.cfg.adminRoles.includes(r)) ? 'tenant_admin' : 'user';
    await this.store.createTenant({ id: tenantId, name: tenantId }).catch(() => {});

    const existing = await this.store.getUserByUsername(tenantId, identity.externalId);
    if (existing) {
      if (existing.status === 'disabled') throw new AiosAuthError('账号已被禁用，请联系管理员');
      // 角色/展示名以 AIOS 最新为准（同 OIDC 语义）；本地手工调过的角色也会被平台侧覆盖。
      const patch: { role?: Role; displayName?: string } = {};
      if (existing.role !== role && existing.role !== 'platform_admin') patch.role = role;
      if (identity.displayName && identity.displayName !== existing.displayName) patch.displayName = identity.displayName;
      const user = Object.keys(patch).length
        ? (await this.store.updateUser(tenantId, existing.id, patch)) ?? existing
        : existing;
      return { ctx: { tenantId, userId: user.id, role: user.role }, user };
    }

    const created = await this.store.createUser({
      tenantId,
      username: identity.externalId,
      role,
      passwordHash: 'aios', // 平台用户无本地口令（哨兵值，同 OIDC 的 'oidc'）
      authProvider: 'aios',
      displayName: identity.displayName,
    });
    log.info({ tenantId, username: identity.externalId }, 'AIOS JIT 建号');
    return { ctx: { tenantId, userId: created.id, role }, user: created };
  }

  /** exchange 之外不支持账密登录。 */
  async login(): Promise<string | undefined> {
    return undefined;
  }

  async authenticate(token: string): Promise<RequestContext | undefined> {
    return verifySession(this.secret, token);
  }
}
