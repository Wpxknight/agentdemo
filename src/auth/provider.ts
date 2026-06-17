import type { RequestContext } from './types.js';

/**
 * 认证提供方抽象：本地（Local，P1）或 SSO（OIDC，P3）。
 * login 颁发会话 token；authenticate 校验 token 还原 RequestContext。
 */
export interface AuthProvider {
  /** 校验凭据并颁发 token；失败返回 undefined。 */
  login(tenantId: string, username: string, password: string): Promise<string | undefined>;
  /** 校验 token 还原身份；失败返回 undefined。 */
  authenticate(token: string): Promise<RequestContext | undefined>;
}
