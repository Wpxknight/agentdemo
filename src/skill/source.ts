import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import {
  PRODUCT_RECORD_FILE,
  PUBLIC_SKILLS_DIR,
  TENANT_SKILLS_DIR,
  USER_SKILLS_DIR,
  normalizeSkillProductRecord,
  parseSkillProductMetadata,
  type SkillProductRecord,
} from './product.js';

const log = logger.child({ mod: 'skill-source' });

/** Enumerates authoritative product sidecars only; it never reads SKILL.md. */
export async function enumerateSkillProductRecords(root: string): Promise<SkillProductRecord[]> {
  const records: SkillProductRecord[] = [];
  await enumerateTenantRoot(root, 'default', records, true);
  const tenantsRoot = join(root, TENANT_SKILLS_DIR);
  for (const tenantId of await directories(tenantsRoot)) {
    await enumerateTenantRoot(join(tenantsRoot, tenantId), tenantId, records, false);
  }
  return records;
}

async function enumerateTenantRoot(
  root: string,
  tenantId: string,
  records: SkillProductRecord[],
  includeLegacy: boolean,
): Promise<void> {
  if (includeLegacy) {
    for (const entry of await directories(root)) {
      if (entry === PUBLIC_SKILLS_DIR || entry === USER_SKILLS_DIR || entry === TENANT_SKILLS_DIR) continue;
      await appendRecord(records, join(root, entry), tenantId);
    }
  }
  for (const entry of await directories(join(root, PUBLIC_SKILLS_DIR))) {
    await appendRecord(records, join(root, PUBLIC_SKILLS_DIR, entry), tenantId);
  }
  const usersRoot = join(root, USER_SKILLS_DIR);
  for (const ownerUserId of await directories(usersRoot)) {
    for (const entry of await directories(join(usersRoot, ownerUserId))) {
      await appendRecord(records, join(usersRoot, ownerUserId, entry), tenantId, ownerUserId);
    }
  }
}

async function appendRecord(
  records: SkillProductRecord[],
  path: string,
  expectedTenantId: string,
  expectedOwnerUserId?: string,
): Promise<void> {
  try {
    const raw = await readFile(join(path, PRODUCT_RECORD_FILE), 'utf8');
    const metadata = parseSkillProductMetadata(JSON.parse(raw));
    if (metadata.tenantId !== expectedTenantId) {
      throw new Error(`tenantId ${metadata.tenantId} 与目录租户 ${expectedTenantId} 不一致`);
    }
    if (expectedOwnerUserId && metadata.ownerUserId !== expectedOwnerUserId) {
      throw new Error('ownerUserId 与用户目录不一致');
    }
    if (expectedOwnerUserId && metadata.visibility === 'public'
      && (!metadata.reviewed || !metadata.allowedTenantIds?.includes('*'))) {
      throw new Error('用户目录中的 public Skill 必须经过全局审核');
    }
    if (!expectedOwnerUserId && metadata.visibility !== 'public') {
      throw new Error('公共目录中的 Skill 必须声明 public');
    }
    records.push(normalizeSkillProductRecord({
      id: `${metadata.tenantId}:${metadata.ownerUserId ?? 'public'}:${metadata.name}`,
      path,
      ...metadata,
    }));
  } catch (error) {
    log.warn({ path, err: String(error) }, 'skipping skill with invalid or missing product metadata');
  }
}

async function directories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
