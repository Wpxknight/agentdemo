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

export interface User {
  id: string;
  tenantId: string;
  username: string;
  role: Role;
}

/** 平台级系统上下文（调度器跨租户扫描、迁移种子等用）。 */
export const SYSTEM_TENANT = 'system';
