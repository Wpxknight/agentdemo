import { isAdminRole } from '../auth/rbac.js';
import type { Skill, SkillProductRecord, SkillViewer } from './product.js';

export function isSkillRecordVisibleTo(record: SkillProductRecord, viewer?: SkillViewer): boolean {
  if (!viewer?.tenantId) return false;
  const tenantAllowed = record.tenantId === viewer.tenantId
    || record.allowedTenantIds?.includes(viewer.tenantId) === true
    || record.allowedTenantIds?.includes('*') === true;
  if (!tenantAllowed) return false;
  if (record.allowedRoles?.length && (!viewer.role || !record.allowedRoles.includes(viewer.role))) return false;
  if (!record.reviewed && record.tenantId === viewer.tenantId && viewer.role && isAdminRole(viewer.role)) return true;
  if (record.visibility === 'private') {
    if (!record.ownerUserId && record.tenantId === viewer.tenantId && viewer.role && isAdminRole(viewer.role)) return true;
    return Boolean(viewer.userId)
      && (record.ownerUserId === viewer.userId || record.submittedByUserId === viewer.userId);
  }
  return true;
}

export function isSkillVisibleTo(skill: Skill, viewer?: SkillViewer): boolean {
  return isSkillRecordVisibleTo(skill.product, viewer);
}

export function canManageSkill(skill: Skill, viewer?: SkillViewer): boolean {
  if (!isSkillVisibleTo(skill, viewer)) return false;
  if (!skill.reviewed && skill.tenantId === viewer?.tenantId && viewer?.role && isAdminRole(viewer.role)) return true;
  if (skill.owner) return Boolean(viewer?.userId) && skill.owner === viewer?.userId;
  if (skill.product.allowedTenantIds?.includes('*')) return viewer?.role === 'platform_admin';
  return skill.tenantId === viewer?.tenantId && Boolean(viewer?.role && isAdminRole(viewer.role));
}
