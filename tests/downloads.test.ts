import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { DownloadStore } from '../src/server/downloads.js';
import { buildExportTool } from '../src/tools/export.js';
import type { SandboxManager } from '../packages/sandbox-runtime/src/lifecycle.js';
import type { SandboxHandle } from '../packages/sandbox-runtime/src/types.js';

const SECRET = 'test-secret';

async function tmpStore(overrides: { ttlMs?: number; maxBytes?: number; now?: () => number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aiop-dl-test-'));
  const store = new DownloadStore({ dir, secret: SECRET, ...overrides });
  return { dir, store };
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('DownloadStore', () => {
  it('saves bytes and serves them back via the signed token', async () => {
    const { store } = await tmpStore();
    const { url, expiresAt } = await store.save(Buffer.from('hello,world'), {
      name: '报表.csv',
      mime: 'text/csv',
      sessionId: 's1',
      tenantId: 't1',
    });
    expect(url.startsWith('/v1/files/')).toBe(true);
    expect(Date.parse(expiresAt)).toBeGreaterThan(0);

    const token = url.slice('/v1/files/'.length);
    const opened = await store.open(token);
    expect(opened).toBeDefined();
    expect(opened!.meta.name).toBe('报表.csv');
    expect(opened!.meta.mime).toBe('text/csv');
    expect(opened!.size).toBe('hello,world'.length);
    expect((await drain(opened!.stream)).toString()).toBe('hello,world');
  });

  it('rejects tampered / foreign-signed / expired tokens', async () => {
    const { store } = await tmpStore();
    const { url } = await store.save(Buffer.from('x'), { name: 'a.txt', mime: 'text/plain', sessionId: 's1' });
    const token = url.slice('/v1/files/'.length);

    expect(await store.open(`${token}tamper`)).toBeUndefined();
    expect(await store.open('not-a-jwt')).toBeUndefined();

    // 用别的密钥签一个结构合法的令牌 → 验签失败
    const foreign = await new SignJWT({ fid: '0'.repeat(32), name: 'a', mime: 'text/plain', sid: 's1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('other-secret'));
    expect(await store.open(foreign)).toBeUndefined();
  });

  it('open returns undefined after expiry', async () => {
    let clock = 1_000_000_000_000;
    const { store } = await tmpStore({ ttlMs: 1000, now: () => clock });
    const { url } = await store.save(Buffer.from('x'), { name: 'a.txt', mime: 'text/plain', sessionId: 's1' });
    const token = url.slice('/v1/files/'.length);
    expect(await store.open(token)).toBeDefined();
    clock += 5000; // 过期
    expect(await store.open(token)).toBeUndefined();
  });

  it('rejects oversized saves', async () => {
    const { store } = await tmpStore({ maxBytes: 4 });
    await expect(store.save(Buffer.from('12345'), { name: 'big', mime: 'text/plain', sessionId: 's1' })).rejects.toThrow(/上限|字节/);
  });

  it('sweep deletes files older than ttl + grace', async () => {
    // 用接近真实的时钟：sweep 比较的是真实文件系统 mtime。
    const clock = Date.now();
    const { dir, store } = await tmpStore({ ttlMs: 1000, now: () => clock });
    await store.save(Buffer.from('keep'), { name: 'keep', mime: 'text/plain', sessionId: 's1' });
    // 造一个陈旧文件（mtime 远早于 cutoff）
    const stale = join(dir, 'a'.repeat(32));
    await writeFile(stale, 'old');
    const oldTime = new Date(clock - 10 * 60 * 60_000);
    await utimes(stale, oldTime, oldTime);

    const removed = await store.sweep();
    expect(removed).toBe(1);
    expect(await readdir(dir)).toHaveLength(1);
  });
});

function fakeManager(sbx: SandboxHandle): SandboxManager {
  return { get: async () => sbx } as unknown as SandboxManager;
}

function fakeSandbox(files: Record<string, Uint8Array>): SandboxHandle {
  return {
    sandboxId: 'sbx',
    runCode: async () => ({ stdout: '', stderr: '' }),
    runCommand: async () => ({ stdout: '', stderr: '' }),
    async readFile(path: string) {
      const f = files[path];
      if (!f) throw new Error('ENOENT');
      return f;
    },
    setTimeout: async () => {},
    kill: async () => {},
  };
}

describe('sbx__export_file tool', () => {
  const ctx = { sessionId: 's1', tenantId: 't1', userId: 'u1', role: 'user' as const };

  it('reads a sandbox file and returns a markdown download link', async () => {
    const { store } = await tmpStore();
    const sbx = fakeSandbox({ '/workspace/out.xlsx': Buffer.from('PK\x03\x04excel') });
    const tool = buildExportTool(fakeManager(sbx), (c) => ({ key: c.sessionId }), store);

    const res = await tool.execute({ path: '/workspace/out.xlsx' }, ctx);
    expect(res.isError).toBeFalsy();
    const m = /\]\((\/v1\/files\/[^)]+)\)/.exec(res.content as string);
    expect(m).toBeTruthy();
    const opened = await store.open(m![1]!.slice('/v1/files/'.length));
    expect(opened!.meta.name).toBe('out.xlsx');
    expect(opened!.meta.mime).toContain('spreadsheetml');
  });

  it('honors an explicit filename and mime', async () => {
    const { store } = await tmpStore();
    const sbx = fakeSandbox({ 'a.bin': Buffer.from('data') });
    const tool = buildExportTool(fakeManager(sbx), (c) => ({ key: c.sessionId }), store);
    const res = await tool.execute({ path: 'a.bin', filename: '结果.md', mime: 'text/markdown' }, ctx);
    const token = /\]\(\/v1\/files\/([^)]+)\)/.exec(res.content as string)![1]!;
    const opened = await store.open(token);
    expect(opened!.meta.name).toBe('结果.md');
    expect(opened!.meta.mime).toBe('text/markdown');
  });

  it('errors when the file is missing or empty', async () => {
    const { store } = await tmpStore();
    const tool = buildExportTool(fakeManager(fakeSandbox({ empty: new Uint8Array() })), (c) => ({ key: c.sessionId }), store);
    expect((await tool.execute({ path: 'nope' }, ctx)).isError).toBe(true);
    expect((await tool.execute({ path: 'empty' }, ctx)).isError).toBe(true);
  });

  it('rejects files above the sink limit', async () => {
    const { store } = await tmpStore({ maxBytes: 3 });
    const tool = buildExportTool(fakeManager(fakeSandbox({ big: Buffer.from('12345') })), (c) => ({ key: c.sessionId }), store);
    const res = await tool.execute({ path: 'big' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('过大');
  });
});
