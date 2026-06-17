import type { Role } from './types.js';

/** OIDC claims → tenant/role 映射配置（对应 config.auth.oidc.mapping）。 */
export interface OidcMapping {
  tenantClaim?: string;
  defaultTenant?: string;
  usernameClaim: string;
  roleClaim?: string;
  roleMap?: Record<string, Role>;
  defaultRole: Role;
}

export type Claims = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** 从 claims 解析 tenantId / username / role。 */
export function mapClaims(claims: Claims, mapping: OidcMapping): {
  tenantId: string;
  username: string;
  role: Role;
} {
  const username =
    str(mapping.usernameClaim ? claims[mapping.usernameClaim] : undefined) ??
    str(claims.preferred_username) ??
    str(claims.email) ??
    str(claims.sub) ??
    'unknown';

  const tenantId =
    (mapping.tenantClaim ? str(claims[mapping.tenantClaim]) : undefined) ??
    mapping.defaultTenant ??
    'default';

  return { tenantId, username, role: resolveRole(claims, mapping) };
}

function resolveRole(claims: Claims, mapping: OidcMapping): Role {
  if (!mapping.roleClaim || !mapping.roleMap) return mapping.defaultRole;
  const raw = claims[mapping.roleClaim];
  const values = Array.isArray(raw) ? raw : [raw];
  for (const v of values) {
    const key = str(v);
    if (key && mapping.roleMap[key]) return mapping.roleMap[key];
  }
  return mapping.defaultRole;
}
