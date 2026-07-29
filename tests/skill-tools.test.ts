import { access, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from '../src/skill/registry.js';
import { buildSkillTools } from '../src/tools/skill/index.js';
import type { SandboxManager } from '../src/sandbox/lifecycle.js';
import type { ExecResult, SandboxHandle } from '../src/sandbox/types.js';
import { LocalSandboxProvider } from '../src/sandbox/local.js';
import { syncSkillToSandbox, SYNC_TOTAL_BYTES } from '../src/skill/sandbox-sync.js';

/** 记录 runCommand 调用并按脚本约定返回成功的假沙箱。 */
class FakeSandbox implements SandboxHandle {
  readonly sandboxId = 'sbx-test';
  commands: string[] = [];
  writtenFiles: Array<{ path: string; content: Uint8Array; mode?: number }> = [];

  async runCode(): Promise<ExecResult> {
    return { stdout: '', stderr: '' };
  }

  async runCommand(command: string): Promise<ExecResult> {
    this.commands.push(command);
    if (command.includes('echo AIOP_SYNC_OK')) return { stdout: 'AIOP_SYNC_OK\n', stderr: '', exitCode: 0 };
    if (command.includes('echo AIOP_CRED_OK')) return { stdout: 'AIOP_CRED_OK\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async setTimeout(): Promise<void> {}
  async writeFile(path: string, content: Uint8Array, options?: { mode?: number }): Promise<void> {
    this.writtenFiles.push({ path, content, mode: options?.mode });
  }
  async readFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async kill(): Promise<void> {}
}

function fakeManager(sbx: FakeSandbox): SandboxManager {
  return { get: async () => sbx, markCredentialInjected: () => {} } as unknown as SandboxManager;
}

/** 从记录的 printf 分片命令中还原 base64 内容。 */
function appendedBase64(commands: string[]): string {
  return commands
    .filter((c) => c.startsWith("printf '%s' '"))
    .map((c) => {
      const m = /^printf '%s' '([^']*)' >> /.exec(c);
      return m?.[1] ?? '';
    })
    .join('');
}

describe('buildSkillTools', () => {
  let dir: string;
  let registry: SkillRegistry;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aiop-skill-tools-'));
    const skill = join(dir, 'demo');
    await mkdir(join(skill, 'sub', 'scripts'), { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\n# 顶层文档');
    await writeFile(join(skill, '.product.json'), JSON.stringify({
      name: 'demo', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    }));
    await writeFile(join(skill, 'sub', 'SKILL.md'), '# 子模块文档内容');
    await writeFile(join(skill, 'sub', 'scripts', 'run.py'), 'print("hello-from-skill")');
    // 超过 2MB 的大文件：默认同步应跳过
    await writeFile(join(skill, 'sub', 'big.bin'), Buffer.alloc(2_500_000, 7));
    registry = new SkillRegistry(dir);
    await registry.scan();
  });

  it('load_skill guidance mentions read_file, and sync only when sandbox available', async () => {
    const [loadWithSync, , syncTool] = buildSkillTools(registry, fakeManager(new FakeSandbox()));
    const withSync = await loadWithSync!.run({ name: 'demo' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(withSync.content).toContain('skill__read_file');
    expect(withSync.content).toContain('skill__sync_to_sandbox');
    expect(withSync.content).not.toContain(dir); // 不再暴露服务端本地路径
    expect(syncTool!.def.description).not.toContain('/workspace/skills');
    expect(syncTool!.def.description).toContain('返回的目标目录');

    const [loadNoSync, ...rest] = buildSkillTools(registry);
    expect(rest.map((t) => t.def.name)).toEqual(['skill__read_file']);
    const noSync = await loadNoSync!.run({ name: 'demo' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(noSync.content).not.toContain('skill__sync_to_sandbox');
  });

  it('skill__read_file reads files, lists directories, and rejects escapes', async () => {
    const tools = buildSkillTools(registry);
    const readFileTool = tools.find((t) => t.def.name === 'skill__read_file')!;

    const file = await readFileTool.run({ name: 'demo', path: 'sub/SKILL.md' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(file.content).toContain('子模块文档内容');

    const rootList = await readFileTool.run({ name: 'demo' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(rootList.content).toContain('sub/');
    const subList = await readFileTool.run({ name: 'demo', path: 'sub' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(subList.content).toContain('sub/scripts/');

    const escape = await readFileTool.run({ name: 'demo', path: '../escape' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(escape.isError).toBe(true);

    const missing = await readFileTool.run({ name: 'nope', path: 'SKILL.md' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(missing.isError).toBe(true);
  });

  it('denies another tenant across load, read and sandbox sync surfaces', async () => {
    const tools = buildSkillTools(registry, fakeManager(new FakeSandbox()));
    const ctx = { sessionId: 'foreign', tenantId: 'tenant-b', userId: 'user-b', role: 'user' as const };
    for (const [name, args] of [
      ['load_skill', { name: 'demo' }],
      ['skill__read_file', { name: 'demo', path: 'SKILL.md' }],
      ['skill__sync_to_sandbox', { name: 'demo' }],
    ] as const) {
      const result = await tools.find((tool) => tool.def.name === name)!.run(args, ctx);
      expect(result.isError, name).toBe(true);
      expect(result.content, name).toContain('未找到技能');
    }
  });

  it('writes merged multi-provider credentials through the sandbox file API without shell secrets', async () => {
    const quotedDir = await mkdtemp(join(tmpdir(), 'aiop-skill-quoted-'));
    const skillDir = join(quotedDir, 'quoted');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: quoted\ndescription: quoted\n---\nbody');
    await writeFile(join(skillDir, '.product.json'), JSON.stringify({
      name: 'quoted', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
      credentials: ['aios', 'gitlab'], credentialFile: "sub/o'hare.json",
    }));
    const quotedRegistry = new SkillRegistry(quotedDir);
    await quotedRegistry.scan();
    const sbx = new FakeSandbox();
    const credentials = { get: async (_tenant: string, _user: string, provider: string) => ({ token: `${provider}-secret` }) };
    const sync = buildSkillTools(quotedRegistry, fakeManager(sbx), undefined, {
      credentials: credentials as never,
    }).find((tool) => tool.def.name === 'skill__sync_to_sandbox')!;

    const result = await sync.run({ name: 'quoted' }, {
      sessionId: 'quoted', tenantId: 'default', userId: 'u', role: 'user',
    });

    expect(result.isError).toBeFalsy();
    expect(sbx.writtenFiles).toHaveLength(1);
    expect(sbx.writtenFiles[0]).toMatchObject({ path: "/workspace/skills/quoted/sub/o'hare.json", mode: 0o600 });
    expect(JSON.parse(Buffer.from(sbx.writtenFiles[0]!.content).toString('utf8'))).toEqual({
      providers: {
        aios: { token: 'aios-secret' },
        gitlab: { token: 'gitlab-secret' },
      },
    });
    expect(sbx.commands.join('\n')).not.toContain('aios-secret');
    expect(sbx.commands.join('\n')).not.toContain('gitlab-secret');
    expect(sbx.commands.join('\n')).not.toContain(Buffer.from('aios-secret').toString('base64'));
  });

  it('syncs multi-provider credentials into a real local sandbox workspace path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-skill-local-sync-'));
    const name = `local-credential-sync-${process.pid}`;
    const skillDir = join(root, name);
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: local credential sync\n---\nbody`);
    await writeFile(join(skillDir, '.product.json'), JSON.stringify({
      name, version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
      credentials: ['aios', 'gitlab'], credentialFile: 'sub/token.json',
    }));
    const localRegistry = new SkillRegistry(root);
    await localRegistry.scan();
    const handle = await new LocalSandboxProvider().create({ key: 'local-credential-sync' });
    const manager = {
      get: async () => handle,
      markCredentialInjected: () => {},
    } as unknown as SandboxManager;
    const getCredential = vi.fn(async (_tenant: string, _user: string, provider: string) => ({
      token: `${provider}-secret`,
    }));
    const sync = buildSkillTools(localRegistry, manager, undefined, {
      credentials: { get: getCredential } as never,
    }).find((tool) => tool.def.name === 'skill__sync_to_sandbox')!;
    const hostWorkspaceFile = `/workspace/skills/${name}/sub/token.json`;
    const sandboxRoot = (await handle.runCommand('pwd')).stdout.trim();

    await expect(access(hostWorkspaceFile)).rejects.toThrow();
    try {
      const result = await sync.run({ name }, {
        sessionId: 'local-sync', tenantId: 'default', userId: 'u', role: 'user',
      });
      const dest = /到沙箱 (.+)\/（/.exec(result.content)?.[1];

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('本地沙箱不支持安全凭据文件');
      expect(getCredential).not.toHaveBeenCalled();
      expect(dest).toMatch(new RegExp(`^workspace/skills/${name}/[0-9a-f-]+$`));
      await expect(handle.readFile(`${dest}/sub/token.json`)).rejects.toThrow();
      expect(await readFile(join(sandboxRoot, dest!, 'SKILL.md'), 'utf8'))
        .toContain('local credential sync');
      const command = await handle.runCommand(`cat '${dest}/SKILL.md'`);
      expect(command).toMatchObject({ exitCode: 0 });
      expect(command.stdout).toContain('local credential sync');
      await expect(access(hostWorkspaceFile)).rejects.toThrow();
    } finally {
      await handle.kill();
    }
    await expect(access(sandboxRoot)).rejects.toThrow();
    await expect(access(hostWorkspaceFile)).rejects.toThrow();
  });

  it('does not follow a local sandbox destination symlink during partial sync', async () => {
    const handle = await new LocalSandboxProvider().create({ key: 'local-sync-symlink' });
    const sandboxRoot = (await handle.runCommand('pwd')).stdout.trim();
    const hostTarget = await mkdtemp(join(tmpdir(), 'aiop-local-sync-host-'));
    await mkdir(join(sandboxRoot, 'workspace', 'skills'), { recursive: true });
    await symlink(hostTarget, join(sandboxRoot, 'workspace', 'skills', 'demo'));
    const sync = buildSkillTools(registry, {
      get: async () => handle,
      markCredentialInjected: () => {},
    } as unknown as SandboxManager).find((tool) => tool.def.name === 'skill__sync_to_sandbox')!;
    try {
      const result = await sync.run({ name: 'demo', paths: ['sub/scripts/run.py'] }, {
        sessionId: 'local-sync-symlink', tenantId: 'default', userId: 'u', role: 'user',
      });
      expect(result.isError).toBe(true);
      await expect(access(join(hostTarget, 'sub', 'scripts', 'run.py'))).rejects.toThrow();
    } finally {
      await handle.kill();
    }
    await expect(access(sandboxRoot)).rejects.toThrow();
    await expect(access(join(hostTarget, 'sub', 'scripts', 'run.py'))).rejects.toThrow();
  });

  it('does not delete through a local sandbox parent symlink during full sync', async () => {
    const handle = await new LocalSandboxProvider().create({ key: 'local-full-sync-parent-symlink' });
    const sandboxRoot = (await handle.runCommand('pwd')).stdout.trim();
    const hostTarget = await mkdtemp(join(tmpdir(), 'aiop-local-full-sync-host-'));
    const hostSkill = join(hostTarget, 'demo');
    const hostFile = join(hostSkill, 'host.txt');
    await mkdir(hostSkill, { recursive: true });
    await writeFile(hostFile, 'host-original');
    await mkdir(join(sandboxRoot, 'workspace'), { recursive: true });
    await symlink(hostTarget, join(sandboxRoot, 'workspace', 'skills'));
    const sync = buildSkillTools(registry, {
      get: async () => handle,
      markCredentialInjected: () => {},
    } as unknown as SandboxManager).find((tool) => tool.def.name === 'skill__sync_to_sandbox')!;
    try {
      const result = await sync.run({ name: 'demo' }, {
        sessionId: 'local-full-sync-parent-symlink', tenantId: 'default', userId: 'u', role: 'user',
      });

      expect(result.isError).toBe(true);
      await expect(readFile(hostFile, 'utf8')).resolves.toBe('host-original');
    } finally {
      await handle.kill();
    }
    await expect(readFile(hostFile, 'utf8')).resolves.toBe('host-original');
  });

  it('uses a fresh destination for each local full sync without deleting the previous copy', async () => {
    const handle = await new LocalSandboxProvider().create({ key: 'local-full-sync-unique-dest' });
    const sandboxRoot = (await handle.runCommand('pwd')).stdout.trim();
    const sync = buildSkillTools(registry, {
      get: async () => handle,
      markCredentialInjected: () => {},
    } as unknown as SandboxManager).find((tool) => tool.def.name === 'skill__sync_to_sandbox')!;
    const destination = (content: string) => /到沙箱 (.+)\/（/.exec(content)?.[1];
    let firstDest: string | undefined;
    let secondDest: string | undefined;
    try {
      const first = await sync.run({ name: 'demo' }, {
        sessionId: 'local-full-sync-unique-dest', tenantId: 'default', userId: 'u', role: 'user',
      });
      const second = await sync.run({ name: 'demo' }, {
        sessionId: 'local-full-sync-unique-dest', tenantId: 'default', userId: 'u', role: 'user',
      });
      firstDest = destination(first.content);
      secondDest = destination(second.content);

      expect(first.isError).toBeFalsy();
      expect(second.isError).toBeFalsy();
      expect(firstDest).toMatch(/^workspace\/skills\/demo\//);
      expect(secondDest).toMatch(/^workspace\/skills\/demo\//);
      expect(secondDest).not.toBe(firstDest);
      await expect(handle.readFile(`${firstDest}/SKILL.md`)).resolves.toBeInstanceOf(Uint8Array);
      await expect(handle.readFile(`${secondDest}/SKILL.md`)).resolves.toBeInstanceOf(Uint8Array);
    } finally {
      await handle.kill();
    }
    await expect(access(sandboxRoot)).rejects.toThrow();
    await expect(access(join(sandboxRoot, firstDest!))).rejects.toThrow();
    await expect(access(join(sandboxRoot, secondDest!))).rejects.toThrow();
  });

  it('enforces local sync generation and byte quotas and resets them for a new handle', async () => {
    type TestOptions = {
      maxSyncGenerations: number;
      maxSyncBytes: number;
    };
    const Provider = LocalSandboxProvider as unknown as new (options: TestOptions) => LocalSandboxProvider;
    const syncTool = (handle: Awaited<ReturnType<LocalSandboxProvider['create']>>) => buildSkillTools(registry, {
      get: async () => handle,
      markCredentialInjected: () => {},
    } as unknown as SandboxManager).find((tool) => tool.def.name === 'skill__sync_to_sandbox')!;
    const context = {
      sessionId: 'local-sync-quota', tenantId: 'default', userId: 'u', role: 'user' as const,
    };

    const countProvider = new Provider({ maxSyncGenerations: 2, maxSyncBytes: 1_000_000 });
    const firstHandle = await countProvider.create({ key: 'local-sync-count-quota' });
    const firstRoot = (await firstHandle.runCommand('pwd')).stdout.trim();
    try {
      const sync = syncTool(firstHandle);
      expect((await sync.run({ name: 'demo' }, context)).isError).toBeFalsy();
      expect((await sync.run({ name: 'demo' }, context)).isError).toBeFalsy();
      const denied = await sync.run({ name: 'demo' }, context);
      expect(denied.isError).toBe(true);
      expect(denied.content).toMatch(/generation|次数|配额/i);
      await expect(readdir(join(firstRoot, 'workspace', 'skills', 'demo'))).resolves.toHaveLength(2);
    } finally {
      await firstHandle.kill();
    }
    const resetHandle = await countProvider.create({ key: 'local-sync-count-reset' });
    try {
      expect((await syncTool(resetHandle).run({ name: 'demo' }, context)).isError).toBeFalsy();
    } finally {
      await resetHandle.kill();
    }

    const byteProvider = new Provider({ maxSyncGenerations: 10, maxSyncBytes: 150 });
    const byteHandle = await byteProvider.create({ key: 'local-sync-byte-quota' });
    const byteRoot = (await byteHandle.runCommand('pwd')).stdout.trim();
    try {
      const sync = syncTool(byteHandle);
      expect((await sync.run({ name: 'demo' }, context)).isError).toBeFalsy();
      const denied = await sync.run({ name: 'demo' }, context);
      expect(denied.isError).toBe(true);
      expect(denied.content).toMatch(/bytes|字节|配额/i);
      await expect(readdir(join(byteRoot, 'workspace', 'skills', 'demo'))).resolves.toHaveLength(1);
    } finally {
      await byteHandle.kill();
    }
  });

  it('uses actual local file bytes for the single-sync limit and handle byte reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-local-sync-actual-bytes-'));
    const oversized = join(root, 'oversized.bin');
    await writeFile(oversized, Buffer.alloc(SYNC_TOTAL_BYTES + 1, 1));
    const totalHandle = await new LocalSandboxProvider({ maxSyncBytes: SYNC_TOTAL_BYTES * 2 })
      .create({ key: 'local-sync-actual-total' });
    try {
      const result = await syncSkillToSandbox({
        name: 'actual-total', dir: root, partial: true, sbx: totalHandle,
        files: [{
          name: 'oversized.bin',
          path: 'oversized.bin',
          size: 1,
          isDirectory: false,
          updatedAt: new Date().toISOString(),
        }],
      });
      expect(result.error).toMatch(/总量超过上限/);
      const sandboxRoot = (await totalHandle.runCommand('pwd')).stdout.trim();
      await expect(access(join(sandboxRoot, 'workspace', 'skills', 'actual-total'))).rejects.toThrow();
    } finally {
      await totalHandle.kill();
    }

    const quotaFile = join(root, 'quota.bin');
    await writeFile(quotaFile, Buffer.alloc(1_200, 2));
    const quotaHandle = await new LocalSandboxProvider({ maxSyncBytes: 1_000 })
      .create({ key: 'local-sync-actual-quota' });
    try {
      const result = await syncSkillToSandbox({
        name: 'actual-quota', dir: root, partial: true, sbx: quotaHandle,
        files: [{
          name: 'quota.bin',
          path: 'quota.bin',
          size: 1,
          isDirectory: false,
          updatedAt: new Date().toISOString(),
        }],
      });
      expect(result.error).toMatch(/byte quota|字节|配额/i);
      const sandboxRoot = (await quotaHandle.runCommand('pwd')).stdout.trim();
      await expect(access(join(sandboxRoot, 'workspace', 'skills', 'actual-quota'))).rejects.toThrow();
    } finally {
      await quotaHandle.kill();
    }

    const fixedFile = join(root, 'fixed.txt');
    await writeFile(fixedFile, 'before');
    const fixedHandle = await new LocalSandboxProvider({ maxSyncBytes: 6 })
      .create({ key: 'local-sync-fixed-buffer' });
    const reserve = fixedHandle.reserveSyncGeneration!.bind(fixedHandle);
    let reservedBytes = 0;
    fixedHandle.reserveSyncGeneration = async (bytes: number) => {
      reservedBytes = bytes;
      await writeFile(fixedFile, 'after-expanded');
      await reserve(bytes);
    };
    try {
      const result = await syncSkillToSandbox({
        name: 'fixed-buffer', dir: root, partial: true, sbx: fixedHandle,
        files: [{
          name: 'fixed.txt',
          path: 'fixed.txt',
          size: 6,
          isDirectory: false,
          updatedAt: new Date().toISOString(),
        }],
      });
      expect(result.error).toBeUndefined();
      expect(reservedBytes).toBe(6);
      await expect(fixedHandle.readFile(`${result.dest}/fixed.txt`)).resolves.toEqual(Buffer.from('before'));
    } finally {
      await fixedHandle.kill();
    }
  });

  it('keeps the multi-provider schema when only some credentials are available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiop-skill-partial-creds-'));
    const skillDir = join(root, 'partial-creds');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: partial-creds\ndescription: partial\n---\nbody');
    await writeFile(join(skillDir, '.product.json'), JSON.stringify({
      name: 'partial-creds', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
      credentials: ['aios', 'gitlab'], credentialFile: 'token.json',
    }));
    const registry = new SkillRegistry(root);
    await registry.scan();
    const sbx = new FakeSandbox();
    const sync = buildSkillTools(registry, fakeManager(sbx), undefined, {
      credentials: {
        get: async (_tenant: string, _user: string, provider: string) => (
          provider === 'aios' ? { token: 'available' } : undefined
        ),
      } as never,
    }).find((tool) => tool.def.name === 'skill__sync_to_sandbox')!;

    await sync.execute({ name: 'partial-creds' }, {
      tenantId: 'default', userId: 'u1', role: 'user', sessionId: 'partial',
    });

    expect(JSON.parse(Buffer.from(sbx.writtenFiles[0]!.content).toString('utf8'))).toEqual({
      providers: { aios: { token: 'available' } },
    });
  });

  it('skill__sync_to_sandbox packs files, chunks base64, unpacks, and skips large files', async () => {
    const sbx = new FakeSandbox();
    const tools = buildSkillTools(registry, fakeManager(sbx));
    const sync = tools.find((t) => t.def.name === 'skill__sync_to_sandbox')!;

    const res = await sync.run({ name: 'demo' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('/workspace/skills/demo/');
    // 大文件默认被跳过并在结果中列出
    expect(res.content).toContain('sub/big.bin');

    // 预检 + 全量同步应先清空目标目录
    expect(sbx.commands[0]).toContain('command -v tar');
    expect(sbx.commands[0]).toContain("rm -rf '/workspace/skills/demo'");
    // 解包命令收尾
    expect(sbx.commands.at(-1)).toContain('tar -xzf');

    // 还原分片 → gunzip 后 tar 流里应包含脚本内容，且不含大文件填充
    const tarStream = gunzipSync(Buffer.from(appendedBase64(sbx.commands), 'base64'));
    expect(tarStream.includes('hello-from-skill')).toBe(true);
    expect(tarStream.length).toBeLessThan(1_000_000);
  });

  it('skill__sync_to_sandbox with explicit paths syncs only that subtree without wiping dest', async () => {
    const sbx = new FakeSandbox();
    const tools = buildSkillTools(registry, fakeManager(sbx));
    const sync = tools.find((t) => t.def.name === 'skill__sync_to_sandbox')!;

    const res = await sync.run({ name: 'demo', paths: ['sub/scripts'] }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(res.isError).toBeFalsy();
    expect(sbx.commands[0]).not.toContain('rm -rf ');
    const tarStream = gunzipSync(Buffer.from(appendedBase64(sbx.commands), 'base64'));
    expect(tarStream.includes('hello-from-skill')).toBe(true);
    expect(tarStream.includes('子模块文档内容')).toBe(false);
  });
});

describe('SkillRegistry Pi summaries', () => {
  it('uses Pi system-prompt formatting without product-side truncation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiop-skill-budget-'));
    for (let i = 0; i < 3; i++) {
      const d = join(dir, `s${i}`);
      await mkdir(d);
      await writeFile(join(d, 'SKILL.md'), `---\nname: s${i}\ndescription: ${'长'.repeat(400)}\n---\n正文`);
      await writeFile(join(d, '.product.json'), JSON.stringify({
        name: `s${i}`, version: '1', enabled: true, reviewed: true,
        tenantId: 'default', visibility: 'public',
      }));
    }
    const reg = new SkillRegistry(dir, { summaryBudget: 500 });
    await reg.scan();
    const text = await reg.summariesFor({ tenantId: 'default', userId: 'u', role: 'user' });
    expect(text).toContain('<available_skills>');
    expect(text).toContain('<name>s0</name>');
    expect(text).toContain('<name>s2</name>');
    expect(text).not.toContain('其余技能（可用 load_skill 按名加载）');
  });
});
