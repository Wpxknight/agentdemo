import type { JsonValue, ToolCall, ToolDef, ToolResult } from '../model/types.js';

/** 工具执行时可用的运行上下文（S7 起注入 tenant/user/role）。 */
export interface ToolContext {
  sessionId: string;
  // tenant?: string; user?: string; role?: Role;  // S7+
  [key: string]: unknown;
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
