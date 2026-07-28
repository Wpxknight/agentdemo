import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PRODUCT_RECORD_FILE,
  PUBLIC_SKILLS_DIR,
  TENANT_SKILLS_DIR,
  USER_SKILLS_DIR,
  normalizeSkillProductRecord,
  type SkillProductRecord,
  type SkillVisibility,
} from './product.js';

const DISABLED_MARKER = '.disabled';
const SHARED_MARKER = '.shared';
const OWNER_MARKER = '.owner';

/** Enumerates product sources and marker metadata only; it never reads SKILL.md. */
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
      const record = await recordFor(join(root, entry), entry, tenantId, '', 'public');
      if (record) records.push(record);
    }
  }
  for (const entry of await directories(join(root, PUBLIC_SKILLS_DIR))) {
    const dir = join(root, PUBLIC_SKILLS_DIR, entry);
    const owner = (await readFile(join(dir, OWNER_MARKER), 'utf8').catch(() => '')).trim();
    const record = await recordFor(dir, entry, tenantId, owner, 'public');
    if (record) records.push(record);
  }
  const usersRoot = join(root, USER_SKILLS_DIR);
  for (const owner of await directories(usersRoot)) {
    for (const entry of await directories(join(usersRoot, owner))) {
      const dir = join(usersRoot, owner, entry);
      const visibility: SkillVisibility = await exists(join(dir, SHARED_MARKER)) ? 'shared' : 'private';
      const record = await recordFor(dir, entry, tenantId, owner, visibility);
      if (record) records.push(record);
    }
  }
}

async function recordFor(
  path: string,
  name: string,
  tenantId: string,
  ownerId: string,
  visibility: SkillVisibility,
): Promise<SkillProductRecord | undefined> {
  if (!await exists(join(path, 'SKILL.md'))) return undefined;
  const sidecar: Partial<SkillProductRecord> = await readFile(join(path, PRODUCT_RECORD_FILE), 'utf8')
    .then((raw) => JSON.parse(raw) as Partial<SkillProductRecord>)
    .catch((): Partial<SkillProductRecord> => ({}));
  return normalizeSkillProductRecord({
    id: `${tenantId}:${ownerId || 'public'}:${name}`,
    name,
    path,
    version: 'legacy',
    tenantId,
    ownerId: ownerId || undefined,
    visibility,
    enabled: !(await exists(join(path, DISABLED_MARKER))),
    reviewed: true,
    credentials: sidecar.credentials,
    credentialFile: sidecar.credentialFile,
  });
}

async function directories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
