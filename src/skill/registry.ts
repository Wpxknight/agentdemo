import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import { defineTool, type ToolContext, type ToolHandler } from '../agent/tools.js';
import { isAdminRole } from '../auth/rbac.js';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  PUBLIC_SKILLS_DIR,
  USER_SKILLS_DIR,
  type Skill,
  type SkillFileBody,
  type SkillFileEntry,
  type SkillViewer,
  type SkillVisibility,
  TENANT_SKILLS_DIR,
  PRODUCT_RECORD_FILE,
  normalizeSkillProductRecord,
  type SkillProductRecord,
} from './product.js';
import { canManageSkill, isSkillVisibleTo } from './visibility.js';
import { enumerateSkillProductRecords } from './source.js';
import { SkillProductService, type ProductSkillLoader } from './service.js';

export {
  PUBLIC_SKILLS_DIR,
  USER_SKILLS_DIR,
  type Skill,
  type SkillFileBody,
  type SkillFileEntry,
  type SkillViewer,
  type SkillVisibility,
  type SkillProductRecord,
} from './product.js';

const log = logger.child({ mod: 'skill' });

const DISABLED_MARKER = '.disabled';
const SHARED_MARKER = '.shared';
const OWNER_MARKER = '.owner';
const MARKER_FILES = new Set([DISABLED_MARKER, SHARED_MARKER, OWNER_MARKER, '.product.json']);

export interface SkillRegistryOptions {
  /** @deprecated Pi owns prompt formatting and does not apply a product-side budget. */
  summaryBudget?: number;
  records?: readonly SkillProductRecord[];
  loader?: ProductSkillLoader;
  env?: ConstructorParameters<typeof SkillProductService>[0];
}

/**
 * 渐进式技能加载（Claude Code 风格）+ 所有权/可见性（DESIGN-aios-integration §4）：
 * - 目录分层：`_public/<name>`（管理员上传，全员可见）、`users/<uid>/<name>`（个人，private/shared）；
 * - 可见性与归属以文件系统为唯一事实源（.shared/.owner 标记，同 .disabled 模式），多副本共享技能目录即共享权限；
 * - 仅把 name+description 注入系统提示（summariesFor 按查看者过滤），模型按需 load_skill 展开；
 * - 列表与执行链路（load_skill / skill__read_file / skill__sync_to_sandbox）双处做同一套可见性检查。
 */
export class SkillRegistry {
  private records: SkillProductRecord[] = [];
  private readonly service: SkillProductService;
  private readonly configuredRecords?: readonly SkillProductRecord[];

  constructor(private readonly dir: string, opts: SkillRegistryOptions = {}) {
    this.configuredRecords = opts.records;
    this.service = new SkillProductService(
      opts.env ?? new NodeExecutionEnv({ cwd: dir }),
      opts.loader,
    );
  }

  rootDir(): string {
    return this.dir;
  }

  /** 技能导入的落盘根：管理员 → _public；普通用户 → users/<uid>。 */
  importRootFor(viewer: SkillViewer): string {
    if (!viewer.tenantId) throw new Error('导入技能需要租户身份');
    const tenantRoot = viewer.tenantId === 'default'
      ? this.dir
      : join(this.dir, TENANT_SKILLS_DIR, safePathSegment(viewer.tenantId));
    if (viewer.role && isAdminRole(viewer.role)) return join(tenantRoot, PUBLIC_SKILLS_DIR);
    if (!viewer.userId) throw new Error('导入技能需要用户身份');
    return join(tenantRoot, USER_SKILLS_DIR, safePathSegment(viewer.userId));
  }

  /** 用户上传始终落入租户内的个人目录，不能通过管理员身份获得内置/公共目录信任。 */
  uploadRootFor(viewer: SkillViewer): string {
    if (!viewer.tenantId) throw new Error('导入技能需要租户身份');
    if (!viewer.userId) throw new Error('导入技能需要用户身份');
    const tenantRoot = viewer.tenantId === 'default'
      ? this.dir
      : join(this.dir, TENANT_SKILLS_DIR, safePathSegment(viewer.tenantId));
    return join(tenantRoot, USER_SKILLS_DIR, safePathSegment(viewer.userId));
  }

  async scan(): Promise<void> {
    this.records = (this.configuredRecords
      ? this.configuredRecords.map(normalizeSkillProductRecord)
      : await enumerateSkillProductRecords(this.dir));
    log.info({ count: this.records.length }, 'skill product sources loaded');
  }

  /** 全量列表（管理/CLI 用；对外接口请用 listFor 按查看者过滤）。 */
  list(): Skill[] {
    return this.records.map((record) => skillFromRecord(record));
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

  async listLoadedFor(viewer: SkillViewer): Promise<Skill[]> {
    const loaded = await this.service.load(this.records, viewer);
    const byId = new Map(loaded.skills.map((item) => [item.source.id, item]));
    return Promise.all(this.records
      .filter((record) => byId.has(record.id))
      .map(async (record) => skillFromRecord(
        record,
        byId.get(record.id)!.skill,
        await listSkillFiles(record.path).catch(() => []),
      )));
  }

  /** 注入系统提示的技能摘要（按查看者过滤）；带总预算与单条描述截断，防止技能增多撑爆 system prompt。 */
  async summariesFor(viewer: SkillViewer): Promise<string> {
    return this.service.prompt(this.records, viewer);
  }

  /** 兼容旧调用：无查看者（public+shared）视角的摘要。 */
  summaries(): string {
    return '';
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
        const productSkill = registry.getFor(name, ctx);
        if (!productSkill || !productSkill.reviewed) {
          const avail = (await registry.listLoadedFor(ctx)).map((item) => item.name).join(', ') || '(无)';
          return { id: '', content: `未找到技能 ${name}。可用：${avail}`, isError: true };
        }
        if (!productSkill.enabled) {
          return { id: '', content: `技能已禁用：${name}`, isError: true };
        }
        const skill = await registry.loadFor(name, ctx);
        if (!skill) return { id: '', content: `未找到技能 ${name}`, isError: true };
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
    const record = this.records.find((item) => item.name === name);
    return record ? skillFromRecord(record) : undefined;
  }

  /** 按名取查看者可见的技能；不可见等同不存在。 */
  getFor(name: string, viewer?: SkillViewer): Skill | undefined {
    const record = this.records.find((item) => item.name === name && this.visibleTo(skillFromRecord(item), viewer));
    return record ? skillFromRecord(record) : undefined;
  }

  async getAvailableFor(name: string, viewer?: SkillViewer): Promise<Skill | undefined> {
    if (!viewer?.tenantId) return undefined;
    return this.loadFor(name, viewer);
  }

  async loadFor(name: string, viewer: SkillViewer): Promise<Skill | undefined> {
    const record = this.records.find((item) => item.name === name
      && this.visibleTo(skillFromRecord(item), viewer));
    if (!record) return undefined;
    const loaded = await this.service.load([record], viewer);
    const item = loaded.skills[0];
    if (!item) return undefined;
    const files = await listSkillFiles(item.source.path).catch(() => []);
    return skillFromRecord(item.source, item.skill, files);
  }

  /**
   * 收集待同步的文件清单（重新扫盘，保证最新）：
   * 不传 paths 收集整个技能目录；传 paths 时逐项解析（目录则递归展开）。
   */
  async collectFiles(name: string, paths?: string[], viewer?: SkillViewer): Promise<{ dir: string; files: SkillFileEntry[] }> {
    const skill = await this.requireAvailableSkill(name, viewer);
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

  async listDir(name: string, path = '', viewer?: SkillViewer): Promise<SkillFileEntry[]> {
    const skill = await this.requireAvailableSkill(name, viewer);
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

  async readFile(name: string, path: string, viewer?: SkillViewer): Promise<SkillFileBody> {
    const skill = await this.requireAvailableSkill(name, viewer);
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

  async setEnabled(name: string, enabled: boolean, viewer?: SkillViewer): Promise<Skill> {
    const skill = this.requireSkill(name, viewer);
    const record = this.requireRecord(name, viewer);
    record.enabled = enabled;
    await writeProductRecord(record);
    return skillFromRecord(record, undefined, await listSkillFiles(skill.dir));
  }

  /** 共享 / 取消共享（仅个人技能有意义；public 技能本就全员可见）。 */
  async setShared(name: string, shared: boolean, viewer?: SkillViewer): Promise<Skill> {
    const skill = this.requireSkill(name, viewer);
    if (skill.visibility === 'public') throw new Error('公共技能无需共享');
    const record = this.requireRecord(name, viewer);
    record.visibility = shared ? 'shared' : 'private';
    await writeProductRecord(record);
    return skillFromRecord(record);
  }

  /** 用认证上下文覆盖上传包中的治理字段；归档只允许贡献经过校验的 name/version。 */
  async installUploadedProduct(skillDir: string, viewer: SkillViewer): Promise<SkillProductRecord> {
    if (!viewer.tenantId || !viewer.userId) throw new Error('导入技能需要完整用户身份');
    const archived = await readUploadedDescription(skillDir);
    const metadata = {
      name: archived.name ?? safePathSegment(posix.basename(skillDir)),
      version: archived.version ?? 'uploaded',
      enabled: true,
      reviewed: false,
      tenantId: viewer.tenantId,
      ownerUserId: viewer.userId,
      visibility: 'private' as const,
    };
    const record = normalizeSkillProductRecord({
      id: `${metadata.tenantId}:${metadata.ownerUserId}:${metadata.name}`,
      path: skillDir,
      ...metadata,
    });
    await writeProductRecord(record);
    return record;
  }

  async review(name: string, viewer: SkillViewer, options: { global?: boolean } = {}): Promise<SkillProductRecord> {
    if (viewer.role !== 'tenant_admin' && viewer.role !== 'platform_admin') {
      throw new Error('仅租户或平台管理员可审核技能');
    }
    if (options.global && viewer.role !== 'platform_admin') {
      throw new Error('仅平台管理员可全局发布技能');
    }
    const tenantRecords = this.records.filter((item) => item.name === name && item.tenantId === viewer.tenantId);
    const pending = tenantRecords.filter((item) => !item.reviewed && this.isUploadedRecord(item));
    if (pending.length > 1) throw new Error(`同名待审核技能 ${name} 不唯一`);
    if (!pending.length) {
      if (tenantRecords.some((item) => item.reviewed && this.isUploadedRecord(item))) {
        throw new Error(`技能 ${name} 已审核`);
      }
      throw new Error(`未找到技能 ${name}`);
    }
    const record = pending[0]!;
    if (record.ownerUserId === viewer.userId) throw new Error('审核者不能审核自己上传的技能');
    const validationRecord = normalizeSkillProductRecord({ ...record, reviewed: true });
    const validation = await this.service.load([validationRecord], {
      tenantId: record.tenantId,
      userId: record.ownerUserId,
      role: 'user',
    });
    if (validation.skills.length !== 1 || resolve(validation.skills[0]!.source.path) !== resolve(record.path)) {
      throw new Error(`SKILL.md name 与产品 name 不一致或技能元数据无效：${name}`);
    }
    const next = normalizeSkillProductRecord({
      ...record,
      reviewed: true,
      visibility: options.global ? 'public' : 'private',
      allowedTenantIds: options.global ? ['*'] : undefined,
    });
    await writeProductRecord(next);
    await this.scan();
    const persisted = this.records.find((item) => resolve(item.path) === resolve(record.path));
    if (!persisted) throw new Error(`审核后未找到技能 ${name}`);
    return persisted;
  }

  private isUploadedRecord(record: SkillProductRecord): boolean {
    if (!record.ownerUserId) return false;
    const uploadRoot = this.uploadRootFor({
      tenantId: record.tenantId,
      userId: record.ownerUserId,
    });
    return dirname(resolve(record.path)) === resolve(uploadRoot);
  }

  async delete(name: string, viewer?: SkillViewer): Promise<void> {
    const skill = this.requireSkill(name, viewer);
    await rm(skill.dir, { recursive: true, force: true });
    this.records = this.records.filter((record) => record !== skill.product);
  }

  private requireSkill(name: string, viewer?: SkillViewer): Skill {
    return skillFromRecord(this.requireRecord(name, viewer));
  }

  private async requireAvailableSkill(name: string, viewer?: SkillViewer): Promise<Skill> {
    const skill = viewer?.tenantId ? await this.loadFor(name, viewer) : undefined;
    if (!skill) throw new Error(`未找到技能 ${name}`);
    return skill;
  }

  private requireRecord(name: string, viewer?: SkillViewer): SkillProductRecord {
    const record = this.records.find((item) => item.name === name
      && (!viewer || this.visibleTo(skillFromRecord(item), viewer)));
    if (!record) throw new Error(`未找到技能 ${name}`);
    return record;
  }
}

async function writeProductRecord(record: SkillProductRecord): Promise<void> {
  const { id: _id, path: _path, description: _description, ...metadata } = record;
  const target = join(record.path, PRODUCT_RECORD_FILE);
  const temp = join(record.path, `.${PRODUCT_RECORD_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readUploadedDescription(skillDir: string): Promise<{ name?: string; version?: string }> {
  try {
    const parsed = JSON.parse(await readFile(join(skillDir, PRODUCT_RECORD_FILE), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const metadata = parsed as Record<string, unknown>;
    return {
      name: uploadedString(metadata.name, 'name'),
      version: uploadedString(metadata.version, 'version'),
    };
  } catch {
    return {};
  }
}

function uploadedString(value: unknown, key: 'name' | 'version'): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.includes('\0') || normalized.length > 200) return undefined;
  if (key === 'name' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) return undefined;
  return normalized;
}

function skillFromRecord(
  record: SkillProductRecord,
  piSkill?: { name: string; description: string; content: string },
  files: SkillFileEntry[] = [],
): Skill {
  return {
    name: piSkill?.name ?? record.name,
    description: piSkill?.description ?? record.description ?? '',
    dir: record.path,
    enabled: record.enabled,
    reviewed: record.reviewed,
    tenantId: record.tenantId,
    allowedTenantIds: record.allowedTenantIds,
    allowedRoles: record.allowedRoles,
    owner: record.ownerUserId ?? '',
    visibility: record.visibility,
    credentials: [...(record.credentials ?? [])],
    credentialFile: record.credentialFile,
    body: piSkill?.content.trim() ?? '',
    files,
    product: record,
  };
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
