import { isAdminRole } from '../auth/rbac.js';
import type { Skill, SkillProductRecord, SkillViewer } from './product.js';

export function isSkillRecordVisibleTo(record: SkillProductRecord, viewer?: SkillViewer): boolean {
  if (!viewer?.tenantId) return false;
  const tenantAllowed = record.tenantId === viewer.tenantId
    || record.allowedTenantIds?.includes(viewer.tenantId) === true;
  if (!tenantAllowed) return false;
  if (record.allowedRoles?.length && (!viewer.role || !record.allowedRoles.includes(viewer.role))) return false;
  if (record.visibility === 'private') return Boolean(viewer.userId) && record.ownerId === viewer.userId;
  return true;
}

export function isSkillRecordAvailableTo(record: SkillProductRecord, viewer?: SkillViewer): boolean {
  return record.enabled && record.reviewed && isSkillRecordVisibleTo(record, viewer);
}

export function isSkillVisibleTo(skill: Skill, viewer?: SkillViewer): boolean {
  return isSkillRecordVisibleTo(skill.product, viewer);
}

export function canManageSkill(skill: Skill, viewer?: SkillViewer): boolean {
  if (!isSkillVisibleTo(skill, viewer)) return false;
  if (skill.owner) return Boolean(viewer?.userId) && skill.owner === viewer?.userId;
  return viewer?.role ? isAdminRole(viewer.role) : false;
}
