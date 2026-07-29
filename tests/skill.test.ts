import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from '../src/skill/registry.js';
import { importSkillZip } from '../src/skill/import.js';
import { normalizeCredentialFile, type SkillProductRecord } from '../src/skill/product.js';
import {
  MysqlSkillMutationLock,
  skillImportPermitPoolSize,
  type SkillMutationLock,
} from '../src/skill/lock.js';
import { ImmutableDigestCache } from '../src/skill/digest-cache.js';

describe('ImmutableDigestCache', () => {
  it('evicts the least recently used artifact after reaching its bound', () => {
    const cache = new ImmutableDigestCache(2);
    cache.set('/a', 'identity-a', 'digest-a');
    cache.set('/b', 'identity-b', 'digest-b');
    expect(cache.get('/a', 'identity-a')).toBe('digest-a');

    cache.set('/c', 'identity-c', 'digest-c');

    expect(cache.get('/a', 'identity-a')).toBe('digest-a');
    expect(cache.get('/b', 'identity-b')).toBeUndefined();
    expect(cache.get('/c', 'identity-c')).toBe('digest-c');
  });

  it('does not reuse a digest when artifact identity changes', () => {
    const cache = new ImmutableDigestCache(2);
    cache.set('/artifact', 'old-identity', 'old-digest');

    expect(cache.get('/artifact', 'new-identity')).toBeUndefined();
    cache.set('/artifact', 'new-identity', 'new-digest');
    expect(cache.get('/artifact', 'new-identity')).toBe('new-digest');
  });
});

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

  it('reads immutable built-ins separately from writable product storage', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-skills-'));
    const productRoot = await mkdtemp(join(tmpdir(), 'aiop-product-skills-'));
    const builtin = join(builtinRoot, 'builtin');
    await mkdir(builtin);
    await writeFile(join(builtin, 'SKILL.md'), '---\nname: builtin\ndescription: builtin\n---\nbody');
    await writeProduct(builtin, {
      name: 'builtin', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    });
    const registry = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });

    await registry.scan();

    expect(registry.get('builtin')?.dir).toBe(builtin);
    expect(registry.importStagingRoot()).toContain(productRoot);
  });

  it('governs a read-only built-in through a shared overlay without mutating its image files', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-overlay-source-'));
    const productRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-overlay-product-'));
    const builtin = join(builtinRoot, 'governed-builtin');
    await mkdir(builtin);
    await writeFile(join(builtin, 'SKILL.md'), '---\nname: governed-builtin\ndescription: builtin\n---\nbody');
    await writeProduct(builtin, {
      name: 'governed-builtin', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    });
    const originalSidecar = await readFile(join(builtin, '.product.json'), 'utf8');
    await chmod(join(builtin, 'SKILL.md'), 0o444);
    await chmod(join(builtin, '.product.json'), 0o444);
    await chmod(builtin, 0o555);
    await chmod(builtinRoot, 0o555);
    const first = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });
    const second = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });
    const admin = { tenantId: 'default', userId: 'admin', role: 'tenant_admin' as const };
    const viewer = { tenantId: 'default', userId: 'viewer', role: 'user' as const };
    await Promise.all([first.scan(), second.scan()]);

    await first.setEnabled('governed-builtin', false, admin);
    await expect(second.loadFor('governed-builtin', viewer)).resolves.toBeUndefined();
    await second.setEnabled('governed-builtin', true, admin);
    await expect(first.loadFor('governed-builtin', viewer)).resolves.toMatchObject({ body: 'body' });
    await expect(first.setShared('governed-builtin', true, admin)).rejects.toThrow('公共技能无需共享');
    await first.delete('governed-builtin', admin);

    await expect(second.loadFor('governed-builtin', viewer)).resolves.toBeUndefined();
    await expect(stat(builtin)).resolves.toBeDefined();
    await expect(readFile(join(builtin, '.product.json'), 'utf8')).resolves.toBe(originalSidecar);
    await expect(stat(join(productRoot, '.aiop-governance'))).resolves.toBeDefined();
  });

  it('keeps install, review, enable, and delete within one distributed lock connection', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-nested-lock-source-'));
    const productRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-nested-lock-product-'));
    const builtin = join(builtinRoot, 'nested-lock-builtin');
    const pendingBuiltin = join(builtinRoot, 'pending-builtin');
    const deletedBuiltin = join(builtinRoot, 'deleted-builtin');
    await mkdir(builtin);
    await mkdir(pendingBuiltin);
    await mkdir(deletedBuiltin);
    await writeFile(join(builtin, 'SKILL.md'), '---\nname: nested-lock-builtin\ndescription: builtin\n---\nbody');
    await writeFile(join(pendingBuiltin, 'SKILL.md'), '---\nname: pending-builtin\ndescription: pending\n---\nbody');
    await writeFile(join(deletedBuiltin, 'SKILL.md'), '---\nname: deleted-builtin\ndescription: deleted\n---\nbody');
    await writeProduct(builtin, {
      name: 'nested-lock-builtin', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    });
    await writeProduct(pendingBuiltin, {
      name: 'pending-builtin', version: '1', enabled: true, reviewed: false,
      tenantId: 'default', visibility: 'public',
    });
    await writeProduct(deletedBuiltin, {
      name: 'deleted-builtin', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    });
    let lockHeld = false;
    const mutationLock = {
      async withLock<T>(_key: string, _timeoutMs: number, operation: () => Promise<T>): Promise<T> {
        if (lockHeld) throw new Error('nested distributed lock');
        lockHeld = true;
        try {
          return await operation();
        } finally {
          lockHeld = false;
        }
      },
    };
    const registry = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot], mutationLock });
    await registry.scan();
    const admin = { tenantId: 'default', userId: 'admin', role: 'tenant_admin' as const };

    await expect(registry.setEnabled('nested-lock-builtin', false, admin))
      .resolves.toMatchObject({ enabled: false });
    await expect(registry.review('pending-builtin', admin))
      .resolves.toMatchObject({ reviewed: true });
    await expect(registry.delete('deleted-builtin', admin)).resolves.toBeUndefined();

    const upload = join(productRoot, 'users', 'uploader', 'uploaded-product');
    await mkdir(upload, { recursive: true });
    await writeFile(join(upload, 'SKILL.md'), '---\nname: uploaded-product\ndescription: uploaded\n---\nbody');
    await writeProduct(upload, { name: 'uploaded-product', version: '1' });
    await expect(registry.installUploadedProduct(upload, {
      tenantId: 'default', userId: 'uploader', role: 'user',
    })).resolves.toMatchObject({ name: 'uploaded-product', reviewed: false });
  }, 1_000);

  it('keeps restrictive built-in governance across image updates and rebases explicit enablement', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-overlay-update-source-'));
    const productRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-overlay-update-product-'));
    const builtin = join(builtinRoot, 'updated-builtin');
    await mkdir(builtin);
    await writeFile(join(builtin, 'SKILL.md'), '---\nname: updated-builtin\ndescription: v1\n---\nv1');
    await writeProduct(builtin, {
      name: 'updated-builtin', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    });
    const first = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });
    const second = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });
    const admin = { tenantId: 'default', userId: 'admin', role: 'tenant_admin' as const };
    const viewer = { tenantId: 'default', userId: 'viewer', role: 'user' as const };
    await Promise.all([first.scan(), second.scan()]);

    await first.setEnabled('updated-builtin', false, admin);
    await writeFile(join(builtin, 'SKILL.md'), '---\nname: updated-builtin\ndescription: v2\n---\nv2');
    await writeProduct(builtin, {
      name: 'updated-builtin', version: '2', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    });

    await expect(second.loadFor('updated-builtin', viewer)).resolves.toBeUndefined();
    await second.setEnabled('updated-builtin', true, admin);
    await expect(first.loadFor('updated-builtin', viewer)).resolves.toMatchObject({ body: 'v2' });
    await first.delete('updated-builtin', admin);
    await writeFile(join(builtin, 'SKILL.md'), '---\nname: updated-builtin\ndescription: v3\n---\nv3');
    await expect(second.loadFor('updated-builtin', viewer)).resolves.toBeUndefined();
    await expect(stat(builtin)).resolves.toBeDefined();
  });

  it('inherits only restrictive built-in visibility changes across image updates', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-overlay-visibility-source-'));
    const productRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-overlay-visibility-product-'));
    const restricted = join(builtinRoot, 'users', 'admin', 'restricted-builtin');
    const expanded = join(builtinRoot, 'users', 'admin', 'expanded-builtin');
    await mkdir(restricted, { recursive: true });
    await mkdir(expanded, { recursive: true });
    await writeFile(join(restricted, 'SKILL.md'), '---\nname: restricted-builtin\ndescription: v1\n---\nv1');
    await writeFile(join(expanded, 'SKILL.md'), '---\nname: expanded-builtin\ndescription: v1\n---\nv1');
    await writeProduct(restricted, {
      name: 'restricted-builtin', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', ownerUserId: 'admin', visibility: 'shared',
    });
    await writeProduct(expanded, {
      name: 'expanded-builtin', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', ownerUserId: 'admin', visibility: 'private',
    });
    const registry = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });
    const admin = { tenantId: 'default', userId: 'admin', role: 'tenant_admin' as const };
    const viewer = { tenantId: 'default', userId: 'viewer', role: 'user' as const };
    await registry.scan();

    await registry.setShared('restricted-builtin', false, admin);
    await registry.setEnabled('restricted-builtin', false, admin);
    await registry.setEnabled('restricted-builtin', true, admin);
    await registry.setShared('expanded-builtin', true, admin);
    await expect(registry.loadFor('expanded-builtin', viewer)).resolves.toMatchObject({ body: 'v1' });

    await writeFile(join(restricted, 'SKILL.md'), '---\nname: restricted-builtin\ndescription: v2\n---\nv2');
    await writeFile(join(expanded, 'SKILL.md'), '---\nname: expanded-builtin\ndescription: v2\n---\nv2');
    await writeProduct(restricted, {
      name: 'restricted-builtin', version: '2', enabled: true, reviewed: true,
      tenantId: 'default', ownerUserId: 'admin', visibility: 'shared',
    });
    await writeProduct(expanded, {
      name: 'expanded-builtin', version: '2', enabled: true, reviewed: true,
      tenantId: 'default', ownerUserId: 'admin', visibility: 'private',
    });

    await expect(registry.loadFor('restricted-builtin', viewer)).resolves.toBeUndefined();
    await expect(registry.loadFor('expanded-builtin', viewer)).resolves.toBeUndefined();
    expect(registry.listFor(admin).find((skill) => skill.name === 'restricted-builtin')?.visibility).toBe('private');
    expect(registry.listFor(admin).find((skill) => skill.name === 'expanded-builtin')?.visibility).toBe('private');

    await registry.setEnabled('restricted-builtin', false, admin);
    await registry.setEnabled('restricted-builtin', true, admin);
    await writeFile(join(restricted, 'SKILL.md'), '---\nname: restricted-builtin\ndescription: v3\n---\nv3');
    await writeProduct(restricted, {
      name: 'restricted-builtin', version: '3', enabled: true, reviewed: true,
      tenantId: 'default', ownerUserId: 'admin', visibility: 'shared',
    });

    await expect(registry.loadFor('restricted-builtin', viewer)).resolves.toBeUndefined();
    expect(registry.listFor(admin).find((skill) => skill.name === 'restricted-builtin')?.visibility).toBe('private');
  });

  it('reviews an unreviewed read-only built-in through the writable governance overlay', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-overlay-review-source-'));
    const productRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-overlay-review-product-'));
    const builtin = join(builtinRoot, 'review-builtin');
    await mkdir(builtin);
    await writeFile(join(builtin, 'SKILL.md'), '---\nname: review-builtin\ndescription: review\n---\nbody');
    await writeProduct(builtin, {
      name: 'review-builtin', version: '1', enabled: true, reviewed: false,
      tenantId: 'default', visibility: 'public',
    });
    const originalSidecar = await readFile(join(builtin, '.product.json'), 'utf8');
    await chmod(join(builtin, 'SKILL.md'), 0o444);
    await chmod(join(builtin, '.product.json'), 0o444);
    await chmod(builtin, 0o555);
    await chmod(builtinRoot, 0o555);
    const first = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });
    const second = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });
    await Promise.all([first.scan(), second.scan()]);

    await expect(first.review('review-builtin', {
      tenantId: 'default', userId: 'reviewer', role: 'platform_admin',
    }, { global: true })).rejects.toThrow('内置技能不支持全局发布');
    await expect(first.review('review-builtin', {
      tenantId: 'default', userId: 'reviewer', role: 'tenant_admin',
    })).resolves.toMatchObject({ reviewed: true, path: builtin });
    await expect(second.loadFor('review-builtin', {
      tenantId: 'default', userId: 'viewer', role: 'user',
    })).resolves.toMatchObject({ body: 'body' });
    await expect(readFile(join(builtin, '.product.json'), 'utf8')).resolves.toBe(originalSidecar);
  });

  it('ignores legacy PVC seed copies that duplicate a read-only built-in', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-seed-source-'));
    const productRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-seed-pvc-'));
    for (const root of [builtinRoot, productRoot]) {
      const skillDir = join(root, 'seeded');
      await mkdir(skillDir);
      await writeFile(join(skillDir, 'SKILL.md'), '---\nname: seeded\ndescription: seeded\n---\nbody');
      await writeProduct(skillDir, {
        name: 'seeded', version: '1', enabled: true, reviewed: true,
        tenantId: 'default', visibility: 'public',
      });
    }
    const registry = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });

    await registry.scan();

    expect(registry.list().filter((skill) => skill.name === 'seeded')).toHaveLength(1);
    await expect(registry.loadFor('seeded', {
      tenantId: 'default', userId: 'viewer', role: 'user',
    })).resolves.toMatchObject({ dir: join(builtinRoot, 'seeded') });

    await registry.delete('seeded', {
      tenantId: 'default', userId: 'admin', role: 'tenant_admin',
    });
    await expect(registry.loadFor('seeded', {
      tenantId: 'default', userId: 'viewer', role: 'user',
    })).resolves.toBeUndefined();
    await expect(stat(join(productRoot, 'seeded'))).rejects.toThrow();

    await rm(join(builtinRoot, 'seeded'), { recursive: true });
    const afterImageUpdate = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });
    await afterImageUpdate.scan();
    await expect(afterImageUpdate.loadFor('seeded', {
      tenantId: 'default', userId: 'viewer', role: 'user',
    })).resolves.toBeUndefined();
  });

  it('migrates restrictive legacy PVC seed governance before suppressing old copies', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-legacy-migration-source-'));
    const productRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-legacy-migration-product-'));
    const definitions = [
      { name: 'legacy-disabled', relative: 'legacy-disabled', source: { visibility: 'public', reviewed: true }, legacy: { visibility: 'public', reviewed: true, enabled: false }, deleted: false },
      { name: 'legacy-unreviewed', relative: 'legacy-unreviewed', source: { visibility: 'public', reviewed: true }, legacy: { visibility: 'public', reviewed: false, enabled: true }, deleted: false },
      { name: 'legacy-private', relative: 'users/admin/legacy-private', source: { visibility: 'shared', reviewed: true, ownerUserId: 'admin' }, legacy: { visibility: 'private', reviewed: true, enabled: true, ownerUserId: 'admin' }, deleted: false },
      { name: 'legacy-shared', relative: 'users/admin/legacy-shared', source: { visibility: 'private', reviewed: true, ownerUserId: 'admin' }, legacy: { visibility: 'shared', reviewed: true, enabled: true, ownerUserId: 'admin' }, deleted: false },
      { name: 'legacy-deleted', relative: 'legacy-deleted', source: { visibility: 'public', reviewed: true }, legacy: { visibility: 'public', reviewed: true, enabled: true }, deleted: true },
    ] as const;
    for (const definition of definitions) {
      const builtin = join(builtinRoot, definition.relative);
      const legacy = join(productRoot, definition.relative);
      await mkdir(builtin, { recursive: true });
      await writeFile(join(builtin, 'SKILL.md'), `---\nname: ${definition.name}\ndescription: legacy\n---\nbody`);
      await writeProduct(builtin, {
        name: definition.name, version: '1', enabled: true,
        tenantId: 'default', ...definition.source,
      });
      await mkdir(legacy, { recursive: true });
      await cp(builtin, legacy, { recursive: true });
      await writeProduct(legacy, {
        name: definition.name, version: '1', tenantId: 'default', ...definition.legacy,
      });
      if (definition.deleted) {
        const tombstone = join(productRoot, '.aiop-tombstones', `old-${definition.name}`);
        await mkdir(dirname(tombstone), { recursive: true });
        await rename(legacy, tombstone);
      }
    }

    const registry = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });
    const admin = { tenantId: 'default', userId: 'admin', role: 'tenant_admin' as const };
    const viewer = { tenantId: 'default', userId: 'viewer', role: 'user' as const };
    await registry.scan();
    await registry.scan();

    expect(registry.listFor(admin).find((skill) => skill.name === 'legacy-disabled')?.enabled).toBe(false);
    expect(registry.listFor(admin).find((skill) => skill.name === 'legacy-unreviewed')?.reviewed).toBe(false);
    await expect(registry.loadFor('legacy-private', viewer)).resolves.toBeUndefined();
    expect(registry.listFor(admin).find((skill) => skill.name === 'legacy-private')?.visibility).toBe('private');
    await expect(registry.loadFor('legacy-shared', viewer)).resolves.toMatchObject({ name: 'legacy-shared' });
    await expect(registry.loadFor('legacy-deleted', admin)).resolves.toBeUndefined();
    for (const definition of definitions.filter((item) => !item.deleted)) {
      await expect(stat(join(productRoot, definition.relative))).rejects.toThrow();
    }
    await expect(stat(join(productRoot, '.aiop-tombstones', 'old-legacy-deleted'))).rejects.toThrow();
  });

  it('keeps a legacy seed when an existing governance overlay is incomplete', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-partial-overlay-source-'));
    const productRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-partial-overlay-product-'));
    const name = 'partial-overlay';
    for (const root of [builtinRoot, productRoot]) {
      const skill = join(root, name);
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: partial\n---\nbody`);
      await writeProduct(skill, {
        name, version: '1', enabled: true, reviewed: true,
        tenantId: 'default', visibility: 'public',
      });
    }
    const identity = createHash('sha256').update(`default\0${name}\0${name}`).digest('hex');
    await mkdir(join(productRoot, '.aiop-governance'), { recursive: true });
    await writeFile(join(productRoot, '.aiop-governance', `${identity}.json`), '{"schemaVersion":1');
    const registry = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });

    await expect(registry.scan()).rejects.toThrow();
    await expect(stat(join(productRoot, name))).resolves.toBeDefined();
  });

  it('retains unmatched legacy deletion tombstones until their builtin can be migrated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-builtin-unmatched-tombstone-'));
    const tombstone = join(root, '.aiop-tombstones', 'legacy-deleted-seed');
    await mkdir(tombstone, { recursive: true });
    await writeFile(join(tombstone, 'SKILL.md'), '---\nname: absent-builtin\ndescription: absent\n---\nbody');
    await writeProduct(tombstone, {
      name: 'absent-builtin', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    });
    const old = new Date(Date.now() - 10_000);
    await utimes(tombstone, old, old);
    const registry = new SkillRegistry(root, { pendingQuota: { retentionMs: 100 } });

    await registry.scan();

    await expect(stat(tombstone)).resolves.toBeDefined();
  });

  it('does not suppress an identical ownerless public product at a non-seed relative path', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-catalog-source-'));
    const productRoot = await mkdtemp(join(tmpdir(), 'aiop-builtin-catalog-product-'));
    const builtin = join(builtinRoot, 'same-name');
    const product = join(productRoot, 'independent-product');
    await mkdir(builtin);
    await writeFile(join(builtin, 'SKILL.md'), '---\nname: same-name\ndescription: builtin\n---\nbuiltin');
    await writeProduct(builtin, {
      name: 'same-name', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    });
    await cp(builtin, product, { recursive: true });
    const registry = new SkillRegistry(productRoot, { builtinRoots: [builtinRoot] });

    await registry.scan();

    expect(registry.list().filter((skill) => skill.name === 'same-name')).toHaveLength(2);
    expect(registry.list().map((skill) => resolve(skill.dir))).toContain(resolve(product));
  });

  it('keeps an interrupted published artifact invisible until its commit marker exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-publish-commit-state-'));
    const artifact = join(root, '.aiop-published', 'global', '1-deadbeef', 'interrupted');
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, 'SKILL.md'), '---\nname: interrupted\ndescription: interrupted\n---\nbody');
    await writeProduct(artifact, {
      name: 'interrupted', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public', allowedTenantIds: ['*'],
      submittedByUserId: 'uploader',
    });
    const registry = new SkillRegistry(root);

    await registry.scan();
    expect(registry.get('interrupted')).toBeUndefined();

    await writeFile(join(artifact, '.aiop-committed'), 'committed\n');
    await registry.scan();
    expect(registry.get('interrupted')).toBeDefined();
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
  it('keeps the import permit pool large enough when MYSQL_POOL_SIZE is one', () => {
    expect(skillImportPermitPoolSize(1)).toBe(5);
    expect(skillImportPermitPoolSize(8)).toBe(8);
  });

  it('uses connection-scoped MySQL advisory locks and releases the dedicated connection on failure', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    let released = false;
    const connection = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return sql.includes('GET_LOCK') ? [[{ acquired: 1 }], []] : [[{ released: 1 }], []];
      },
      release: () => { released = true; },
    };
    const pool = { promise: () => ({ getConnection: async () => connection, end: async () => undefined }) };
    const lock = new MysqlSkillMutationLock(pool as never);

    await expect(lock.withLock('skill-name:demo', 1000, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(queries.map(({ sql }) => sql)).toEqual([
      'SELECT GET_LOCK(?, ?) AS acquired',
      'SELECT RELEASE_LOCK(?) AS released',
    ]);
    expect(released).toBe(true);
  });

  it('destroys a MySQL advisory-lock connection when release cannot be confirmed', async () => {
    let released = false;
    let destroyed = false;
    const connection = {
      query: async (sql: string) => (
        sql.includes('GET_LOCK') ? [[{ acquired: 1 }], []] : [[{ released: 0 }], []]
      ),
      release: () => { released = true; },
      destroy: () => { destroyed = true; },
    };
    const pool = { promise: () => ({ getConnection: async () => connection, end: async () => undefined }) };
    const lock = new MysqlSkillMutationLock(pool as never);

    await expect(lock.withLock('skill-name:demo', 1000, async () => 'ok')).resolves.toBe('ok');

    expect(released).toBe(false);
    expect(destroyed).toBe(true);
  });

  it('holds MySQL import slot locks on dedicated connections until explicit release', async () => {
    let released = false;
    const queries: string[] = [];
    const connection = {
      query: async (sql: string) => {
        queries.push(sql);
        return sql.includes('GET_LOCK') ? [[{ acquired: 1 }], []] : [[{ released: 1 }], []];
      },
      release: () => { released = true; },
      destroy: () => undefined,
    };
    const pool = { promise: () => ({ getConnection: async () => connection, end: async () => undefined }) };
    const lock = new MysqlSkillMutationLock(pool as never);

    const release = await lock.tryAcquireSlot('skill-import:global', 4);

    expect(release).toBeTypeOf('function');
    expect(released).toBe(false);
    await release?.();
    expect(released).toBe(true);
    expect(queries).toEqual([
      'SELECT GET_LOCK(?, 0) AS acquired',
      'SELECT RELEASE_LOCK(?) AS released',
    ]);
  });

  it('holds global and tenant import slots with a pool capacity of one', async () => {
    let connectionCount = 0;
    let released = false;
    const queries: string[] = [];
    const connection = {
      query: async (sql: string) => {
        queries.push(sql);
        return sql.includes('GET_LOCK') ? [[{ acquired: 1 }], []] : [[{ released: 1 }], []];
      },
      release: () => { released = true; },
      destroy: () => undefined,
    };
    const pool = {
      promise: () => ({
        getConnection: async () => {
          connectionCount += 1;
          return connection;
        },
        end: async () => undefined,
      }),
    };
    const lock = new MysqlSkillMutationLock(pool as never);

    const release = await lock.tryAcquireSlots([
      { keyPrefix: 'skill-import:global', limit: 4 },
      { keyPrefix: 'skill-import:tenant:tenant-a', limit: 2 },
    ]);

    expect(release).toBeTypeOf('function');
    expect(connectionCount).toBe(1);
    expect(released).toBe(false);
    await release?.();
    expect(released).toBe(true);
    expect(queries).toEqual([
      'SELECT GET_LOCK(?, 0) AS acquired',
      'SELECT GET_LOCK(?, 0) AS acquired',
      'SELECT RELEASE_LOCK(?) AS released',
      'SELECT RELEASE_LOCK(?) AS released',
    ]);
  });

  it('keeps an occupied import permit pool independent from the name mutation pool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-independent-skill-locks-'));
    const source = join(root, '.staged-independent');
    await mkdir(source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: independent\ndescription: independent locks\n---\nbody');
    await writeProduct(source, { name: 'independent', version: '1' });
    let permitReleased = false;
    let permitCalls = 0;
    const importPermitLock: SkillMutationLock = {
      async tryAcquireSlots() {
        permitCalls += 1;
        return async () => { permitReleased = true; };
      },
      async withLock<T>(_key: string, _timeoutMs: number, operation: () => Promise<T>): Promise<T> {
        return operation();
      },
    };
    const mutationCalls: Array<[string, number]> = [];
    const mutationLock: SkillMutationLock = {
      async withLock<T>(key: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
        mutationCalls.push([key, timeoutMs]);
        return operation();
      },
    };
    const registry = new SkillRegistry(root, {
      mutationLock,
      importPermitLock,
    });

    const permit = await registry.acquireImportPermit('default', 1, 1);
    expect(permit).toMatchObject({ supported: true });
    await expect(registry.installUploadedProduct(source, {
      tenantId: 'default', userId: 'uploader', role: 'user',
    }, {
      destinationDir: join(root, 'users', 'uploader', 'independent'),
    })).resolves.toMatchObject({ name: 'independent' });
    expect(permitReleased).toBe(false);
    expect(permitCalls).toBe(1);
    expect(mutationCalls).toEqual([[
      'skill-mutation',
      10_000,
    ]]);
    await permit.release?.();
    expect(permitReleased).toBe(true);
  });

  it('bounds waiting for a MySQL advisory-lock pool connection', async () => {
    const pool = {
      promise: () => ({
        getConnection: () => new Promise(() => undefined),
        end: async () => undefined,
      }),
    };
    const lock = new MysqlSkillMutationLock(pool as never, 20);

    const result = Promise.race([
      lock.withLock('skill-name:blocked', 1000, async () => 'unexpected'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('test deadline exceeded')), 200)),
    ]);
    await expect(result).rejects.toThrow('获取技能锁连接超时');
  });

  it('releases a pool connection that arrives after the bounded acquire timeout', async () => {
    let resolveConnection!: (connection: { release(): void }) => void;
    let released = false;
    const pendingConnection = new Promise<{ release(): void }>((resolvePending) => {
      resolveConnection = resolvePending;
    });
    const pool = {
      promise: () => ({
        getConnection: () => pendingConnection,
        end: async () => undefined,
      }),
    };
    const lock = new MysqlSkillMutationLock(pool as never, 10);

    await expect(lock.withLock('skill-name:late', 1000, async () => 'unexpected'))
      .rejects.toThrow('获取技能锁连接超时');
    resolveConnection({ release: () => { released = true; } });
    await new Promise((resolvePending) => setTimeout(resolvePending, 0));

    expect(released).toBe(true);
  });

  it('uses only two connections for two concurrent global and tenant permits', async () => {
    let connectionCount = 0;
    const connections = Array.from({ length: 2 }, () => ({
      query: async (sql: string) => (
        sql.includes('GET_LOCK') ? [[{ acquired: 1 }], []] : [[{ released: 1 }], []]
      ),
      release: () => undefined,
      destroy: () => undefined,
    }));
    const pool = {
      promise: () => ({
        getConnection: async () => {
          const connection = connections[connectionCount];
          connectionCount += 1;
          if (!connection) throw new Error('pool capacity exceeded');
          return connection;
        },
        end: async () => undefined,
      }),
    };
    const lock = new MysqlSkillMutationLock(pool as never);

    const [firstRelease, secondRelease] = await Promise.all([
      lock.tryAcquireSlots([
        { keyPrefix: 'skill-import:global', limit: 4 },
        { keyPrefix: 'skill-import:tenant:tenant-a', limit: 2 },
      ]),
      lock.tryAcquireSlots([
        { keyPrefix: 'skill-import:global', limit: 4 },
        { keyPrefix: 'skill-import:tenant:tenant-a', limit: 2 },
      ]),
    ]);

    expect(firstRelease).toBeTypeOf('function');
    expect(secondRelease).toBeTypeOf('function');
    expect(connectionCount).toBe(2);
    await Promise.all([firstRelease?.(), secondRelease?.()]);
  });

  it('releases the global slot when no tenant slot is available', async () => {
    let getLockCalls = 0;
    let released = false;
    let destroyed = false;
    const queries: string[] = [];
    const connection = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('GET_LOCK')) {
          getLockCalls += 1;
          return [[{ acquired: getLockCalls === 1 ? 1 : 0 }], []];
        }
        return [[{ released: 1 }], []];
      },
      release: () => { released = true; },
      destroy: () => { destroyed = true; },
    };
    const pool = { promise: () => ({ getConnection: async () => connection, end: async () => undefined }) };
    const lock = new MysqlSkillMutationLock(pool as never);

    await expect(lock.tryAcquireSlots([
      { keyPrefix: 'skill-import:global', limit: 4 },
      { keyPrefix: 'skill-import:tenant:tenant-a', limit: 2 },
    ])).resolves.toBeUndefined();

    expect(released).toBe(true);
    expect(destroyed).toBe(false);
    expect(queries).toEqual([
      'SELECT GET_LOCK(?, 0) AS acquired',
      'SELECT GET_LOCK(?, 0) AS acquired',
      'SELECT GET_LOCK(?, 0) AS acquired',
      'SELECT RELEASE_LOCK(?) AS released',
    ]);
  });

  it('destroys the shared import-slot connection when a later lock query fails', async () => {
    let getLockCalls = 0;
    let released = false;
    let destroyed = false;
    const connection = {
      query: async (sql: string) => {
        if (sql.includes('GET_LOCK')) {
          getLockCalls += 1;
          if (getLockCalls === 2) throw new Error('tenant lock query failed');
          return [[{ acquired: 1 }], []];
        }
        return [[{ released: 1 }], []];
      },
      release: () => { released = true; },
      destroy: () => { destroyed = true; },
    };
    const pool = { promise: () => ({ getConnection: async () => connection, end: async () => undefined }) };
    const lock = new MysqlSkillMutationLock(pool as never);

    await expect(lock.tryAcquireSlots([
      { keyPrefix: 'skill-import:global', limit: 4 },
      { keyPrefix: 'skill-import:tenant:tenant-a', limit: 2 },
    ])).rejects.toThrow('tenant lock query failed');

    expect(released).toBe(false);
    expect(destroyed).toBe(true);
  });

  it('destroys the shared import-slot connection when either release cannot be confirmed', async () => {
    let releaseCalls = 0;
    let released = false;
    let destroyed = false;
    const connection = {
      query: async (sql: string) => {
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        releaseCalls += 1;
        return [[{ released: releaseCalls === 1 ? 0 : 1 }], []];
      },
      release: () => { released = true; },
      destroy: () => { destroyed = true; },
    };
    const pool = { promise: () => ({ getConnection: async () => connection, end: async () => undefined }) };
    const lock = new MysqlSkillMutationLock(pool as never);

    const release = await lock.tryAcquireSlots([
      { keyPrefix: 'skill-import:global', limit: 4 },
      { keyPrefix: 'skill-import:tenant:tenant-a', limit: 2 },
    ]);
    await release?.();

    expect(releaseCalls).toBe(2);
    expect(released).toBe(false);
    expect(destroyed).toBe(true);
  });

  it('publishes an immutable digest-verified artifact and stale registries observe revocation without scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-published-artifact-'));
    const uploadedDir = join(root, 'users', 'uploader', 'immutable');
    await mkdir(uploadedDir, { recursive: true });
    await writeFile(join(uploadedDir, 'SKILL.md'), '---\nname: immutable\ndescription: approved\n---\napproved body');
    await writeProduct(uploadedDir, { name: 'immutable', version: '1' });
    const first = new SkillRegistry(root);
    const stale = new SkillRegistry(root);
    await first.installUploadedProduct(uploadedDir, {
      tenantId: 'default', userId: 'uploader', role: 'user',
    });
    await Promise.all([first.scan(), stale.scan()]);

    const published = await first.review('immutable', {
      tenantId: 'default', userId: 'reviewer', role: 'platform_admin',
    }, { global: true });
    expect(published.path).toContain(join(root, '.aiop-published'));
    expect(published.ownerUserId).toBeUndefined();
    expect(published.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(published.revision).toBe(1);
    expect((await stale.loadFor('immutable', {
      tenantId: 'default', userId: 'viewer', role: 'user',
    }))?.body).toContain('approved body');

    await mkdir(uploadedDir, { recursive: true });
    await writeFile(join(uploadedDir, 'SKILL.md'), '---\nname: immutable\ndescription: malicious\n---\nmalicious body');
    await writeProduct(uploadedDir, { name: 'immutable', version: '1' });
    await stale.installUploadedProduct(uploadedDir, {
      tenantId: 'default', userId: 'uploader', role: 'user',
    });
    expect((await stale.loadFor('immutable', {
      tenantId: 'default', userId: 'viewer', role: 'user',
    }))?.body).toContain('approved body');
    const uploaderLoad = await stale.tool().execute({ name: 'immutable' }, {
      tenantId: 'default', userId: 'uploader', role: 'user', sessionId: 'shadow-check',
    });
    expect(uploaderLoad.isError).toBeFalsy();
    expect(uploaderLoad.content).toContain('approved body');

    await first.setEnabled('immutable', false, {
      tenantId: 'default', userId: 'reviewer', role: 'platform_admin',
    });
    await expect(stale.loadFor('immutable', {
      tenantId: 'default', userId: 'viewer', role: 'user',
    })).resolves.toBeUndefined();

    await expect(stale.delete('immutable', {
      tenantId: 'default', userId: 'uploader', role: 'user',
    })).resolves.toBeUndefined();
    await expect(stat(published.path)).resolves.toBeDefined();
    await first.delete('immutable', {
      tenantId: 'default', userId: 'reviewer', role: 'platform_admin',
    });
    await expect(stale.loadFor('immutable', {
      tenantId: 'default', userId: 'viewer', role: 'user',
    })).resolves.toBeUndefined();
  });

  it.each([
    ['artifact renamed before commit', false, false],
    ['pending tombstoned before commit', false, true],
    ['marker committed before pending cleanup', true, false],
    ['pending cleanup interrupted after commit', true, true],
  ] as const)('reconciles publication crash state: %s', async (_case, committed, tombstoned) => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-publication-recovery-'));
    const name = `recover-${committed ? 'committed' : 'pending'}-${tombstoned ? 'tombstoned' : 'source'}`;
    const sourcePath = join(root, 'users', 'uploader', name);
    const publishedPath = join(root, '.aiop-published', 'tenant-default', '1-deadbeef', name);
    const stagedPath = join(root, '.aiop-published', '.staging-recovery');
    const tombstonePath = join(root, '.aiop-tombstones', 'publication-recovery');
    const journalPath = join(root, '.aiop-publications', 'recovery.json');
    await mkdir(sourcePath, { recursive: true });
    await writeFile(join(sourcePath, 'SKILL.md'), `---\nname: ${name}\ndescription: pending\n---\npending`);
    await writeProduct(sourcePath, {
      name, version: '1', enabled: true, reviewed: false,
      tenantId: 'default', ownerUserId: 'uploader', visibility: 'private',
    });
    await writeFile(join(sourcePath, '.aiop-publication-source'), 'recovery\n');
    await mkdir(publishedPath, { recursive: true });
    await writeFile(join(publishedPath, 'SKILL.md'), `---\nname: ${name}\ndescription: published\n---\npublished`);
    await writeProduct(publishedPath, {
      name, version: '1', enabled: true, reviewed: true,
      tenantId: 'default', submittedByUserId: 'uploader', visibility: 'private',
    });
    if (committed) await writeFile(join(publishedPath, '.aiop-committed'), 'committed\n');
    if (tombstoned) {
      await mkdir(join(root, '.aiop-tombstones'), { recursive: true });
      await rename(sourcePath, tombstonePath);
    }
    await mkdir(join(root, '.aiop-publications'), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schemaVersion: 1,
      publicationId: 'recovery',
      sourceId: `default:uploader:${name}`,
      sourceDigest: '0'.repeat(64),
      sourceVersion: '1',
      sourcePath,
      stagedPath,
      publishedPath,
      tombstonePath,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const restarted = new SkillRegistry(root);
    await restarted.scan();
    await restarted.scan();

    const pathExists = async (path: string) => stat(path).then(() => true, () => false);
    expect(await pathExists(journalPath)).toBe(false);
    expect(await pathExists(stagedPath)).toBe(false);
    expect(await pathExists(tombstonePath)).toBe(false);
    expect(await pathExists(publishedPath)).toBe(committed);
    expect(await pathExists(sourcePath)).toBe(!committed);
    if (committed) {
      expect(restarted.listFor({ tenantId: 'default', userId: 'uploader', role: 'user' })
        .some((skill) => skill.name === name && skill.reviewed)).toBe(true);
    }
  });

  it('does not let an old committed journal delete a later pending upload at the same path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-publication-later-source-'));
    const name = 'later-source';
    const sourcePath = join(root, 'users', 'uploader', name);
    const publishedPath = join(root, '.aiop-published', 'tenant-default', '1-digest', name);
    const stagedPath = join(root, '.aiop-published', '.staging-later');
    const tombstonePath = join(root, '.aiop-tombstones', 'publication-old');
    await mkdir(sourcePath, { recursive: true });
    await writeFile(join(sourcePath, 'SKILL.md'), `---\nname: ${name}\ndescription: new pending\n---\nnew`);
    await writeProduct(sourcePath, {
      name, version: '2', enabled: true, reviewed: false,
      tenantId: 'default', ownerUserId: 'uploader', visibility: 'private',
    });
    await mkdir(publishedPath, { recursive: true });
    await writeFile(join(publishedPath, 'SKILL.md'), `---\nname: ${name}\ndescription: published\n---\nold`);
    await writeProduct(publishedPath, {
      name, version: '1', enabled: true, reviewed: true,
      tenantId: 'default', submittedByUserId: 'uploader', visibility: 'private',
    });
    await writeFile(join(publishedPath, '.aiop-committed'), 'committed\n');
    await mkdir(join(root, '.aiop-publications'), { recursive: true });
    await writeFile(join(root, '.aiop-publications', 'old.json'), JSON.stringify({
      schemaVersion: 1,
      publicationId: 'old',
      sourceId: `default:uploader:${name}`,
      sourceDigest: 'a'.repeat(64),
      sourceVersion: '1',
      sourcePath,
      stagedPath,
      publishedPath,
      tombstonePath,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    }));

    const registry = new SkillRegistry(root);
    await registry.scan();

    await expect(stat(sourcePath)).resolves.toBeDefined();
    await expect(readFile(join(sourcePath, 'SKILL.md'), 'utf8')).resolves.toContain('new pending');
    await expect(stat(join(root, '.aiop-publications', 'old.json'))).rejects.toThrow();
  });

  it('waits for the publication lock before reconciling a live journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-publication-live-'));
    const name = 'live-publication';
    const sourcePath = join(root, 'users', 'uploader', name);
    const stagedPath = join(root, '.aiop-published', '.staging-live');
    const publishedPath = join(root, '.aiop-published', 'tenant-default', '1-digest', name);
    const tombstonePath = join(root, '.aiop-tombstones', 'publication-live');
    await mkdir(sourcePath, { recursive: true });
    await writeFile(join(sourcePath, 'SKILL.md'), `---\nname: ${name}\ndescription: live\n---\nbody`);
    await writeProduct(sourcePath, {
      name, version: '1', enabled: true, reviewed: false,
      tenantId: 'default', ownerUserId: 'uploader', visibility: 'private',
    });
    await mkdir(dirname(stagedPath), { recursive: true });
    await cp(sourcePath, stagedPath, { recursive: true });
    await mkdir(dirname(publishedPath), { recursive: true });
    await rename(stagedPath, publishedPath);
    await mkdir(join(root, '.aiop-publications'), { recursive: true });
    await writeFile(join(root, '.aiop-publications', 'live.json'), JSON.stringify({
      schemaVersion: 1,
      publicationId: 'live',
      sourceId: `default:uploader:${name}`,
      sourceDigest: 'a'.repeat(64),
      sourceVersion: '1',
      sourcePath,
      stagedPath,
      publishedPath,
      tombstonePath,
      createdAt: new Date().toISOString(),
    }));
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolveGate) => { releaseLock = resolveGate; });
    let lockRequested = false;
    const registry = new SkillRegistry(root, { mutationLock: {
      async withLock<T>(key: string, _timeoutMs: number, operation: () => Promise<T>): Promise<T> {
        expect(key).toBe('skill-mutation');
        lockRequested = true;
        await lockGate;
        return operation();
      },
    } });

    const scan = registry.scan();
    await vi.waitFor(() => expect(lockRequested).toBe(true));
    await expect(stat(publishedPath)).resolves.toBeDefined();
    releaseLock();
    await scan;
    await expect(stat(publishedPath)).rejects.toThrow();
    await expect(stat(sourcePath)).resolves.toBeDefined();
  });

  it('rejects a published artifact whose content no longer matches its digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-published-digest-'));
    const uploadedDir = join(root, 'users', 'uploader', 'digest-check');
    await mkdir(uploadedDir, { recursive: true });
    await writeFile(join(uploadedDir, 'SKILL.md'), '---\nname: digest-check\ndescription: approved\n---\napproved');
    await writeProduct(uploadedDir, { name: 'digest-check', version: '1' });
    const registry = new SkillRegistry(root);
    await registry.installUploadedProduct(uploadedDir, {
      tenantId: 'default', userId: 'uploader', role: 'user',
    });
    const published = await registry.review('digest-check', {
      tenantId: 'default', userId: 'reviewer', role: 'tenant_admin',
    });
    await writeFile(join(published.path, 'SKILL.md'), '---\nname: digest-check\ndescription: tampered\n---\ntampered');

    await expect(registry.loadFor('digest-check', {
      tenantId: 'default', userId: 'viewer', role: 'user',
    })).resolves.toBeUndefined();
  });

  it('does not let pending uploads reserve the global published name and lets admins remove pending uploads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-pending-governance-'));
    const registry = new SkillRegistry(root);
    for (const [tenantId, owner] of [['default', 'squatter'], ['other', 'publisher']] as const) {
      const tenantRoot = tenantId === 'default' ? root : join(root, 'tenants', tenantId);
      const dir = join(tenantRoot, 'users', owner, 'reserved');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), '---\nname: reserved\ndescription: candidate\n---\nbody');
      await writeProduct(dir, { name: 'reserved', version: '1' });
      await registry.installUploadedProduct(dir, { tenantId, userId: owner, role: 'user' });
    }

    await expect(registry.review('reserved', {
      tenantId: 'other', userId: 'platform-reviewer', role: 'platform_admin',
    }, { global: true })).resolves.toMatchObject({ reviewed: true, visibility: 'public' });
    await expect(registry.delete('reserved', {
      tenantId: 'default', userId: 'tenant-reviewer', role: 'tenant_admin',
    })).resolves.toBeUndefined();
  });

  it('preserves concurrent governance updates from separate long-lived registries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-governance-cas-'));
    const skillDir = join(root, 'users', 'owner', 'governed');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: governed\ndescription: governed\n---\nbody');
    await writeProduct(skillDir, { name: 'governed', version: '1' });
    const first = new SkillRegistry(root);
    const second = new SkillRegistry(root);
    await first.installUploadedProduct(skillDir, { tenantId: 'default', userId: 'owner', role: 'user' });
    await Promise.all([first.scan(), second.scan()]);

    await Promise.all([
      first.setEnabled('governed', false, { tenantId: 'default', userId: 'owner', role: 'user' }),
      second.setShared('governed', true, { tenantId: 'default', userId: 'owner', role: 'user' }),
    ]);

    const verifier = new SkillRegistry(root);
    await verifier.scan();
    expect(verifier.get('governed')?.product).toMatchObject({
      enabled: false,
      visibility: 'shared',
      revision: 2,
    });
  });
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

  it('allows a pending update beside a same-name built-in but rejects publishing over it', async () => {
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

  it('rejects same-tenant pending name collisions but allows pending updates beside reviewed products', async () => {
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
      const expectation = expect(reg.installUploadedProduct(incoming, {
        tenantId: 'default', userId: 'incoming', role: 'user',
      }));
      if (name === 'pending-name') await expectation.rejects.toThrow('名称冲突');
      else await expectation.resolves.toMatchObject({ reviewed: false });
    }
  });

  it('allows tenant-private duplicate names across isolated tenants and ignores pending records for global publication', async () => {
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
    }, { global: true })).resolves.toMatchObject({ reviewed: true, allowedTenantIds: ['*'] });
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
    const persisted = JSON.parse(await readFile(join(fulfilled[0]!.value.path, '.product.json'), 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      reviewed: true,
      visibility: fulfilled[0]!.value.visibility,
      ...(fulfilled[0]!.value.allowedTenantIds?.includes('*') ? { allowedTenantIds: ['*'] } : {}),
    });
  });

  it('serializes same-name imports across registry instances in one process', async () => {
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

  it('enforces per-user pending quotas atomically across unique concurrent names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-pending-quota-'));
    const staged = await Promise.all(['quota-one', 'quota-two'].map(async (name) => {
      const path = join(root, '.aiop-imports', `${name}-staged`, name);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: quota\n---\nbody`);
      await writeProduct(path, { name, version: '1' });
      return { name, path };
    }));
    const pendingQuota = {
      perUserMaxCount: 1, perUserMaxBytes: 1024 * 1024,
      perTenantMaxCount: 10, perTenantMaxBytes: 10 * 1024 * 1024,
      minFreeBytes: 0, retentionMs: 60_000,
    };
    const first = new SkillRegistry(root, { ...({ pendingQuota } as object) });
    const second = new SkillRegistry(root, { ...({ pendingQuota } as object) });
    const viewer = { tenantId: 'default', userId: 'quota-user', role: 'user' as const };

    const results = await Promise.allSettled(staged.map((item, index) => [first, second][index]!
      .installUploadedProduct(item.path, viewer, {
        destinationDir: join(root, 'users', viewer.userId, item.name),
      })));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(String((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason))
      .toContain('用户待审核技能数量配额');
  });

  it('isolates pending quotas by user and rejects byte and free-space exhaustion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-pending-quota-boundaries-'));
    const install = async (name: string, userId: string, registry: SkillRegistry, bytes = 4) => {
      const source = join(root, '.aiop-imports', `${name}-staged`, name);
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: quota\n---\n${'x'.repeat(bytes)}`);
      await writeProduct(source, { name, version: '1' });
      return registry.installUploadedProduct(source, {
        tenantId: 'default', userId, role: 'user',
      }, { destinationDir: join(root, 'users', userId, name) });
    };
    const countRegistry = new SkillRegistry(root, { ...({ pendingQuota: {
      perUserMaxCount: 1, perUserMaxBytes: 1024 * 1024,
      perTenantMaxCount: 10, perTenantMaxBytes: 10 * 1024 * 1024,
      minFreeBytes: 0, retentionMs: 60_000,
    } } as object) });
    await expect(install('user-a-one', 'user-a', countRegistry)).resolves.toBeDefined();
    await expect(install('user-b-one', 'user-b', countRegistry)).resolves.toBeDefined();

    const byteRegistry = new SkillRegistry(root, { ...({ pendingQuota: {
      perUserMaxCount: 10, perUserMaxBytes: 32,
      perTenantMaxCount: 10, perTenantMaxBytes: 64,
      minFreeBytes: 0, retentionMs: 60_000,
    } } as object) });
    await expect(install('bytes-over', 'bytes-user', byteRegistry, 128))
      .rejects.toThrow('用户待审核技能字节配额');

    const diskRegistry = new SkillRegistry(root, { ...({
      pendingQuota: {
        perUserMaxCount: 10, perUserMaxBytes: 1024,
        perTenantMaxCount: 10, perTenantMaxBytes: 1024,
        minFreeBytes: 512, retentionMs: 60_000,
      },
      availableBytes: async () => 511,
    } as object) });
    await expect(install('disk-over', 'disk-user', diskRegistry)).rejects.toThrow('技能存储可用空间不足');
  });

  it('isolates pending quotas by tenant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-pending-quota-tenants-'));
    const registry = new SkillRegistry(root, { pendingQuota: {
      perUserMaxCount: 10, perUserMaxBytes: 1024 * 1024,
      perTenantMaxCount: 1, perTenantMaxBytes: 10 * 1024 * 1024,
      minFreeBytes: 0, retentionMs: 60_000,
    } });
    const install = async (name: string, tenantId: string) => {
      const viewer = { tenantId, userId: 'same-user', role: 'user' as const };
      const source = join(root, '.aiop-imports', `${tenantId}-${name}`, name);
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: quota\n---\nbody`);
      await writeProduct(source, { name, version: '1' });
      return registry.installUploadedProduct(source, viewer, {
        destinationDir: join(registry.uploadRootFor(viewer), name),
      });
    };

    await expect(install('tenant-a-one', 'tenant-a')).resolves.toBeDefined();
    await expect(install('tenant-b-one', 'tenant-b')).resolves.toBeDefined();
    await expect(install('tenant-a-two', 'tenant-a')).rejects.toThrow('租户待审核技能数量配额');
  });

  it('serializes free-space reservations across tenants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-pending-quota-storage-'));
    const destinations = [
      join(root, 'tenants', 'tenant-a', 'users', 'user-a', 'storage-a'),
      join(root, 'tenants', 'tenant-b', 'users', 'user-b', 'storage-b'),
    ];
    const availableBytes = async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      const occupied = (await Promise.all(destinations.map((path) => stat(path).then(() => true, () => false))))
        .some(Boolean);
      return occupied ? 0 : 1024 * 1024;
    };
    const pendingQuota = {
      perUserMaxCount: 10, perUserMaxBytes: 1024 * 1024,
      perTenantMaxCount: 10, perTenantMaxBytes: 10 * 1024 * 1024,
      minFreeBytes: 1024, retentionMs: 60_000,
    };
    const registries = [
      new SkillRegistry(root, { pendingQuota, availableBytes }),
      new SkillRegistry(root, { pendingQuota, availableBytes }),
    ];
    const installs = await Promise.all(['a', 'b'].map(async (suffix, index) => {
      const name = `storage-${suffix}`;
      const tenantId = `tenant-${suffix}`;
      const userId = `user-${suffix}`;
      const source = join(root, '.aiop-imports', `${name}-staged`, name);
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: storage\n---\nbody`);
      await writeProduct(source, { name, version: '1' });
      return { registry: registries[index]!, source, viewer: { tenantId, userId, role: 'user' as const } };
    }));

    const results = await Promise.allSettled(installs.map((item, index) => item.registry.installUploadedProduct(
      item.source,
      item.viewer,
      { destinationDir: destinations[index]! },
    )));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(String((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason))
      .toContain('技能存储可用空间不足');
  });

  it('reuses pending quota after review and deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-pending-quota-release-'));
    const registry = new SkillRegistry(root, { pendingQuota: {
      perUserMaxCount: 1, perUserMaxBytes: 1024 * 1024,
      perTenantMaxCount: 10, perTenantMaxBytes: 10 * 1024 * 1024,
      minFreeBytes: 0, retentionMs: 60_000,
    } });
    const viewer = { tenantId: 'default', userId: 'quota-owner', role: 'user' as const };
    const install = async (name: string) => {
      const source = join(root, '.aiop-imports', `${name}-staged`, name);
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: quota\n---\nbody`);
      await writeProduct(source, { name, version: '1' });
      return registry.installUploadedProduct(source, viewer, {
        destinationDir: join(registry.uploadRootFor(viewer), name),
      });
    };

    await install('quota-reviewed');
    await registry.review('quota-reviewed', {
      tenantId: 'default', userId: 'reviewer', role: 'tenant_admin',
    });
    await expect(install('quota-deleted')).resolves.toBeDefined();
    await registry.delete('quota-deleted', viewer);
    await expect(install('quota-reused')).resolves.toBeDefined();
  });

  it('releases deleted pending storage immediately and garbage-collects stale staging artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-skill-retention-gc-'));
    const pending = join(root, 'users', 'owner', 'delete-me');
    await mkdir(pending, { recursive: true });
    await writeFile(join(pending, 'SKILL.md'), '---\nname: delete-me\ndescription: delete\n---\nbody');
    await writeProduct(pending, {
      name: 'delete-me', version: '1', enabled: true, reviewed: false,
      tenantId: 'default', ownerUserId: 'owner', visibility: 'private',
    });
    const staleImport = join(root, '.aiop-imports', 'stale-import');
    const staleArtifact = join(root, '.aiop-published', '.staging-stale');
    await mkdir(staleImport, { recursive: true });
    await mkdir(staleArtifact, { recursive: true });
    const old = new Date(Date.now() - 10_000);
    await utimes(staleImport, old, old);
    await utimes(staleArtifact, old, old);
    const registry = new SkillRegistry(root, { ...({ pendingQuota: {
      retentionMs: 100,
    } } as object) });
    await registry.scan();

    await registry.delete('delete-me', {
      tenantId: 'default', userId: 'owner', role: 'user',
    });

    await expect(stat(pending)).rejects.toThrow();
    await expect(readdir(join(root, '.aiop-tombstones'))).resolves.toEqual([]);
    await expect(stat(staleImport)).rejects.toThrow();
    await expect(stat(staleArtifact)).rejects.toThrow();
  });

  it('uses a process-shared mutex instead of recovering filesystem lease owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-upload-stale-lock-'));
    const name = 'process-lock';
    const lockKey = `skill-name:${name}`;
    const lockPath = join(
      root,
      '.aiop-locks',
      createHash('sha256').update(lockKey).digest('hex'),
    );
    const expiredOwnerDir = join(lockPath, 'foreign-live-owner');
    await mkdir(expiredOwnerDir, { recursive: true });
    await writeFile(join(expiredOwnerDir, 'owner.json'), JSON.stringify({
      token: 'foreign-live-owner', key: lockKey, leaseUntil: Date.now() - 60_000,
      hostname: 'another-pod.example', pid: 2_147_483_647,
    }));
    const skillDir = join(root, 'users', 'uploader', name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: stale\n---\nbody`);
    await writeProduct(skillDir, { name, version: '1' });
    const registry = new SkillRegistry(root);

    await expect(registry.installUploadedProduct(skillDir, {
      tenantId: 'default', userId: 'uploader', role: 'user',
    })).resolves.toMatchObject({ name, reviewed: false });
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it('releases the shared name mutex when review validation fails', async () => {
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
  it('rejects compressed archives above the route-specific package limit before parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-import-skill-compressed-limit-'));
    await expect(importSkillZip({
      rootDir: root,
      filename: 'oversized.zip',
      data: Buffer.alloc(10_000_001),
    })).rejects.toThrow('压缩包大小上限');
  });
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
