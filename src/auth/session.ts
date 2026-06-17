import { SignJWT, jwtVerify } from 'jose';
import type { RequestContext, Role } from './types.js';

/** 颁发会话 JWT（HS256），携带 tenant/role，sub=userId。 */
export async function signSession(
  secret: Uint8Array,
  ctx: RequestContext,
  ttl: string,
): Promise<string> {
  return new SignJWT({ tenant: ctx.tenantId, role: ctx.role })
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
    if (typeof userId !== 'string' || typeof tenantId !== 'string' || typeof role !== 'string') {
      return undefined;
    }
    return { userId, tenantId, role: role as Role };
  } catch {
    return undefined;
  }
}
