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

export interface SkillIdentity {
  tenantId: string;
  actorId: string;
  roles: readonly string[];
}

export type SkillVisibility = 'public' | 'private' | 'shared';

/** Product-owned governance metadata carried through Pi as source data. */
export interface SkillProductSource {
  id: string;
  version: string;
  enabled: boolean;
  reviewed: boolean;
  audited: boolean;
  tenantIds?: readonly string[];
  visibility?: SkillVisibility;
  ownerId?: string;
  allowedRoles?: readonly string[];
}

export interface GovernedSkillSource {
  path: string;
  source: SkillProductSource;
}

export interface AvailableSkills {
  skills: Skill[];
  prompt: string;
  diagnostics: Array<SkillDiagnostic & { source: SkillProductSource }>;
}

export type PiSkillLoader = (
  env: ExecutionEnv,
  sources: GovernedSkillSource[],
) => Promise<{
  skills: Array<{ skill: Skill; source: SkillProductSource }>;
  diagnostics: Array<SkillDiagnostic & { source: SkillProductSource }>;
}>;

/** Filter product records before Pi receives any filesystem source. */
export async function loadAvailableSkills(
  env: ExecutionEnv,
  identity: SkillIdentity,
  sources: readonly GovernedSkillSource[],
  loader: PiSkillLoader = loadSourcedSkills,
): Promise<AvailableSkills> {
  const visibleSources = sources.filter(({ source }) => isAvailableTo(source, identity));
  const loaded = await loader(env, visibleSources);
  const skills = loaded.skills.map(({ skill }) => skill);
  const prompt = formatSkillsForSystemPrompt(loaded.skills.map(({ skill }) => skill));
  return { skills, prompt, diagnostics: loaded.diagnostics };
}

function isAvailableTo(source: SkillProductSource, identity: SkillIdentity): boolean {
  if (!source.enabled || !source.reviewed || !source.audited) return false;
  if (source.tenantIds?.length && !source.tenantIds.includes(identity.tenantId)) return false;
  if (source.allowedRoles?.length && !source.allowedRoles.some((role) => identity.roles.includes(role))) {
    return false;
  }
  if (source.visibility === 'private' && source.ownerId !== identity.actorId) return false;
  return true;
}
