import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolHandler } from '../agent/tools.js';

const log = logger.child({ mod: 'skill' });

export interface Skill {
  name: string;
  description: string;
  dir: string;
  /** SKILL.md frontmatter 之后的正文（按需 load 时返回）。 */
  body: string;
  /** 技能目录内的其它文件名（脚本 / 参考资料）。 */
  files: string[];
}

/** 极简 frontmatter 解析：取首个 `---`...`---` 间的 key: value。 */
export function parseFrontmatter(raw: string): {
  attrs: Record<string, string>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { attrs: {}, body: raw };
  const attrs: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) attrs[key] = val;
  }
  return { attrs, body: m[2] ?? '' };
}

/**
 * 渐进式技能加载（Claude Code 风格）：
 * - 扫描 skills 目录，每个子目录含一个 SKILL.md（frontmatter: name/description）；
 * - 仅把 name+description 注入系统提示（summaries），节省上下文；
 * - 模型按需调用 load_skill 展开完整指令。
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();

  constructor(private readonly dir: string) {}

  async scan(): Promise<void> {
    this.skills.clear();
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      log.warn({ dir: this.dir }, 'skills 目录不存在，跳过');
      return;
    }

    for (const entry of entries) {
      const skillDir = join(this.dir, entry);
      try {
        if (!(await stat(skillDir)).isDirectory()) continue;
        const raw = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
        const { attrs, body } = parseFrontmatter(raw);
        const name = attrs.name || entry;
        const files = (await readdir(skillDir)).filter((f) => f !== 'SKILL.md');
        this.skills.set(name, {
          name,
          description: attrs.description ?? '',
          dir: skillDir,
          body: body.trim(),
          files,
        });
      } catch (err) {
        log.warn({ entry, err: String(err) }, '跳过无效技能目录');
      }
    }
    log.info({ count: this.skills.size }, 'skills 扫描完成');
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  /** 注入系统提示的技能摘要（name + description）。 */
  summaries(): string {
    const items = this.list();
    if (!items.length) return '';
    const lines = items.map((s) => `- ${s.name}: ${s.description}`);
    return [
      '可用技能（用 load_skill 加载完整指令）：',
      '用户请求与某个技能描述匹配时，请先调用 load_skill 加载该技能，再按技能指令执行。',
      lines.join('\n'),
    ].join('\n');
  }

  /** load_skill 工具：按名字展开完整 SKILL.md 正文。 */
  tool(): ToolHandler {
    const skills = this.skills;
    return {
      def: {
        name: 'load_skill',
        description: '按名字加载某个技能的完整指令（渐进式披露）。',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: '技能名' } },
          required: ['name'],
        },
      },
      async run(args: JsonValue): Promise<ToolResult> {
        const name =
          args && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, JsonValue>).name
            : undefined;
        if (typeof name !== 'string' || !name) {
          return { id: '', content: '参数 name 必须是非空字符串', isError: true };
        }
        const skill = skills.get(name);
        if (!skill) {
          const avail = [...skills.keys()].join(', ') || '(无)';
          return { id: '', content: `未找到技能 ${name}。可用：${avail}`, isError: true };
        }
        const fileNote = skill.files.length
          ? `\n\n附带文件（在 ${skill.dir}）：${skill.files.join(', ')}`
          : '';
        return { id: '', content: skill.body + fileNote };
      },
    };
  }
}
