export type TenantId = string;
export type ActorId = string;
export type RoleName = string;
export type ResourceScope = string;

export interface IdentityContext {
  tenantId: TenantId;
  actorId: ActorId;
  roles: readonly RoleName[];
  resourceScopes?: readonly ResourceScope[];
  correlationId?: string;
}
