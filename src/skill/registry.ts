import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
const PRODUCT_SCHEMA_VERSION = 2;
const BUILTIN_GOVERNANCE_DIR = '.aiop-governance';
const BUILTIN_CATALOG_DIR = 'builtin-catalog';
const processNameLockTails = new Map<string, Promise<void>>();

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

interface BuiltinCatalogEntry {
  identity: string;
  name: string;
  tenantId: string;
  relativePath: string;
  sourceDigest: string;
  sourceVersion: string;
  seedEligible: boolean;
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
  private readonly builtinRoots: readonly string[];
  private readonly mutationLock?: SkillMutationLock;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string, opts: SkillRegistryOptions = {}) {
    this.configuredRecords = opts.records;
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
        // Refresh under both the registry-local and root-shared process mutexes.
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
    const key = `skill-name:${name}`;
    if (this.mutationLock) return this.mutationLock.withLock(key, 10_000, operation);
    return withProcessNameLock(`${resolve(this.dir)}\0${key}`, operation);
  }

  private async scanUnlocked(excludedPaths: readonly string[] = []): Promise<void> {
    const excluded = new Set(excludedPaths.map((path) => resolve(path)));
    let records: SkillProductRecord[];
    if (this.configuredRecords) {
      records = this.configuredRecords.map(normalizeSkillProductRecord);
    } else {
      const rawBuiltinRecords = (await Promise.all(
        this.builtinRoots.map((root) => this.enumerateWithSnapshot(root)),
      )).flat();
      const builtinCatalog = await this.updateBuiltinCatalog(rawBuiltinRecords);
      const builtinRecords = (await Promise.all(
        rawBuiltinRecords.map((record) => this.applyBuiltinGovernance(record)),
      )).filter((record): record is SkillProductRecord => record !== undefined);
      const productRecords = await this.enumerateWithSnapshot(this.dir);
      const filteredProductRecords = (await Promise.all(productRecords.map(async (record) => (
        await isSeededBuiltinCopy(record, builtinCatalog, this.dir) ? undefined : record
      )))).filter((record): record is SkillProductRecord => record !== undefined);
      records = [
        ...builtinRecords,
        ...filteredProductRecords,
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
      else await renameToTombstone(record.path, this.dir);
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
    const root = this.builtinRootFor(record.path);
    if (!root) throw new Error(`技能 ${record.name} 不是内置技能`);
    const relativePath = relative(resolve(root), resolve(record.path)).split(sep).join('/');
    const identity = createHash('sha256')
      .update(`${record.tenantId}\0${record.name}\0${relativePath}`)
      .digest('hex');
    return { identity, digest: await contentDigest(record.path), relativePath };
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

/** Ignore only byte-identical legacy PVC copies made by the retired seed-skills initContainer. */
async function isSeededBuiltinCopy(
  record: SkillProductRecord,
  catalog: readonly BuiltinCatalogEntry[],
  productRoot: string,
): Promise<boolean> {
  if (!isSeedEligibleBuiltin(record)) return false;
  const relativePath = relative(resolve(productRoot), resolve(record.path)).split(sep).join('/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) return false;
  const candidates = catalog.filter((entry) => entry.seedEligible
    && entry.name === record.name
    && entry.tenantId === record.tenantId
    && entry.sourceVersion === record.version
    && entry.relativePath === relativePath);
  if (!candidates.length) return false;
  const digest = await contentDigest(record.path).catch(() => undefined);
  return digest !== undefined && candidates.some((entry) => entry.sourceDigest === digest);
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
