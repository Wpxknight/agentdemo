import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, link, mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import { defineTool, type ToolContext, type ToolHandler } from '../agent/tools.js';
import { isAdminRole } from '../auth/rbac.js';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  PUBLIC_SKILLS_DIR,
  SKILL_IMPORTS_DIR,
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
  parseSkillProductMetadata,
  type SkillProductRecord,
} from './product.js';
import { canManageSkill, isSkillVisibleTo } from './visibility.js';
import { enumerateSkillProductRecords } from './source.js';
import { SkillProductService, type ProductSkillLoader } from './service.js';
import type { SkillMutationLock } from './lock.js';
import { ImmutableDigestCache, mapConcurrentOrdered } from './digest-cache.js';

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
const PUBLICATION_SOURCE_MARKER = '.aiop-publication-source';
const MARKER_FILES = new Set([
  DISABLED_MARKER, SHARED_MARKER, OWNER_MARKER, PRODUCT_RECORD_FILE, PUBLISHED_COMMIT_FILE,
  PUBLICATION_SOURCE_MARKER,
]);
const PRODUCT_SCHEMA_VERSION = 2;
const BUILTIN_GOVERNANCE_DIR = '.aiop-governance';
const BUILTIN_CATALOG_DIR = 'builtin-catalog';
const BUILTIN_MIGRATIONS_DIR = 'migrations';
const LEGACY_SEED_MIGRATION_ID = 'legacy-seed-governance-v1';
const LEGACY_TOMBSTONE_STATE_DIR = `${LEGACY_SEED_MIGRATION_ID}-tombstones`;
const LEGACY_SEED_MIGRATION_LOCK_KEY = 'skill-legacy-migration:v1';
const PUBLICATION_JOURNAL_DIR = '.aiop-publications';
const PUBLICATION_LOCK_KEY = 'skill-publication';
const LEGACY_MUTATION_LOCK_KEY = 'skill-mutation';
const STORAGE_QUOTA_LOCK_KEY = 'skill-quota:storage';
const processNameLockTails = new Map<string, Promise<void>>();
const immutableDigestCache = new ImmutableDigestCache(256);
const DIGEST_VERIFICATION_CONCURRENCY = 4;

interface BuiltinGovernanceOverlay {
  schemaVersion: 1;
  identity: string;
  name: string;
  tenantId: string;
  sourceDigest: string;
  sourceVersion: string;
  sourceVisibility?: SkillVisibility;
  revision: number;
  enabled: boolean;
  reviewed: boolean;
  visibility: SkillVisibility;
  deleted: boolean;
}

interface LegacySeedMigrationOutcome {
  resolved: number;
  unresolved: number;
}

interface LegacyTombstoneMigrationState {
  schemaVersion: 1;
  tombstoneRelativePath: string;
  inventoryFingerprint?: string;
  contentDigest?: string;
  catalogFingerprint: string;
  result: 'no-candidate' | 'digest-mismatch' | 'ambiguous' | 'source-unavailable';
}

interface BuiltinCatalogEntry {
  identity: string;
  name: string;
  tenantId: string;
  relativePath: string;
  sourceDigest: string;
  sourceVersion: string;
  seedEligible: boolean;
}

interface PublicationJournal {
  schemaVersion: 1;
  publicationId: string;
  sourceId: string;
  sourceDigest: string;
  sourceVersion: string;
  sourcePath: string;
  stagedPath: string;
  publishedPath: string;
  tombstonePath: string;
  createdAt: string;
}

export interface SkillRegistryOptions {
  /** @deprecated Pi owns prompt formatting and does not apply a product-side budget. */
  summaryBudget?: number;
  records?: readonly SkillProductRecord[];
  loader?: ProductSkillLoader;
  env?: ConstructorParameters<typeof SkillProductService>[0];
  /** @deprecated Local fallback is a process mutex and has no lease timeout. */
  nameLockTimeoutMs?: number;
  /** Read-only image roots; mutations and uploads always use `dir`. */
  builtinRoots?: readonly string[];
  mutationLock?: SkillMutationLock;
  importPermitLock?: SkillMutationLock;
  pendingQuota?: Partial<SkillPendingQuota>;
  availableBytes?: () => Promise<number>;
  verifyContentDigest?: (path: string) => Promise<string>;
  legacyContentDigest?: (path: string) => Promise<string>;
}

export interface SkillPendingQuota {
  perUserMaxCount: number;
  perUserMaxBytes: number;
  perTenantMaxCount: number;
  perTenantMaxBytes: number;
  minFreeBytes: number;
  retentionMs: number;
}

const DEFAULT_PENDING_QUOTA: SkillPendingQuota = {
  perUserMaxCount: 20,
  perUserMaxBytes: 256 * 1024 * 1024,
  perTenantMaxCount: 200,
  perTenantMaxBytes: 2 * 1024 * 1024 * 1024,
  minFreeBytes: 512 * 1024 * 1024,
  retentionMs: 24 * 60 * 60 * 1000,
};

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
  private readonly builtinRoots: readonly string[];
  private readonly mutationLock?: SkillMutationLock;
  private readonly importPermitLock?: SkillMutationLock;
  private readonly pendingQuota: SkillPendingQuota;
  private readonly availableBytes: () => Promise<number>;
  private readonly verifyContentDigest: (path: string) => Promise<string>;
  private readonly legacyContentDigest: (path: string) => Promise<string>;
  private mutationTail: Promise<void> = Promise.resolve();
  private distributedLockDepth = 0;

  constructor(private readonly dir: string, opts: SkillRegistryOptions = {}) {
    this.configuredRecords = opts.records;
    this.builtinRoots = opts.builtinRoots ?? [];
    this.mutationLock = opts.mutationLock;
    this.importPermitLock = opts.importPermitLock ?? opts.mutationLock;
    this.pendingQuota = { ...DEFAULT_PENDING_QUOTA, ...opts.pendingQuota };
    this.availableBytes = opts.availableBytes ?? (async () => {
      const info = await statfs(resolve(this.dir));
      return Number(info.bavail) * Number(info.bsize);
    });
    this.verifyContentDigest = opts.verifyContentDigest
      ?? ((path) => contentDigest(path, { immutable: true }));
    this.legacyContentDigest = opts.legacyContentDigest ?? ((path) => contentDigest(path));
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
    if (this.importPermitLock?.tryAcquireSlots) {
      const release = await this.importPermitLock.tryAcquireSlots([
        { keyPrefix: 'skill-import:global', limit: globalLimit },
        { keyPrefix: `skill-import:tenant:${tenantId}`, limit: tenantLimit },
      ]);
      return { supported: true, release };
    }
    if (!this.importPermitLock?.tryAcquireSlot) return { supported: false };
    const globalRelease = await this.importPermitLock.tryAcquireSlot('skill-import:global', globalLimit);
    if (!globalRelease) return { supported: true };
    let tenantRelease: (() => Promise<void>) | undefined;
    try {
      tenantRelease = await this.importPermitLock.tryAcquireSlot(`skill-import:tenant:${tenantId}`, tenantLimit);
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
    await this.withMutationLock(() => this.scanUnlocked([], true));
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
      return this.withDistributedLocks([
        STORAGE_QUOTA_LOCK_KEY,
        `skill-quota:tenant:${metadata.tenantId}`,
        `skill-quota:user:${metadata.tenantId}:${metadata.ownerUserId}`,
        `skill-name:${metadata.name}`,
      ], async () => {
        const record = normalizeSkillProductRecord({
          id: `${metadata.tenantId}:${metadata.ownerUserId}:${metadata.name}`,
          path: destinationDir,
          ...metadata,
        });
        // Refresh under both the registry-local and root-shared process mutexes.
        // The uploaded sidecar remains untrusted until the server replaces it below.
        await this.scanUnlocked([destinationDir]);
        this.assertNoPendingNameConflict(record);
        if (sourceDir !== destinationDir) await assertPathAbsent(destinationDir);
        await this.assertPendingQuota(record, sourceDir);
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
      return this.withDistributedLocks([PUBLICATION_LOCK_KEY, `skill-name:${name}`], async () => {
        await this.scanUnlocked();
        const tenantRecords = this.records.filter((item) => item.name === name && item.tenantId === viewer.tenantId);
        const pending = tenantRecords.filter((item) => !item.reviewed && this.isUploadedRecord(item));
        if (pending.length > 1) throw new Error(`同名待审核技能 ${name} 不唯一`);
        if (!pending.length) {
          const builtinPending = tenantRecords.filter((item) => !item.reviewed && this.isBuiltinRecord(item));
          if (builtinPending.length > 1) throw new Error(`同名待审核内置技能 ${name} 不唯一`);
          if (builtinPending.length === 1) {
            if (options.global) throw new Error('内置技能不支持全局发布');
            const record = builtinPending[0]!;
            const validationRecord = normalizeSkillProductRecord({ ...record, reviewed: true });
            const validation = await this.service.load([validationRecord], viewer);
            if (validation.diagnostics.length || validation.skills.length !== 1
              || resolve(validation.skills[0]!.source.path) !== resolve(record.path)) {
              throw new Error(`Pi Skill 校验产生诊断，技能保持待审核：${name}`);
            }
            await this.writeBuiltinGovernance(record, { ...record, reviewed: true });
            await this.scanUnlocked();
            const persisted = this.records.find((item) => resolve(item.path) === resolve(record.path));
            if (!persisted) throw new Error(`审核后未找到技能 ${name}`);
            return persisted;
          }
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
        let publicationJournal: PublicationJournal | undefined;
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
          const publicationId = randomUUID();
          publicationJournal = {
            schemaVersion: 1,
            publicationId,
            sourceId: record.id,
            sourceDigest: digest,
            sourceVersion: record.version,
            sourcePath: record.path,
            stagedPath: stagingPath,
            publishedPath,
            tombstonePath: join(resolve(this.dir), SKILL_TOMBSTONES_DIR, `publication-${publicationId}`),
            createdAt: new Date().toISOString(),
          };
          await writePublicationJournal(this.dir, publicationJournal);
          await writePublicationSourceMarker(record.path, publicationId);
          await rename(stagingPath, publishedPath);
          await fsyncParent(publishedPath);
          await commitPublishedArtifact(publishedPath);
        } catch (error) {
          const rollbackError = publicationJournal
            ? await reconcilePublicationJournal(this.dir, publicationJournal).then(() => undefined, String)
            : await rollbackPublishedArtifact(stagingPath, publishedPath);
          if (rollbackError) {
            throw new Error(`技能发布失败且 artifact 回滚失败：${String(error)}; rollback: ${rollbackError}`);
          }
          throw error;
        }
        try {
          if (!publicationJournal) throw new Error('技能发布 journal 缺失');
          await finishCommittedPublication(this.dir, publicationJournal);
        } catch (error) {
          log.warn({ skill: name, path: publishedPath, err: String(error) }, 'published skill committed; cleanup deferred to reconciliation');
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
    const checked = await mapConcurrentOrdered(records, DIGEST_VERIFICATION_CONCURRENCY, async (record) => {
      if (!record.contentDigest) return record;
      try {
        const actual = await this.verifyContentDigest(record.path);
        if (actual === record.contentDigest) return record;
        log.error({ skill: record.name, expected: record.contentDigest, actual }, 'published skill digest mismatch');
      } catch (error) {
        log.error({ skill: record.name, err: String(error) }, 'published skill digest verification failed');
      }
      return undefined;
    });
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
      if (this.isBuiltinRecord(current)) await this.writeBuiltinGovernance(current, next);
      else await writeProductRecord(next, current.revision ?? 0);
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
    return this.withDistributedLocks([`skill-name:${name}`], operation);
  }

  private async withDistributedLocks<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const trackedOperation = async () => {
      this.distributedLockDepth += 1;
      try {
        return await operation();
      } finally {
        this.distributedLockDepth -= 1;
      }
    };
    if (this.mutationLock?.withLocks) return this.mutationLock.withLocks(ordered, 10_000, trackedOperation);
    if (this.mutationLock) {
      // The legacy API cannot atomically compose independent advisory keys. Serialize every
      // mutation through one stable key so single-key and multi-key operations still interlock.
      return this.mutationLock.withLock(LEGACY_MUTATION_LOCK_KEY, 10_000, trackedOperation);
    }
    const acquire = (index: number): Promise<T> => {
      if (index >= ordered.length) return trackedOperation();
      const key = ordered[index]!;
      return withProcessNameLock(`${resolve(this.dir)}\0${key}`, () => acquire(index + 1));
    };
    return acquire(0);
  }

  private async assertPendingQuota(incoming: SkillProductRecord, sourceDir: string): Promise<void> {
    const pending = this.records.filter((record) => !record.reviewed && this.isUploadedRecord(record));
    const userPending = pending.filter((record) => record.tenantId === incoming.tenantId
      && record.ownerUserId === incoming.ownerUserId);
    const tenantPending = pending.filter((record) => record.tenantId === incoming.tenantId);
    const incomingBytes = await directorySize(sourceDir);
    const [userBytes, tenantBytes, freeBytes] = await Promise.all([
      sumDirectorySizes(userPending),
      sumDirectorySizes(tenantPending),
      this.availableBytes(),
    ]);
    if (userPending.length >= this.pendingQuota.perUserMaxCount) {
      throw new Error('用户待审核技能数量配额已满');
    }
    if (tenantPending.length >= this.pendingQuota.perTenantMaxCount) {
      throw new Error('租户待审核技能数量配额已满');
    }
    if (userBytes + incomingBytes > this.pendingQuota.perUserMaxBytes) {
      throw new Error('用户待审核技能字节配额已满');
    }
    if (tenantBytes + incomingBytes > this.pendingQuota.perTenantMaxBytes) {
      throw new Error('租户待审核技能字节配额已满');
    }
    if (freeBytes - incomingBytes < this.pendingQuota.minFreeBytes) {
      throw new Error('技能存储可用空间不足');
    }
  }

  private async scanUnlocked(
    excludedPaths: readonly string[] = [],
    runStartupMigrations = false,
  ): Promise<void> {
    if (!this.configuredRecords && this.distributedLockDepth === 0) {
      await this.withDistributedLocks([PUBLICATION_LOCK_KEY], () => reconcilePublicationJournals(this.dir));
    }
    const excluded = new Set(excludedPaths.map((path) => resolve(path)));
    let records: SkillProductRecord[];
    if (this.configuredRecords) {
      records = this.configuredRecords.map(normalizeSkillProductRecord);
    } else {
      const rawBuiltinRecords = (await Promise.all(
        this.builtinRoots.map((root) => this.enumerateWithSnapshot(root)),
      )).flat();
      const builtinCatalog = await this.updateBuiltinCatalog(rawBuiltinRecords);
      if (runStartupMigrations) {
        await this.ensureLegacySeedMigration(rawBuiltinRecords, builtinCatalog);
      }
      await readLegacySeedMigrationMarker(this.dir);
      await cleanupStaleSkillStorage(this.dir, this.pendingQuota.retentionMs);
      const builtinRecords = (await Promise.all(
        rawBuiltinRecords.map((record) => this.applyBuiltinGovernance(record)),
      )).filter((record): record is SkillProductRecord => record !== undefined);
      const productRecords = await this.enumerateWithSnapshot(this.dir);
      records = [
        ...builtinRecords,
        ...productRecords,
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
      if (this.isBuiltinRecord(record)) await this.writeBuiltinGovernance(record, record, true);
      else {
        const tombstone = await renameToTombstone(record.path, this.dir);
        if (tombstone) await rm(tombstone, { recursive: true, force: true });
      }
      await this.scanUnlocked();
    }));
  }

  private isBuiltinRecord(record: SkillProductRecord): boolean {
    return this.builtinRootFor(record.path) !== undefined;
  }

  private builtinRootFor(path: string): string | undefined {
    const resolvedPath = resolve(path);
    return this.builtinRoots.find((root) => {
      const resolvedRoot = resolve(root);
      return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
    });
  }

  private async builtinSource(record: SkillProductRecord): Promise<{
    identity: string;
    digest: string;
    relativePath: string;
  }> {
    const location = this.builtinLocation(record);
    return { ...location, digest: await contentDigest(record.path) };
  }

  private builtinLocation(record: SkillProductRecord): {
    identity: string;
    relativePath: string;
  } {
    const root = this.builtinRootFor(record.path);
    if (!root) throw new Error(`技能 ${record.name} 不是内置技能`);
    const relativePath = relative(resolve(root), resolve(record.path)).split(sep).join('/');
    const identity = createHash('sha256')
      .update(`${record.tenantId}\0${record.name}\0${relativePath}`)
      .digest('hex');
    return { identity, relativePath };
  }

  private async updateBuiltinCatalog(records: readonly SkillProductRecord[]): Promise<readonly BuiltinCatalogEntry[]> {
    const currentEntries = await Promise.all(records.map(async (record) => {
      const source = await this.builtinSource(record);
      return {
        identity: source.identity,
        name: record.name,
        tenantId: record.tenantId,
        relativePath: source.relativePath,
        sourceDigest: source.digest,
        sourceVersion: record.version,
        seedEligible: isSeedEligibleBuiltin(record),
      } satisfies BuiltinCatalogEntry;
    }));
    await Promise.all(currentEntries.map((entry) => writeBuiltinCatalogEntry(this.dir, entry)));
    return readBuiltinCatalogEntries(this.dir);
  }

  private async migrateLegacySeedGovernance(
    rawBuiltinRecords: readonly SkillProductRecord[],
    catalog: readonly BuiltinCatalogEntry[],
  ): Promise<LegacySeedMigrationOutcome> {
    const outcome: LegacySeedMigrationOutcome = { resolved: 0, unresolved: 0 };
    if (!rawBuiltinRecords.length || !catalog.length) return outcome;
    const rawByIdentity = new Map<string, SkillProductRecord>();
    for (const record of rawBuiltinRecords) {
      rawByIdentity.set(this.builtinLocation(record).identity, record);
    }
    for (const source of catalog) {
      const candidatePath = safeResolve(this.dir, source.relativePath);
      const legacy = await readLegacySeedCandidate(candidatePath, source);
      if (!legacy) continue;
      const digest = await contentDigest(legacy.path);
      if (digest !== source.sourceDigest) continue;
      if (await this.migrateLegacySeedRecord(legacy, source, rawByIdentity, false)) outcome.resolved += 1;
      else outcome.unresolved += 1;
    }

    const tombstoneRoot = join(resolve(this.dir), SKILL_TOMBSTONES_DIR);
    const tombstones = await enumerateSkillProductRecords(tombstoneRoot);
    const catalogFingerprint = builtinCatalogFingerprint(catalog);
    for (const legacy of tombstones) {
      const cachedState = await readLegacyTombstoneMigrationState(this.dir, legacy.path);
      const candidates = catalog.filter((entry) => entry.name === legacy.name
        && entry.tenantId === legacy.tenantId
        && entry.sourceVersion === legacy.version
        && legacyRelativePathCandidates(legacy).includes(entry.relativePath));
      if (!candidates.length) {
        const state: LegacyTombstoneMigrationState = {
          schemaVersion: 1,
          tombstoneRelativePath: legacyTombstoneRelativePath(this.dir, legacy.path),
          catalogFingerprint,
          result: 'no-candidate',
        };
        if (!sameLegacyTombstoneMigrationState(cachedState, state)) {
          await writeLegacyTombstoneMigrationState(this.dir, legacy.path, state);
        }
        outcome.unresolved += 1;
        continue;
      }
      const inventoryFingerprint = await artifactFingerprint(legacy.path);
      const digest = cachedState?.inventoryFingerprint === inventoryFingerprint
        && cachedState.contentDigest
        ? cachedState.contentDigest
        : await this.legacyContentDigest(legacy.path);
      const persistUnresolved = async (result: LegacyTombstoneMigrationState['result']): Promise<void> => {
        const state: LegacyTombstoneMigrationState = {
          schemaVersion: 1,
          tombstoneRelativePath: legacyTombstoneRelativePath(this.dir, legacy.path),
          inventoryFingerprint,
          contentDigest: digest,
          catalogFingerprint,
          result,
        };
        if (!sameLegacyTombstoneMigrationState(cachedState, state)) {
          await writeLegacyTombstoneMigrationState(this.dir, legacy.path, state);
        }
        outcome.unresolved += 1;
      };
      const exactByIdentity = new Map(
        candidates.filter((entry) => entry.sourceDigest === digest).map((entry) => [entry.identity, entry]),
      );
      if (!exactByIdentity.size) {
        await persistUnresolved('digest-mismatch');
        continue;
      }
      if (exactByIdentity.size !== 1) {
        await persistUnresolved('ambiguous');
        continue;
      }
      const source = exactByIdentity.values().next().value!;
      if (await this.migrateLegacySeedRecord(legacy, source, rawByIdentity, true)) {
        outcome.resolved += 1;
        await removeLegacyTombstoneMigrationState(this.dir, legacy.path);
      } else {
        await persistUnresolved('source-unavailable');
      }
    }
    return outcome;
  }

  private async ensureLegacySeedMigration(
    rawBuiltinRecords: readonly SkillProductRecord[],
    catalog: readonly BuiltinCatalogEntry[],
  ): Promise<void> {
    if (!rawBuiltinRecords.length || !catalog.length || await readLegacySeedMigrationMarker(this.dir)) return;
    await this.withDistributedLocks([
      LEGACY_SEED_MIGRATION_LOCK_KEY,
      ...catalog.map((entry) => `skill-name:${entry.name}`),
    ], async () => {
      if (await readLegacySeedMigrationMarker(this.dir)) return;
      const outcome = await this.migrateLegacySeedGovernance(rawBuiltinRecords, catalog);
      if (outcome.unresolved === 0) await writeLegacySeedMigrationMarker(this.dir);
    });
  }

  private async migrateLegacySeedRecord(
    legacy: SkillProductRecord,
    source: BuiltinCatalogEntry,
    rawByIdentity: ReadonlyMap<string, SkillProductRecord>,
    deleted: boolean,
  ): Promise<boolean> {
    const raw = rawByIdentity.get(source.identity);
    const existing = await readBuiltinGovernanceOverlay(this.dir, source.identity);
    if (existing) {
      if (deleted && !existing.deleted) {
        await writeBuiltinGovernanceOverlay(this.dir, {
          ...existing,
          sourceDigest: source.sourceDigest,
          sourceVersion: source.sourceVersion,
          sourceVisibility: raw?.visibility ?? existing.sourceVisibility,
          revision: existing.revision + 1,
          deleted: true,
        });
      }
      await rm(legacy.path, { recursive: true, force: true });
      await fsyncParent(legacy.path).catch(() => undefined);
      return true;
    }
    if (!raw) return false;
    await writeBuiltinGovernanceOverlayIfAbsent(this.dir, {
      schemaVersion: 1,
      identity: source.identity,
      name: source.name,
      tenantId: source.tenantId,
      sourceDigest: source.sourceDigest,
      sourceVersion: source.sourceVersion,
      sourceVisibility: raw.visibility,
      revision: Math.max(1, legacy.revision ?? 1),
      enabled: legacy.enabled,
      reviewed: legacy.reviewed,
      visibility: legacy.visibility,
      deleted,
    });
    const written = await readBuiltinGovernanceOverlay(this.dir, source.identity);
    if (deleted && written && !written.deleted) {
      await writeBuiltinGovernanceOverlay(this.dir, {
        ...written,
        sourceDigest: source.sourceDigest,
        sourceVersion: source.sourceVersion,
        sourceVisibility: raw.visibility,
        revision: written.revision + 1,
        deleted: true,
      });
    }
    await rm(legacy.path, { recursive: true, force: true });
    await fsyncParent(legacy.path).catch(() => undefined);
    return true;
  }

  private async applyBuiltinGovernance(
    record: SkillProductRecord,
  ): Promise<SkillProductRecord | undefined> {
    try {
      const source = await this.builtinSource(record);
      const overlay = await readBuiltinGovernanceOverlay(this.dir, source.identity);
      if (!overlay) return record;
      const exactSource = overlay.sourceDigest === source.digest && overlay.sourceVersion === record.version;
      if (overlay.deleted) return undefined;
      if (!exactSource) {
        return normalizeSkillProductRecord({
          ...record,
          enabled: overlay.enabled === false ? false : record.enabled,
          reviewed: overlay.reviewed === false ? false : record.reviewed,
          visibility: restrictiveOverlayVisibility(overlay, record.visibility),
          revision: overlay.revision,
        });
      }
      return normalizeSkillProductRecord({
        ...record,
        enabled: overlay.enabled,
        reviewed: overlay.reviewed,
        visibility: overlay.visibility,
        revision: overlay.revision,
      });
    } catch (error) {
      log.error({ skill: record.name, path: record.path, err: String(error) }, 'builtin governance overlay invalid; hiding skill');
      return undefined;
    }
  }

  private async writeBuiltinGovernance(
    sourceRecord: SkillProductRecord,
    next: SkillProductRecord,
    deleted = false,
  ): Promise<void> {
    const source = await this.builtinSource(sourceRecord);
    const sourceMetadata = parseSkillProductMetadata(JSON.parse(
      await readFile(join(sourceRecord.path, PRODUCT_RECORD_FILE), 'utf8'),
    ));
    const current = await readBuiltinGovernanceOverlay(this.dir, source.identity);
    await writeBuiltinGovernanceOverlay(this.dir, {
      schemaVersion: 1,
      identity: source.identity,
      name: sourceRecord.name,
      tenantId: sourceRecord.tenantId,
      sourceDigest: source.digest,
      sourceVersion: sourceRecord.version,
      sourceVisibility: sourceMetadata.visibility,
      revision: (current?.revision ?? 0) + 1,
      enabled: next.enabled,
      reviewed: next.reviewed,
      visibility: next.visibility,
      deleted,
    });
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

async function readBuiltinGovernanceOverlay(
  root: string,
  identity: string,
): Promise<BuiltinGovernanceOverlay | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(resolve(root), BUILTIN_GOVERNANCE_DIR, `${identity}.json`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(raw) as Partial<BuiltinGovernanceOverlay>;
  if (value.schemaVersion !== 1 || value.identity !== identity
    || typeof value.name !== 'string' || typeof value.tenantId !== 'string'
    || typeof value.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceDigest)
    || typeof value.sourceVersion !== 'string'
    || (value.sourceVisibility !== undefined
      && !['public', 'private', 'shared'].includes(String(value.sourceVisibility)))
    || !Number.isInteger(value.revision) || (value.revision ?? 0) < 1
    || typeof value.enabled !== 'boolean' || typeof value.reviewed !== 'boolean'
    || !['public', 'private', 'shared'].includes(String(value.visibility))
    || typeof value.deleted !== 'boolean') {
    throw new Error(`内置技能治理 overlay 无效：${identity}`);
  }
  return value as BuiltinGovernanceOverlay;
}

function restrictiveOverlayVisibility(
  overlay: BuiltinGovernanceOverlay,
  sourceVisibility: SkillVisibility,
): SkillVisibility {
  const visibilityRank: Record<SkillVisibility, number> = { private: 0, shared: 1, public: 2 };
  const wasRestrictive = overlay.sourceVisibility === undefined
    ? overlay.visibility === 'private'
    : visibilityRank[overlay.visibility] < visibilityRank[overlay.sourceVisibility];
  if (!wasRestrictive || visibilityRank[overlay.visibility] >= visibilityRank[sourceVisibility]) {
    return sourceVisibility;
  }
  return overlay.visibility;
}

async function readBuiltinCatalogEntries(root: string): Promise<BuiltinCatalogEntry[]> {
  const catalogRoot = join(resolve(root), BUILTIN_GOVERNANCE_DIR, BUILTIN_CATALOG_DIR);
  let files;
  try {
    files = await readdir(catalogRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries = await Promise.all(files
    .filter((file) => file.isFile() && file.name.endsWith('.json'))
    .map(async (file) => {
      const value = JSON.parse(await readFile(join(catalogRoot, file.name), 'utf8')) as unknown;
      if (!isBuiltinCatalogEntry(value)) throw new Error(`内置技能 catalog entry 无效：${file.name}`);
      const expectedName = `${createHash('sha256').update(builtinCatalogEntryKey(value)).digest('hex')}.json`;
      if (file.name !== expectedName) throw new Error(`内置技能 catalog entry 文件名无效：${file.name}`);
      return value;
    }));
  return entries.sort(compareBuiltinCatalogEntry);
}

async function writeBuiltinCatalogEntry(root: string, entry: BuiltinCatalogEntry): Promise<void> {
  const catalogRoot = join(resolve(root), BUILTIN_GOVERNANCE_DIR, BUILTIN_CATALOG_DIR);
  await mkdir(catalogRoot, { recursive: true, mode: 0o700 });
  const filename = `${createHash('sha256').update(builtinCatalogEntryKey(entry)).digest('hex')}.json`;
  const target = join(catalogRoot, filename);
  try {
    const existing = JSON.parse(await readFile(target, 'utf8')) as unknown;
    if (!isBuiltinCatalogEntry(existing) || builtinCatalogEntryKey(existing) !== builtinCatalogEntryKey(entry)) {
      throw new Error(`内置技能 catalog entry 冲突：${filename}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = join(catalogRoot, `.${filename}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`, { flag: 'wx' });
    await fsyncFile(temp);
    await rename(temp, target);
    await fsyncParent(target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function isBuiltinCatalogEntry(value: unknown): value is BuiltinCatalogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<BuiltinCatalogEntry>;
  return typeof entry.identity === 'string' && /^[a-f0-9]{64}$/.test(entry.identity)
    && typeof entry.name === 'string' && typeof entry.tenantId === 'string'
    && typeof entry.relativePath === 'string'
    && typeof entry.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(entry.sourceDigest)
    && typeof entry.sourceVersion === 'string' && typeof entry.seedEligible === 'boolean';
}

function builtinCatalogEntryKey(entry: BuiltinCatalogEntry): string {
  return `${entry.identity}\0${entry.sourceDigest}\0${entry.sourceVersion}\0${entry.seedEligible ? '1' : '0'}`;
}

function compareBuiltinCatalogEntry(a: BuiltinCatalogEntry, b: BuiltinCatalogEntry): number {
  return builtinCatalogEntryKey(a).localeCompare(builtinCatalogEntryKey(b));
}

function builtinCatalogFingerprint(catalog: readonly BuiltinCatalogEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of catalog) hash.update(`${builtinCatalogEntryKey(entry)}\0`);
  return hash.digest('hex');
}

function legacyTombstoneRelativePath(root: string, tombstonePath: string): string {
  const tombstoneRoot = join(resolve(root), SKILL_TOMBSTONES_DIR);
  const relativePath = relative(tombstoneRoot, resolve(tombstonePath)).split(sep).join('/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error(`Legacy tombstone 路径越界：${tombstonePath}`);
  }
  return relativePath;
}

function legacyTombstoneMigrationStatePath(root: string, tombstonePath: string): string {
  const relativePath = legacyTombstoneRelativePath(root, tombstonePath);
  const filename = `${createHash('sha256').update(relativePath).digest('hex')}.json`;
  return join(resolve(root), BUILTIN_GOVERNANCE_DIR, BUILTIN_MIGRATIONS_DIR,
    LEGACY_TOMBSTONE_STATE_DIR, filename);
}

async function readLegacyTombstoneMigrationState(
  root: string,
  tombstonePath: string,
): Promise<LegacyTombstoneMigrationState | undefined> {
  const path = legacyTombstoneMigrationStatePath(root, tombstonePath);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log.warn({ path, err: String(error) }, 'ignoring invalid legacy tombstone migration state');
    return undefined;
  }
  if (!isLegacyTombstoneMigrationState(value)
    || value.tombstoneRelativePath !== legacyTombstoneRelativePath(root, tombstonePath)) {
    log.warn({ path }, 'ignoring invalid legacy tombstone migration state');
    return undefined;
  }
  return value;
}

function isLegacyTombstoneMigrationState(value: unknown): value is LegacyTombstoneMigrationState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<LegacyTombstoneMigrationState>;
  return state.schemaVersion === 1
    && typeof state.tombstoneRelativePath === 'string' && state.tombstoneRelativePath.length > 0
    && typeof state.catalogFingerprint === 'string' && /^[a-f0-9]{64}$/.test(state.catalogFingerprint)
    && ['no-candidate', 'digest-mismatch', 'ambiguous', 'source-unavailable'].includes(String(state.result))
    && (state.inventoryFingerprint === undefined
      || typeof state.inventoryFingerprint === 'string' && /^[a-f0-9]{64}$/.test(state.inventoryFingerprint))
    && (state.contentDigest === undefined
      || typeof state.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(state.contentDigest))
    && (state.result === 'no-candidate'
      || typeof state.inventoryFingerprint === 'string' && typeof state.contentDigest === 'string');
}

function sameLegacyTombstoneMigrationState(
  left: LegacyTombstoneMigrationState | undefined,
  right: LegacyTombstoneMigrationState,
): boolean {
  return left?.schemaVersion === right.schemaVersion
    && left.tombstoneRelativePath === right.tombstoneRelativePath
    && left.inventoryFingerprint === right.inventoryFingerprint
    && left.contentDigest === right.contentDigest
    && left.catalogFingerprint === right.catalogFingerprint
    && left.result === right.result;
}

async function writeLegacyTombstoneMigrationState(
  root: string,
  tombstonePath: string,
  state: LegacyTombstoneMigrationState,
): Promise<void> {
  const target = legacyTombstoneMigrationStatePath(root, tombstonePath);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(dirname(target), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fsyncFile(temp);
    await rename(temp, target);
    await fsyncParent(target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function removeLegacyTombstoneMigrationState(root: string, tombstonePath: string): Promise<void> {
  const target = legacyTombstoneMigrationStatePath(root, tombstonePath);
  await rm(target, { force: true });
  await fsyncParent(target).catch(() => undefined);
}

async function readLegacySeedMigrationMarker(root: string): Promise<boolean> {
  const path = join(
    resolve(root),
    BUILTIN_GOVERNANCE_DIR,
    BUILTIN_MIGRATIONS_DIR,
    `${LEGACY_SEED_MIGRATION_ID}.done`,
  );
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (value.schemaVersion !== 1 || value.migration !== LEGACY_SEED_MIGRATION_ID
    || typeof value.completedAt !== 'string') {
    throw new Error(`Skill legacy migration marker 无效：${path}`);
  }
  return true;
}

async function writeLegacySeedMigrationMarker(root: string): Promise<void> {
  const migrationRoot = join(resolve(root), BUILTIN_GOVERNANCE_DIR, BUILTIN_MIGRATIONS_DIR);
  await mkdir(migrationRoot, { recursive: true, mode: 0o700 });
  const target = join(migrationRoot, `${LEGACY_SEED_MIGRATION_ID}.done`);
  const temp = join(migrationRoot, `.${LEGACY_SEED_MIGRATION_ID}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify({
      schemaVersion: 1,
      migration: LEGACY_SEED_MIGRATION_ID,
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fsyncFile(temp);
    await rename(temp, target);
    await fsyncParent(target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function writeBuiltinGovernanceOverlay(
  root: string,
  overlay: BuiltinGovernanceOverlay,
): Promise<void> {
  const overlayRoot = join(resolve(root), BUILTIN_GOVERNANCE_DIR);
  await mkdir(overlayRoot, { recursive: true, mode: 0o700 });
  const target = join(overlayRoot, `${overlay.identity}.json`);
  const temp = join(overlayRoot, `.${overlay.identity}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(overlay, null, 2)}\n`, { flag: 'wx' });
    await fsyncFile(temp);
    await rename(temp, target);
    await fsyncParent(target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function writeBuiltinGovernanceOverlayIfAbsent(
  root: string,
  overlay: BuiltinGovernanceOverlay,
): Promise<void> {
  const overlayRoot = join(resolve(root), BUILTIN_GOVERNANCE_DIR);
  await mkdir(overlayRoot, { recursive: true, mode: 0o700 });
  const target = join(overlayRoot, `${overlay.identity}.json`);
  const temp = join(overlayRoot, `.${overlay.identity}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(overlay, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fsyncFile(temp);
    try {
      await link(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await readBuiltinGovernanceOverlay(root, overlay.identity);
      return;
    }
    await fsyncParent(target);
  } catch (error) {
    throw error;
  } finally {
    await rm(temp, { force: true });
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

async function withProcessNameLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = processNameLockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  processNameLockTails.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (processNameLockTails.get(key) === current) processNameLockTails.delete(key);
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

function recordVisibleInTenant(record: SkillProductRecord, tenantId: string): boolean {
  return record.tenantId === tenantId
    || record.allowedTenantIds?.includes(tenantId) === true
    || record.allowedTenantIds?.includes('*') === true;
}

function isSeedEligibleBuiltin(record: SkillProductRecord): boolean {
  return record.reviewed && record.visibility === 'public'
    && !record.ownerUserId && !record.submittedByUserId;
}

function legacyRelativePathCandidates(record: SkillProductRecord): string[] {
  const tenantPrefix = record.tenantId === 'default'
    ? ''
    : `${TENANT_SKILLS_DIR}/${record.tenantId}/`;
  if (record.ownerUserId) {
    return [`${tenantPrefix}${USER_SKILLS_DIR}/${record.ownerUserId}/${record.name}`];
  }
  return [
    `${tenantPrefix}${record.name}`,
    `${tenantPrefix}${PUBLIC_SKILLS_DIR}/${record.name}`,
  ];
}

async function readLegacySeedCandidate(
  path: string,
  source: BuiltinCatalogEntry,
): Promise<SkillProductRecord | undefined> {
  let metadata;
  try {
    metadata = parseSkillProductMetadata(JSON.parse(await readFile(join(path, PRODUCT_RECORD_FILE), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log.warn({ path, err: String(error) }, 'skipping invalid legacy seed candidate metadata');
    return undefined;
  }
  if (metadata.name !== source.name || metadata.tenantId !== source.tenantId
    || metadata.version !== source.sourceVersion) return undefined;
  return normalizeSkillProductRecord({
    id: `${metadata.tenantId}:${metadata.ownerUserId ?? 'public'}:${metadata.name}`,
    path,
    ...metadata,
  });
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

async function contentDigest(root: string, options: { immutable?: boolean } = {}): Promise<string> {
  const entries = await artifactEntries(root);
  const identity = artifactEntriesFingerprint(entries);
  const cacheKey = resolve(root);
  const cached = options.immutable ? immutableDigestCache.get(cacheKey, identity) : undefined;
  if (cached) return cached;

  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.directory ? `D\0${entry.path}\0` : `F\0${entry.path}\0`);
    if (!entry.directory) {
      for await (const chunk of createReadStream(safeResolve(root, entry.path))) hash.update(chunk as Buffer);
    }
  }
  const digest = hash.digest('hex');
  if (options.immutable) immutableDigestCache.set(cacheKey, identity, digest);
  return digest;
}

async function artifactFingerprint(root: string): Promise<string> {
  return artifactEntriesFingerprint(await artifactEntries(root));
}

function artifactEntriesFingerprint(entries: readonly ArtifactEntryIdentity[]): string {
  const identityHash = createHash('sha256');
  for (const entry of entries) {
    identityHash.update(`${entry.directory ? 'D' : 'F'}\0${entry.path}\0${entry.size}\0${entry.mtimeMs}\0${entry.ctimeMs}\0${entry.ino}\0`);
  }
  return identityHash.digest('hex');
}

interface ArtifactEntryIdentity {
  path: string;
  directory: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

async function artifactEntries(root: string, rel = ''): Promise<ArtifactEntryIdentity[]> {
  const target = safeResolve(root, rel);
  const entries = await readdir(target, { withFileTypes: true });
  const result: ArtifactEntryIdentity[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === PRODUCT_RECORD_FILE || entry.name === PUBLISHED_COMMIT_FILE
      || entry.name.startsWith(`.${PRODUCT_RECORD_FILE}.`)
      || entry.name.startsWith(`.${PUBLISHED_COMMIT_FILE}.`)) continue;
    if (entry.isSymbolicLink()) throw new Error('Skill artifact 不允许符号链接');
    const child = rel ? posix.join(rel, entry.name) : entry.name;
    const info = await stat(safeResolve(root, child));
    result.push({
      path: child,
      directory: entry.isDirectory(),
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      ino: Number(info.ino),
    });
    if (entry.isDirectory()) result.push(...await artifactEntries(root, child));
  }
  return result;
}

async function directorySize(root: string, rel = ''): Promise<number> {
  const target = safeResolve(root, rel);
  const entries = await readdir(target, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Skill artifact 不允许符号链接');
    const child = rel ? posix.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) total += await directorySize(root, child);
    else total += (await stat(safeResolve(root, child))).size;
  }
  return total;
}

async function sumDirectorySizes(records: readonly SkillProductRecord[]): Promise<number> {
  let total = 0;
  for (const record of records) total += await directorySize(record.path);
  return total;
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

async function writePublicationJournal(root: string, journal: PublicationJournal): Promise<void> {
  const journalRoot = join(resolve(root), PUBLICATION_JOURNAL_DIR);
  await mkdir(journalRoot, { recursive: true, mode: 0o700 });
  const target = join(journalRoot, `${journal.publicationId}.json`);
  const temp = join(journalRoot, `.${journal.publicationId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fsyncFile(temp);
    await rename(temp, target);
    await fsyncParent(target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function reconcilePublicationJournals(root: string): Promise<void> {
  const journalRoot = join(resolve(root), PUBLICATION_JOURNAL_DIR);
  let files;
  try {
    files = await readdir(journalRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
    const path = join(journalRoot, file.name);
    const journal = parsePublicationJournal(root, JSON.parse(await readFile(path, 'utf8')), file.name);
    await reconcilePublicationJournal(root, journal);
  }
}

async function cleanupStaleSkillStorage(root: string, retentionMs: number): Promise<void> {
  const cutoff = Date.now() - retentionMs;
  await cleanupStaleDirectories(join(resolve(root), SKILL_IMPORTS_DIR), cutoff, (name) => name !== '.concurrency');
  await cleanupStaleDirectories(join(resolve(root), SKILL_PUBLISHED_DIR), cutoff, (name) => name.startsWith('.staging-'));
  await cleanupStaleDirectories(
    join(resolve(root), SKILL_TOMBSTONES_DIR),
    cutoff,
    isManagedSkillTombstoneName,
  );
}

async function cleanupStaleDirectories(
  root: string,
  cutoff: number,
  eligible: (name: string) => boolean,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !eligible(entry.name)) continue;
    const target = join(root, entry.name);
    const info = await stat(target).catch(() => undefined);
    if (info && info.mtimeMs <= cutoff) await rm(target, { recursive: true, force: true });
  }
}

function parsePublicationJournal(root: string, value: unknown, filename?: string): PublicationJournal {
  if (!value || typeof value !== 'object') throw new Error('技能发布 journal 无效');
  const journal = value as Partial<PublicationJournal>;
  if (journal.schemaVersion !== 1
    || typeof journal.publicationId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(journal.publicationId)
    || typeof journal.sourceId !== 'string' || !journal.sourceId
    || typeof journal.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(journal.sourceDigest)
    || typeof journal.sourceVersion !== 'string' || !journal.sourceVersion
    || typeof journal.sourcePath !== 'string'
    || typeof journal.stagedPath !== 'string'
    || typeof journal.publishedPath !== 'string'
    || typeof journal.tombstonePath !== 'string'
    || typeof journal.createdAt !== 'string') {
    throw new Error('技能发布 journal 无效');
  }
  if (filename !== undefined && filename !== `${journal.publicationId}.json`) {
    throw new Error('技能发布 journal 文件名无效');
  }
  const resolvedRoot = resolve(root);
  assertContainedPublicationPath(resolvedRoot, journal.sourcePath, resolvedRoot);
  assertContainedPublicationPath(resolvedRoot, journal.stagedPath, join(resolvedRoot, SKILL_PUBLISHED_DIR));
  assertContainedPublicationPath(resolvedRoot, journal.publishedPath, join(resolvedRoot, SKILL_PUBLISHED_DIR));
  assertContainedPublicationPath(resolvedRoot, journal.tombstonePath, join(resolvedRoot, SKILL_TOMBSTONES_DIR));
  return journal as PublicationJournal;
}

function assertContainedPublicationPath(root: string, candidate: string, requiredRoot: string): void {
  const target = resolve(candidate);
  const boundary = resolve(requiredRoot);
  if (target === root || (target !== boundary && !target.startsWith(`${boundary}${sep}`))) {
    throw new Error('技能发布 journal 路径越界');
  }
}

async function reconcilePublicationJournal(root: string, journal: PublicationJournal): Promise<void> {
  const markerCommitted = await exists(join(journal.publishedPath, PUBLISHED_COMMIT_FILE));
  if (markerCommitted) await finishCommittedPublication(root, journal);
  else await rollbackUncommittedPublication(root, journal);
}

async function finishCommittedPublication(root: string, journal: PublicationJournal): Promise<void> {
  await mkdir(dirname(journal.tombstonePath), { recursive: true, mode: 0o700 });
  if (await publicationSourceOwnedBy(journal.sourcePath, journal.publicationId)) {
    try {
      await rename(journal.sourcePath, journal.tombstonePath);
      await Promise.all([fsyncParent(journal.sourcePath), fsyncParent(journal.tombstonePath)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const journalPath = publicationJournalPath(root, journal.publicationId);
  await rm(journalPath, { force: true });
  await fsyncParent(journalPath);
  await rm(journal.tombstonePath, { recursive: true, force: true });
  await fsyncParent(journal.tombstonePath).catch(() => undefined);
}

async function rollbackUncommittedPublication(root: string, journal: PublicationJournal): Promise<void> {
  if (!await exists(journal.sourcePath) && await exists(journal.tombstonePath)) {
    await mkdir(dirname(journal.sourcePath), { recursive: true });
    try {
      await rename(journal.tombstonePath, journal.sourcePath);
      await Promise.all([fsyncParent(journal.tombstonePath), fsyncParent(journal.sourcePath)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await removePublicationSourceMarker(journal.sourcePath, journal.publicationId);
  await rm(journal.stagedPath, { recursive: true, force: true });
  await rm(journal.publishedPath, { recursive: true, force: true });
  await rm(journal.tombstonePath, { recursive: true, force: true });
  await rm(publicationJournalPath(root, journal.publicationId), { force: true });
}

function publicationJournalPath(root: string, publicationId: string): string {
  return join(resolve(root), PUBLICATION_JOURNAL_DIR, `${publicationId}.json`);
}

async function writePublicationSourceMarker(sourcePath: string, publicationId: string): Promise<void> {
  const target = join(sourcePath, PUBLICATION_SOURCE_MARKER);
  const temp = join(sourcePath, `.${PUBLICATION_SOURCE_MARKER}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${publicationId}\n`, { flag: 'wx', mode: 0o600 });
    await fsyncFile(temp);
    await rename(temp, target);
    await fsyncParent(target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function publicationSourceOwnedBy(sourcePath: string, publicationId: string): Promise<boolean> {
  return readFile(join(sourcePath, PUBLICATION_SOURCE_MARKER), 'utf8')
    .then((value) => value.trim() === publicationId, () => false);
}

async function removePublicationSourceMarker(sourcePath: string, publicationId: string): Promise<void> {
  if (!await publicationSourceOwnedBy(sourcePath, publicationId)) return;
  const marker = join(sourcePath, PUBLICATION_SOURCE_MARKER);
  await rm(marker, { force: true });
  await fsyncParent(marker).catch(() => undefined);
}

function isManagedSkillTombstoneName(name: string): boolean {
  return /^publication-[a-zA-Z0-9._-]+$/.test(name)
    || /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name);
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
