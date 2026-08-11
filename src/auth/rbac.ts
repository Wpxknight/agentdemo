import type { RequestContext, Role } from './types.js';

/** 细粒度权限。 */
export type Permission =
  | 'tenant:manage' // 建/列租户（平台管理员）
  | 'user:manage:any' // 管理任意租户用户（平台管理员）
  | 'user:manage:own' // 管理本租户用户（租户管理员）
  | 'cluster:write' // 执行变更类 kubectl
  | 'approve' // 审批生产变更 / 设置 preApproved
  | 'task:create' // 创建定时任务
  | 'audit:read'; // 查看审计

/** 角色 → 权限矩阵。 */
const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  platform_admin: new Set<Permission>([
    'tenant:manage',
    'user:manage:any',
    'user:manage:own',
    'cluster:write',
    'approve',
    'task:create',
    'audit:read',
  ]),
  tenant_admin: new Set<Permission>([
    'user:manage:own',
    'cluster:write',
    'approve',
    'task:create',
    'audit:read',
  ]),
  user: new Set<Permission>(['task:create']),
};

/** 角色是否具备某权限。 */
export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role]?.has(perm) ?? false;
}

/** 返回服务端授权后的权限快照，供 Web 菜单做一致的 UX 裁剪。 */
export function permissionsFor(role: Role): Permission[] {
  return [...(MATRIX[role] ?? [])];
}

/** 是否管理员角色（租户/平台）；技能上传落 public、无主存量技能代管等按此判定。 */
export function isAdminRole(role: Role): boolean {
  return role === 'platform_admin' || role === 'tenant_admin';
}

/** 越权错误（鉴权中间件抛出）。 */
export class AuthzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthzError';
  }
}

/** API 鉴权中间件：缺权限即抛 AuthzError。 */
export function requirePermission(ctx: RequestContext, perm: Permission): void {
  if (!can(ctx.role, perm)) {
    throw new AuthzError(`权限不足：${ctx.role} 无 ${perm}`);
  }
}

/**
 * 是否可管理目标租户的用户：
 * 平台管理员可管任意租户；租户管理员仅限本租户。
 */
export function canManageUsersOf(ctx: RequestContext, targetTenantId: string): boolean {
  if (can(ctx.role, 'user:manage:any')) return true;
  return can(ctx.role, 'user:manage:own') && ctx.tenantId === targetTenantId;
}
