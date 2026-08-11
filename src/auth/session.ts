import { SignJWT, jwtVerify } from 'jose';
import { parsePrincipalId, type AuthProviderKind, type RequestContext, type Role } from './types.js';

/** 颁发会话 JWT（HS256），携带 tenant/role，sub=userId。 */
export async function signSession(
  secret: Uint8Array,
  ctx: RequestContext,
  ttl: string,
): Promise<string> {
  return new SignJWT({
    tenant: ctx.tenantId,
    role: ctx.role,
    provider: ctx.provider ?? 'local',
    ...(ctx.displayName ? { displayName: ctx.displayName } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(ctx.userId)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
}

/** 校验会话 JWT，还原 RequestContext；失败返回 undefined。 */
export async function verifySession(
  secret: Uint8Array,
  token: string,
): Promise<RequestContext | undefined> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const userId = payload.sub;
    const tenantId = payload.tenant;
    const role = payload.role;
    const provider = payload.provider;
    const displayName = payload.displayName;
    if (
      typeof tenantId !== 'string'
      || (role !== 'platform_admin' && role !== 'tenant_admin' && role !== 'user')
      || (provider !== 'local' && provider !== 'oidc' && provider !== 'aios')
      || (displayName !== undefined && typeof displayName !== 'string')
    ) return undefined;
    return {
      userId: parsePrincipalId(userId), tenantId, provider: provider as AuthProviderKind, role: role as Role,
      ...(displayName ? { displayName } : {}),
    };
  } catch {
    return undefined;
  }
}
