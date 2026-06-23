import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillRegistry, parseFrontmatter } from '../src/skill/registry.js';
import { importSkillZip } from '../src/skill/import.js';

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function testZip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(0, 34);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centralParts.reduce((n, part) => n + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

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

  it('exposes file metadata and reads directory contents safely', async () => {
    const nested = join(dir, 'inspect', 'scripts');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'run.sh'), 'echo nested');
    const reg = new SkillRegistry(dir);
    await reg.scan();

    const skill = reg.list()[0]!;
    expect(skill.files.map((file) => file.path)).toContain('SKILL.md');
    expect(skill.files.map((file) => file.path)).toContain('scripts');
    expect(skill.files.map((file) => file.path)).toContain('scripts/run.sh');
    expect(skill.files.find((file) => file.path === 'scripts')?.isDirectory).toBe(true);
    expect(skill.files.find((file) => file.path === 'SKILL.md')).toMatchObject({
      path: 'SKILL.md',
      name: 'SKILL.md',
      isDirectory: false,
      size: expect.any(Number),
      updatedAt: expect.any(String),
    });

    await expect(reg.readFile('inspect', 'SKILL.md')).resolves.toMatchObject({
      path: 'SKILL.md',
      content: expect.stringContaining('# 巡检步骤'),
      entry: expect.objectContaining({ path: 'SKILL.md', isDirectory: false }),
    });
    await expect(reg.listDir('inspect', 'scripts')).resolves.toEqual([
      expect.objectContaining({ path: 'scripts/run.sh', isDirectory: false }),
    ]);
    await expect(reg.readFile('inspect', '../escape.txt')).rejects.toThrow('非法技能文件路径');
  });

  it('disables, enables, and deletes skills without exposing disabled skills to load_skill', async () => {
    const reg = new SkillRegistry(dir);
    await reg.scan();

    await reg.setEnabled('inspect', false);
    expect(reg.list().find((skill) => skill.name === 'inspect')?.enabled).toBe(false);
    expect(reg.summaries()).not.toContain('inspect: 集群巡检');
    const disabled = await reg.tool().run({ name: 'inspect' }, { sessionId: 's1' });
    expect(disabled.isError).toBe(true);
    expect(disabled.content).toContain('技能已禁用');

    await reg.setEnabled('inspect', true);
    expect(reg.list().find((skill) => skill.name === 'inspect')?.enabled).toBe(true);
    expect(reg.summaries()).toContain('inspect: 集群巡检');

    await reg.delete('inspect');
    await expect(stat(join(dir, 'inspect'))).rejects.toThrow();
    expect(reg.list().map((skill) => skill.name)).toEqual([]);
  });

  it('missing dir degrades gracefully', async () => {
    const reg = new SkillRegistry(join(dir, 'does-not-exist'));
    await reg.scan();
    expect(reg.list()).toEqual([]);
    expect(reg.summaries()).toBe('');
  });
});

describe('importSkillZip', () => {
  it('extracts a zip with root SKILL.md into a named skill directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-import-skill-'));
    const zip = testZip({
      'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo',
      'scripts/run.sh': 'echo demo',
    });

    const result = await importSkillZip({ rootDir: root, filename: 'demo.zip', data: zip });

    expect(result.skillDir).toBe(join(root, 'demo'));
    expect(result.files.sort()).toEqual(['SKILL.md', 'scripts/run.sh']);
    await expect(readFile(join(root, 'demo', 'SKILL.md'), 'utf8')).resolves.toContain('Demo skill');
    await expect(readFile(join(root, 'demo', 'scripts', 'run.sh'), 'utf8')).resolves.toBe('echo demo');
  });

  it('rejects zip entries that escape the skills directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-import-skill-bad-'));
    const zip = testZip({ '../escape.txt': 'nope' });

    await expect(importSkillZip({ rootDir: root, filename: 'bad.zip', data: zip })).rejects.toThrow('非法 zip 路径');
  });
});
