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

  /** 注入系统提示的技能摘要（name + description）。 */
  summaries(): string {
    const items = this.list().filter((skill) => skill.enabled);
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
          const avail = [...skills.values()].filter((item) => item.enabled).map((item) => item.name).join(', ') || '(无)';
          return { id: '', content: `未找到技能 ${name}。可用：${avail}`, isError: true };
        }
        if (!skill.enabled) {
          return { id: '', content: `技能已禁用：${name}`, isError: true };
        }
        const bundledFiles = skill.files
          .filter((file) => !file.isDirectory && file.path !== 'SKILL.md')
          .map((file) => file.path);
        const fileNote = bundledFiles.length
          ? `\n\n附带文件（在 ${skill.dir}）：${bundledFiles.join(', ')}`
          : '';
        return { id: '', content: skill.body + fileNote };
      },
    };
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
