import type { JsonValue, ToolCall, ToolDef, ToolResult } from '../model/types.js';
import type { RequestContext, Role } from '../auth/types.js';

/** 工具执行时可用的运行上下文（含租户身份，用于隔离与鉴权）。 */
export interface ToolContext {
  sessionId: string;
  tenantId?: string;
  userId?: string;
  role?: Role;
  [key: string]: unknown;
}

/** 从 ToolContext 取出租户身份；缺失则抛错（防止漏过隔离）。 */
export function reqContext(ctx: ToolContext): RequestContext {
  if (!ctx.tenantId || !ctx.userId || !ctx.role) {
    throw new Error('缺少身份上下文（tenantId/userId/role）');
  }
  return { tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role };
}

export interface ToolHandler {
  def: ToolDef;
  run(args: JsonValue, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * 工具注册表：汇集内置工具 / Skill / MCP / Sandbox / kubectl，
 * 统一对外暴露 defs() 并按名字 dispatch。
 */
export class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): this {
    if (this.handlers.has(handler.def.name)) {
      throw new Error(`duplicate tool: ${handler.def.name}`);
    }
    this.handlers.set(handler.def.name, handler);
    return this;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  defs(): ToolDef[] {
    return [...this.handlers.values()].map((h) => h.def);
  }

  async dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return { id: call.id, content: `unknown tool: ${call.name}`, isError: true };
    }
    try {
      const result = await handler.run(call.args, ctx);
      return { ...result, id: call.id };
    } catch (err) {
      return {
        id: call.id,
        content: `tool ${call.name} failed: ${String(err)}`,
        isError: true,
      };
    }
  }
}
