import { isAdminRole } from '../auth/rbac.js';
import type { Skill, SkillViewer } from './product.js';

export function isSkillVisibleTo(skill: Skill, viewer?: SkillViewer): boolean {
  if (skill.visibility === 'public' || skill.visibility === 'shared') return true;
  return Boolean(viewer?.userId) && skill.owner === viewer?.userId;
}

export function canManageSkill(skill: Skill, viewer?: SkillViewer): boolean {
  if (skill.owner) return Boolean(viewer?.userId) && skill.owner === viewer?.userId;
  return viewer?.role ? isAdminRole(viewer.role) : false;
}
