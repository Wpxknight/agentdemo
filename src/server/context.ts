import type { AuthProvider } from '../auth/provider.js';
import type { RequestContext } from '../auth/types.js';

/** 从 Authorization 头取 Bearer token。 */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}

/**
 * 认证中间件核心：校验 Authorization 头 → RequestContext。
 * HTTP 层（后续接入）调用此函数得到 ctx 并下传到 agent / Store。
 */
export async function authenticate(
  authProvider: AuthProvider,
  authorizationHeader: string | undefined,
): Promise<RequestContext | undefined> {
  const token = bearerToken(authorizationHeader);
  if (!token) return undefined;
  return authProvider.authenticate(token);
}
