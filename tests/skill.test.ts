import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from '../src/skill/registry.js';
import { importSkillZip } from '../src/skill/import.js';
import { normalizeCredentialFile, type SkillProductRecord } from '../src/skill/product.js';

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

async function writeProduct(dir: string, metadata: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, '.product.json'), `${JSON.stringify(metadata, null, 2)}\n`);
}

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
    await writeProduct(inspect, {
      name: 'inspect', version: '1.0.0', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    });
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
    const prompt = await reg.summariesFor({ tenantId: 'default', userId: 'u', role: 'user' });
    expect(prompt).toContain('<name>inspect</name>');
    expect(prompt).toContain('<description>集群巡检</description>');
    expect(prompt).toContain(`<location>${join(dir, 'inspect', 'SKILL.md')}</location>`);
  });

  it('ignores reserved and hidden directories at every product-source level', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-hidden-skill-sources-'));
    const hiddenRecords = [
      { path: join(root, '.aiop-locks', 'lock-as-skill'), tenantId: 'default' },
      { path: join(root, '.aiop-imports', 'import-as-skill'), tenantId: 'default' },
      { path: join(root, '.hidden'), tenantId: 'default' },
      { path: join(root, '_public', '.hidden'), tenantId: 'default' },
      { path: join(root, 'users', 'owner', '.hidden'), tenantId: 'default', ownerUserId: 'owner' },
      { path: join(root, 'tenants', 'tenant-a', '.hidden'), tenantId: 'tenant-a' },
      { path: join(root, 'tenants', 'tenant-a', '_public', '.hidden'), tenantId: 'tenant-a' },
      { path: join(root, 'tenants', 'tenant-a', 'users', 'owner', '.hidden'), tenantId: 'tenant-a', ownerUserId: 'owner' },
    ];
    for (const [index, record] of hiddenRecords.entries()) {
      await mkdir(record.path, { recursive: true });
      await writeFile(join(record.path, 'SKILL.md'), `---\nname: hidden-${index}\ndescription: hidden\n---\nbody`);
      await writeProduct(record.path, {
        name: `hidden-${index}`, version: '1', enabled: true, reviewed: true,
        tenantId: record.tenantId, ownerUserId: record.ownerUserId,
        visibility: record.ownerUserId ? 'private' : 'public',
      });
    }
    const loadedSourceCounts: number[] = [];
    const registry = new SkillRegistry(root, {
      loader: async (_env, sources) => {
        loadedSourceCounts.push(sources.length);
        return { skills: [], diagnostics: [] };
      },
    });

    await registry.scan();
    await registry.listLoadedFor({ tenantId: 'default', userId: 'owner', role: 'user' });

    expect(registry.list()).toEqual([]);
    expect(loadedSourceCounts).toEqual([]);
  });

  it('load_skill returns full body and lists bundled files', async () => {
    const reg = new SkillRegistry(dir);
    await reg.scan();
    const tool = reg.tool();

    const res = await tool.run({ name: 'inspect' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(res.content).toContain('# 巡检步骤');
    expect(res.content).toContain('helper.sh');

    const miss = await tool.run({ name: 'nope' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(miss.isError).toBe(true);
  });

  it('exposes file metadata and reads directory contents safely', async () => {
    const nested = join(dir, 'inspect', 'scripts');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'run.sh'), 'echo nested');
    const reg = new SkillRegistry(dir);
    await reg.scan();

    const skill = (await reg.loadFor('inspect', { tenantId: 'default', userId: 'u', role: 'user' }))!;
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

    const viewer = { tenantId: 'default', userId: 'u', role: 'user' as const };
    await expect(reg.readFile('inspect', 'SKILL.md', viewer)).resolves.toMatchObject({
      path: 'SKILL.md',
      content: expect.stringContaining('# 巡检步骤'),
      entry: expect.objectContaining({ path: 'SKILL.md', isDirectory: false }),
    });
    await expect(reg.listDir('inspect', 'scripts', viewer)).resolves.toEqual([
      expect.objectContaining({ path: 'scripts/run.sh', isDirectory: false }),
    ]);
    await expect(reg.readFile('inspect', '../escape.txt', viewer)).rejects.toThrow('非法技能文件路径');
  });

  it('disables, enables, and deletes skills without exposing disabled skills to load_skill', async () => {
    const reg = new SkillRegistry(dir);
    await reg.scan();

    await reg.setEnabled('inspect', false);
    await reg.scan();
    expect(reg.list().find((skill) => skill.name === 'inspect')?.enabled).toBe(false);
    expect(await reg.summariesFor({ tenantId: 'default', userId: 'u', role: 'user' })).not.toContain('<name>inspect</name>');
    const disabled = await reg.tool().run({ name: 'inspect' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(disabled.isError).toBe(true);
    expect(disabled.content).toContain('技能已禁用');

    await reg.setEnabled('inspect', true);
    await reg.scan();
    expect(reg.list().find((skill) => skill.name === 'inspect')?.enabled).toBe(true);
    expect(await reg.summariesFor({ tenantId: 'default', userId: 'u', role: 'user' })).toContain('<name>inspect</name>');

    await reg.delete('inspect');
    await expect(stat(join(dir, 'inspect'))).rejects.toThrow();
    expect(reg.list().map((skill) => skill.name)).toEqual([]);
  });

  it('missing dir degrades gracefully', async () => {
    const reg = new SkillRegistry(join(dir, 'does-not-exist'));
    await reg.scan();
    expect(reg.list()).toEqual([]);
    expect(await reg.summariesFor({ tenantId: 'default', userId: 'u', role: 'user' })).toBe('');
  });
});

describe('SkillRegistry governed Pi loading', () => {
  it('loads reviewed built-in products through their explicit platform-global tenant contract', async () => {
    const reg = new SkillRegistry(resolve('skills'));
    await reg.scan();

    expect((await reg.listLoadedFor({ tenantId: 'tenant-other', userId: 'u', role: 'user' }))
      .map((skill) => skill.name).sort()).toEqual(['aios-request', 'aios-sandbox', 'netdiag']);
  });

  it('exposes only successfully loaded canonical Pi skills across list and lookup', async () => {
    const records: SkillProductRecord[] = [
      { id: 'valid', name: 'valid', path: '/skills/valid', version: '1', tenantId: 'tenant-a', visibility: 'public', enabled: true, reviewed: true },
      { id: 'missing', name: 'missing', path: '/skills/missing', version: '1', tenantId: 'tenant-a', visibility: 'public', enabled: true, reviewed: true },
      { id: 'mismatch', name: 'canonical', path: '/skills/mismatch', version: '1', tenantId: 'tenant-a', visibility: 'public', enabled: true, reviewed: true },
    ];
    const loader = vi.fn(async () => ({
      skills: [
        { source: records[0]!, skill: { name: 'valid', description: 'valid', content: 'valid', filePath: '/skills/valid/SKILL.md' } },
        { source: records[2]!, skill: { name: 'different', description: 'different', content: 'different', filePath: '/skills/mismatch/SKILL.md' } },
      ],
      diagnostics: [{ type: 'warning' as const, code: 'read_failed' as const, message: 'missing', path: '/skills/missing', source: records[1]! }],
    }));
    const reg = new SkillRegistry('/unused', { records, loader, env: {} as never });
    await reg.scan();
    const viewer = { tenantId: 'tenant-a', userId: 'user-a', role: 'user' as const };

    expect((await reg.listLoadedFor(viewer)).map((skill) => skill.name)).toEqual(['valid']);
    expect(await reg.loadFor('missing', viewer)).toBeUndefined();
    expect(await reg.loadFor('canonical', viewer)).toBeUndefined();
    expect(await reg.getAvailableFor('canonical', viewer)).toBeUndefined();
    await expect(reg.readFile('canonical', 'SKILL.md', viewer)).rejects.toThrow('未找到技能 canonical');
  });

  it('fails closed on real filesystem product metadata before invoking Pi', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-products-'));
    const fixtures = [
      ['tenant-a', 'allowed', { name: 'allowed', version: '1', enabled: true, reviewed: true, tenantId: 'tenant-a', visibility: 'public' }],
      ['tenant-a', 'unreviewed', { name: 'unreviewed', version: '1', enabled: true, reviewed: false, tenantId: 'tenant-a', visibility: 'public' }],
      ['tenant-a', 'admin-only', { name: 'admin-only', version: '1', enabled: true, reviewed: true, tenantId: 'tenant-a', visibility: 'public', allowedRoles: ['tenant_admin'] }],
      ['tenant-b', 'foreign', { name: 'foreign', version: '1', enabled: true, reviewed: true, tenantId: 'tenant-b', visibility: 'public' }],
    ] as const;
    for (const [tenantId, name, metadata] of fixtures) {
      const skillDir = join(root, 'tenants', tenantId, '_public', name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nbody`);
      await writeProduct(skillDir, metadata);
    }
    for (const name of ['invalid', 'incomplete', 'missing']) {
      const skillDir = join(root, name);
      await mkdir(skillDir);
      await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nbody`);
      if (name === 'invalid') await writeFile(join(skillDir, '.product.json'), '{ broken');
      if (name === 'incomplete') await writeProduct(skillDir, {
        name, version: '1', enabled: true, tenantId: 'default', visibility: 'public',
      });
    }
    const loader = vi.fn(async (_env, sources: Array<{ path: string; source: SkillProductRecord }>) => ({
      skills: sources.map(({ path, source }) => ({
        source,
        skill: { name: source.name, description: source.name, content: 'body', filePath: join(path, 'SKILL.md') },
      })),
      diagnostics: [],
    }));
    const reg = new SkillRegistry(root, { loader, env: {} as never });
    await reg.scan();
    const viewer = { tenantId: 'tenant-a', userId: 'user-a', role: 'user' as const };

    expect(reg.list().map((skill) => skill.name)).toEqual(['admin-only', 'allowed', 'unreviewed', 'foreign']);
    expect((await reg.listLoadedFor(viewer)).map((skill) => skill.name)).toEqual(['allowed']);
    expect(await reg.summariesFor(viewer)).toContain('<name>allowed</name>');
    expect(await reg.loadFor('unreviewed', viewer)).toBeUndefined();
    for (const call of loader.mock.calls) expect(call[1].map((item) => item.source.name)).toEqual(['allowed']);
  });

  it('filters actual product records before every Pi loader call', async () => {
    const records: SkillProductRecord[] = [
      { id: 'allowed', name: 'allowed', path: '/skills/allowed', version: '1', tenantId: 'tenant-a', ownerUserId: 'user-a', visibility: 'private', enabled: true, reviewed: true, allowedRoles: ['user'] },
      { id: 'disabled', name: 'disabled', path: '/skills/disabled', version: '1', tenantId: 'tenant-a', visibility: 'public', enabled: false, reviewed: true },
      { id: 'unreviewed', name: 'unreviewed', path: '/skills/unreviewed', version: '1', tenantId: 'tenant-a', visibility: 'public', enabled: true, reviewed: false },
      { id: 'foreign', name: 'foreign', path: '/skills/foreign', version: '1', tenantId: 'tenant-b', visibility: 'public', enabled: true, reviewed: true },
      { id: 'other-owner', name: 'other-owner', path: '/skills/other-owner', version: '1', tenantId: 'tenant-a', ownerUserId: 'user-b', visibility: 'private', enabled: true, reviewed: true },
      { id: 'admin-only', name: 'admin-only', path: '/skills/admin-only', version: '1', tenantId: 'tenant-a', visibility: 'shared', enabled: true, reviewed: true, allowedRoles: ['tenant_admin'] },
    ];
    const loader = vi.fn(async (_env, sources: Array<{ path: string; source: SkillProductRecord }>) => ({
      skills: sources.map(({ path, source }) => ({
        source,
        skill: { name: source.name, description: 'loaded by Pi', content: 'Pi body', filePath: join(path, 'SKILL.md') },
      })),
      diagnostics: [],
    }));
    const reg = new SkillRegistry('/unused', { records, loader, env: {} as never });
    await reg.scan();
    const viewer = { tenantId: 'tenant-a', userId: 'user-a', role: 'user' as const };

    const prompt = await reg.summariesFor(viewer);
    expect(prompt).toContain('<name>allowed</name>');
    expect((await reg.listLoadedFor(viewer)).map((skill) => skill.name)).toEqual(['allowed']);
    const loaded = await reg.tool().run({ name: 'allowed' }, { sessionId: 's', ...viewer });
    expect(loaded.content).toContain('Pi body');
    expect(loader).toHaveBeenCalled();
    for (const call of loader.mock.calls) expect(call[1].map((item) => item.source.id)).toEqual(['allowed']);
    expect(await reg.getAvailableFor('disabled', viewer)).toBeUndefined();
    expect(await reg.getAvailableFor('unreviewed', viewer)).toBeUndefined();
    expect(reg.listFor({ ...viewer, tenantId: 'tenant-b' }).map((skill) => skill.name)).toEqual(['foreign']);
    expect(reg.listFor({ ...viewer, tenantId: 'tenant-c' })).toEqual([]);
  });
});

describe('SkillRegistry upload review governance', () => {
  it('rejects review when the uploaded product name does not match canonical SKILL.md metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-name-'));
    const skillDir = join(root, 'users', 'uploader', 'expected');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: different\ndescription: mismatch\n---\nbody');
    await writeProduct(skillDir, { name: 'expected', version: '1', reviewed: true });
    const reg = new SkillRegistry(root);

    await reg.installUploadedProduct(skillDir, {
      tenantId: 'default', userId: 'uploader', role: 'user',
    });
    await reg.scan();

    await expect(reg.review('expected', {
      tenantId: 'default', userId: 'reviewer', role: 'tenant_admin',
    })).rejects.toThrow('诊断');
    expect(reg.get('expected')?.reviewed).toBe(false);
  });

  it('rejects review on Pi invalid-metadata diagnostics and keeps the skill pending and absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-diagnostic-'));
    const skillDir = join(root, 'users', 'uploader', 'bad_name');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: bad_name\ndescription: invalid Pi name\n---\nbody');
    await writeProduct(skillDir, { name: 'bad_name', version: '1' });
    const reg = new SkillRegistry(root);
    await reg.installUploadedProduct(skillDir, {
      tenantId: 'default', userId: 'uploader', role: 'user',
    });
    await reg.scan();

    await expect(reg.review('bad_name', {
      tenantId: 'default', userId: 'reviewer', role: 'tenant_admin',
    })).rejects.toThrow('诊断');
    expect(JSON.parse(await readFile(join(skillDir, '.product.json'), 'utf8'))).toMatchObject({ reviewed: false });
    expect(await reg.summariesFor({ tenantId: 'default', userId: 'uploader', role: 'user' })).toBe('');
    expect(await reg.loadFor('bad_name', { tenantId: 'default', userId: 'uploader', role: 'user' })).toBeUndefined();
  });

  it('forbids an admin uploader from reviewing their own pending skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-self-review-'));
    const skillDir = join(root, 'users', 'admin', 'owned');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: owned\ndescription: owned\n---\nbody');
    await writeProduct(skillDir, {
      name: 'owned', version: '1', enabled: true, reviewed: false,
      tenantId: 'default', ownerUserId: 'admin', visibility: 'private',
    });
    const reg = new SkillRegistry(root);
    await reg.scan();

    await expect(reg.review('owned', {
      tenantId: 'default', userId: 'admin', role: 'tenant_admin',
    })).rejects.toThrow('不能审核自己');
  });

  it('rejects ambiguous or repeated review transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-review-transition-'));
    for (const owner of ['u1', 'u2']) {
      const skillDir = join(root, 'users', owner, 'duplicate');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '---\nname: duplicate\ndescription: duplicate\n---\nbody');
      await writeProduct(skillDir, {
        name: 'duplicate', version: '1', enabled: true, reviewed: false,
        tenantId: 'default', ownerUserId: owner, visibility: 'private',
      });
    }
    const reviewedDir = join(root, 'users', 'u3', 'published');
    await mkdir(reviewedDir, { recursive: true });
    await writeFile(join(reviewedDir, 'SKILL.md'), '---\nname: published\ndescription: published\n---\nbody');
    await writeProduct(reviewedDir, {
      name: 'published', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', ownerUserId: 'u3', visibility: 'public', allowedTenantIds: ['*'],
    });
    const reg = new SkillRegistry(root);
    await reg.scan();
    const reviewer = { tenantId: 'default', userId: 'reviewer', role: 'tenant_admin' as const };

    await expect(reg.review('duplicate', reviewer)).rejects.toThrow('不唯一');
    await expect(reg.review('published', reviewer)).rejects.toThrow('已审核');
  });

  it('rejects a pending upload that collides with a same-name built-in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-review-target-'));
    const builtInDir = join(root, 'collision');
    await mkdir(builtInDir);
    await writeFile(join(builtInDir, 'SKILL.md'), '---\nname: collision\ndescription: built in\n---\nbody');
    await writeProduct(builtInDir, {
      name: 'collision', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public', allowedTenantIds: ['*'],
    });
    const uploadedDir = join(root, 'users', 'uploader', 'collision');
    await mkdir(uploadedDir, { recursive: true });
    await writeFile(join(uploadedDir, 'SKILL.md'), '---\nname: collision\ndescription: uploaded\n---\nbody');
    await writeProduct(uploadedDir, {
      name: 'collision', version: '2', enabled: true, reviewed: false,
      tenantId: 'default', ownerUserId: 'uploader', visibility: 'private',
    });
    const reg = new SkillRegistry(root);
    await reg.scan();

    const incomingDir = join(root, 'users', 'incoming', 'collision-copy');
    await mkdir(incomingDir, { recursive: true });
    await writeFile(join(incomingDir, 'SKILL.md'), '---\nname: collision\ndescription: incoming\n---\nbody');
    await writeProduct(incomingDir, { name: 'collision', version: '3' });
    await expect(reg.installUploadedProduct(incomingDir, {
      tenantId: 'default', userId: 'incoming', role: 'user',
    })).rejects.toThrow('名称冲突');

    await expect(reg.review('collision', {
      tenantId: 'default', userId: 'reviewer', role: 'tenant_admin',
    })).rejects.toThrow('名称冲突');
    expect(JSON.parse(await readFile(join(uploadedDir, '.product.json'), 'utf8'))).toMatchObject({ reviewed: false });
    expect(JSON.parse(await readFile(join(builtInDir, '.product.json'), 'utf8'))).toMatchObject({
      reviewed: true, visibility: 'public', allowedTenantIds: ['*'],
    });
  });

  it('rejects same-tenant reviewed and pending name collisions during upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-collision-'));
    for (const [owner, reviewed] of [['reviewed-owner', true], ['pending-owner', false]] as const) {
      const skillDir = join(root, 'users', owner, reviewed ? 'reviewed-name' : 'pending-name');
      await mkdir(skillDir, { recursive: true });
      const name = reviewed ? 'reviewed-name' : 'pending-name';
      await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: existing\n---\nbody`);
      await writeProduct(skillDir, {
        name, version: '1', enabled: true, reviewed,
        tenantId: 'default', ownerUserId: owner, visibility: 'private',
      });
    }
    const reg = new SkillRegistry(root);
    await reg.scan();
    for (const name of ['reviewed-name', 'pending-name']) {
      const incoming = join(root, 'users', 'incoming', `${name}-copy`);
      await mkdir(incoming, { recursive: true });
      await writeFile(join(incoming, 'SKILL.md'), `---\nname: ${name}\ndescription: incoming\n---\nbody`);
      await writeProduct(incoming, { name, version: '2' });
      await expect(reg.installUploadedProduct(incoming, {
        tenantId: 'default', userId: 'incoming', role: 'user',
      })).rejects.toThrow('名称冲突');
    }
  });

  it('allows tenant-private duplicate names across isolated tenants but rejects a global review collision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-global-collision-'));
    const defaultDir = join(root, 'users', 'default-owner', 'isolated');
    await mkdir(defaultDir, { recursive: true });
    await writeFile(join(defaultDir, 'SKILL.md'), '---\nname: isolated\ndescription: default\n---\nbody');
    await writeProduct(defaultDir, { name: 'isolated', version: '1' });
    const reg = new SkillRegistry(root);
    await reg.installUploadedProduct(defaultDir, {
      tenantId: 'default', userId: 'default-owner', role: 'user',
    });
    await reg.scan();
    const otherDir = join(root, 'tenants', 'other', 'users', 'other-owner', 'isolated');
    await mkdir(otherDir, { recursive: true });
    await writeFile(join(otherDir, 'SKILL.md'), '---\nname: isolated\ndescription: other\n---\nbody');
    await writeProduct(otherDir, { name: 'isolated', version: '1' });
    await expect(reg.installUploadedProduct(otherDir, {
      tenantId: 'other', userId: 'other-owner', role: 'user',
    })).resolves.toMatchObject({ name: 'isolated', reviewed: false });
    await reg.scan();

    await expect(reg.review('isolated', {
      tenantId: 'default', userId: 'platform-reviewer', role: 'platform_admin',
    }, { global: true })).rejects.toThrow('全局名称冲突');
  });

  it('skips ambiguous reviewed names consistently across list, prompt, and lookup', async () => {
    const records: SkillProductRecord[] = [
      { id: 'a', name: 'duplicate', path: '/skills/a', version: '1', tenantId: 'default', visibility: 'public', enabled: true, reviewed: true },
      { id: 'b', name: 'duplicate', path: '/skills/b', version: '1', tenantId: 'default', visibility: 'public', enabled: true, reviewed: true },
    ];
    const loader = vi.fn(async (_env, sources: Array<{ path: string; source: SkillProductRecord }>) => ({
      skills: sources.map(({ path, source }) => ({
        source,
        skill: { name: source.name, description: source.id, content: source.id, filePath: join(path, 'SKILL.md') },
      })),
      diagnostics: [],
    }));
    const reg = new SkillRegistry('/unused', { records, loader, env: {} as never });
    await reg.scan();
    const viewer = { tenantId: 'default', userId: 'u', role: 'user' as const };

    expect(await reg.listLoadedFor(viewer)).toEqual([]);
    expect(await reg.summariesFor(viewer)).toBe('');
    expect(await reg.loadFor('duplicate', viewer)).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });

  it('serializes concurrent same-tenant imports so only one duplicate name succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-concurrent-import-'));
    const reg = new SkillRegistry(root);
    await reg.scan();
    const dirs = ['u1', 'u2'].map((owner) => join(root, 'users', owner, `concurrent-${owner}`));
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), '---\nname: concurrent\ndescription: concurrent\n---\nbody');
      await writeProduct(dir, { name: 'concurrent', version: '1' });
    }

    const results = await Promise.allSettled(dirs.map((dir, index) => reg.installUploadedProduct(dir, {
      tenantId: 'default', userId: `u${index + 1}`, role: 'user',
    })));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(reg.list().filter((skill) => skill.name === 'concurrent')).toHaveLength(1);
  });

  it('serializes concurrent local and global review so persisted state matches the sole success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-concurrent-review-'));
    const skillDir = join(root, 'users', 'uploader', 'race-review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: race-review\ndescription: race review\n---\nbody');
    await writeProduct(skillDir, {
      name: 'race-review', version: '1', enabled: true, reviewed: false,
      tenantId: 'default', ownerUserId: 'uploader', visibility: 'private',
    });
    const reg = new SkillRegistry(root);
    await reg.scan();

    const results = await Promise.allSettled([
      reg.review('race-review', { tenantId: 'default', userId: 'tenant-reviewer', role: 'tenant_admin' }),
      reg.review('race-review', { tenantId: 'default', userId: 'platform-reviewer', role: 'platform_admin' }, { global: true }),
    ]);

    const fulfilled = results.filter((result): result is PromiseFulfilledResult<SkillProductRecord> => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const persisted = JSON.parse(await readFile(join(skillDir, '.product.json'), 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      reviewed: true,
      visibility: fulfilled[0]!.value.visibility,
      ...(fulfilled[0]!.value.visibility === 'public' ? { allowedTenantIds: ['*'] } : {}),
    });
  });

  it('serializes same-name imports across separate registry instances sharing a filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-cross-process-import-'));
    const registries = [new SkillRegistry(root), new SkillRegistry(root)];
    await Promise.all(registries.map((registry) => registry.scan()));
    const dirs = ['u1', 'u2'].map((owner) => join(root, 'users', owner, `distributed-${owner}`));
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), '---\nname: distributed\ndescription: distributed\n---\nbody');
      await writeProduct(dir, { name: 'distributed', version: '1' });
    }

    const results = await Promise.allSettled(registries.map((registry, index) => (
      registry.installUploadedProduct(dirs[index]!, {
        tenantId: 'default', userId: `u${index + 1}`, role: 'user',
      })
    )));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const verificationRegistry = new SkillRegistry(root);
    await verificationRegistry.scan();
    expect(verificationRegistry.list().filter((skill) => skill.name === 'distributed')).toHaveLength(1);
  });

  it('serializes local and global review across separate registry instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-cross-process-review-'));
    const skillDir = join(root, 'users', 'uploader', 'distributed-review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: distributed-review\ndescription: review\n---\nbody');
    await writeProduct(skillDir, {
      name: 'distributed-review', version: '1', enabled: true, reviewed: false,
      tenantId: 'default', ownerUserId: 'uploader', visibility: 'private',
    });
    const registries = [new SkillRegistry(root), new SkillRegistry(root)];
    await Promise.all(registries.map((registry) => registry.scan()));

    const results = await Promise.allSettled([
      registries[0]!.review('distributed-review', {
        tenantId: 'default', userId: 'tenant-reviewer', role: 'tenant_admin',
      }),
      registries[1]!.review('distributed-review', {
        tenantId: 'default', userId: 'platform-reviewer', role: 'platform_admin',
      }, { global: true }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('recovers an expired distributed name lock and releases its own lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-stale-lock-'));
    const name = 'stale-lock';
    const lockKey = `skill-name:${name}`;
    const lockPath = join(
      root,
      '.aiop-locks',
      createHash('sha256').update(lockKey).digest('hex'),
    );
    const expiredOwnerDir = join(lockPath, 'expired-owner');
    await mkdir(expiredOwnerDir, { recursive: true });
    await writeFile(join(expiredOwnerDir, 'owner.json'), JSON.stringify({
      token: 'expired-owner', key: lockKey, leaseUntil: Date.now() - 60_000,
      hostname: hostname(), pid: 2_147_483_647,
    }));
    const skillDir = join(root, 'users', 'uploader', name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: stale\n---\nbody`);
    await writeProduct(skillDir, { name, version: '1' });
    const registry = new SkillRegistry(root);

    await expect(registry.installUploadedProduct(skillDir, {
      tenantId: 'default', userId: 'uploader', role: 'user',
    })).resolves.toMatchObject({ name, reviewed: false });
    await expect(stat(lockPath)).rejects.toThrow();
    expect((await stat(join(root, '.aiop-locks'))).mode & 0o777).toBe(0o700);
  });

  it('does not recover an expired distributed name lock while its owner process is alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-live-lock-'));
    const name = 'live-lock';
    const lockKey = `skill-name:${name}`;
    const lockPath = join(
      root,
      '.aiop-locks',
      createHash('sha256').update(lockKey).digest('hex'),
    );
    const liveOwnerDir = join(lockPath, 'live-owner');
    await mkdir(liveOwnerDir, { recursive: true });
    await writeFile(join(liveOwnerDir, 'owner.json'), JSON.stringify({
      token: 'live-owner', key: lockKey, leaseUntil: Date.now() - 60_000,
      hostname: hostname(), pid: process.pid,
    }));
    const skillDir = join(root, 'users', 'uploader', name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: live\n---\nbody`);
    await writeProduct(skillDir, { name, version: '1' });
    const registry = new SkillRegistry(root, { nameLockTimeoutMs: 50 });

    await expect(registry.installUploadedProduct(skillDir, {
      tenantId: 'default', userId: 'uploader', role: 'user',
    })).rejects.toThrow('获取技能名称锁超时');
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it('releases the distributed name lock when review validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-failed-lock-'));
    const skillDir = join(root, 'users', 'uploader', 'retry-review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: wrong-name\ndescription: invalid\n---\nbody');
    await writeProduct(skillDir, {
      name: 'retry-review', version: '1', enabled: true, reviewed: false,
      tenantId: 'default', ownerUserId: 'uploader', visibility: 'private',
    });
    const first = new SkillRegistry(root);
    const second = new SkillRegistry(root);
    await Promise.all([first.scan(), second.scan()]);
    await expect(first.review('retry-review', {
      tenantId: 'default', userId: 'reviewer-one', role: 'tenant_admin',
    })).rejects.toThrow('诊断');
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: retry-review\ndescription: valid\n---\nbody');

    await expect(second.review('retry-review', {
      tenantId: 'default', userId: 'reviewer-two', role: 'tenant_admin',
    })).resolves.toMatchObject({ name: 'retry-review', reviewed: true });
  });
});

describe('credential_file validation', () => {
  it.each(['', '.', '..', '../token.json', '/tmp/token.json', 'C:/token.json', 'sub\\token.json', 'sub/../token.json', 'token.json\0x', 'sub/'])('rejects unsafe target %j', (target) => {
    expect(() => normalizeCredentialFile(target)).toThrow('credential_file');
  });

  it('accepts a normalized relative file including a single quote', () => {
    expect(normalizeCredentialFile("sub/o'hare.json")).toBe("sub/o'hare.json");
  });
});

describe('importSkillZip', () => {
  it('rolls back the extracted directory when post-extraction validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-import-skill-cleanup-'));

    await expect(importSkillZip({
      rootDir: root,
      filename: 'broken.zip',
      data: testZip({ 'README.md': 'missing skill' }),
    })).rejects.toThrow('缺少 SKILL.md');
    await expect(stat(join(root, 'broken'))).rejects.toThrow();
  });

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

  it('rejects symbolic-link zip entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-import-skill-link-'));
    const zip = testZip({ 'SKILL.md': '../../outside' });
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(0x0314, central + 4); // Unix, ZIP 2.0
    zip.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);

    await expect(importSkillZip({ rootDir: root, filename: 'link.zip', data: zip })).rejects.toThrow('符号链接');
  });

  it('rejects symbolic-link directory entries before skipping directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-import-skill-link-dir-'));
    const zip = testZip({ 'link/': '' });
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(0x0314, central + 4);
    zip.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    await expect(importSkillZip({ rootDir: root, filename: 'link-dir.zip', data: zip })).rejects.toThrow('符号链接');
  });

  it('rejects oversized zip entries before inflation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-import-skill-large-'));
    const zip = testZip({ 'SKILL.md': 'small' });
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(20_000_000, central + 24);

    await expect(importSkillZip({ rootDir: root, filename: 'large.zip', data: zip })).rejects.toThrow('大小上限');
  });

  it('bounds actual inflation when a forged entry declares a small size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-import-skill-bomb-'));
    const zip = testZip({ 'SKILL.md': 'a'.repeat(17_000_000) });
    const local = zip.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(5, local + 22);
    zip.writeUInt32LE(5, central + 24);

    await expect(importSkillZip({ rootDir: root, filename: 'bomb.zip', data: zip })).rejects.toThrow(/上限|maxOutputLength|larger/);
  });

  it('rejects dangerous executable extensions and malformed directory paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-import-skill-type-'));
    await expect(importSkillZip({
      rootDir: root, filename: 'danger.zip',
      data: testZip({ 'SKILL.md': '---\nname: danger\ndescription: danger\n---\nbody', 'payload.exe': 'MZ' }),
    })).rejects.toThrow('文件类型');
    await expect(importSkillZip({
      rootDir: root, filename: 'bad-dir.zip',
      data: testZip({ 'SKILL.md': 'ok', 'scripts//run.sh': 'echo no' }),
    })).rejects.toThrow('非法 zip 路径');
  });
});
