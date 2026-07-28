import { formatSkillsForSystemPrompt, loadSourcedSkills } from '@aiop/pi-runtime';
import type { ExecutionEnv, Skill as PiSkill, SkillDiagnostic } from '@earendil-works/pi-agent-core';
import type { SkillProductRecord, SkillViewer } from './product.js';
import { isSkillRecordAvailableTo } from './visibility.js';

export type ProductSkillLoader = (
  env: ExecutionEnv,
  sources: Array<{ path: string; source: SkillProductRecord }>,
) => Promise<{
  skills: Array<{ skill: PiSkill; source: SkillProductRecord }>;
  diagnostics: Array<SkillDiagnostic & { source: SkillProductRecord }>;
}>;

export class SkillProductService {
  constructor(
    private readonly env: ExecutionEnv,
    private readonly loader: ProductSkillLoader = loadSourcedSkills,
  ) {}

  async load(records: readonly SkillProductRecord[], viewer: SkillViewer): Promise<{
    skills: Array<{ skill: PiSkill; source: SkillProductRecord }>;
    diagnostics: Array<SkillDiagnostic & { source: SkillProductRecord }>;
  }> {
    const visibleSources = records
      .filter((record) => isSkillRecordAvailableTo(record, viewer))
      .map((source) => ({ path: source.path, source }));
    return this.loader(this.env, visibleSources);
  }

  async prompt(records: readonly SkillProductRecord[], viewer: SkillViewer): Promise<string> {
    const loaded = await this.load(records, viewer);
    return formatSkillsForSystemPrompt(loaded.skills.map(({ skill }) => skill));
  }
}
