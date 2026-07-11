import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';
import { isAdminRole } from '../auth/rbac.js';
import type { Role } from '../auth/types.js';

const log = logger.child({ mod: 'skill' });

/** 技能可见性：public 全员（管理员上传）；private 仅所有者；shared 所有者共享给租户内全员。 */
export type SkillVisibility = 'public' | 'private' | 'shared';

/** 可见性/归属判断所需的最小身份（ToolContext / RequestContext 均满足）。 */
export interface SkillViewer {
  userId?: string;
  role?: Role;
}

export interface Skill {
  name: string;
  description: string;
  dir: string;
  enabled: boolean;
  /** 所有者用户 id；'' 表示无主（迁移前的存量公共技能，由管理员代管）。 */
  owner: string;
  visibility: SkillVisibility;
  /** frontmatter `credentials:` 声明的下游凭据需求（如 aios），同步进沙箱时按当前用户注入。 */
  credentials: string[];
  /** frontmatter `credential_file:` 凭据文件在技能内的相对路径（默认 token.json）。 */
  credentialFile?: string;
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
const SHARED_MARKER = '.shared';
const OWNER_MARKER = '.owner';
const MARKER_FILES = new Set([DISABLED_MARKER, SHARED_MARKER, OWNER_MARKER]);

/** 公共技能目录（管理员上传） / 个人技能目录根。 */
export const PUBLIC_SKILLS_DIR = '_public';
export const USER_SKILLS_DIR = 'users';

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

/** frontmatter credentials 值解析："aios" / "[aios, foo]" → ['aios','foo']。 */
function parseCredentials(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 渐进式技能加载（Claude Code 风格）+ 所有权/可见性（DESIGN-aios-integration §4）：
 * - 目录分层：`_public/<name>`（管理员上传，全员可见）、`users/<uid>/<name>`（个人，private/shared）；
 * - 可见性与归属以文件系统为唯一事实源（.shared/.owner 标记，同 .disabled 模式），多副本共享技能目录即共享权限；
 * - 仅把 name+description 注入系统提示（summariesFor 按查看者过滤），模型按需 load_skill 展开；
 * - 列表与执行链路（load_skill / skill__read_file / skill__sync_to_sandbox）双处做同一套可见性检查。
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

  /** 技能导入的落盘根：管理员 → _public；普通用户 → users/<uid>。 */
  importRootFor(viewer: SkillViewer): string {
    if (viewer.role && isAdminRole(viewer.role)) return join(this.dir, PUBLIC_SKILLS_DIR);
    if (!viewer.userId) throw new Error('导入技能需要用户身份');
    return join(this.dir, USER_SKILLS_DIR, safePathSegment(viewer.userId));
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

    // 存量技能（旧布局：技能目录直接位于根下）原地视为 public，不搬家——
    // 技能目录可能是只读挂载/多副本共享盘，移动有风险且无必要。
    for (const entry of entries.sort()) {
      if (entry === PUBLIC_SKILLS_DIR || entry === USER_SKILLS_DIR) continue;
      await this.scanSkillDir(join(this.dir, entry), entry, '', 'public');
    }

    await this.scanRoot(join(this.dir, PUBLIC_SKILLS_DIR), '', 'public');
    const usersRoot = join(this.dir, USER_SKILLS_DIR);
    let userDirs: string[] = [];
    try {
      userDirs = await readdir(usersRoot);
    } catch {
      // 无个人技能
    }
    for (const uid of userDirs.sort()) {
      try {
        if ((await stat(join(usersRoot, uid))).isDirectory()) {
          await this.scanRoot(join(usersRoot, uid), uid, 'user');
        }
      } catch {
        // 跳过异常目录
      }
    }
    log.info({ count: this.skills.size }, 'skills 扫描完成');
  }

  private async scanRoot(root: string, dirOwner: string, kind: 'public' | 'user'): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      await this.scanSkillDir(join(root, entry), entry, dirOwner, kind);
    }
  }

  private async scanSkillDir(skillDir: string, entry: string, dirOwner: string, kind: 'public' | 'user'): Promise<void> {
    try {
      if (!(await stat(skillDir)).isDirectory()) return;
      const raw = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
      const { attrs, body } = parseFrontmatter(raw);
      const baseName = attrs.name || entry;
      const files = await listSkillFiles(skillDir);
      const enabled = !(await exists(join(skillDir, DISABLED_MARKER)));
      const owner = kind === 'public'
        ? (await readFile(join(skillDir, OWNER_MARKER), 'utf8').catch(() => '')).trim()
        : dirOwner;
      const visibility: SkillVisibility = kind === 'public'
        ? 'public'
        : (await exists(join(skillDir, SHARED_MARKER))) ? 'shared' : 'private';
      // 同名消歧：public 命名空间优先占用裸名；个人技能与之冲突时挂 @owner 后缀。
      const name = this.skills.has(baseName) ? `${baseName}@${owner || 'public'}` : baseName;
      if (this.skills.has(name)) {
        log.warn({ name, dir: skillDir }, '技能名冲突（含消歧后缀仍冲突），跳过');
        return;
      }
      this.skills.set(name, {
        name,
        description: attrs.description ?? '',
        dir: skillDir,
        enabled,
        owner,
        visibility,
        credentials: parseCredentials(attrs.credentials),
        credentialFile: attrs.credential_file || undefined,
        body: body.trim(),
        files,
      });
    } catch (err) {
      log.warn({ entry, err: String(err) }, '跳过无效技能目录');
    }
  }

  /** 全量列表（管理/CLI 用；对外接口请用 listFor 按查看者过滤）。 */
  list(): Skill[] {
    return [...this.skills.values()];
  }

  /** 技能对查看者是否可见：public/shared 全员；private 仅所有者。身份缺失时按"非所有者"处理。 */
  visibleTo(skill: Skill, viewer?: SkillViewer): boolean {
    if (skill.visibility === 'public' || skill.visibility === 'shared') return true;
    return Boolean(viewer?.userId) && skill.owner === viewer?.userId;
  }

  /** 查看者是否可管理（启停/删除/共享/改文件）：仅所有者；无主存量技能由管理员代管。 */
  canManage(skill: Skill, viewer?: SkillViewer): boolean {
    if (skill.owner) return Boolean(viewer?.userId) && skill.owner === viewer?.userId;
    return viewer?.role ? isAdminRole(viewer.role) : false;
  }

  /** 按查看者过滤的技能列表：public ∪ 自己的 ∪ shared。 */
  listFor(viewer?: SkillViewer): Skill[] {
    return this.list().filter((s) => this.visibleTo(s, viewer));
  }

  /** 注入系统提示的技能摘要（按查看者过滤）；带总预算与单条描述截断，防止技能增多撑爆 system prompt。 */
  summariesFor(viewer?: SkillViewer): string {
    const items = this.listFor(viewer).filter((skill) => skill.enabled);
    if (!items.length) return '';
    const header = [
      '可用技能（用 load_skill 加载完整指令）：',
      '用户请求与某个技能描述匹配时，请先调用 load_skill 加载该技能，再按技能指令执行。',
      '即使用户没有点名技能或 API，且浏览器、shell 等通用工具也能完成同类任务，只要主题命中某个技能描述，就必须优先加载并使用该技能。',
      '每次加载技能后，先用一句话明确告知用户已加载的技能名称（如“已加载技能：aios-request”），再按技能指令继续。',
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

  /** 兼容旧调用：无查看者（public+shared）视角的摘要。 */
  summaries(): string {
    return this.summariesFor(undefined);
  }

  /** load_skill 工具：按名字展开完整 SKILL.md 正文。hasSandboxSync 决定使用说明里是否提及沙箱同步。 */
  tool(opts: { hasSandboxSync?: boolean } = {}): ToolHandler {
    const registry = this;
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
      async run(args: JsonValue, ctx: ToolContext): Promise<ToolResult> {
        const name =
          args && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, JsonValue>).name
            : undefined;
        if (typeof name !== 'string' || !name) {
          return { id: '', content: '参数 name 必须是非空字符串', isError: true };
        }
        // 可见性在执行链路同样强制（不信 LLM）：越权技能等同不存在，不泄露存在性。
        const skill = registry.getFor(name, ctx);
        if (!skill) {
          const avail = registry.listFor(ctx).filter((item) => item.enabled).map((item) => item.name).join(', ') || '(无)';
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
          '- 环境信息（平台地址等）通过环境变量提供；账号密码等凭据禁止在对话中索取或回显，平台凭据由系统按当前用户注入。',
          ...(bundledFiles.length ? [`- 附带文件：${listed}`] : []),
        ].join('\n');
        return { id: '', content: skill.body + usage };
      },
    };
  }

  /** 按名取技能（含禁用的；不做可见性过滤，管理路径用）；不存在返回 undefined。 */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** 按名取查看者可见的技能；不可见等同不存在。 */
  getFor(name: string, viewer?: SkillViewer): Skill | undefined {
    const skill = this.skills.get(name);
    return skill && this.visibleTo(skill, viewer) ? skill : undefined;
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
      .filter((entry) => !MARKER_FILES.has(entry.name))
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

  /** 共享 / 取消共享（仅个人技能有意义；public 技能本就全员可见）。 */
  async setShared(name: string, shared: boolean): Promise<Skill> {
    const skill = this.requireSkill(name);
    if (skill.visibility === 'public') throw new Error('公共技能无需共享');
    const marker = join(skill.dir, SHARED_MARKER);
    if (shared) await writeFile(marker, 'shared\n');
    else await rm(marker, { force: true });
    skill.visibility = shared ? 'shared' : 'private';
    return skill;
  }

  /** 记录所有者（导入后调用；public 技能落 .owner 标记，个人技能由目录决定）。 */
  async setOwner(skillDir: string, owner: string): Promise<void> {
    if (!owner) return;
    await writeFile(join(skillDir, OWNER_MARKER), `${owner}\n`);
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
    if (MARKER_FILES.has(entry.name)) continue;
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

/** 用户 id 作为目录段：只保留安全字符（防路径注入）。 */
function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error('非法用户目录名');
  return safe;
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
