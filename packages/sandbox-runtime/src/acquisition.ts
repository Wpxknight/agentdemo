import type { ToolContext } from './contracts.js';
import type { SandboxManagerLike } from './lifecycle.js';
import type { SandboxHandle, SandboxSpec } from './types.js';

/** 由调用上下文推导 Sandbox spec；profile 由 generation 在调用开始时固定。 */
export type SpecResolver = (
  ctx: ToolContext,
  profile?: string,
) => Partial<SandboxSpec> | Promise<Partial<SandboxSpec>>;

export interface SandboxAcquisition {
  handle: SandboxHandle;
  spec: SandboxSpec;
  /** 将凭据污染标记写回本次实际使用的 generation/entry。 */
  markCredentialInjected(): void;
}

export interface SandboxAcquirer extends SandboxManagerLike {
  acquire(ctx: ToolContext, profile?: string): Promise<SandboxAcquisition>;
  acquireSpec(
    ctx: ToolContext,
    spec: SandboxSpec | (() => SandboxSpec | Promise<SandboxSpec>),
  ): Promise<SandboxAcquisition>;
}

export function isSandboxAcquirer(manager: SandboxManagerLike): manager is SandboxAcquirer {
  return typeof (manager as Partial<SandboxAcquirer>).acquire === 'function'
    && typeof (manager as Partial<SandboxAcquirer>).acquireSpec === 'function';
}
