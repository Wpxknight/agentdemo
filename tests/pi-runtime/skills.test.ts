import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatSkillsForSystemPrompt,
  loadAvailableSkills,
  loadSourcedSkills,
  type PiSkillProduct,
} from '../../packages/pi-runtime/src/index.js';

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('Pi skills bridge', () => {
  it('does not invoke the Pi loader when governance rejects every product', async () => {
    const loader = vi.fn();
    const formatter = vi.fn(() => '');
    const product: PiSkillProduct = {
      id: 'unreviewed', name: 'unreviewed', path: '/skills/unreviewed', version: '1',
      tenantId: 'tenant-a', visibility: 'public', enabled: true, reviewed: false,
    };

    const result = await loadAvailableSkills(
      {} as never,
      [product],
      { tenantId: 'tenant-a', userId: 'user-a', role: 'user' },
      { loader, formatter },
    );

    expect(loader).not.toHaveBeenCalled();
    expect(formatter).toHaveBeenCalledWith([]);
    expect(result).toEqual({ skills: [], loaded: [], prompt: '', diagnostics: [] });
  });

  it('filters product sources before Pi loading and returns skills, prompt, and diagnostics', async () => {
    const products: PiSkillProduct[] = [
      { id: 'allowed', name: 'allowed', path: '/skills/allowed', version: '1', tenantId: 'tenant-a', ownerUserId: 'user-a', visibility: 'private', enabled: true, reviewed: true, allowedRoles: ['user'] },
      { id: 'disabled', name: 'disabled', path: '/skills/disabled', version: '1', tenantId: 'tenant-a', visibility: 'public', enabled: false, reviewed: true },
      { id: 'unreviewed', name: 'unreviewed', path: '/skills/unreviewed', version: '1', tenantId: 'tenant-a', visibility: 'public', enabled: true, reviewed: false },
      { id: 'foreign', name: 'foreign', path: '/skills/foreign', version: '1', tenantId: 'tenant-b', visibility: 'public', enabled: true, reviewed: true },
      { id: 'admin', name: 'admin', path: '/skills/admin', version: '1', tenantId: 'tenant-a', visibility: 'shared', enabled: true, reviewed: true, allowedRoles: ['tenant_admin'] },
    ];
    const loader = vi.fn(async (_env, sources: Array<{ path: string; source: PiSkillProduct }>) => ({
      skills: sources.map(({ path, source }) => ({
        source,
        skill: { name: source.name, description: source.name, content: source.name, filePath: join(path, 'SKILL.md') },
      })),
      diagnostics: [{ type: 'warning' as const, code: 'read_failed' as const, message: 'fixture', path: '/fixture', source: sources[0]!.source }],
    }));
    const formatter = vi.fn((skills: Array<{ name: string }>) => skills.map((skill) => skill.name).join(','));

    const result = await loadAvailableSkills(
      {} as never,
      products,
      { tenantId: 'tenant-a', userId: 'user-a', role: 'user' },
      { loader, formatter: formatter as never },
    );

    expect(loader.mock.calls[0]![1].map((item) => item.source.id)).toEqual(['allowed']);
    expect(result.skills.map((skill) => skill.name)).toEqual(['allowed']);
    expect(result.loaded.map((item) => item.product.id)).toEqual(['allowed']);
    expect(result.prompt).toBe('allowed');
    expect(result.diagnostics).toHaveLength(1);
    expect(formatter).toHaveBeenCalledWith(result.skills);
  });

  it('drops Pi skills whose loaded name does not match the canonical product name', async () => {
    const product: PiSkillProduct = {
      id: 'canonical', name: 'canonical', path: '/skills/canonical', version: '1',
      tenantId: 'tenant-a', visibility: 'public', enabled: true, reviewed: true,
    };
    const loader = vi.fn(async () => ({
      skills: [{
        source: product,
        skill: { name: 'different', description: 'different', content: 'body', filePath: '/skills/canonical/SKILL.md' },
      }],
      diagnostics: [],
    }));

    const result = await loadAvailableSkills(
      {} as never,
      [product],
      { tenantId: 'tenant-a', userId: 'user-a', role: 'user' },
      { loader },
    );

    expect(result.skills).toEqual([]);
    expect(result.loaded).toEqual([]);
    expect(result.prompt).toBe('');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'invalid_metadata', source: product }),
    ]);
  });

  it('drops a same-name Pi skill loaded from outside the product root SKILL.md', async () => {
    const product: PiSkillProduct = {
      id: 'canonical', name: 'canonical', path: '/skills/canonical', version: '1',
      tenantId: 'tenant-a', visibility: 'public', enabled: true, reviewed: true,
    };
    const loader = vi.fn(async () => ({
      skills: [{
        source: product,
        skill: { name: 'canonical', description: 'nested', content: 'nested', filePath: '/skills/canonical/nested/SKILL.md' },
      }],
      diagnostics: [],
    }));

    const result = await loadAvailableSkills(
      {} as never,
      [product],
      { tenantId: 'tenant-a', userId: 'user-a', role: 'user' },
      { loader },
    );

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'invalid_metadata', source: product }),
    ]);
  });

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
