import { logger } from '../../logger.js';
import type { JsonValue, ToolResult } from '../../llm/types.js';
import { defineTool, type ToolContext, type ToolHandler } from '../../agent/tools.js';
import type { SkillRegistry } from '../../skill/registry.js';
import type { SandboxManagerLike } from '@aiop/sandbox-runtime';
import { isSandboxAcquirer } from '@aiop/sandbox-runtime';
import type { SandboxSpec } from '@aiop/sandbox-runtime';
import { resolveSandboxSpec, type SpecResolver } from '../builtin.js';
import type { UserCredentials } from '../../auth/credentials.js';
import type { AuditSink } from '../../audit/sink.js';
import { injectSkillCredentials } from '../../skill/credentials.js';
import { syncSkillToSandbox, SYNC_SKIP_FILE_BYTES } from '../../skill/sandbox-sync.js';

const log = logger.child({ mod: 'skill-tools' });

/** skill__read_file 返回内容的截断上限（字符）：防止大文件灌满上下文。 */
const READ_MAX_CHARS = 200_000;

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

function fmtSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)}KB`;
  return `${bytes}B`;
}

export interface SkillToolDeps {
  /** 用户下游凭据缓存：同步声明了 credentials 的技能时按当前用户注入凭据文件（P3）。 */
  credentials?: UserCredentials;
  audit?: AuditSink;
}

/**
 * 技能 agent 工具集：
 * - load_skill：渐进披露（registry.tool()）；
 * - skill__read_file：按需读技能子文档 / 脚本源码；
 * - skill__sync_to_sandbox（需沙箱）：把技能文件推进会话沙箱以便执行。
 * 三条链路都做可见性检查（不信 LLM）：越权技能等同不存在。
 */
export function buildSkillTools(
  registry: SkillRegistry,
  manager?: SandboxManagerLike,
  resolve?: SpecResolver,
  deps: SkillToolDeps = {},
): ToolHandler[] {
  const hasSandboxSync = Boolean(manager);
  const tools: ToolHandler[] = [registry.tool({ hasSandboxSync })];

  tools.push(defineTool({
      name: 'skill__read_file',
      capability: 'read',
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
    async execute(args: JsonValue, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(args);
      const name = reqString(o, 'name');
      const path = typeof o.path === 'string' ? o.path : '';
      if (!await registry.getAvailableFor(name, ctx)) {
        return { id: '', content: `未找到技能 ${name}`, isError: true };
      }
      const listDir = async (dirPath: string): Promise<ToolResult> => {
        const entries = await registry.listDir(name, dirPath, ctx);
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
        const body = await registry.readFile(name, path, ctx);
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
  }));

  if (manager) {
    const resolveSpec = async (ctx: ToolContext): Promise<SandboxSpec> =>
      resolveSandboxSpec(resolve ?? (() => ({})), ctx);
    tools.push(defineTool({
        name: 'skill__sync_to_sandbox',
        capability: 'retryable_write',
        description:
          '把技能目录同步进当前会话沙箱，之后可在工具返回的目标目录内执行其脚本。'
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
      async execute(args: JsonValue, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const name = reqString(o, 'name');
        const paths = optStringArray(o, 'paths');
        const skill = await registry.getAvailableFor(name, ctx);
        if (!skill) return { id: '', content: `未找到技能 ${name}`, isError: true };
        const { dir, files } = await registry.collectFiles(name, paths, ctx);

        const acquired = isSandboxAcquirer(manager)
          ? await manager.acquire(ctx)
          : await (async () => {
              const spec = await resolveSpec(ctx);
              const handle = await manager.get(spec, { signal: ctx.signal });
              return {
                handle,
                spec,
                invalidate: () => manager.evict?.(spec.key, handle),
                markCredentialInjected: () => manager.markCredentialInjected(spec.key),
              };
            })();
        const sbx = acquired.handle;
        const synced = await syncSkillToSandbox({ name, dir, files, partial: Boolean(paths?.length), sbx });
        if (synced.error) return { id: '', content: synced.error, isError: true };
        const { dest, kept, skipped, total } = synced;
        log.info({ skill: name, files: kept.length, bytes: total, sessionId: ctx.sessionId }, 'skill synced to sandbox');

        // 凭据注入（P3）：技能声明了 credentials 时，把当前用户的平台凭据写入沙箱内的凭据文件。
        // 凭据来自服务端缓存（按 toolCtx 的 tenant/user 查找），身份不可能被聊天内容改变。
        const credentialNote = await injectSkillCredentials({
          skill,
          sbx,
          dest,
          ctx,
          markCredentialInjected: acquired.markCredentialInjected,
          deps,
        });

        const skippedNote = skipped.length
          ? `\n跳过的大文件（>${fmtSize(SYNC_SKIP_FILE_BYTES)}，需要时用 paths 显式同步）：\n`
            + skipped.slice(0, 20).map((f) => `- ${f.path} (${fmtSize(f.size)})`).join('\n')
            + (skipped.length > 20 ? `\n…等共 ${skipped.length} 个` : '')
          : '';
        return {
          id: '',
          content: `已同步技能 ${name} 到沙箱 ${dest}/（${kept.length} 个文件，${fmtSize(total)}）。`
            + `在沙箱内执行脚本请以该目录为根，例如 cd '${dest}' 后运行相应 scripts。${credentialNote}${skippedNote}`,
        };
      },
    }));
  }

  return tools;
}
