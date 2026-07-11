import { logger } from '../logger.js';
import type { Store } from '../db/store.js';
import type { AuditSink } from '../audit/sink.js';
import type { RequestContext, User } from './types.js';
import { AuthzError, canManageUsersOf } from './rbac.js';
import type { UserCredentials } from './credentials.js';

const log = logger.child({ mod: 'user-lifecycle' });

/**
 * 用户软删除 / 禁用（DESIGN-aios-integration §8）：
 * - 行永不硬删（sessions/skills/scheduled_tasks/审计 外键锚定）；
 * - 默认保留原 username（占位即封禁：AIOS/OIDC 用户下次登录命中 disabled 行被拒，无法经 JIT 复活）；
 * - tombstone=true 显式打墓碑（改名释放用户名，同名新人 JIT 建干净新号）——仅在确认工号回收时使用。
 */

export interface UserLifecycleDeps {
  store: Store;
  credentials: UserCredentials;
  audit?: AuditSink;
}

/** 管理护栏：不能动自己；tenant_admin 不能动管理员（仅 platform_admin 可以）；租户范围由 RBAC 限定。 */
export function assertCanManageTarget(ctx: RequestContext, target: User): void {
  if (target.id === ctx.userId) throw new AuthzError('不能对自己执行该操作');
  if (!canManageUsersOf(ctx, target.tenantId)) {
    throw new AuthzError(`权限不足：无法管理租户 ${target.tenantId} 的用户`);
  }
  if ((target.role === 'platform_admin' || target.role === 'tenant_admin') && ctx.role !== 'platform_admin') {
    throw new AuthzError('仅平台管理员可管理管理员账号');
  }
}

/** 软删除：禁用 + 清凭据 + 暂停定时任务（+ 可选墓碑改名）。幂等。 */
export async function softDeleteUser(
  deps: UserLifecycleDeps,
  ctx: RequestContext,
  target: User,
  opts: { tombstone?: boolean } = {},
): Promise<User> {
  assertCanManageTarget(ctx, target);
  const tombstoneName = opts.tombstone && !target.username.includes('#deleted#')
    ? `${target.username}#deleted#${Date.now()}`
    : undefined;
  const updated = await deps.store.updateUser(target.tenantId, target.id, {
    status: 'disabled',
    ...(tombstoneName ? { username: tombstoneName } : {}),
  });
  if (!updated) throw new Error('用户不存在');
  await deps.credentials.clear(target.tenantId, target.id);
  const pausedTasks = await deps.store.disableTasksByUser(target.tenantId, target.id);
  await deps.audit?.record({
    kind: 'auth',
    action: 'user-deleted',
    tenantId: target.tenantId,
    detail: { by: ctx.userId, target: target.id, tombstone: Boolean(tombstoneName), pausedTasks },
  });
  log.info({ tenantId: target.tenantId, target: target.id, tombstone: Boolean(tombstoneName), pausedTasks }, '用户已软删除');
  return updated;
}

/** 临时禁用 / 恢复（不动数据归属；禁用同样清凭据缓存）。 */
export async function setUserEnabled(
  deps: UserLifecycleDeps,
  ctx: RequestContext,
  target: User,
  enabled: boolean,
): Promise<User> {
  assertCanManageTarget(ctx, target);
  const updated = await deps.store.updateUser(target.tenantId, target.id, {
    status: enabled ? 'active' : 'disabled',
  });
  if (!updated) throw new Error('用户不存在');
  if (!enabled) await deps.credentials.clear(target.tenantId, target.id);
  await deps.audit?.record({
    kind: 'auth',
    action: enabled ? 'user-enabled' : 'user-disabled',
    tenantId: target.tenantId,
    detail: { by: ctx.userId, target: target.id },
  });
  return updated;
}
