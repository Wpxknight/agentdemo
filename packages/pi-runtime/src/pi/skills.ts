import { join, resolve } from 'node:path';
import {
  formatSkillsForSystemPrompt,
  loadSourcedSkills,
  type ExecutionEnv,
  type Skill,
  type SkillDiagnostic,
} from '@earendil-works/pi-agent-core';

export {
  formatSkillsForSystemPrompt,
  loadSourcedSkills,
  loadSkills,
  type Skill,
  type SkillDiagnostic,
} from '@earendil-works/pi-agent-core';

export interface PiSkillIdentity {
  tenantId: string;
  userId?: string;
  role?: string;
}

/** Product DTO owned by the runtime package; applications may add fields structurally. */
export interface PiSkillProduct {
  id: string;
  name: string;
  path: string;
  version: string;
  tenantId: string;
  allowedTenantIds?: readonly string[];
  ownerUserId?: string;
  visibility: 'public' | 'private' | 'shared';
  enabled: boolean;
  reviewed: boolean;
  allowedRoles?: readonly string[];
  credentials?: readonly string[];
  credentialFile?: string;
}

export type PiAvailableSkillLoader<TProduct extends PiSkillProduct> = (
  env: ExecutionEnv,
  sources: Array<{ path: string; source: TProduct }>,
) => Promise<{
  skills: Array<{ skill: Skill; source: TProduct }>;
  diagnostics: Array<SkillDiagnostic & { source: TProduct }>;
}>;

export interface LoadAvailableSkillsDeps<TProduct extends PiSkillProduct> {
  loader?: PiAvailableSkillLoader<TProduct>;
  formatter?: (skills: Skill[]) => string;
}

export async function loadAvailableSkills<TProduct extends PiSkillProduct>(
  env: ExecutionEnv,
  products: readonly TProduct[],
  identity: PiSkillIdentity,
  deps: LoadAvailableSkillsDeps<TProduct> = {},
): Promise<{
  skills: Skill[];
  loaded: Array<{ skill: Skill; product: TProduct }>;
  prompt: string;
  diagnostics: Array<SkillDiagnostic & { source: TProduct }>;
}> {
  const sources = products
    .filter((product) => isAvailableTo(product, identity))
    .map((source) => ({ path: source.path, source }));
  if (!sources.length) {
    const skills: Skill[] = [];
    return {
      skills,
      loaded: [],
      prompt: (deps.formatter ?? formatSkillsForSystemPrompt)(skills),
      diagnostics: [],
    };
  }
  const allowedProductIds = new Set(sources.map(({ source }) => source.id));
  const result = await (deps.loader ?? loadSourcedSkills)(env, sources);
  const diagnosedProductIds = new Set(result.diagnostics
    .filter(({ source }) => allowedProductIds.has(source.id))
    .map(({ source }) => source.id));
  const returned = result.skills.filter(({ source }) => (
    allowedProductIds.has(source.id) && !diagnosedProductIds.has(source.id)
  ));
  const mismatches = returned.filter(({ skill, source }) => !matchesProduct(skill, source));
  const loaded = returned
    .filter(({ skill, source }) => matchesProduct(skill, source))
    .map(({ skill, source }) => ({ skill, product: source }));
  const skills = loaded.map(({ skill }) => skill);
  return {
    skills,
    loaded,
    prompt: (deps.formatter ?? formatSkillsForSystemPrompt)(skills),
    diagnostics: [
      ...result.diagnostics,
      ...mismatches.map(({ skill, source }) => ({
        type: 'warning' as const,
        code: 'invalid_metadata' as const,
        message: `Pi skill ${skill.name} at ${skill.filePath} does not match product ${source.name}`,
        path: source.path,
        source,
      })),
    ],
  };
}

function matchesProduct(skill: Skill, product: PiSkillProduct): boolean {
  return skill.name === product.name
    && resolve(skill.filePath) === resolve(join(product.path, 'SKILL.md'));
}

function isAvailableTo(product: PiSkillProduct, identity: PiSkillIdentity): boolean {
  if (!product.enabled || !product.reviewed) return false;
  const tenantAllowed = product.tenantId === identity.tenantId
    || product.allowedTenantIds?.includes(identity.tenantId) === true
    || product.allowedTenantIds?.includes('*') === true;
  if (!tenantAllowed) return false;
  if (product.allowedRoles?.length
    && (!identity.role || !product.allowedRoles.includes(identity.role))) return false;
  return product.visibility !== 'private'
    || Boolean(identity.userId)
      && (product.ownerUserId === identity.userId
        || (product as PiSkillProduct & { submittedByUserId?: string }).submittedByUserId === identity.userId);
}
