import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import { defineTool, type ToolContext, type ToolHandler } from '../agent/tools.js';
import { isAdminRole } from '../auth/rbac.js';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  PUBLIC_SKILLS_DIR,
  SKILL_IMPORTS_DIR,
  SKILL_LOCKS_DIR,
  SKILL_PUBLISHED_DIR,
  SKILL_TOMBSTONES_DIR,
  USER_SKILLS_DIR,
  type Skill,
  type SkillFileBody,
  type SkillFileEntry,
  type SkillViewer,
  type SkillVisibility,
  TENANT_SKILLS_DIR,
  PRODUCT_RECORD_FILE,
  PUBLISHED_COMMIT_FILE,
  normalizeSkillProductRecord,
  type SkillProductRecord,
} from './product.js';
import { canManageSkill, isSkillVisibleTo } from './visibility.js';
import { enumerateSkillProductRecords } from './source.js';
import { SkillProductService, type ProductSkillLoader } from './service.js';
import type { SkillMutationLock } from './lock.js';

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
const MARKER_FILES = new Set([
  DISABLED_MARKER, SHARED_MARKER, OWNER_MARKER, PRODUCT_RECORD_FILE, PUBLISHED_COMMIT_FILE,
]);
const NAME_LOCK_LEASE_MS = 300_000;
const NAME_LOCK_TIMEOUT_MS = 10_000;
const NAME_LOCK_RETRY_MS = 10;
const NAME_LOCK_OWNER_FILE = 'owner.json';
const PRODUCT_SCHEMA_VERSION = 2;

export interface SkillRegistryOptions {
  /** @deprecated Pi owns prompt formatting and does not apply a product-side budget. */
  summaryBudget?: number;
  records?: readonly SkillProductRecord[];
  loader?: ProductSkillLoader;
  env?: ConstructorParameters<typeof SkillProductService>[0];
  nameLockTimeoutMs?: number;
  /** Read-only image roots; mutations and uploads always use `dir`. */
  builtinRoots?: readonly string[];
  mutationLock?: SkillMutationLock;
}

interface UploadedProductInstallOptions {
  destinationDir?: string;
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
  private readonly nameLockTimeoutMs: number;
  private readonly builtinRoots: readonly string[];
  private readonly mutationLock?: SkillMutationLock;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string, opts: SkillRegistryOptions = {}) {
    this.configuredRecords = opts.records;
    this.nameLockTimeoutMs = opts.nameLockTimeoutMs ?? NAME_LOCK_TIMEOUT_MS;
    this.builtinRoots = opts.builtinRoots ?? [];
    this.mutationLock = opts.mutationLock;
    this.service = new SkillProductService(
      opts.env ?? new NodeExecutionEnv({ cwd: dir }),
      opts.loader,
    );
  }

  rootDir(): string {
    return this.dir;
  }

  importStagingRoot(): string {
    return join(resolve(this.dir), SKILL_IMPORTS_DIR);
  }

  async acquireImportPermit(
    tenantId: string,
    globalLimit: number,
    tenantLimit: number,
  ): Promise<{ supported: boolean; release?: () => Promise<void> }> {
    if (this.mutationLock?.tryAcquireSlots) {
      const release = await this.mutationLock.tryAcquireSlots([
        { keyPrefix: 'skill-import:global', limit: globalLimit },
        { keyPrefix: `skill-import:tenant:${tenantId}`, limit: tenantLimit },
      ]);
      return { supported: true, release };
    }
    if (!this.mutationLock?.tryAcquireSlot) return { supported: false };
    const globalRelease = await this.mutationLock.tryAcquireSlot('skill-import:global', globalLimit);
    if (!globalRelease) return { supported: true };
    let tenantRelease: (() => Promise<void>) | undefined;
    try {
      tenantRelease = await this.mutationLock.tryAcquireSlot(`skill-import:tenant:${tenantId}`, tenantLimit);
    } catch (error) {
      await globalRelease();
      throw error;
    }
    if (!tenantRelease) {
      await globalRelease();
      return { supported: true };
    }
    let released = false;
    return {
      supported: true,
      release: async () => {
        if (released) return;
        released = true;
        await Promise.all([tenantRelease(), globalRelease()]);
      },
    };
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
    await this.withMutationLock(() => this.scanUnlocked());
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
    await this.refreshForRead();
    const records = this.unambiguousAvailableRecords(viewer);
    const verified = await this.verifiedRecords(records);
    const loaded = await this.service.load(verified, viewer);
    const byId = new Map(loaded.skills.map((item) => [item.source.id, item]));
    return Promise.all(verified
      .filter((record) => byId.has(record.id))
      .map(async (record) => skillFromRecord(
        record,
        byId.get(record.id)!.skill,
        await listSkillFiles(record.path).catch(() => []),
      )));
  }

  /** 注入系统提示的技能摘要（按查看者过滤）；带总预算与单条描述截断，防止技能增多撑爆 system prompt。 */
  async summariesFor(viewer: SkillViewer): Promise<string> {
    await this.refreshForRead();
    return this.service.prompt(await this.verifiedRecords(this.unambiguousAvailableRecords(viewer)), viewer);
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
        const skill = await registry.loadFor(name, ctx);
        if (!skill) {
          const reviewed = await registry.getReviewedForFresh(name, ctx);
          if (reviewed && !reviewed.enabled) {
            return { id: '', content: `技能已禁用：${name}`, isError: true };
          }
          const avail = (await registry.listLoadedFor(ctx)).map((item) => item.name).join(', ') || '(无)';
          return { id: '', content: `未找到技能 ${name}。可用：${avail}`, isError: true };
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
    const record = this.records.find((item) => item.name === name);
    return record ? skillFromRecord(record) : undefined;
  }

  /** 按名取查看者可见的技能；不可见等同不存在。 */
  getFor(name: string, viewer?: SkillViewer): Skill | undefined {
    const record = this.records.find((item) => item.name === name && this.visibleTo(skillFromRecord(item), viewer));
    return record ? skillFromRecord(record) : undefined;
  }

  async getForFresh(name: string, viewer?: SkillViewer): Promise<Skill | undefined> {
    await this.refreshForRead();
    return this.getFor(name, viewer);
  }

  async getReviewedForFresh(name: string, viewer: SkillViewer): Promise<Skill | undefined> {
    await this.refreshForRead();
    const matches = this.records.filter((record) => (
      record.name === name && record.reviewed && this.visibleTo(skillFromRecord(record), viewer)
    ));
    return matches.length === 1 ? skillFromRecord(matches[0]!) : undefined;
  }

  async getManageableForFresh(
    name: string,
    viewer: SkillViewer,
    preferReviewed = false,
  ): Promise<Skill | undefined> {
    await this.refreshForRead();
    try {
      return skillFromRecord(this.requireManageableRecord(name, viewer, preferReviewed));
    } catch {
      return undefined;
    }
  }

  async hasVisibleForFresh(name: string, viewer: SkillViewer): Promise<boolean> {
    await this.refreshForRead();
    return this.records.some((record) => record.name === name && this.visibleTo(skillFromRecord(record), viewer));
  }

  async getAvailableFor(name: string, viewer?: SkillViewer): Promise<Skill | undefined> {
    if (!viewer?.tenantId) return undefined;
    return this.loadFor(name, viewer);
  }

  async loadFor(name: string, viewer: SkillViewer): Promise<Skill | undefined> {
    await this.refreshForRead();
    const matches = (await this.verifiedRecords(this.unambiguousAvailableRecords(viewer)))
      .filter((item) => item.name === name);
    if (matches.length !== 1) return undefined;
    const record = matches[0]!;
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
    return this.mutateRecord(name, viewer, async (record) => ({ ...record, enabled }), true);
  }

  /** 共享 / 取消共享（仅个人技能有意义；public 技能本就全员可见）。 */
  async setShared(name: string, shared: boolean, viewer?: SkillViewer): Promise<Skill> {
    return this.mutateRecord(name, viewer, async (record) => {
      if (record.visibility === 'public') throw new Error('公共技能无需共享');
      return { ...record, visibility: shared ? 'shared' : 'private' };
    });
  }

  /** 用认证上下文覆盖上传包中的治理字段；归档只允许贡献经过校验的 name/version。 */
  async installUploadedProduct(
    skillDir: string,
    viewer: SkillViewer,
    options: UploadedProductInstallOptions = {},
  ): Promise<SkillProductRecord> {
    return this.withMutationLock(async () => {
      if (!viewer.tenantId || !viewer.userId) throw new Error('导入技能需要完整用户身份');
      const archived = await readUploadedDescription(skillDir);
      const sourceDir = resolve(skillDir);
      const destinationDir = resolve(options.destinationDir ?? skillDir);
      const uploadRoot = resolve(this.uploadRootFor(viewer));
      if (dirname(destinationDir) !== uploadRoot) throw new Error('导入技能目标路径非法');
      const metadata = {
        name: archived.name ?? safePathSegment(posix.basename(skillDir)),
        version: archived.version ?? 'uploaded',
        enabled: true,
        reviewed: false,
        tenantId: viewer.tenantId,
        ownerUserId: viewer.userId,
        visibility: 'private' as const,
        schemaVersion: PRODUCT_SCHEMA_VERSION,
        revision: 0,
      };
      return this.withDistributedNameLock(metadata.name, async () => {
        const record = normalizeSkillProductRecord({
          id: `${metadata.tenantId}:${metadata.ownerUserId}:${metadata.name}`,
          path: destinationDir,
          ...metadata,
        });
        // Refresh under both the process-local and filesystem-backed name locks.
        // The uploaded sidecar remains untrusted until the server replaces it below.
        await this.scanUnlocked([destinationDir]);
        this.assertNoPendingNameConflict(record);
        if (sourceDir !== destinationDir) await assertPathAbsent(destinationDir);
        await writeProductRecord({ ...record, path: sourceDir });
        let moved = false;
        try {
          if (sourceDir !== destinationDir) {
            await mkdir(dirname(destinationDir), { recursive: true });
            await rename(sourceDir, destinationDir);
            moved = true;
          }
          await this.scanUnlocked();
          return this.records.find((item) => resolve(item.path) === destinationDir) ?? record;
        } catch (error) {
          if (moved) await rename(destinationDir, sourceDir).catch(() => undefined);
          await this.scanUnlocked([destinationDir]);
          throw error;
        }
      });
    });
  }

  async review(name: string, viewer: SkillViewer, options: { global?: boolean } = {}): Promise<SkillProductRecord> {
    return this.withMutationLock(async () => {
      if (viewer.role !== 'tenant_admin' && viewer.role !== 'platform_admin') {
        throw new Error('仅租户或平台管理员可审核技能');
      }
      if (options.global && viewer.role !== 'platform_admin') {
        throw new Error('仅平台管理员可全局发布技能');
      }
      return this.withDistributedNameLock(name, async () => {
        await this.scanUnlocked();
        const tenantRecords = this.records.filter((item) => item.name === name && item.tenantId === viewer.tenantId);
        const pending = tenantRecords.filter((item) => !item.reviewed && this.isUploadedRecord(item));
        if (pending.length > 1) throw new Error(`同名待审核技能 ${name} 不唯一`);
        if (!pending.length) {
          if (tenantRecords.some((item) => item.reviewed
            && (this.isUploadedRecord(item) || Boolean(item.submittedByUserId)))) {
            throw new Error(`技能 ${name} 已审核`);
          }
          throw new Error(`未找到技能 ${name}`);
        }
        const record = pending[0]!;
        if (record.ownerUserId === viewer.userId) throw new Error('审核者不能审核自己上传的技能');
        this.assertNoNameConflict(record, options.global === true, true);
        const validationRecord = normalizeSkillProductRecord({ ...record, reviewed: true });
        const validation = await this.service.load([validationRecord], {
          tenantId: record.tenantId,
          userId: record.ownerUserId,
          role: 'user',
        });
        if (validation.diagnostics.length) {
          throw new Error(`Pi Skill 校验产生诊断，技能保持待审核：${name}`);
        }
        if (validation.skills.length !== 1 || resolve(validation.skills[0]!.source.path) !== resolve(record.path)) {
          throw new Error(`SKILL.md name 与产品 name 不一致或技能元数据无效：${name}`);
        }
        const scope = options.global ? 'global' : `tenant-${safePathSegment(record.tenantId)}`;
        const publishedRoot = join(resolve(this.dir), SKILL_PUBLISHED_DIR);
        const stagingPath = join(publishedRoot, `.staging-${randomUUID()}`);
        await mkdir(publishedRoot, { recursive: true, mode: 0o750 });
        let publishedPath = stagingPath;
        let publishedRecord: SkillProductRecord | undefined;
        try {
          await cp(record.path, stagingPath, { recursive: true, errorOnExist: true, force: false });
          await rm(join(stagingPath, PRODUCT_RECORD_FILE), { force: true });
          // Hash the copied bytes, not the mutable upload source, so the recorded digest
          // always describes the exact artifact that will be exposed to Pi.
          const digest = await contentDigest(stagingPath);
          const artifactVersion = `${safePathSegment(record.version)}-${digest.slice(0, 16)}`;
          const publishedParent = join(publishedRoot, scope, artifactVersion);
          publishedPath = join(publishedParent, safePathSegment(record.name));
          await mkdir(publishedParent, { recursive: true, mode: 0o750 });
          await assertPathAbsent(publishedPath);
          const next = normalizeSkillProductRecord({
            ...record,
            id: `published:${scope}:${record.name}`,
            path: stagingPath,
            ownerUserId: undefined,
            submittedByUserId: record.ownerUserId,
            reviewed: true,
            visibility: options.global ? 'public' : 'private',
            allowedTenantIds: options.global ? ['*'] : undefined,
            schemaVersion: PRODUCT_SCHEMA_VERSION,
            revision: 1,
            contentDigest: digest,
            artifactVersion,
          });
          publishedRecord = normalizeSkillProductRecord({ ...next, path: publishedPath });
          await writeProductRecord(next);
          await rename(stagingPath, publishedPath);
          await fsyncParent(publishedPath);
        } catch (error) {
          const rollbackError = await rollbackPublishedArtifact(stagingPath, publishedPath);
          if (rollbackError) {
            throw new Error(`技能发布失败且 artifact 回滚失败：${String(error)}; rollback: ${rollbackError}`);
          }
          throw error;
        }
        let uploadTombstone: string | undefined;
        try {
          uploadTombstone = await renameToTombstone(record.path, this.dir);
        } catch (error) {
          const rollbackError = await rollbackPublishedArtifact(stagingPath, publishedPath);
          if (rollbackError) {
            throw new Error(`技能上传目录归档失败且 artifact 回滚失败：${String(error)}; rollback: ${rollbackError}`);
          }
          throw error;
        }
        try {
          await commitPublishedArtifact(publishedPath);
        } catch (error) {
          const rollbackErrors: string[] = [];
          const artifactRollback = await rollbackPublishedArtifact(stagingPath, publishedPath);
          if (artifactRollback) rollbackErrors.push(`artifact: ${artifactRollback}`);
          if (uploadTombstone) {
            try {
              await mkdir(dirname(record.path), { recursive: true });
              await rename(uploadTombstone, record.path);
              await fsyncParent(uploadTombstone);
              await fsyncParent(record.path);
            } catch (restoreError) {
              rollbackErrors.push(`upload: ${String(restoreError)}`);
            }
          }
          if (rollbackErrors.length) {
            throw new Error(`技能发布提交失败且回滚不完整：${String(error)}; ${rollbackErrors.join('; ')}`);
          }
          throw error;
        }
        try {
          await this.scanUnlocked();
          const persisted = this.records.find((item) => resolve(item.path) === resolve(publishedPath));
          if (persisted) return persisted;
          log.warn({ skill: name, path: publishedPath }, 'published skill committed but refresh retained an older snapshot');
        } catch (error) {
          log.warn({ skill: name, path: publishedPath, err: String(error) }, 'published skill committed but refresh failed');
        }
        if (!publishedRecord) throw new Error(`审核后未找到技能 ${name}`);
        return publishedRecord;
      });
    });
  }

  private isUploadedRecord(record: SkillProductRecord): boolean {
    if (!record.ownerUserId) return false;
    const uploadRoot = this.uploadRootFor({
      tenantId: record.tenantId,
      userId: record.ownerUserId,
    });
    return dirname(resolve(record.path)) === resolve(uploadRoot);
  }

  private assertNoNameConflict(record: SkillProductRecord, global: boolean, publishedOnly = false): void {
    const conflict = this.records.find((item) => (
      item.name === record.name
      && resolve(item.path) !== resolve(record.path)
      && (!publishedOnly || item.reviewed)
      && (global || recordVisibleInTenant(item, record.tenantId))
    ));
    if (!conflict) return;
    if (global) throw new Error(`Skill 全局名称冲突：${record.name}`);
    throw new Error(`Skill 名称冲突：${record.name}`);
  }

  private assertNoPendingNameConflict(record: SkillProductRecord): void {
    const conflict = this.records.find((item) => (
      !item.reviewed
      && item.name === record.name
      && item.tenantId === record.tenantId
      && resolve(item.path) !== resolve(record.path)
    ));
    if (conflict) throw new Error(`Skill 名称冲突：${record.name}`);
  }

  private unambiguousAvailableRecords(viewer: SkillViewer): SkillProductRecord[] {
    const visible = this.records.filter((record) => (
      record.enabled && record.reviewed && this.visibleTo(skillFromRecord(record), viewer)
    ));
    const counts = new Map<string, number>();
    for (const record of visible) counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
    return visible.filter((record) => counts.get(record.name) === 1);
  }

  private async refreshForRead(): Promise<void> {
    if (!this.configuredRecords) await this.scanUnlocked();
  }

  private async verifiedRecords(records: readonly SkillProductRecord[]): Promise<SkillProductRecord[]> {
    const checked = await Promise.all(records.map(async (record) => {
      if (!record.contentDigest) return record;
      try {
        const actual = await contentDigest(record.path);
        if (actual === record.contentDigest) return record;
        log.error({ skill: record.name, expected: record.contentDigest, actual }, 'published skill digest mismatch');
      } catch (error) {
        log.error({ skill: record.name, err: String(error) }, 'published skill digest verification failed');
      }
      return undefined;
    }));
    return checked.filter((record): record is SkillProductRecord => record !== undefined);
  }

  private async mutateRecord(
    name: string,
    viewer: SkillViewer | undefined,
    change: (record: SkillProductRecord) => Promise<SkillProductRecord> | SkillProductRecord,
    preferReviewed = false,
  ): Promise<Skill> {
    return this.withMutationLock(() => this.withDistributedNameLock(name, async () => {
      await this.scanUnlocked();
      const current = this.requireManageableRecord(name, viewer, preferReviewed);
      const next = normalizeSkillProductRecord({
        ...await change(current),
        revision: (current.revision ?? 0) + 1,
        schemaVersion: PRODUCT_SCHEMA_VERSION,
      });
      await writeProductRecord(next, current.revision ?? 0);
      await this.scanUnlocked();
      const persisted = this.records.find((item) => resolve(item.path) === resolve(current.path));
      if (!persisted) throw new Error(`更新后未找到技能 ${name}`);
      return skillFromRecord(persisted, undefined, await listSkillFiles(persisted.path));
    }));
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withDistributedNameLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const key = `skill-name:${name}`;
    if (this.mutationLock) return this.mutationLock.withLock(key, this.nameLockTimeoutMs, operation);
    return this.withFileNameLock(key, name, operation);
  }

  private async withFileNameLock<T>(key: string, name: string, operation: () => Promise<T>): Promise<T> {
    const lockRoot = join(resolve(this.dir), SKILL_LOCKS_DIR);
    const lockPath = join(lockRoot, createHash('sha256').update(key).digest('hex'));
    const token = randomUUID();
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    await chmod(lockRoot, 0o700);
    const startedAt = Date.now();
    for (;;) {
      const candidatePath = `${lockPath}.candidate-${token}`;
      try {
        await mkdir(candidatePath);
        const ownerDir = join(candidatePath, token);
        await mkdir(ownerDir);
        await writeNameLockOwner(ownerDir, { token, key, leaseUntil: Date.now() + NAME_LOCK_LEASE_MS });
        await rename(candidatePath, lockPath);
        break;
      } catch (error) {
        await rm(candidatePath, { recursive: true, force: true });
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
        await recoverStaleNameLock(lockPath, key);
        if (Date.now() - startedAt >= this.nameLockTimeoutMs) {
          throw new Error(`获取技能名称锁超时：${name}`);
        }
        await delay(NAME_LOCK_RETRY_MS + Math.floor(Math.random() * NAME_LOCK_RETRY_MS));
      }
    }
    const heartbeat = setInterval(() => {
      void renewNameLock(lockPath, token, key).catch((error) => {
        log.warn({ lockPath, err: String(error) }, 'skill name lock renewal failed');
      });
    }, Math.floor(NAME_LOCK_LEASE_MS / 3));
    heartbeat.unref();
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await releaseNameLock(lockPath, token).catch((error) => {
        log.warn({ lockPath, err: String(error) }, 'skill name lock release failed');
      });
    }
  }

  private async scanUnlocked(excludedPaths: readonly string[] = []): Promise<void> {
    const excluded = new Set(excludedPaths.map((path) => resolve(path)));
    let records: SkillProductRecord[];
    if (this.configuredRecords) {
      records = this.configuredRecords.map(normalizeSkillProductRecord);
    } else {
      const builtinRecords = (await Promise.all(
        this.builtinRoots.map((root) => this.enumerateWithSnapshot(root)),
      )).flat();
      const productRecords = await this.enumerateWithSnapshot(this.dir);
      records = [
        ...builtinRecords,
        ...productRecords.filter((record) => !builtinRecords.some((builtin) => isSeededBuiltinCopy(record, builtin))),
      ];
    }
    this.records = records.filter((record) => !excluded.has(resolve(record.path)));
    log.info({ count: this.records.length }, 'skill product sources loaded');
  }

  private async enumerateWithSnapshot(root: string): Promise<SkillProductRecord[]> {
    try {
      return await enumerateSkillProductRecords(root);
    } catch (error) {
      const resolvedRoot = resolve(root);
      const snapshot = this.records.filter((record) => {
        const path = resolve(record.path);
        return path === resolvedRoot || path.startsWith(`${resolvedRoot}${sep}`);
      });
      log.error({ root, count: snapshot.length, err: String(error) }, 'skill source unavailable; retaining last snapshot');
      return snapshot;
    }
  }

  async delete(name: string, viewer?: SkillViewer): Promise<void> {
    await this.withMutationLock(() => this.withDistributedNameLock(name, async () => {
      await this.scanUnlocked();
      const record = this.requireManageableRecord(name, viewer);
      await renameToTombstone(record.path, this.dir);
      await this.scanUnlocked();
    }));
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

  private requireManageableRecord(name: string, viewer?: SkillViewer, preferReviewed = false): SkillProductRecord {
    if (!viewer) {
      const record = this.records.find((item) => item.name === name);
      if (!record) throw new Error(`未找到技能 ${name}`);
      return record;
    }
    const candidates = this.records.filter((item) => item.name === name)
      .map((record) => skillFromRecord(record))
      .filter((skill) => this.canManage(skill, viewer));
    const preferred = (preferReviewed
      ? candidates.find((skill) => skill.tenantId === viewer?.tenantId && skill.reviewed)
      : undefined)
      ?? candidates.find((skill) => skill.tenantId === viewer?.tenantId && !skill.reviewed)
      ?? candidates.find((skill) => skill.tenantId === viewer?.tenantId)
      ?? candidates[0];
    if (!preferred) throw new Error(`未找到技能 ${name} 或仅管理员可管理`);
    return preferred.product;
  }
}

async function writeProductRecord(record: SkillProductRecord, expectedRevision?: number): Promise<void> {
  const { id: _id, path: _path, description: _description, ...metadata } = record;
  const target = join(record.path, PRODUCT_RECORD_FILE);
  const temp = join(record.path, `.${PRODUCT_RECORD_FILE}.${randomUUID()}.tmp`);
  try {
    if (expectedRevision !== undefined) {
      const current = parsePersistedRevision(await readFile(target, 'utf8'));
      if (current !== expectedRevision) throw new Error(`Skill 产品记录 revision 冲突：${record.name}`);
    }
    await writeFile(temp, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    await fsyncFile(temp);
    await rename(temp, target);
    await fsyncParent(target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function parsePersistedRevision(raw: string): number {
  const value = JSON.parse(raw) as { revision?: unknown };
  return typeof value.revision === 'number' ? value.revision : 0;
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`导入技能目录已存在：${path}`);
}

interface NameLockOwner {
  token: string;
  key: string;
  leaseUntil: number;
  hostname?: string;
  pid?: number;
}

async function writeNameLockOwner(lockPath: string, owner: NameLockOwner): Promise<void> {
  const target = join(lockPath, NAME_LOCK_OWNER_FILE);
  const temp = join(lockPath, `.${NAME_LOCK_OWNER_FILE}.${owner.token}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify({ ...owner, hostname: hostname(), pid: process.pid })}\n`, { flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readNameLockOwner(lockPath: string): Promise<NameLockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(lockPath, NAME_LOCK_OWNER_FILE), 'utf8')) as Partial<NameLockOwner>;
    if (typeof value.token !== 'string' || typeof value.key !== 'string' || typeof value.leaseUntil !== 'number') {
      return undefined;
    }
    return {
      token: value.token,
      key: value.key,
      leaseUntil: value.leaseUntil,
      hostname: typeof value.hostname === 'string' ? value.hostname : undefined,
      pid: typeof value.pid === 'number' ? value.pid : undefined,
    };
  } catch {
    return undefined;
  }
}

async function recoverStaleNameLock(lockPath: string, key: string): Promise<void> {
  const current = await readCurrentNameLockOwner(lockPath);
  if (!current) {
    const retiredPath = `${lockPath}.orphan-${randomUUID()}`;
    try {
      await rename(lockPath, retiredPath);
      await rm(retiredPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return;
  }
  if (current.owner.key !== key
    || current.owner.leaseUntil > Date.now()) return;
  const retiredPath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, retiredPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const recovered = await readCurrentNameLockOwner(retiredPath);
  if (!recovered || recovered.owner.token !== current.owner.token
    || recovered.owner.key !== key || recovered.owner.leaseUntil > Date.now()) {
    await rename(retiredPath, lockPath).catch(() => undefined);
    return;
  }
  await rm(retiredPath, { recursive: true, force: true });
}

async function renewNameLock(lockPath: string, token: string, key: string): Promise<void> {
  const ownerDir = join(lockPath, token);
  const owner = await readNameLockOwner(ownerDir);
  if (owner?.token !== token || owner.key !== key) return;
  await writeNameLockOwner(ownerDir, { token, key, leaseUntil: Date.now() + NAME_LOCK_LEASE_MS });
}

async function releaseNameLock(lockPath: string, token: string): Promise<void> {
  const ownerDir = join(lockPath, token);
  const releaseEntry = join(lockPath, `.release-${token}`);
  try {
    await rename(ownerDir, releaseEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const releasedOwner = await readNameLockOwner(releaseEntry);
  if (releasedOwner?.token !== token) {
    await rename(releaseEntry, ownerDir).catch(() => undefined);
    return;
  }
  const retiredPath = `${lockPath}.release-${token}`;
  try {
    await rename(lockPath, retiredPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rm(retiredPath, { recursive: true, force: true });
}

async function readCurrentNameLockOwner(
  lockPath: string,
): Promise<{ ownerDir: string; owner: NameLockOwner } | undefined> {
  let entries;
  try {
    entries = await readdir(lockPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const ownerDir = join(lockPath, entry.name);
    const owner = await readNameLockOwner(ownerDir);
    if (owner?.token === entry.name) return { ownerDir, owner };
  }
  return undefined;
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

function recordVisibleInTenant(record: SkillProductRecord, tenantId: string): boolean {
  return record.tenantId === tenantId
    || record.allowedTenantIds?.includes(tenantId) === true
    || record.allowedTenantIds?.includes('*') === true;
}

/** Ignore legacy PVC copies made by the retired seed-skills initContainer. */
function isSeededBuiltinCopy(record: SkillProductRecord, builtin: SkillProductRecord): boolean {
  return record.name === builtin.name
    && record.tenantId === builtin.tenantId
    && record.reviewed && builtin.reviewed
    && record.visibility === 'public' && builtin.visibility === 'public'
    && !record.ownerUserId && !builtin.ownerUserId
    && !record.submittedByUserId && !builtin.submittedByUserId;
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

async function contentDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (rel: string): Promise<void> => {
    const target = safeResolve(root, rel);
    const entries = await readdir(target, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === PRODUCT_RECORD_FILE || entry.name === PUBLISHED_COMMIT_FILE
        || entry.name.startsWith(`.${PRODUCT_RECORD_FILE}.`)
        || entry.name.startsWith(`.${PUBLISHED_COMMIT_FILE}.`)) continue;
      const child = rel ? posix.join(rel, entry.name) : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Skill artifact 不允许符号链接');
      hash.update(entry.isDirectory() ? `D\0${child}\0` : `F\0${child}\0`);
      if (entry.isDirectory()) await visit(child);
      else hash.update(await readFile(safeResolve(root, child)));
    }
  };
  await visit('');
  return hash.digest('hex');
}

async function renameToTombstone(path: string, root: string): Promise<string | undefined> {
  const tombstoneRoot = join(resolve(root), SKILL_TOMBSTONES_DIR);
  await mkdir(tombstoneRoot, { recursive: true, mode: 0o700 });
  const target = join(tombstoneRoot, `${Date.now()}-${randomUUID()}`);
  try {
    await rename(path, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  await Promise.all([fsyncParent(path), fsyncParent(target)]).catch((error) => {
    log.warn({ path, target, err: String(error) }, 'skill tombstone directory fsync failed after rename');
  });
  return target;
}

async function rollbackPublishedArtifact(stagingPath: string, publishedPath: string): Promise<string | undefined> {
  try {
    await rm(stagingPath, { recursive: true, force: true });
    await rm(publishedPath, { recursive: true, force: true });
    await fsyncParent(publishedPath);
    return undefined;
  } catch (error) {
    return String(error);
  }
}

async function commitPublishedArtifact(publishedPath: string): Promise<void> {
  const marker = join(publishedPath, PUBLISHED_COMMIT_FILE);
  const temp = join(publishedPath, `.${PUBLISHED_COMMIT_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, 'committed\n', { flag: 'wx' });
    await fsyncFile(temp);
    await rename(temp, marker);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  // Marker visibility is the authorization commit point. A directory fsync error
  // after the rename is an ambiguous durability result, so keep the committed state.
  await fsyncParent(marker).catch((error) => {
    log.warn({ path: publishedPath, err: String(error) }, 'published skill commit directory fsync failed');
  });
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncParent(path: string): Promise<void> {
  const handle = await open(dirname(path), 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
