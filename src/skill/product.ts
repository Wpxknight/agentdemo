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
  version?: string;
  description?: string;
  tenantId: string;
  allowedTenantIds?: readonly string[];
  ownerId?: string;
  visibility: SkillVisibility;
  enabled: boolean;
  reviewed: boolean;
  allowedRoles?: readonly Role[];
  credentials?: readonly string[];
  credentialFile?: string;
}

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
  if (!record.id || !record.name || !record.path || !record.tenantId) {
    throw new Error('Skill 产品记录缺少必填字段');
  }
  if (record.credentials && (!Array.isArray(record.credentials)
    || record.credentials.some((item) => typeof item !== 'string' || !item))) {
    throw new Error('Skill credentials 必须是非空字符串数组');
  }
  return {
    ...record,
    credentialFile: record.credentialFile === undefined
      ? undefined
      : normalizeCredentialFile(record.credentialFile),
  };
}
