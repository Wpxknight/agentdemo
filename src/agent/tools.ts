import type { JsonValue, StreamEvent, ToolCall, ToolDef, ToolResult } from '../llm/types.js';
import type { RequestContext, Role } from '../auth/types.js';
import type { OutputSink } from '@aiop/sandbox-runtime';
import type { QuestionAnswers, QuestionSpec } from './question.js';
import type { ChangePlan } from './plan.js';
import { UnifiedToolRegistry, type ToolSource } from '@aiop/pi-runtime';

/** 工具执行时可用的运行上下文（含租户身份，用于隔离与鉴权）。 */
export interface ToolContext {
  sessionId: string;
  tenantId?: string;
  userId?: string;
  role?: Role;
  signal?: AbortSignal;
  /** 实时输出回调：工具执行期把 stdout/stderr 分片回传（由 agent loop 注入，按工具调用归集）。 */
  onOutput?: OutputSink;
  /** 流式事件回调：工具主动推送结构化事件（如 todo_updated），由 agent loop 注入转发到 SSE。 */
  emitEvent?: (e: StreamEvent) => void;
  /**
   * 向用户提问并等待回答（ask_user 工具用）：暂停运行、推送问题、等前端提交答案。
   * 返回每个问题 → 选中项列表；返回 null 表示未获回答（中止/无交互端）。
   */
  askUser?: (questions: QuestionSpec[]) => Promise<QuestionAnswers | null>;
  /** 提交变更方案并等待用户审批（submit_change_plan 工具用）；返回是否批准。 */
  requestPlanApproval?: (plan: ChangePlan) => Promise<boolean>;
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
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  capability: 'read' | 'retryable_write' | 'non_idempotent_write';
  execute(args: JsonValue, ctx: ToolContext): Promise<ToolResult>;
}

export type DirectToolExecution =
  | { result: ToolResult }
  | { error: unknown; result: ToolResult };

export function defineTool(input: ToolHandler): ToolHandler {
  return input;
}

/**
 * 工具注册表：汇集内置工具 / Skill / MCP / Sandbox / kubectl，
 * 统一对外暴露 defs() 并按名字 dispatch。
 */
export class ToolRegistry {
  private handlers = new Map<string, { tool: ToolHandler; source: Exclude<ToolSource, 'pi'> }>();

  register(tool: ToolHandler, source: Exclude<ToolSource, 'pi'> = 'aiop'): this {
    if (this.handlers.has(tool.name)) {
      throw new Error(`duplicate tool: ${tool.name}`);
    }
    this.handlers.set(tool.name, { tool, source });
    return this;
  }

  unregister(name: string): boolean {
    return this.handlers.delete(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  defs(): ToolDef[] {
    return [...this.handlers.values()].map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      capability: tool.capability,
    }));
  }

  unified(
    context: ToolContext | ((call: ToolCall) => ToolContext),
    filter?: (defs: ToolDef[]) => ToolDef[],
  ): UnifiedToolRegistry {
    const allowed = new Set((filter ? filter(this.defs()) : this.defs()).map((definition) => definition.name));
    const registry = new UnifiedToolRegistry();
    for (const { tool, source } of this.handlers.values()) {
      if (!allowed.has(tool.name)) continue;
      registry.register(source, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        capability: tool.capability,
        execute: async (call, executionContext) => {
          const ctx = typeof context === 'function'
            ? context({ id: call.id, name: call.name, args: call.arguments })
            : context;
          const output = await tool.execute(call.arguments, {
            ...ctx,
            idempotencyKey: executionContext.idempotencyKey,
            signal: executionContext.signal,
          });
          return { content: output.content, isError: output.isError };
        },
      });
    }
    return registry;
  }

  async dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    return (await this.executeDirect(call, ctx)).result;
  }

  /** 直接 API 使用：保留结构化异常，由 HTTP 边界映射状态码。 */
  async executeDirect(call: ToolCall, ctx: ToolContext): Promise<DirectToolExecution> {
    const registered = this.handlers.get(call.name);
    if (!registered) {
      return { result: { id: call.id, content: `unknown tool: ${call.name}`, isError: true } };
    }
    try {
      const result = await registered.tool.execute(call.args, ctx);
      return { result: { ...result, id: call.id } };
    } catch (error) {
      if (error && typeof error === 'object' && (error as { is_bubble_up?: unknown }).is_bubble_up === true) throw error;
      return {
        error,
        result: {
          id: call.id,
          content: `tool ${call.name} failed: ${String(error)}`,
          isError: true,
        },
      };
    }
  }
}
