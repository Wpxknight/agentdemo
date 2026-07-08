import { posix } from 'node:path';
import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';
import type { SandboxManager } from '../sandbox/lifecycle.js';
import type { SandboxSpec } from '../sandbox/types.js';
import type { ExportSink } from '../server/downloads.js';
import type { SpecResolver } from './builtin.js';

function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

function reqString(o: Record<string, JsonValue>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !v) throw new Error(`参数 ${key} 必须是非空字符串`);
  return v;
}

function resolveSpec(resolve: SpecResolver, ctx: ToolContext): SandboxSpec {
  return { key: ctx.sessionId, ...resolve(ctx) };
}

/** 扩展名 → MIME，覆盖导出常见格式；未知回退 octet-stream（浏览器仍会当附件下载）。 */
const MIME_BY_EXT: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  zip: 'application/zip',
};

function guessMime(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** 规整下载文件名：取 basename，剔除控制字符与双引号（防 Content-Disposition 注入），兜底 download。 */
function safeDownloadName(raw: string): string {
  const base = posix.basename(raw.replace(/\\/g, '/'));
  const cleaned = [...base]
    .filter((ch) => ch !== '"' && ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
  return cleaned || 'download';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * sbx__export_file：把沙箱内已生成的文件导出为用户可下载的链接。
 * 读取字节 → 交给 ExportSink 落盘签发能力 URL → 返回可点击的 Markdown 链接，
 * 由模型转达给用户（下载路由是能力令牌，锚点点击即可下载）。
 */
export function buildExportTool(
  manager: SandboxManager,
  resolve: SpecResolver,
  sink: ExportSink,
): ToolHandler {
  return {
    def: {
      name: 'sbx__export_file',
      description:
        '把沙箱中已生成的文件（Excel/CSV/Markdown/PDF/图片/压缩包等）导出为用户可下载的链接。'
        + '当用户要“下载/导出/保存到本地”某个生成结果时使用。返回一个有时效的下载链接，'
        + '请在回复中把该链接作为 Markdown 链接原样提供给用户。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '沙箱内文件路径（相对会话工作目录或绝对路径）' },
          filename: { type: 'string', description: '下载时的文件名；缺省取 path 的文件名' },
          mime: { type: 'string', description: 'MIME 类型；缺省按扩展名推断' },
        },
        required: ['path'],
      },
    },
    async run(args: JsonValue, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(args);
      const path = reqString(o, 'path');
      const name = safeDownloadName(typeof o.filename === 'string' && o.filename ? o.filename : path);
      const mime = typeof o.mime === 'string' && o.mime ? o.mime : guessMime(name);

      const sbx = await manager.get(resolveSpec(resolve, ctx));
      let bytes: Uint8Array;
      try {
        bytes = await sbx.readFile(path);
      } catch (err) {
        return { id: '', content: `读取文件失败：${path}（${String(err)}）。请确认文件已在沙箱中生成。`, isError: true };
      }
      if (bytes.byteLength === 0) {
        return { id: '', content: `文件为空：${path}`, isError: true };
      }
      if (bytes.byteLength > sink.maxBytes) {
        return {
          id: '',
          content: `文件过大无法导出：${formatBytes(bytes.byteLength)}，上限 ${formatBytes(sink.maxBytes)}。`,
          isError: true,
        };
      }

      try {
        const { url, expiresAt } = await sink.save(bytes, {
          name,
          mime,
          tenantId: ctx.tenantId,
          sessionId: ctx.sessionId,
        });
        const hours = Math.round(sink.ttlMs / 3_600_000);
        return {
          id: '',
          content:
            `文件已导出：${name}（${formatBytes(bytes.byteLength)}）。`
            + `请把下面的下载链接提供给用户（约 ${hours} 小时内有效，至 ${expiresAt}）：\n`
            + `[${name}](${url})`,
        };
      } catch (err) {
        return { id: '', content: `导出失败：${String(err)}`, isError: true };
      }
    },
  };
}
