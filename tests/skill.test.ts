import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillRegistry, parseFrontmatter } from '../src/skill/registry.js';

describe('parseFrontmatter', () => {
  it('parses key: value and strips quotes', () => {
    const { attrs, body } = parseFrontmatter(
      '---\nname: demo\ndescription: "做演示"\n---\n正文内容',
    );
    expect(attrs.name).toBe('demo');
    expect(attrs.description).toBe('做演示');
    expect(body).toBe('正文内容');
  });

  it('returns raw body when no frontmatter', () => {
    const { attrs, body } = parseFrontmatter('just text');
    expect(attrs).toEqual({});
    expect(body).toBe('just text');
  });
});

describe('SkillRegistry', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aiop-skills-'));
    const inspect = join(dir, 'inspect');
    await mkdir(inspect);
    await writeFile(
      join(inspect, 'SKILL.md'),
      '---\nname: inspect\ndescription: 集群巡检\n---\n# 巡检步骤\n1. kubectl get pods',
    );
    await writeFile(join(inspect, 'helper.sh'), 'echo hi');
    // 一个无 SKILL.md 的目录应被跳过
    await mkdir(join(dir, 'broken'));
  });

  afterAll(async () => {
    // tmp 目录留给 OS 清理
  });

  it('scans skills and exposes summaries', async () => {
    const reg = new SkillRegistry(dir);
    await reg.scan();

    expect(reg.list().map((s) => s.name)).toEqual(['inspect']);
    expect(reg.summaries()).toContain('inspect: 集群巡检');
    expect(reg.summaries()).toContain('用户请求与某个技能描述匹配时，请先调用 load_skill');
  });

  it('load_skill returns full body and lists bundled files', async () => {
    const reg = new SkillRegistry(dir);
    await reg.scan();
    const tool = reg.tool();

    const res = await tool.run({ name: 'inspect' }, { sessionId: 's1' });
    expect(res.content).toContain('# 巡检步骤');
    expect(res.content).toContain('helper.sh');

    const miss = await tool.run({ name: 'nope' }, { sessionId: 's1' });
    expect(miss.isError).toBe(true);
  });

  it('missing dir degrades gracefully', async () => {
    const reg = new SkillRegistry(join(dir, 'does-not-exist'));
    await reg.scan();
    expect(reg.list()).toEqual([]);
    expect(reg.summaries()).toBe('');
  });
});
