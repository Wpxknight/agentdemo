// file: index.d.ts
import { type Skill } from '@earendil-works/pi-agent-core';
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
    diagnostics: Array<{
        code: string;
        message: string;
        path: string;
    }>;
}
export type SkillLoader = (sources: readonly SkillSource[]) => Promise<GovernedSkill[]>;
export declare class SkillRuntime {
    private readonly loader;
    constructor(loader: SkillLoader);
    resolve(input: ResolveSkillsInput): Promise<ResolvedSkillSet>;
    render(skill: GovernedSkill, additionalInstructions?: string): Promise<string>;
}
export declare function createPiSkillLoader(environment: unknown): SkillLoader;
