import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { SkillRegistry } from '../src/skill/registry.js';
import { buildSkillTools } from '../src/tools/skill.js';
import type { SandboxManager } from '../src/sandbox/lifecycle.js';
import type { ExecResult, SandboxHandle } from '../src/sandbox/types.js';

/** 记录 runCommand 调用并按脚本约定返回成功的假沙箱。 */
class FakeSandbox implements SandboxHandle {
  readonly sandboxId = 'sbx-test';
  commands: string[] = [];

  async runCode(): Promise<ExecResult> {
    return { stdout: '', stderr: '' };
  }

  async runCommand(command: string): Promise<ExecResult> {
    this.commands.push(command);
    if (command.includes('echo AIOP_SYNC_OK')) return { stdout: 'AIOP_SYNC_OK\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async setTimeout(): Promise<void> {}
  async kill(): Promise<void> {}
}

function fakeManager(sbx: FakeSandbox): SandboxManager {
  return { get: async () => sbx } as unknown as SandboxManager;
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
    await writeFile(join(skill, 'sub', 'SKILL.md'), '# 子模块文档内容');
    await writeFile(join(skill, 'sub', 'scripts', 'run.py'), 'print("hello-from-skill")');
    // 超过 2MB 的大文件：默认同步应跳过
    await writeFile(join(skill, 'sub', 'big.bin'), Buffer.alloc(2_500_000, 7));
    registry = new SkillRegistry(dir);
    await registry.scan();
  });

  it('load_skill guidance mentions read_file, and sync only when sandbox available', async () => {
    const [loadWithSync] = buildSkillTools(registry, fakeManager(new FakeSandbox()));
    const withSync = await loadWithSync!.run({ name: 'demo' }, { sessionId: 's1' });
    expect(withSync.content).toContain('skill__read_file');
    expect(withSync.content).toContain('skill__sync_to_sandbox');
    expect(withSync.content).not.toContain(dir); // 不再暴露服务端本地路径

    const [loadNoSync, ...rest] = buildSkillTools(registry);
    expect(rest.map((t) => t.def.name)).toEqual(['skill__read_file']);
    const noSync = await loadNoSync!.run({ name: 'demo' }, { sessionId: 's1' });
    expect(noSync.content).not.toContain('skill__sync_to_sandbox');
  });

  it('skill__read_file reads files, lists directories, and rejects escapes', async () => {
    const tools = buildSkillTools(registry);
    const readFileTool = tools.find((t) => t.def.name === 'skill__read_file')!;

    const file = await readFileTool.run({ name: 'demo', path: 'sub/SKILL.md' }, { sessionId: 's1' });
    expect(file.content).toContain('子模块文档内容');

    const rootList = await readFileTool.run({ name: 'demo' }, { sessionId: 's1' });
    expect(rootList.content).toContain('sub/');
    const subList = await readFileTool.run({ name: 'demo', path: 'sub' }, { sessionId: 's1' });
    expect(subList.content).toContain('sub/scripts/');

    const escape = await readFileTool.run({ name: 'demo', path: '../escape' }, { sessionId: 's1' });
    expect(escape.isError).toBe(true);

    const missing = await readFileTool.run({ name: 'nope', path: 'SKILL.md' }, { sessionId: 's1' });
    expect(missing.isError).toBe(true);
  });

  it('skill__sync_to_sandbox packs files, chunks base64, unpacks, and skips large files', async () => {
    const sbx = new FakeSandbox();
    const tools = buildSkillTools(registry, fakeManager(sbx));
    const sync = tools.find((t) => t.def.name === 'skill__sync_to_sandbox')!;

    const res = await sync.run({ name: 'demo' }, { sessionId: 's1' });
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

    const res = await sync.run({ name: 'demo', paths: ['sub/scripts'] }, { sessionId: 's1' });
    expect(res.isError).toBeFalsy();
    expect(sbx.commands[0]).not.toContain('rm -rf ');
    const tarStream = gunzipSync(Buffer.from(appendedBase64(sbx.commands), 'base64'));
    expect(tarStream.includes('hello-from-skill')).toBe(true);
    expect(tarStream.includes('子模块文档内容')).toBe(false);
  });
});

describe('SkillRegistry summaries budget', () => {
  it('truncates long descriptions and folds overflow skills', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiop-skill-budget-'));
    for (let i = 0; i < 3; i++) {
      const d = join(dir, `s${i}`);
      await mkdir(d);
      await writeFile(join(d, 'SKILL.md'), `---\nname: s${i}\ndescription: ${'长'.repeat(400)}\n---\n正文`);
    }
    const reg = new SkillRegistry(dir, { summaryBudget: 500 });
    await reg.scan();
    const text = reg.summaries();
    // 预算内至少一条被截断收录，其余折叠为仅名字
    expect(text).toContain('…');
    expect(text).toContain('其余技能（可用 load_skill 按名加载）');
    expect(text.length).toBeLessThan(700);
  });
});
