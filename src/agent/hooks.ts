import { execFile } from 'node:child_process';
import { logger } from '../logger.js';
import { assertPublicUrl } from '../net/ssrf.js';
import type { ToolCall } from '../model/types.js';
import type { ToolContext } from './tools.js';

const log = logger.child({ mod: 'hooks' });

/**
 * PreToolUse 钩子（借鉴 Claude Code utils/hooks）：
 * 工具执行前把 (工具名, 参数, 上下文) 交给外部处理器；处理器可返回 deny 拦截调用。
 * 两种执行器：
 * - command：本机 shell 命令，stdin 收 JSON，退出码非 0 或 stdout 含 `"deny"` 视为拒绝；
 * - webhook：HTTP POST JSON，响应 JSON `{ "decision": "deny", "reason": "..." }` 或非 2xx 视为拒绝。
 * 任一处理器拒绝即拦截。处理器出错默认放行（fail-open），但审计告警——
 * 合规硬拦截应结合权限规则 deny（fail-closed），hooks 面向"外部系统联动/告警"。
 */
export type HookEvent = 'PreToolUse';

export interface HookMatcher {
  /** 匹配的工具名前缀列表；缺省匹配所有工具。 */
  tools?: string[];
}

export interface CommandHook extends HookMatcher {
  type: 'command';
  command: string;
  /** 超时毫秒，默认 5000。 */
  timeoutMs?: number;
}

export interface WebhookHook extends HookMatcher {
  type: 'webhook';
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export type Hook = CommandHook | WebhookHook;

export interface HooksConfig {
  preToolUse?: Hook[];
}

export interface HookDecision {
  denied: boolean;
  reason?: string;
}

export interface HookPayload {
  event: HookEvent;
  tool: string;
  args: unknown;
  sessionId?: string;
  tenantId?: string;
  userId?: string;
  role?: string;
}

export class HookRunner {
  private readonly preToolUse: Hook[];
  /** 是否允许 webhook 打私网（仅内网自建审批系统时开启）。 */
  private readonly allowPrivateWebhook: boolean;

  constructor(config?: HooksConfig, opts: { allowPrivateWebhook?: boolean } = {}) {
    this.preToolUse = config?.preToolUse ?? [];
    this.allowPrivateWebhook = opts.allowPrivateWebhook ?? false;
  }

  get empty(): boolean {
    return this.preToolUse.length === 0;
  }

  private matches(hook: Hook, tool: string): boolean {
    if (!hook.tools?.length) return true;
    return hook.tools.some((t) => (t.endsWith('*') ? tool.startsWith(t.slice(0, -1)) : t === tool));
  }

  /** 逐个执行匹配的 PreToolUse 钩子；任一拒绝即返回 denied。 */
  async preTool(call: ToolCall, ctx?: ToolContext): Promise<HookDecision> {
    if (this.empty) return { denied: false };
    const payload: HookPayload = {
      event: 'PreToolUse',
      tool: call.name,
      args: call.args,
      sessionId: ctx?.sessionId,
      tenantId: ctx?.tenantId,
      userId: ctx?.userId,
      role: ctx?.role,
    };
    for (const hook of this.preToolUse) {
      if (!this.matches(hook, call.name)) continue;
      try {
        const decision = hook.type === 'command'
          ? await this.runCommand(hook, payload)
          : await this.runWebhook(hook, payload);
        if (decision.denied) {
          log.info({ tool: call.name, type: hook.type, reason: decision.reason }, 'hook denied tool');
          return decision;
        }
      } catch (err) {
        // fail-open：钩子本身出错不阻断业务，但记录告警（合规硬拦截应用 permissions.deny）。
        log.warn({ tool: call.name, type: hook.type, err: String(err) }, 'hook 执行失败，放行');
      }
    }
    return { denied: false };
  }

  private runCommand(hook: CommandHook, payload: HookPayload): Promise<HookDecision> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'sh',
        ['-c', hook.command],
        { timeout: hook.timeoutMs ?? 5000, maxBuffer: 1_000_000 },
        (err, stdout) => {
          if (err) {
            // 退出码非 0：视为拒绝（约定 hook 用非 0 表示拦截）
            const out = String(stdout || '').trim();
            resolve({ denied: true, reason: out || `hook 命令拒绝（exit ${(err as { code?: number }).code ?? 'err'}）` });
            return;
          }
          const out = String(stdout || '').trim();
          if (/\bdeny\b/i.test(out)) {
            resolve({ denied: true, reason: out });
          } else {
            resolve({ denied: false });
          }
        },
      );
      // 子进程可能在读 stdin 前就退出（如 `exit 3`）：吞掉 EPIPE，避免未捕获异常。
      child.stdin?.on('error', () => {});
      try {
        child.stdin?.end(JSON.stringify(payload));
      } catch {
        /* stdin 已关闭，忽略 */
      }
      child.on('error', reject);
    });
  }

  private async runWebhook(hook: WebhookHook, payload: HookPayload): Promise<HookDecision> {
    const url = await assertPublicUrl(hook.url, this.allowPrivateWebhook);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...hook.headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(hook.timeoutMs ?? 5000),
      redirect: 'error', // 禁止跟随重定向（防重定向绕过 SSRF 校验）
    });
    if (!res.ok) return { denied: true, reason: `webhook 返回 ${res.status}` };
    const text = await res.text();
    if (!text.trim()) return { denied: false };
    try {
      const body = JSON.parse(text) as { decision?: string; reason?: string };
      if (body.decision === 'deny') return { denied: true, reason: body.reason || 'webhook 拒绝' };
    } catch {
      if (/\bdeny\b/i.test(text)) return { denied: true, reason: text.slice(0, 200) };
    }
    return { denied: false };
  }
}
