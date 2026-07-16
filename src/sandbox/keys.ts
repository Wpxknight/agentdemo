export interface SandboxIdentity {
  tenantId?: string;
  userId?: string;
  sessionId: string;
}

export function sandboxIdentityKey(ctx: SandboxIdentity): string {
  return ctx.tenantId && ctx.userId
    ? JSON.stringify([ctx.tenantId, ctx.userId, ctx.sessionId])
    : ctx.sessionId;
}

export function sandboxIdentityMetadata(ctx: SandboxIdentity): Record<string, string> {
  return {
    ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    sessionId: ctx.sessionId,
  };
}

export function sandboxScopedKey(identity: SandboxIdentity, suffix?: string): string {
  const base = sandboxIdentityKey(identity);
  return suffix ? `${base}:${suffix}` : base;
}
