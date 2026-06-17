import type { Store } from '../db/store.js';
import type { LocalAuthProvider } from './local.js';
import type { RequestContext, Role, Tenant, User } from './types.js';
import { AuthzError, canManageUsersOf, requirePermission } from './rbac.js';

/**
 * 租户/用户管理接口（带 RBAC）：
 * 平台管理员管租户与任意用户；租户管理员仅管本租户用户。
 */

export async function createTenant(
  ctx: RequestContext,
  store: Store,
  tenant: Tenant,
): Promise<void> {
  requirePermission(ctx, 'tenant:manage');
  await store.createTenant(tenant);
}

export async function listTenants(ctx: RequestContext, store: Store): Promise<Tenant[]> {
  requirePermission(ctx, 'tenant:manage');
  return store.listTenants();
}

export async function createUser(
  ctx: RequestContext,
  auth: LocalAuthProvider,
  input: { tenantId: string; username: string; password: string; role: Role },
): Promise<User> {
  if (!canManageUsersOf(ctx, input.tenantId)) {
    throw new AuthzError(`权限不足：无法在租户 ${input.tenantId} 建号`);
  }
  // 租户管理员不得创建平台管理员
  if (input.role === 'platform_admin' && ctx.role !== 'platform_admin') {
    throw new AuthzError('仅平台管理员可创建平台管理员');
  }
  return auth.createUser(input.tenantId, input.username, input.password, input.role);
}
