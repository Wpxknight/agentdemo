import {
  formatSkillInvocation,
  loadSourcedSkills,
  type ExecutionEnv,
  type Skill,
} from '@earendil-works/pi-agent-core';

export interface SkillSource {
  path: string;
  version: string;
  enabled?: boolean;
  tenantIds?: readonly string[];
  reviewed?: boolean;
}

export interface GovernedSkill extends Skill {
  source: SkillSource;
}

export interface ResolveSkillsInput {
  tenantId: string;
  sources: readonly SkillSource[];
  requireReviewed?: boolean;
}

export interface ResolvedSkillSet {
  version: string;
  skills: GovernedSkill[];
  diagnostics: Array<{ code: string; message: string; path: string }>;
}

export type SkillLoader = (sources: readonly SkillSource[]) => Promise<GovernedSkill[]>;

export class SkillRuntime {
  constructor(private readonly loader: SkillLoader) {}

  async resolve(input: ResolveSkillsInput): Promise<ResolvedSkillSet> {
    const loaded = await this.loader(input.sources);
    const skills = loaded
      .filter((skill) => skill.source.enabled !== false)
      .filter((skill) => !input.requireReviewed || skill.source.reviewed === true)
      .filter((skill) => !skill.source.tenantIds?.length || skill.source.tenantIds.includes(input.tenantId))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      version: skills.length ? skills.map((skill) => `${skill.name}@${skill.source.version}`).join(',') : 'empty',
      skills,
      diagnostics: [],
    };
  }

  async render(skill: GovernedSkill, additionalInstructions?: string): Promise<string> {
    return formatSkillInvocation(skill, additionalInstructions);
  }
}

export function createPiSkillLoader(environment: unknown): SkillLoader {
  const env = environment as ExecutionEnv;
  return async (sources) => {
    const loaded = await loadSourcedSkills(env, sources.map((source) => ({ path: source.path, source })));
    return loaded.skills.map(({ skill, source }) => ({ ...skill, source }));
  };
}
