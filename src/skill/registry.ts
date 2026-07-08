import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolHandler } from '../agent/tools.js';

const log = logger.child({ mod: 'skill' });

export interface Skill {
  name: string;
  description: string;
  dir: string;
  enabled: boolean;
  /** SKILL.md frontmatter 之后的正文（按需 load 时返回）。 */
  body: string;
  /** 技能目录内的文件和目录元数据（包含 SKILL.md）。 */
  files: SkillFileEntry[];
}

export interface SkillFileEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  updatedAt: string;
}

export interface SkillFileBody {
  path: string;
  parentPath: string | null;
  entry: SkillFileEntry;
  content: string;
}

const DISABLED_MARKER = '.disabled';

/** summaries() 注入 system prompt 的默认字符预算与单条描述上限（借鉴 Claude Code SkillTool 的预算式披露）。 */
const DEFAULT_SUMMARY_BUDGET = 4000;
const MAX_SUMMARY_DESC_CHARS = 250;

export interface SkillRegistryOptions {
  /** summaries() 总字符预算；超出预算的技能折叠为仅名字一行。 */
  summaryBudget?: number;
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
  private readonly summaryBudget: number;

  constructor(private readonly dir: string, opts: SkillRegistryOptions = {}) {
    this.summaryBudget = opts.summaryBudget ?? DEFAULT_SUMMARY_BUDGET;
  }

  rootDir(): string {
    return this.dir;
  }

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
        const files = await listSkillFiles(skillDir);
        const enabled = !(await exists(join(skillDir, DISABLED_MARKER)));
        this.skills.set(name, {
          name,
          description: attrs.description ?? '',
          dir: skillDir,
          enabled,
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

  /** 注入系统提示的技能摘要（name + description）；带总预算与单条描述截断，防止技能增多撑爆 system prompt。 */
  summaries(): string {
    const items = this.list().filter((skill) => skill.enabled);
    if (!items.length) return '';
    const header = [
      '可用技能（用 load_skill 加载完整指令）：',
      '用户请求与某个技能描述匹配时，请先调用 load_skill 加载该技能，再按技能指令执行。',
      '即使用户没有点名技能或 API，且浏览器、shell 等通用工具也能完成同类任务，只要主题命中某个技能描述，就必须优先加载并使用该技能。',
    ];
    let used = header.join('\n').length;
    const lines: string[] = [];
    const overflow: string[] = [];
    for (const s of items) {
      const desc = s.description.length > MAX_SUMMARY_DESC_CHARS
        ? `${s.description.slice(0, MAX_SUMMARY_DESC_CHARS)}…`
        : s.description;
      const line = `- ${s.name}: ${desc}`;
      if (used + line.length + 1 <= this.summaryBudget) {
        lines.push(line);
        used += line.length + 1;
      } else {
        overflow.push(s.name);
      }
    }
    if (overflow.length) lines.push(`- 其余技能（可用 load_skill 按名加载）：${overflow.join(', ')}`);
    return [...header, lines.join('\n')].join('\n');
  }

  /** load_skill 工具：按名字展开完整 SKILL.md 正文。hasSandboxSync 决定使用说明里是否提及沙箱同步。 */
  tool(opts: { hasSandboxSync?: boolean } = {}): ToolHandler {
    const skills = this.skills;
    const hasSandboxSync = opts.hasSandboxSync ?? false;
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
          const avail = [...skills.values()].filter((item) => item.enabled).map((item) => item.name).join(', ') || '(无)';
          return { id: '', content: `未找到技能 ${name}。可用：${avail}`, isError: true };
        }
        if (!skill.enabled) {
          return { id: '', content: `技能已禁用：${name}`, isError: true };
        }
        const bundledFiles = skill.files
          .filter((file) => !file.isDirectory && file.path !== 'SKILL.md')
          .map((file) => file.path);
        const listed = bundledFiles.slice(0, 40).join(', ')
          + (bundledFiles.length > 40 ? ` …（共 ${bundledFiles.length} 个）` : '');
        const usage = [
          '',
          '--- 使用说明 ---',
          `- 子模块文档 / 脚本源码：用 skill__read_file(name="${name}", path="<相对路径>") 按需读取（path 为目录时返回清单）。`,
          ...(hasSandboxSync
            ? [`- 执行脚本：先调用 skill__sync_to_sandbox(name="${name}") 把技能文件同步进当前会话沙箱，然后在沙箱内以其返回的目录为根执行；不要使用服务端本地路径。`]
            : []),
          '- 环境信息（平台地址等）通过环境变量提供；账号密码等凭据只在对话中向用户索取，禁止写入任何持久文件或在汇报中回显。',
          ...(bundledFiles.length ? [`- 附带文件：${listed}`] : []),
        ].join('\n');
        return { id: '', content: skill.body + usage };
      },
    };
  }

  /** 按名取技能（含禁用的）；不存在返回 undefined。 */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * 收集待同步的文件清单（重新扫盘，保证最新）：
   * 不传 paths 收集整个技能目录；传 paths 时逐项解析（目录则递归展开）。
   */
  async collectFiles(name: string, paths?: string[]): Promise<{ dir: string; files: SkillFileEntry[] }> {
    const skill = this.requireSkill(name);
    if (!skill.enabled) throw new Error(`技能已禁用：${name}`);
    if (!paths?.length) {
      return { dir: skill.dir, files: (await listSkillFiles(skill.dir)).filter((f) => !f.isDirectory) };
    }
    const out: SkillFileEntry[] = [];
    for (const p of paths) {
      const rel = normalizeSkillPath(p);
      if (!rel) throw new Error('paths 不能包含空路径');
      const entry = await fileEntry(skill.dir, rel);
      if (entry.isDirectory) {
        out.push(...(await listSkillFiles(skill.dir, rel)).filter((f) => !f.isDirectory));
      } else {
        out.push(entry);
      }
    }
    return { dir: skill.dir, files: out };
  }

  async listDir(name: string, path = ''): Promise<SkillFileEntry[]> {
    const skill = this.requireSkill(name);
    const rel = normalizeSkillPath(path);
    const target = safeResolve(skill.dir, rel);
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error('技能路径不是目录');
    const entries = await readdir(target, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.name !== DISABLED_MARKER)
      .map((entry) => {
        const childRel = rel ? posix.join(rel, entry.name) : entry.name;
        return fileEntry(skill.dir, childRel);
      }));
    return files.sort(compareFileEntry);
  }

  async readFile(name: string, path: string): Promise<SkillFileBody> {
    const skill = this.requireSkill(name);
    const rel = normalizeSkillPath(path);
    if (!rel) throw new Error('技能文件路径不能为空');
    const entry = await fileEntry(skill.dir, rel);
    if (entry.isDirectory) throw new Error('技能路径不是文件');
    const content = await readFile(safeResolve(skill.dir, rel), 'utf8');
    return {
      path: rel,
      parentPath: parentPath(rel),
      entry,
      content,
    };
  }

  async setEnabled(name: string, enabled: boolean): Promise<Skill> {
    const skill = this.requireSkill(name);
    const marker = join(skill.dir, DISABLED_MARKER);
    if (enabled) await rm(marker, { force: true });
    else await writeFile(marker, 'disabled\n');
    skill.enabled = enabled;
    skill.files = await listSkillFiles(skill.dir);
    return skill;
  }

  async delete(name: string): Promise<void> {
    const skill = this.requireSkill(name);
    await rm(skill.dir, { recursive: true, force: true });
    this.skills.delete(name);
  }

  private requireSkill(name: string): Skill {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`未找到技能 ${name}`);
    return skill;
  }
}

async function listSkillFiles(dir: string, rel = ''): Promise<SkillFileEntry[]> {
  const entries = await readdir(safeResolve(dir, rel), { withFileTypes: true });
  const files: SkillFileEntry[] = [];
  for (const entry of entries) {
    if (entry.name === DISABLED_MARKER) continue;
    const childRel = rel ? posix.join(rel, entry.name) : entry.name;
    const child = await fileEntry(dir, childRel);
    files.push(child);
    if (entry.isDirectory()) {
      files.push(...await listSkillFiles(dir, childRel));
    }
  }
  return files.sort(compareFileEntry);
}

async function fileEntry(dir: string, rel: string): Promise<SkillFileEntry> {
  const info = await stat(safeResolve(dir, rel));
  return {
    path: rel,
    name: posix.basename(rel),
    isDirectory: info.isDirectory(),
    size: info.isDirectory() ? 0 : info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

function compareFileEntry(a: SkillFileEntry, b: SkillFileEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.path.localeCompare(b.path, 'zh-CN');
}

function normalizeSkillPath(path: string): string {
  const raw = path.replace(/\\/g, '/').trim();
  if (!raw) return '';
  if (raw.includes('\0') || raw.startsWith('/') || raw.startsWith('//') || /^[A-Za-z]:\//.test(raw)) {
    throw new Error('非法技能文件路径');
  }
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('非法技能文件路径');
  const normalized = posix.normalize(parts.join('/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('非法技能文件路径');
  }
  return normalized;
}

function safeResolve(dir: string, rel: string): string {
  const root = resolve(dir);
  const target = rel ? resolve(root, rel) : root;
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('非法技能文件路径');
  return target;
}

function parentPath(path: string): string | null {
  const parent = posix.dirname(path);
  return parent === '.' ? '' : parent;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
