import {
  loadAvailableSkills,
  type PiAvailableSkillLoader,
} from '@aiop/pi-runtime';
import type { ExecutionEnv, Skill as PiSkill, SkillDiagnostic } from '@earendil-works/pi-agent-core';
import type { SkillProductRecord, SkillViewer } from './product.js';

export type ProductSkillLoader = PiAvailableSkillLoader<SkillProductRecord>;

export class SkillProductService {
  constructor(
    private readonly env: ExecutionEnv,
    private readonly loader?: ProductSkillLoader,
  ) {}

  async load(records: readonly SkillProductRecord[], viewer: SkillViewer): Promise<{
    skills: Array<{ skill: PiSkill; source: SkillProductRecord }>;
    diagnostics: Array<SkillDiagnostic & { source: SkillProductRecord }>;
  }> {
    const result = await loadAvailableSkills(this.env, records, requireIdentity(viewer), {
      loader: this.loader,
    });
    return {
      skills: result.loaded.map(({ skill, product }) => ({ skill, source: product })),
      diagnostics: result.diagnostics,
    };
  }

  async prompt(records: readonly SkillProductRecord[], viewer: SkillViewer): Promise<string> {
    return (await loadAvailableSkills(this.env, records, requireIdentity(viewer), {
      loader: this.loader,
    })).prompt;
  }
}

function requireIdentity(viewer: SkillViewer): { tenantId: string; userId?: string; role?: string } {
  if (!viewer.tenantId) throw new Error('Skill 加载需要租户身份');
  return { tenantId: viewer.tenantId, userId: viewer.userId, role: viewer.role };
}
