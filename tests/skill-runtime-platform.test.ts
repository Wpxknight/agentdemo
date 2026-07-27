import { describe, expect, it } from 'vitest';
import { SkillRuntime } from '../packages/skill-runtime/src/index.js';

describe('SkillRuntime', () => {
  it('applies enabled, tenant and version governance around Pi-compatible skills', async () => {
    const runtime = new SkillRuntime(async () => [{
      name: 'netdiag', description: 'network diagnostics', content: 'Run diagnostics', filePath: '/skills/netdiag/SKILL.md',
      source: { path: '/skills/netdiag', version: 'v2', enabled: true, tenantIds: ['tenant-a'] },
    }, {
      name: 'hidden', description: 'hidden', content: 'hidden', filePath: '/skills/hidden/SKILL.md',
      source: { path: '/skills/hidden', version: 'v1', enabled: false },
    }]);
    const resolved = await runtime.resolve({ tenantId: 'tenant-a', sources: [] });
    expect(resolved.version).toBe('netdiag@v2');
    expect(resolved.skills.map((skill) => skill.name)).toEqual(['netdiag']);
    expect(await runtime.render(resolved.skills[0]!, 'focus on DNS')).toContain('focus on DNS');
    expect((await runtime.resolve({ tenantId: 'tenant-b', sources: [] })).skills).toEqual([]);
  });
});
