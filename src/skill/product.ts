import { posix } from 'node:path';
import type { Role } from '../auth/types.js';

export type SkillVisibility = 'public' | 'private' | 'shared';

export interface SkillViewer {
  tenantId?: string;
  userId?: string;
  role?: Role;
}

/** Authoritative AIoP product record. Pi receives this only after governance. */
export interface SkillProductRecord {
  id: string;
  name: string;
  path: string;
  version: string;
  description?: string;
  tenantId: string;
  allowedTenantIds?: readonly string[];
  ownerUserId?: string;
  visibility: SkillVisibility;
  enabled: boolean;
  reviewed: boolean;
  allowedRoles?: readonly Role[];
  credentials?: readonly string[];
  credentialFile?: string;
  /** Sidecar schema for rolling-compatible product metadata evolution. */
  schemaVersion?: number;
  /** Monotonic governance revision; mutations use it as a filesystem CAS token. */
  revision?: number;
  /** SHA-256 over immutable artifact files (excluding the mutable product sidecar). */
  contentDigest?: string;
  /** Versioned artifact identity, normally `<version>-<digest-prefix>`. */
  artifactVersion?: string;
  /** Original uploader retained for audit only; it does not grant artifact ownership. */
  submittedByUserId?: string;
}

export type SkillProductMetadata = Omit<SkillProductRecord, 'id' | 'path' | 'description'>;

export interface Skill {
  name: string;
  description: string;
  dir: string;
  enabled: boolean;
  reviewed: boolean;
  tenantId: string;
  allowedTenantIds?: readonly string[];
  allowedRoles?: readonly Role[];
  owner: string;
  visibility: SkillVisibility;
  credentials: string[];
  credentialFile?: string;
  body: string;
  files: SkillFileEntry[];
  product: SkillProductRecord;
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

export const PUBLIC_SKILLS_DIR = '_public';
export const USER_SKILLS_DIR = 'users';
export const TENANT_SKILLS_DIR = 'tenants';
export const SKILL_LOCKS_DIR = '.aiop-locks';
export const SKILL_IMPORTS_DIR = '.aiop-imports';
export const SKILL_PUBLISHED_DIR = '.aiop-published';
export const SKILL_TOMBSTONES_DIR = '.aiop-tombstones';
export const PUBLISHED_COMMIT_FILE = '.aiop-committed';
export const PRODUCT_RECORD_FILE = '.product.json';

export function normalizeCredentialFile(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.endsWith('/')
    || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    throw new Error('credential_file 必须是规范的相对文件路径');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('credential_file 必须是规范的相对文件路径');
  }
  const normalized = posix.normalize(value);
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    throw new Error('credential_file 必须是规范的相对文件路径');
  }
  return normalized;
}

export function normalizeSkillProductRecord(record: SkillProductRecord): SkillProductRecord {
  if (!record.id || !record.name || !record.path || !record.version || !record.tenantId) {
    throw new Error('Skill 产品记录缺少必填字段');
  }
  const metadata = parseSkillProductMetadata({
    name: record.name,
    version: record.version,
    tenantId: record.tenantId,
    allowedTenantIds: record.allowedTenantIds,
    ownerUserId: record.ownerUserId,
    visibility: record.visibility,
    enabled: record.enabled,
    reviewed: record.reviewed,
    allowedRoles: record.allowedRoles,
    credentials: record.credentials,
    credentialFile: record.credentialFile,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    contentDigest: record.contentDigest,
    artifactVersion: record.artifactVersion,
    submittedByUserId: record.submittedByUserId,
  });
  return {
    ...record,
    ...metadata,
    credentialFile: metadata.credentialFile === undefined
      ? undefined
      : normalizeCredentialFile(metadata.credentialFile),
  };
}

export function parseSkillProductMetadata(value: unknown): SkillProductMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Skill 产品元数据必须是对象');
  }
  const metadata = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'name', 'version', 'enabled', 'reviewed', 'tenantId', 'allowedTenantIds',
    'ownerUserId', 'visibility', 'allowedRoles', 'credentials', 'credentialFile',
    'schemaVersion', 'revision', 'contentDigest', 'artifactVersion', 'submittedByUserId',
  ]);
  const unknownKey = Object.keys(metadata).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`Skill 产品元数据包含未知字段 ${unknownKey}`);
  const name = requiredString(metadata, 'name');
  const version = requiredString(metadata, 'version');
  const tenantId = requiredString(metadata, 'tenantId');
  if (typeof metadata.enabled !== 'boolean' || typeof metadata.reviewed !== 'boolean') {
    throw new Error('Skill 产品元数据 enabled/reviewed 必须是布尔值');
  }
  if (!['public', 'private', 'shared'].includes(String(metadata.visibility))) {
    throw new Error('Skill 产品元数据 visibility 无效');
  }
  const parsed: SkillProductMetadata = {
    name,
    version,
    tenantId,
    visibility: metadata.visibility as SkillVisibility,
    enabled: metadata.enabled,
    reviewed: metadata.reviewed,
    allowedTenantIds: optionalStringArray(metadata, 'allowedTenantIds'),
    ownerUserId: optionalString(metadata, 'ownerUserId'),
    allowedRoles: optionalRoles(metadata, 'allowedRoles'),
    credentials: optionalStringArray(metadata, 'credentials'),
    credentialFile: optionalString(metadata, 'credentialFile'),
    schemaVersion: optionalPositiveInteger(metadata, 'schemaVersion'),
    revision: optionalNonNegativeInteger(metadata, 'revision'),
    contentDigest: optionalDigest(metadata, 'contentDigest'),
    artifactVersion: optionalString(metadata, 'artifactVersion'),
    submittedByUserId: optionalString(metadata, 'submittedByUserId'),
  };
  validateMetadata(parsed);
  return parsed;
}

function optionalPositiveInteger(value: Record<string, unknown>, key: string): number | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (!Number.isInteger(item) || (item as number) < 1) throw new Error(`Skill 产品元数据 ${key} 必须是正整数`);
  return item as number;
}

function optionalNonNegativeInteger(value: Record<string, unknown>, key: string): number | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (!Number.isInteger(item) || (item as number) < 0) throw new Error(`Skill 产品元数据 ${key} 必须是非负整数`);
  return item as number;
}

function optionalDigest(value: Record<string, unknown>, key: string): string | undefined {
  const item = optionalString(value, key);
  if (item !== undefined && !/^[a-f0-9]{64}$/.test(item)) throw new Error(`Skill 产品元数据 ${key} 无效`);
  return item;
}

function validateMetadata(record: SkillProductMetadata | SkillProductRecord): void {
  if (record.visibility === 'private' && !record.ownerUserId
    && !(record.reviewed && record.submittedByUserId)) {
    throw new Error('private Skill 产品元数据缺少 ownerUserId');
  }
  if (record.credentials?.length === 0) throw new Error('Skill credentials 不能为空数组');
  if (record.credentialFile && !record.credentials?.length) {
    throw new Error('credentialFile 需要 credentials');
  }
  if (record.allowedTenantIds?.length === 0 || record.allowedRoles?.length === 0) {
    throw new Error('Skill 产品授权数组不能为空');
  }
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || !item.trim()) throw new Error(`Skill 产品元数据 ${key} 必须是非空字符串`);
  return item;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (typeof item !== 'string' || !item.trim()) throw new Error(`Skill 产品元数据 ${key} 必须是非空字符串`);
  return item;
}

function optionalStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (!Array.isArray(item) || item.length === 0
    || item.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`Skill 产品元数据 ${key} 必须是非空字符串数组`);
  }
  return [...item] as string[];
}

function optionalRoles(value: Record<string, unknown>, key: string): Role[] | undefined {
  const roles = optionalStringArray(value, key);
  if (!roles) return undefined;
  if (roles.some((role) => !['platform_admin', 'tenant_admin', 'user'].includes(role))) {
    throw new Error('Skill 产品元数据 allowedRoles 包含无效角色');
  }
  return roles as Role[];
}
