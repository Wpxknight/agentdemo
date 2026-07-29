import type { JsonValue, ToolCall, ToolDef } from '../llm/types.js';
import { parseKubectlArgs, classifyKubectl, positionals } from '../ops/classify.js';

/**
 * 工具权限规则引擎（借鉴 Claude Code utils/permissions）：
 * 管理员用配置声明 allow / deny / ask 规则，覆盖任意工具（不止 kubectl）。
 *
 * 规则语法：`工具名` 或 `工具名(子模式)`
 * - `sbx__run_command` —— 匹配该工具的所有调用；
 * - `kubectl(delete:*)` —— 匹配 kubectl 且子模式匹配（见 subjectFor）；
 * - `mcp__github(*)` / `mcp__github` —— 匹配某 MCP server 的全部工具（前缀）。
 *
 * 子模式用 shell 通配（* ?），大小写不敏感；对应工具的“子对象”：
 * - kubectl：`<verb>` 或 `<verb>:<资源/命名空间关键字>`（如 `delete:prod-*`、`get`）；
 * - sbx__run_command / sbx__run_code：命令/代码文本；
 * - 其他工具：无子对象时，只有不带括号的规则能命中。
 *
 * 优先级：deny > ask > allow；同类内“后配置的更具体规则”不额外加权，命中即用。
 * evaluate 返回 undefined 表示无规则命中，交由下游 OpsPolicy 决策。
 */
export type RuleEffect = 'allow' | 'deny' | 'ask';

export interface PermissionRulesConfig {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

interface ParsedRule {
  tool: string;
  /** 工具名是否以 * 结尾表示前缀匹配（用于 mcp__server* 之类）。 */
  toolPrefix: boolean;
  subject?: RegExp;
  raw: string;
}

export interface RuleMatch {
  effect: RuleEffect;
  rule: string;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function parseRule(raw: string): ParsedRule | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const m = /^([^(]+?)(?:\((.*)\))?$/.exec(trimmed);
  if (!m) return undefined;
  let tool = m[1]!.trim();
  const subjectPat = m[2]?.trim();
  const toolPrefix = tool.endsWith('*');
  if (toolPrefix) tool = tool.slice(0, -1);
  return {
    tool,
    toolPrefix,
    subject: subjectPat && subjectPat !== '*' ? globToRegExp(subjectPat) : undefined,
    raw: trimmed,
  };
}

function str(o: Record<string, JsonValue>, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : '';
}

function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

/** 工具调用的“子对象”字符串集合，供 subject 模式匹配（一个调用可产生多个候选，任一命中即算命中）。 */
export function subjectsFor(call: ToolCall): string[] {
  const o = asObject(call.args);
  if (call.name === 'kubectl') {
    const { args } = parseKubectlArgs(call.args);
    const cls = classifyKubectl(args);
    // 候选：`<verb>`、`<verb>:<全部目标连写>`、以及 `<verb>:<每个目标 token>`，
    // 便于写 `delete`、`delete:pod`、`delete:prod-*`（按资源名匹配）等规则。
    const targets = positionals(args).slice(1);
    const subjects = [cls.verb];
    if (targets.length) {
      subjects.push(`${cls.verb}:${targets.join(' ')}`);
      for (const t of targets) subjects.push(`${cls.verb}:${t}`);
    }
    return subjects.filter(Boolean);
  }
  if (call.name === 'sbx__run_command') return [str(o, 'command')];
  if (call.name === 'sbx__run_code') return [str(o, 'code')];
  return [];
}

export class PermissionRules {
  private readonly rules: { effect: RuleEffect; parsed: ParsedRule }[] = [];

  constructor(config?: PermissionRulesConfig) {
    for (const [effect, list] of [
      ['deny', config?.deny],
      ['ask', config?.ask],
      ['allow', config?.allow],
    ] as const) {
      for (const raw of list ?? []) {
        const parsed = parseRule(raw);
        if (parsed) this.rules.push({ effect, parsed });
      }
    }
  }

  get empty(): boolean {
    return this.rules.length === 0;
  }

  private toolMatches(parsed: ParsedRule, toolName: string): boolean {
    return parsed.toolPrefix ? toolName.startsWith(parsed.tool) : parsed.tool === toolName;
  }

  /** 判定一次工具调用；deny > ask > allow，无命中返回 undefined。 */
  evaluate(call: ToolCall): RuleMatch | undefined {
    const subjects = subjectsFor(call);
    for (const effect of ['deny', 'ask', 'allow'] as const) {
      for (const { effect: e, parsed } of this.rules) {
        if (e !== effect) continue;
        if (!this.toolMatches(parsed, call.name)) continue;
        if (parsed.subject) {
          if (!subjects.some((s) => parsed.subject!.test(s))) continue;
        }
        return { effect, rule: parsed.raw };
      }
    }
    return undefined;
  }

  /**
   * 判断某工具是否被“无条件 deny”（deny 规则不带子模式且工具名整体匹配）。
   * 这类工具在注入模型前就整体剥离——模型看不到即不会尝试。
   * 带子模式的 deny 不剥离（同名工具的其他调用仍可用），只在调用时拦截。
   */
  isToolFullyDenied(toolName: string): boolean {
    return this.rules.some(
      ({ effect, parsed }) => effect === 'deny' && !parsed.subject && this.toolMatches(parsed, toolName),
    );
  }

  /** 从工具定义列表中剥离被无条件 deny 的工具。 */
  filterToolDefs(defs: ToolDef[]): ToolDef[] {
    if (this.empty) return defs;
    return defs.filter((d) => !this.isToolFullyDenied(d.name));
  }
}
