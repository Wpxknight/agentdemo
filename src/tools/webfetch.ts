import { assertPublicUrl } from '../net/ssrf.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import { defineTool, type ToolContext, type ToolHandler } from '../agent/tools.js';

/**
 * WebFetch 工具（借鉴 Claude Code WebFetchTool）：
 * 抓取一个 URL 并把 HTML 归一为纯文本返回，供模型排障时查文档 / 读页面。
 * 安全边界：
 * - 域名预批准：配置 allowedDomains 后，只允许其中（含子域）的主机；未配置则默认放行公网主机；
 * - SSRF 防护：解析后的目标 IP 不得落在私网（除非显式 allowPrivate）；禁止跟随重定向；
 * - 大小/超时上限，返回文本截断。
 */
const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 40_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface WebFetchOptions {
  /** 允许访问的域名白名单（含子域）；为空表示不限制（仍受 SSRF 私网防护约束）。 */
  allowedDomains?: string[];
  /** 允许目标解析到私网地址（仅内网文档站点时开启）。默认禁止。 */
  allowPrivate?: boolean;
  timeoutMs?: number;
}

function domainAllowed(host: string, allowed?: string[]): boolean {
  if (!allowed?.length) return true;
  const h = host.toLowerCase();
  return allowed.some((d) => {
    const dd = d.toLowerCase().replace(/^\*\./, '');
    return h === dd || h.endsWith(`.${dd}`);
  });
}

/** 极简 HTML→文本：去 script/style、标签转空白、解码常见实体、压缩空白。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

export function buildWebFetchTool(opts: WebFetchOptions = {}): ToolHandler {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return defineTool({
      name: 'web_fetch',
      capability: 'read',
      description:
        '抓取指定 URL 的网页内容并返回纯文本（用于查阅文档、读取页面）。'
        + '仅支持 http/https，遵守域名白名单与私网防护。'
        + (opts.allowedDomains?.length ? `允许域名：${opts.allowedDomains.join(', ')}。` : ''),
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的完整 URL（http/https）' },
        },
        required: ['url'],
      },
    async execute(args: JsonValue, _ctx: ToolContext): Promise<ToolResult> {
      const url = typeof asObject(args).url === 'string' ? (asObject(args).url as string) : '';
      if (!url) return { id: '', content: '参数 url 必填', isError: true };

      let target: URL;
      try {
        target = await assertPublicUrl(url, opts.allowPrivate ?? false);
      } catch (err) {
        return { id: '', content: `URL 被拒绝：${String(err instanceof Error ? err.message : err)}`, isError: true };
      }
      if (!domainAllowed(target.hostname, opts.allowedDomains)) {
        return { id: '', content: `域名不在白名单：${target.hostname}`, isError: true };
      }

      try {
        const res = await fetch(target, {
          redirect: 'error', // 禁止重定向绕过 SSRF/白名单校验
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
        });
        if (!res.ok) return { id: '', content: `HTTP ${res.status} ${res.statusText}`, isError: true };

        const buf = Buffer.from(await res.arrayBuffer());
        const truncatedBytes = buf.length > MAX_BYTES;
        const raw = buf.subarray(0, MAX_BYTES).toString('utf8');
        const ctype = res.headers.get('content-type') ?? '';
        const body = /html/i.test(ctype) ? htmlToText(raw) : raw;
        const text = body.length > MAX_TEXT_CHARS ? `${body.slice(0, MAX_TEXT_CHARS)}\n\n…（内容已截断）` : body;
        const note = truncatedBytes ? '（响应体较大，仅取前 2MB）\n' : '';
        return { id: '', content: `# ${target.href}\n${note}\n${text}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { id: '', content: `抓取失败：${msg}`, isError: true };
      }
    },
  });
}
