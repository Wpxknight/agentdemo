import { describe, expect, it } from 'vitest';
import { can, canManageUsersOf, permissionsFor, requirePermission, AuthzError } from '../src/auth/rbac.js';
import { createTenant, createUser } from '../src/auth/admin.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { MemoryStore } from '../src/db/memory.js';
import type { RequestContext } from '../src/auth/types.js';

const platform: RequestContext = { tenantId: 't1', userId: 'p', role: 'platform_admin' };
const tadmin: RequestContext = { tenantId: 't1', userId: 'ta', role: 'tenant_admin' };
const user: RequestContext = { tenantId: 't1', userId: 'u', role: 'user' };

describe('permission matrix', () => {
  it('grants by role', () => {
    expect(can('platform_admin', 'tenant:manage')).toBe(true);
    expect(can('tenant_admin', 'tenant:manage')).toBe(false);
    expect(can('tenant_admin', 'approve')).toBe(true);
    expect(can('user', 'cluster:write')).toBe(false);
    expect(can('user', 'task:create')).toBe(true);
    expect(permissionsFor('tenant_admin')).toContain('audit:read');
    expect(permissionsFor('user')).not.toContain('user:manage:own');
  });

  it('requirePermission throws on denial', () => {
    expect(() => requirePermission(tadmin, 'tenant:manage')).toThrow(AuthzError);
    expect(() => requirePermission(platform, 'tenant:manage')).not.toThrow();
  });

  it('canManageUsersOf scopes tenant_admin to own tenant', () => {
    expect(canManageUsersOf(platform, 't9')).toBe(true);
    expect(canManageUsersOf(tadmin, 't1')).toBe(true);
    expect(canManageUsersOf(tadmin, 't2')).toBe(false);
    expect(canManageUsersOf(user, 't1')).toBe(false);
  });
});

describe('admin operations', () => {
  async function setup() {
    const store = new MemoryStore();
    const auth = new LocalAuthProvider({ store, secret: 's' });
    return { store, auth };
  }

  it('only platform admin creates tenants', async () => {
    const { store } = await setup();
    await expect(createTenant(tadmin, store, { id: 't2', name: 'T2' })).rejects.toThrow(AuthzError);
    await createTenant(platform, store, { id: 't2', name: 'T2' });
    expect(await store.listTenants()).toHaveLength(1);
  });

  it('tenant admin cannot create users in other tenants', async () => {
    const { auth } = await setup();
    await expect(
      createUser(tadmin, auth, { tenantId: 't2', username: 'x', password: 'p', role: 'user' }),
    ).rejects.toThrow(AuthzError);
    // own tenant ok
    const u = await createUser(tadmin, auth, { tenantId: 't1', username: 'x', password: 'p', role: 'user' });
    expect(u.tenantId).toBe('t1');
  });

  it('tenant admin cannot mint platform admins', async () => {
    const { auth } = await setup();
    await expect(
      createUser(tadmin, auth, { tenantId: 't1', username: 'boss', password: 'p', role: 'platform_admin' }),
    ).rejects.toThrow(/平台管理员/);
  });
});
