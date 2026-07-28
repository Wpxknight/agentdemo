import type { Role } from '../auth/types.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** AIoP Skill product visibility. */
export type SkillVisibility = 'public' | 'private' | 'shared';

export interface SkillViewer {
  userId?: string;
  role?: Role;
}

export interface Skill {
  name: string;
  description: string;
  dir: string;
  enabled: boolean;
  owner: string;
  visibility: SkillVisibility;
  credentials: string[];
  credentialFile?: string;
  body: string;
  files: SkillFileEntry[];
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

export interface SkillProductMetadata {
  credentials: string[];
  credentialFile?: string;
}

/** Product-only metadata not interpreted by Pi's runtime Skill model. */
export async function readSkillProductMetadata(dir: string): Promise<SkillProductMetadata> {
  const raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)?.[1] ?? '';
  const values = new Map<string, string>();
  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (key) values.set(key, value);
  }
  const credentials = (values.get('credentials') ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return { credentials, credentialFile: values.get('credential_file') || undefined };
}
