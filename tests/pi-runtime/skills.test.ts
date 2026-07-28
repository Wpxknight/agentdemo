import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { afterEach, describe, expect, it } from 'vitest';
import { formatSkillsForSystemPrompt, loadSourcedSkills } from '../../packages/pi-runtime/src/index.js';

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
});
