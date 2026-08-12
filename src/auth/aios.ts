import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { logger } from '../logger.js';
import type { Store } from '../db/store.js';
import type { AiosConfigSchema } from '../config/schema.js';
import type { AuthProvider } from './provider.js';
import { parsePrincipalId, type RequestContext, type Role } from './types.js';
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
  /** AIOS 可信身份源返回的稳定正整数 accountId。 */
  accountId: string;
  tenantId: string;
  status: 'active' | 'disabled';
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
 * AIOS 集成登录（token exchange）：
 * 宿主传来 AIOS token → 服务端验证（userinfo 回调或 JWKS 验签）→
 * 直接使用可信 accountId 签发 aiop JWT，并缓存该身份的 AIOS 下游凭据。
 *
 * 此路径不创建本地 users/tenants 行。身份映射使用 AIOS 稳定唯一标识
 * （配置 fields.userId），永不来自请求方自报的用户名。
 */
export class AiosAuthProvider implements AuthProvider {
  private readonly secret: Uint8Array;
  private readonly cfg: AiosConfig;
  private readonly credentials: UserCredentials;
  private readonly ttl: string;
  private readonly fetchImpl: typeof fetch;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(opts: AiosAuthOptions) {
    this.secret = new TextEncoder().encode(opts.secret);
    this.cfg = opts.config;
    this.credentials = opts.credentials;
    this.ttl = opts.ttl ?? '2h';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  allowedParentOrigins(): string[] {
    return this.cfg.allowedParentOrigins;
  }

  /** AIOS token → 服务端可信验证 → 直连身份 → aiop JWT + 凭据缓存。 */
  async exchange(tokenData: AiosTokenData): Promise<{ token: string; ctx: RequestContext }> {
    if (!tokenData.token) throw new AiosAuthError('缺少 AIOS token');
    const identity = await this.verify(tokenData.token);
    const ctx = this.resolveIdentity(identity);
    // expiredTime 缺失时沿用可信服务端 TTL；一旦提供则必须合法且仍在有效期内，禁止非法值回退。
    const expiresAt = tokenData.expiredTime === undefined
      ? new Date(Date.now() + (this.cfg.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS))
      : parseAiosExpiry(tokenData.expiredTime);
    if (!expiresAt) throw new AiosAuthError('AIOS expiredTime 格式非法');
    if (expiresAt.getTime() <= Date.now()) throw new AiosAuthError('AIOS 凭据已过期');
    await this.credentials.set(ctx.tenantId, ctx.userId, 'aios', tokenData, expiresAt);
    const token = await signSession(this.secret, ctx, this.ttl);
    return { token, ctx };
  }

  /** 验证 AIOS token 真伪并取回身份。 */
  private async verify(aiosToken: string): Promise<AiosIdentity> {
    const claims = this.cfg.verify === 'jwks'
      ? await this.verifyJwks(aiosToken)
      : await this.verifyUserinfo(aiosToken);
    const rawAccountId = pick(claims, this.cfg.fields.userId);
    let accountId: string;
    try {
      accountId = parsePrincipalId(typeof rawAccountId === 'number' && Number.isSafeInteger(rawAccountId)
        ? String(rawAccountId) : rawAccountId);
    } catch {
      throw new AiosAuthError(`AIOS 用户信息缺少合法 accountId 字段 ${this.cfg.fields.userId}`);
    }
    const rawTenantId = this.cfg.fields.tenantId ? pick(claims, this.cfg.fields.tenantId) : this.cfg.tenantId;
    if (typeof rawTenantId !== 'string' || !rawTenantId.trim()) {
      throw new AiosAuthError('AIOS 用户信息缺少合法 tenantId');
    }
    const rawStatus = pick(claims, this.cfg.fields.status);
    if (rawStatus !== 'active' && rawStatus !== 'disabled') {
      throw new AiosAuthError(`AIOS 用户信息缺少合法账号状态字段 ${this.cfg.fields.status}`);
    }
    const displayName = pick(claims, this.cfg.fields.displayName);
    return {
      accountId,
      tenantId: rawTenantId.trim(),
      status: rawStatus,
      displayName: typeof displayName === 'string' && displayName ? displayName : undefined,
      roles: asRoles(pick(claims, this.cfg.fields.roles)),
    };
  }

  private async verifyUserinfo(aiosToken: string): Promise<unknown> {
    const url = this.cfg.userinfoUrl;
    if (!url) throw new AiosAuthError('未配置 auth.aios.userinfoUrl');
    let res: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.userinfoTimeoutMs);
    try {
      res = await this.fetchImpl(url, {
        headers: {
          token: aiosToken,
          authorization: `Bearer ${aiosToken}`,
          systemId: this.cfg.systemId,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'AIOS userinfo 请求失败');
      throw new AiosAuthError('AIOS 用户信息接口不可达');
    } finally {
      clearTimeout(timeout);
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

  /** 可信 AIOS identity 直接映射 RequestContext；认证路径不得读写本地 users/tenants。 */
  resolveIdentity(identity: AiosIdentity): RequestContext {
    if (identity.status !== 'active') throw new AiosAuthError('账号已被禁用，请联系管理员');
    // AIOS 角色只映射 tenant_admin/user，永不产生 platform_admin。
    const role: Role = identity.roles.some((r) => this.cfg.adminRoles.includes(r)) ? 'tenant_admin' : 'user';
    return {
      tenantId: identity.tenantId,
      userId: parsePrincipalId(identity.accountId),
      provider: 'aios',
      role,
      displayName: identity.displayName,
    };
  }

  /** exchange 之外不支持账密登录。 */
  async login(): Promise<string | undefined> {
    return undefined;
  }

  async authenticate(token: string): Promise<RequestContext | undefined> {
    const ctx = await verifySession(this.secret, token);
    if (!ctx || ctx.provider !== 'aios' || ctx.role === 'platform_admin') return undefined;
    const credential = await this.credentials.get<AiosTokenData>(ctx.tenantId, ctx.userId, 'aios');
    if (!credential?.token) return undefined;
    try {
      const identity = await this.verify(credential.token);
      const current = this.resolveIdentity(identity);
      if (
        current.tenantId !== ctx.tenantId
        || current.userId !== ctx.userId
        || current.role !== ctx.role
      ) return undefined;
      return { ...ctx, displayName: current.displayName };
    } catch {
      return undefined;
    }
  }
}
