/** 三种角色（RBAC 在 S8 充实）。 */
export type Role = 'platform_admin' | 'tenant_admin' | 'user';

/** 贯穿请求 / 工具调用 / Store 查询的身份上下文，用于租户隔离与鉴权。 */
export interface RequestContext {
  tenantId: string;
  userId: string;
  role: Role;
}

export interface Tenant {
  id: string;
  name: string;
}

/** 用户状态：active 正常；disabled 软删除/封禁（行保留，登录与访问被拒）。 */
export type UserStatus = 'active' | 'disabled';

/** 登录来源：本地账密 / OIDC SSO / AIOS 平台嵌入。 */
export type AuthProviderKind = 'local' | 'oidc' | 'aios';

export interface User {
  id: string;
  tenantId: string;
  username: string;
  role: Role;
  status: UserStatus;
  authProvider: AuthProviderKind;
  displayName?: string;
  createdAt?: string;
}

/** 平台级系统上下文（调度器跨租户扫描、迁移种子等用）。 */
export const SYSTEM_TENANT = 'system';
