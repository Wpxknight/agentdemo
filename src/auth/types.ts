/** 三种角色（RBAC 在 S8 充实）。 */
export type Role = 'platform_admin' | 'tenant_admin' | 'user';

/** MySQL BIGINT UNSIGNED 的最大值；应用/API 始终以十进制字符串表示。 */
export const MAX_PRINCIPAL_ID = 18_446_744_073_709_551_615n;
export const DEFAULT_MEMORY_CLI_PRINCIPAL_ID = MAX_PRINCIPAL_ID.toString();
export type PrincipalId = string;

/** 严格规范化正整数身份，避免 Number 对 BIGINT 的精度损失。 */
export function parsePrincipalId(value: unknown): PrincipalId {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('PrincipalId must be a canonical positive decimal string');
  }
  if (BigInt(value) > MAX_PRINCIPAL_ID) {
    throw new Error('PrincipalId exceeds BIGINT UNSIGNED');
  }
  return value;
}

/** 登录来源：本地账密 / OIDC SSO / AIOS 平台嵌入。 */
export type AuthProviderKind = 'local' | 'oidc' | 'aios';
export type DeploymentMode = 'standalone' | 'aios-integrated';

/** 贯穿请求 / 工具调用 / Store 查询的身份上下文，用于租户隔离与鉴权。 */
export interface RequestContext {
  tenantId: string;
  userId: PrincipalId;
  /** 兼容内部非认证调用；认证 Provider 产出的上下文始终包含该字段。 */
  provider?: AuthProviderKind;
  role: Role;
  /** 来自已验证身份源的展示信息；不参与授权。 */
  displayName?: string;
}

export interface Tenant {
  id: string;
  name: string;
}

/** 用户状态：active 正常；disabled 软删除/封禁（行保留，登录与访问被拒）。 */
export type UserStatus = 'active' | 'disabled';

export interface User {
  id: string;
  tenantId: string;
  username: string;
  role: Role;
  status: UserStatus;
  authProvider: AuthProviderKind;
  displayName?: string;
  /** 绑定的主机主目录（绝对路径）；启动沙箱时默认挂载进沙箱。 */
  homeDir?: string;
  createdAt?: string;
}

/** 平台级系统上下文（调度器跨租户扫描、迁移种子等用）。 */
export const SYSTEM_TENANT = 'system';
