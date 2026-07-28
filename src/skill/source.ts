import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import {
  PRODUCT_RECORD_FILE,
  PUBLISHED_COMMIT_FILE,
  PUBLIC_SKILLS_DIR,
  SKILL_PUBLISHED_DIR,
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
  await enumeratePublishedRoot(root, records);
  return records;
}

async function enumeratePublishedRoot(root: string, records: SkillProductRecord[]): Promise<void> {
  const publishedRoot = join(root, SKILL_PUBLISHED_DIR);
  for (const scope of await directories(publishedRoot)) {
    for (const artifact of await directories(join(publishedRoot, scope))) {
      for (const name of await directories(join(publishedRoot, scope, artifact))) {
        const path = join(publishedRoot, scope, artifact, name);
        try {
          await readFile(join(path, PUBLISHED_COMMIT_FILE));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        await appendRecord(records, path, undefined);
      }
    }
  }
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
  expectedTenantId?: string,
  expectedOwnerUserId?: string,
): Promise<void> {
  try {
    const raw = await readFile(join(path, PRODUCT_RECORD_FILE), 'utf8');
    const metadata = parseSkillProductMetadata(JSON.parse(raw));
    if (expectedTenantId !== undefined && metadata.tenantId !== expectedTenantId) {
      throw new Error(`tenantId ${metadata.tenantId} 与目录租户 ${expectedTenantId} 不一致`);
    }
    if (expectedOwnerUserId && metadata.ownerUserId !== expectedOwnerUserId) {
      throw new Error('ownerUserId 与用户目录不一致');
    }
    if (expectedOwnerUserId && metadata.visibility === 'public'
      && (!metadata.reviewed || !metadata.allowedTenantIds?.includes('*'))) {
      throw new Error('用户目录中的 public Skill 必须经过全局审核');
    }
    if (expectedTenantId !== undefined && !expectedOwnerUserId && metadata.visibility !== 'public') {
      throw new Error('公共目录中的 Skill 必须声明 public');
    }
    records.push(normalizeSkillProductRecord({
      id: `${metadata.tenantId}:${metadata.ownerUserId ?? 'public'}:${metadata.name}`,
      path,
      ...metadata,
    }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') throw error;
    if (code !== 'ENOENT') {
      log.error({ path, err: String(error) }, 'skill product source read failed');
    }
    log.warn({ path, err: String(error) }, 'skipping skill with invalid or missing product metadata');
  }
}

async function directories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
