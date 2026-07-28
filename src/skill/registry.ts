import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import { defineTool, type ToolContext, type ToolHandler } from '../agent/tools.js';
import { isAdminRole } from '../auth/rbac.js';
import { formatSkillsForSystemPrompt, loadSourcedSkills } from '@aiop/pi-runtime';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  PUBLIC_SKILLS_DIR,
  USER_SKILLS_DIR,
  type Skill,
  type SkillFileBody,
  type SkillFileEntry,
  type SkillViewer,
  type SkillVisibility,
  readSkillProductMetadata,
} from './product.js';
import { canManageSkill, isSkillVisibleTo } from './visibility.js';

export {
  PUBLIC_SKILLS_DIR,
  USER_SKILLS_DIR,
  type Skill,
  type SkillFileBody,
  type SkillFileEntry,
  type SkillViewer,
  type SkillVisibility,
} from './product.js';

const log = logger.child({ mod: 'skill' });

const DISABLED_MARKER = '.disabled';
const SHARED_MARKER = '.shared';
const OWNER_MARKER = '.owner';
const MARKER_FILES = new Set([DISABLED_MARKER, SHARED_MARKER, OWNER_MARKER]);

export interface SkillRegistryOptions {
  /** @deprecated Pi owns prompt formatting and does not apply a product-side budget. */
  summaryBudget?: number;
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

  constructor(private readonly dir: string, _opts: SkillRegistryOptions = {}) {}

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
    const env = new NodeExecutionEnv({ cwd: this.dir });
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      log.warn({ dir: this.dir }, 'skills 目录不存在，跳过');
      await env.cleanup();
      return;
    }
    try {
      // 存量技能（旧布局：技能目录直接位于根下）原地视为 public，不搬家。
      for (const entry of entries.sort()) {
        if (entry === PUBLIC_SKILLS_DIR || entry === USER_SKILLS_DIR) continue;
        await this.scanSkillDir(env, join(this.dir, entry), entry, '', 'public');
      }
      await this.scanRoot(env, join(this.dir, PUBLIC_SKILLS_DIR), '', 'public');
      const usersRoot = join(this.dir, USER_SKILLS_DIR);
      let userDirs: string[] = [];
      try { userDirs = await readdir(usersRoot); } catch { /* 无个人技能 */ }
      for (const uid of userDirs.sort()) {
        try {
          if ((await stat(join(usersRoot, uid))).isDirectory()) {
            await this.scanRoot(env, join(usersRoot, uid), uid, 'user');
          }
        } catch {
          // 跳过异常目录
        }
      }
    } finally {
      await env.cleanup();
    }
    log.info({ count: this.skills.size }, 'skills 扫描完成');
  }

  private async scanRoot(env: NodeExecutionEnv, root: string, dirOwner: string, kind: 'public' | 'user'): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      await this.scanSkillDir(env, join(root, entry), entry, dirOwner, kind);
    }
  }

  private async scanSkillDir(env: NodeExecutionEnv, skillDir: string, entry: string, dirOwner: string, kind: 'public' | 'user'): Promise<void> {
    try {
      if (!(await stat(skillDir)).isDirectory()) return;
      const loaded = await loadSourcedSkills(env, [{ path: skillDir, source: { kind: 'aiop-product' } }]);
      const piSkill = loaded.skills.find(({ skill }) => resolve(skill.filePath) === resolve(join(skillDir, 'SKILL.md')))?.skill;
      if (!piSkill) throw new Error(loaded.diagnostics[0]?.message ?? '技能包缺少有效 SKILL.md');
      const metadata = await readSkillProductMetadata(skillDir);
      const baseName = piSkill.name || entry;
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
        description: piSkill.description,
        dir: skillDir,
        enabled,
        owner,
        visibility,
        credentials: metadata.credentials,
        credentialFile: metadata.credentialFile,
        body: piSkill.content.trim(),
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
    return isSkillVisibleTo(skill, viewer);
  }

  /** 查看者是否可管理（启停/删除/共享/改文件）：仅所有者；无主存量技能由管理员代管。 */
  canManage(skill: Skill, viewer?: SkillViewer): boolean {
    return canManageSkill(skill, viewer);
  }

  /** 按查看者过滤的技能列表：public ∪ 自己的 ∪ shared。 */
  listFor(viewer?: SkillViewer): Skill[] {
    return this.list().filter((s) => this.visibleTo(s, viewer));
  }

  /** 注入系统提示的技能摘要（按查看者过滤）；带总预算与单条描述截断，防止技能增多撑爆 system prompt。 */
  summariesFor(viewer?: SkillViewer): string {
    const items = this.listFor(viewer).filter((skill) => skill.enabled);
    if (!items.length) return '';
    return formatSkillsForSystemPrompt(items.map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.body,
      filePath: join(skill.dir, 'SKILL.md'),
    })));
  }

  /** 兼容旧调用：无查看者（public+shared）视角的摘要。 */
  summaries(): string {
    return this.summariesFor(undefined);
  }

  /** load_skill 工具：按名字展开完整 SKILL.md 正文。hasSandboxSync 决定使用说明里是否提及沙箱同步。 */
  tool(opts: { hasSandboxSync?: boolean } = {}): ToolHandler {
    const registry = this;
    const hasSandboxSync = opts.hasSandboxSync ?? false;
    return defineTool({
        name: 'load_skill',
        capability: 'read',
        description: '按名字加载某个技能的完整指令（渐进式披露）。',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: '技能名' } },
          required: ['name'],
        },
      async execute(args: JsonValue, ctx: ToolContext): Promise<ToolResult> {
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
    });
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
