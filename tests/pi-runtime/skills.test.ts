import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatSkillsForSystemPrompt,
  loadAvailableSkills,
  loadSourcedSkills,
  type GovernedSkillSource,
} from '../../packages/pi-runtime/src/index.js';

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('Pi skills bridge', () => {
  it('loads sourced skills with Pi and formats the model-visible system block', async () => {
    await mkdir(resolve('dist'), { recursive: true });
    const root = await mkdtemp(join(resolve('dist'), 'pi-runtime-skills-'));
    fixtures.push(root);
    const skillDir = join(root, 'demo');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\nUse the demo workflow.\n');
    const env = new NodeExecutionEnv({ cwd: root });
    const loaded = await loadSourcedSkills(env, [{ path: root, source: { kind: 'fixture' } }]);

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0]!.source).toEqual({ kind: 'fixture' });
    expect(formatSkillsForSystemPrompt(loaded.skills.map(({ skill }) => skill))).toContain('demo');
    await env.cleanup();
  });

  it('passes only reviewed, audited and identity-visible product sources to the Pi loader', async () => {
    const allowed = {
      path: '/skills/allowed',
      source: {
        id: 'allowed', version: 'v1', enabled: true, reviewed: true, audited: true,
        tenantIds: ['tenant-a'], visibility: 'private', ownerId: 'user-a', allowedRoles: ['user'],
      },
    } satisfies GovernedSkillSource;
    const hidden: GovernedSkillSource[] = [
      { path: '/skills/unreviewed', source: { id: 'unreviewed', version: 'v1', enabled: true, reviewed: false, audited: true } },
      { path: '/skills/unaudited', source: { id: 'unaudited', version: 'v1', enabled: true, reviewed: true, audited: false } },
      { path: '/skills/disabled', source: { id: 'disabled', version: 'v1', enabled: false, reviewed: true, audited: true } },
      { path: '/skills/foreign', source: { id: 'foreign', version: 'v1', enabled: true, reviewed: true, audited: true, tenantIds: ['tenant-b'] } },
      { path: '/skills/private', source: { id: 'private', version: 'v1', enabled: true, reviewed: true, audited: true, visibility: 'private', ownerId: 'other-user' } },
      { path: '/skills/admin', source: { id: 'admin', version: 'v1', enabled: true, reviewed: true, audited: true, allowedRoles: ['tenant_admin'] } },
    ];
    const piSkill = {
      name: 'allowed', description: 'Pi formatted skill',
      content: 'Use Pi.', filePath: '/skills/allowed/SKILL.md',
    };
    const loader = vi.fn(async (_env, sources) => ({
      skills: [{ skill: piSkill, source: sources[0]!.source }], diagnostics: [],
    }));

    const result = await loadAvailableSkills(
      {} as never,
      { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      [allowed, ...hidden],
      loader,
    );

    expect(loader).toHaveBeenCalledOnce();
    expect(loader.mock.calls[0]![1]).toEqual([allowed]);
    expect(result.skills).toEqual([piSkill]);
    expect(result.prompt).toBe(formatSkillsForSystemPrompt([piSkill]));
  });
});
