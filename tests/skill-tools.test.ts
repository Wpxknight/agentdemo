import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { SkillRegistry } from '../src/skill/registry.js';
import { buildSkillTools } from '../src/tools/skill/index.js';
import type { SandboxManager } from '../src/sandbox/lifecycle.js';
import type { ExecResult, SandboxHandle } from '../src/sandbox/types.js';

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
    const [loadWithSync] = buildSkillTools(registry, fakeManager(new FakeSandbox()));
    const withSync = await loadWithSync!.run({ name: 'demo' }, { sessionId: 's1', tenantId: 'default', userId: 'u', role: 'user' });
    expect(withSync.content).toContain('skill__read_file');
    expect(withSync.content).toContain('skill__sync_to_sandbox');
    expect(withSync.content).not.toContain(dir); // 不再暴露服务端本地路径

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
