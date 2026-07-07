import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';
import type { SkillRegistry } from '../skill/registry.js';
import type { SandboxManager } from '../sandbox/lifecycle.js';
import type { ExecResult, SandboxHandle, SandboxSpec } from '../sandbox/types.js';
import type { SpecResolver } from './builtin.js';

const log = logger.child({ mod: 'skill-tools' });
const execFileAsync = promisify(execFile);

/** skill__read_file 返回内容的截断上限（字符）：防止大文件灌满上下文。 */
const READ_MAX_CHARS = 200_000;
/** 默认同步时跳过超过此大小的单文件；显式 paths 指定时不做单文件过滤。 */
const SYNC_SKIP_FILE_BYTES = 2_000_000;
/** 单次同步的原始文件总量上限。 */
const SYNC_TOTAL_BYTES = 16_000_000;
/** base64 分片长度（字符）：保守避开沙箱 shell 单命令长度限制。 */
const SYNC_CHUNK_CHARS = 64_000;
/** 同步进沙箱的目标根目录。 */
const SANDBOX_SKILLS_ROOT = '/workspace/skills';

function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

function reqString(o: Record<string, JsonValue>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !v) throw new Error(`参数 ${key} 必须是非空字符串`);
  return v;
}

function optStringArray(o: Record<string, JsonValue>, key: string): string[] | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
    throw new Error(`参数 ${key} 必须是字符串数组`);
  }
  return v as string[];
}

function failed(r: ExecResult): boolean {
  return Boolean(r.error) || (typeof r.exitCode === 'number' && r.exitCode !== 0);
}

function execErrorText(r: ExecResult): string {
  return r.error || r.stderr.trim() || `exit code ${r.exitCode}`;
}

/** 沙箱内目录名只保留安全字符，防止技能名注入 shell。 */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function fmtSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** 向沙箱追加一个 base64 分片；失败时减半重试一次。 */
async function pushChunk(sbx: SandboxHandle, b64Path: string, chunk: string): Promise<void> {
  const first = await sbx.runCommand(`printf '%s' '${chunk}' >> '${b64Path}'`);
  if (!failed(first)) return;
  const mid = Math.ceil(chunk.length / 2);
  for (const part of [chunk.slice(0, mid), chunk.slice(mid)]) {
    const retry = await sbx.runCommand(`printf '%s' '${part}' >> '${b64Path}'`);
    if (failed(retry)) throw new Error(`分片写入沙箱失败：${execErrorText(retry)}`);
  }
}

/**
 * 技能 agent 工具集：
 * - load_skill：渐进披露（registry.tool()）；
 * - skill__read_file：按需读技能子文档 / 脚本源码；
 * - skill__sync_to_sandbox（需沙箱）：把技能文件推进会话沙箱以便执行。
 */
export function buildSkillTools(
  registry: SkillRegistry,
  manager?: SandboxManager,
  resolve?: SpecResolver,
): ToolHandler[] {
  const hasSandboxSync = Boolean(manager);
  const tools: ToolHandler[] = [registry.tool({ hasSandboxSync })];

  tools.push({
    def: {
      name: 'skill__read_file',
      description:
        '读取技能目录内某个文件的内容（如子模块 SKILL.md、脚本源码）；path 指向目录或留空时返回该层文件清单。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名' },
          path: { type: 'string', description: '技能内相对路径；目录或留空则列目录' },
        },
        required: ['name'],
      },
    },
    async run(args: JsonValue): Promise<ToolResult> {
      const o = asObject(args);
      const name = reqString(o, 'name');
      const path = typeof o.path === 'string' ? o.path : '';
      if (!registry.get(name)) {
        return { id: '', content: `未找到技能 ${name}`, isError: true };
      }
      const listDir = async (dirPath: string): Promise<ToolResult> => {
        const entries = await registry.listDir(name, dirPath);
        const lines = entries.map((e) =>
          e.isDirectory ? `${e.path}/` : `${e.path} (${fmtSize(e.size)})`,
        );
        return {
          id: '',
          content: `目录 ${dirPath || '(根)'} 下共 ${entries.length} 项：\n${lines.join('\n') || '(空)'}`,
        };
      };
      try {
        if (!path) return await listDir('');
        const body = await registry.readFile(name, path);
        const truncated = body.content.length > READ_MAX_CHARS;
        const content = truncated
          ? `${body.content.slice(0, READ_MAX_CHARS)}\n\n…（已截断，原文件 ${fmtSize(body.entry.size)}）`
          : body.content;
        return { id: '', content };
      } catch (err) {
        if (String(err).includes('技能路径不是文件')) return listDir(path);
        return { id: '', content: `读取失败：${String(err)}`, isError: true };
      }
    },
  });

  if (manager) {
    const resolveSpec = (ctx: ToolContext): SandboxSpec => ({
      key: ctx.sessionId,
      ...(resolve ? resolve(ctx) : {}),
    });
    tools.push({
      def: {
        name: 'skill__sync_to_sandbox',
        description:
          '把技能目录同步进当前会话沙箱（目标 /workspace/skills/<技能名>/），之后可在沙箱内执行其脚本。'
          + '默认跳过超过 2MB 的单个文件；需要大文件时用 paths 显式指定子路径（单次同步总量上限 16MB）。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名' },
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: '可选：只同步这些技能内相对路径（文件或目录）',
            },
          },
          required: ['name'],
        },
      },
      async run(args: JsonValue, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const name = reqString(o, 'name');
        const paths = optStringArray(o, 'paths');
        const { dir, files } = await registry.collectFiles(name, paths);

        // 显式 paths 表示模型明确要这些内容，不做单文件过滤；默认全量同步时跳过大文件。
        const skipLarge = !paths?.length;
        const kept = skipLarge ? files.filter((f) => f.size <= SYNC_SKIP_FILE_BYTES) : files;
        const skipped = skipLarge ? files.filter((f) => f.size > SYNC_SKIP_FILE_BYTES) : [];
        if (!kept.length) {
          return { id: '', content: '没有可同步的文件（可能全部被大小过滤跳过）', isError: true };
        }
        const total = kept.reduce((n, f) => n + f.size, 0);
        if (total > SYNC_TOTAL_BYTES) {
          return {
            id: '',
            content: `待同步文件总量 ${fmtSize(total)} 超过上限 ${fmtSize(SYNC_TOTAL_BYTES)}；请用 paths 参数缩小同步范围`,
            isError: true,
          };
        }

        // 服务端打包（tar 保留目录结构与可执行位）
        const { stdout: tarBuf } = await execFileAsync(
          'tar',
          ['-C', dir, '-czf', '-', ...kept.map((f) => f.path)],
          { maxBuffer: SYNC_TOTAL_BYTES * 2, encoding: 'buffer' },
        );
        const b64 = tarBuf.toString('base64');

        const safe = safeName(name);
        const dest = `${SANDBOX_SKILLS_ROOT}/${safe}`;
        const tmp = `/tmp/aiop-skill-${safe}`;
        const sbx = await manager.get(resolveSpec(ctx));

        // 预检 + 准备：全量同步先清空目标目录保证幂等；子集同步原地覆盖。
        const prep = await sbx.runCommand(
          `command -v tar >/dev/null 2>&1 && command -v base64 >/dev/null 2>&1 || { echo AIOP_MISSING_TOOLS; exit 9; }; `
          + (paths?.length ? '' : `rm -rf '${dest}'; `)
          + `mkdir -p '${dest}' && rm -f '${tmp}.b64' '${tmp}.tgz'`,
        );
        if (failed(prep) || prep.stdout.includes('AIOP_MISSING_TOOLS')) {
          return {
            id: '',
            content: prep.stdout.includes('AIOP_MISSING_TOOLS')
              ? '沙箱缺少 tar/base64，无法同步；请改用 skill__read_file 读取内容后在沙箱内手动写文件'
              : `沙箱准备失败：${execErrorText(prep)}`,
            isError: true,
          };
        }
        for (let i = 0; i < b64.length; i += SYNC_CHUNK_CHARS) {
          await pushChunk(sbx, `${tmp}.b64`, b64.slice(i, i + SYNC_CHUNK_CHARS));
        }
        const unpack = await sbx.runCommand(
          `base64 -d '${tmp}.b64' > '${tmp}.tgz' && tar -xzf '${tmp}.tgz' -C '${dest}' `
          + `&& rm -f '${tmp}.b64' '${tmp}.tgz' && echo AIOP_SYNC_OK`,
        );
        if (failed(unpack) || !unpack.stdout.includes('AIOP_SYNC_OK')) {
          return { id: '', content: `沙箱解包失败：${execErrorText(unpack)}`, isError: true };
        }
        log.info({ skill: name, files: kept.length, bytes: total, sessionId: ctx.sessionId }, 'skill synced to sandbox');

        const skippedNote = skipped.length
          ? `\n跳过的大文件（>${fmtSize(SYNC_SKIP_FILE_BYTES)}，需要时用 paths 显式同步）：\n`
            + skipped.slice(0, 20).map((f) => `- ${f.path} (${fmtSize(f.size)})`).join('\n')
            + (skipped.length > 20 ? `\n…等共 ${skipped.length} 个` : '')
          : '';
        return {
          id: '',
          content: `已同步技能 ${name} 到沙箱 ${dest}/（${kept.length} 个文件，${fmtSize(total)}）。`
            + `在沙箱内执行脚本请以该目录为根，例如 cd '${dest}' 后运行相应 scripts。${skippedNote}`,
        };
      },
    });
  }

  return tools;
}
