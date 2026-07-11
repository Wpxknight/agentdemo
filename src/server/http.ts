import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import { logger } from '../logger.js';
import type { Runtime, RuntimeModelConfig, SandboxConnectionInfo } from '../runtime.js';
import { COMPACTION_RETRY_GROWTH_TOKENS, runAgent } from '../agent/core.js';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  contextBudgetTokens as budgetForWindow,
  renderForSummary,
} from '../agent/context.js';
import type { ChatModel, ToolContentBlock } from '../model/types.js';
import { InMemoryApprovalStore, InteractiveApprovalGate } from '../agent/approval.js';
import { InMemoryQuestionStore } from '../agent/question.js';
import type { QuestionAnswers, QuestionSpec } from '../agent/question.js';
import { authenticate } from './context.js';
import { AuthzError, canManageUsersOf, requirePermission } from '../auth/rbac.js';
import { LocalAuthProvider } from '../auth/local.js';
import { OidcAuthProvider } from '../auth/oidc.js';
import { AiosAuthError } from '../auth/aios.js';
import { softDeleteUser, setUserEnabled } from '../auth/lifecycle.js';
import { createTenant, createUser, listTenants } from '../auth/admin.js';
import type { RequestContext, Role } from '../auth/types.js';
import { DEFAULT_TASK_MAX_RUN_MS, type SandboxSettings, type ScheduledTaskPatch } from '../db/store.js';
import { isValidCron } from '../scheduler/cron.js';
import { createScheduledTaskRunner } from '../scheduler/runner.js';
import { createModel } from '../model/factory.js';
import { estimateCost } from '../model/cost.js';
import type { JsonValue, Msg, ToolCall } from '../model/types.js';
import { importSkillZip } from '../skill/import.js';
import type { Skill, SkillRegistry } from '../skill/registry.js';
import { McpServerSchema } from '../config/schema.js';

const log = logger.child({ mod: 'http' });

type Req = http.IncomingMessage;
type Res = http.ServerResponse;
type ActiveAgentRun = { abort: AbortController; append: (message: Msg) => void; drain: () => Msg[] };
type ActiveAgentRuns = Map<string, Set<ActiveAgentRun>>;
/** 无效压缩水位（tenant+session → token 数）：摘要后仍超触发线时记录，历史没涨够前跳过重试。 */
type CompactionWatermarks = Map<string, number>;

const OIDC_COOKIE = 'aiop_oidc';
/** 手动“立即执行”的任务 id 去重（本进程内），防止连点重复触发。 */
const runningManualTasks = new Set<number>();
const RUN_TERMINATED_MESSAGE = '会话运行已终止';
const GOAL_MODE_SYSTEM = [
  '目标模式：用户通过 /goal 授权你自主推进目标任务，直到目标完成、遇到阻塞或需要用户决策。',
  '在目标模式下，低风险、可逆、只读或纯新增的辅助步骤可直接执行，不要为普通中间步骤反复请求确认。',
  '涉及不可逆、高风险、破坏性、删除、修改现有系统状态、生产变更、凭据暴露或费用明显增加的操作，仍必须先询问用户并等待明确确认。',
  '持续记录关键行动和验证结果；完成后用简洁 Markdown 汇报目标是否达成、执行过的关键步骤和遗留风险。',
].join('\n');

/** 技能 zip 以 base64 JSON 上传：44MB 的包编码后约 60MB，导入接口单独放宽到 128MB。 */
const SKILL_IMPORT_MAX_BODY = 128_000_000;

/** 读取并解析 JSON 请求体（默认限制 8MB，支持聊天附件以 base64 形式上传）。 */
async function readJson(req: Req, maxSize = 8_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxSize) throw new HttpError(413, '请求体过大');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function sendJson(res: Res, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function sendHtml(res: Res, status: number, html: string): void {
  const buf = Buffer.from(html);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

/** attachment 头：ASCII 兜底 filename + RFC 5987 filename*（保留中文等非 ASCII 文件名）。 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function sendWebAsset(res: Res, path: string, frameAncestors?: string[]): Promise<boolean> {
  if (path === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return true;
  }
  const cleanPath = decodeURIComponent(path).replace(/^\/+/, '');
  if (cleanPath.includes('..')) return false;
  const isSpaRoute = path === '/' || path === '/index.html' || path === '/login';
  const assetPath = isSpaRoute ? 'index.html' : cleanPath;
  if (!isSpaRoute && !assetPath.startsWith('assets/')) return false;
  const buf = await readWebFile(`dist/${assetPath}`).catch(() => undefined);
  if (!buf) return false;
  const headers: Record<string, string | number> = {
    'content-type': contentType(assetPath),
    'content-length': buf.length,
  };
  if (assetPath === 'index.html') {
    // 嵌入防护：仅允许同源 + 配置白名单里的宿主页（如 AIOS）嵌入，防第三方站点 iframe 钓鱼。
    const ancestors = ['\'self\'', ...(frameAncestors ?? [])].join(' ');
    headers['content-security-policy'] = `frame-ancestors ${ancestors}`;
  }
  res.writeHead(200, headers);
  res.end(buf);
  return true;
}

async function readWebFile(file: string): Promise<Buffer> {
  return readFile(new URL(`../../web/${file}`, import.meta.url));
}

function contentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 业务错误：携带 HTTP 状态码。 */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

function newSessionId(): string {
  return String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
}

function sessionIdValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

function currentModelConfig(rt: Runtime): RuntimeModelConfig {
  return rt.modelConfig ?? {
    id: rt.model.id,
    protocol: 'anthropic',
    baseURL: '',
    apiKey: '',
    model: rt.model.id,
  };
}

function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.length <= 6) return `${apiKey.slice(0, 1)}...${apiKey.slice(-1)}`;
  return `${apiKey.slice(0, 3)}...${apiKey.slice(-3)}`;
}

function publicModelConfig(config: RuntimeModelConfig): Record<string, unknown> {
  return {
    id: config.id,
    protocol: config.protocol,
    base_url: config.baseURL,
    model: config.model,
    api_key: config.apiKey,
    api_key_set: Boolean(config.apiKey),
    api_key_preview: maskApiKey(config.apiKey),
    context_window_tokens: contextWindowTokens(config),
    context_keep_images: keepImagesOf(config),
    effort: config.effort,
  };
}

function sandboxSettingsBody(s: SandboxConnectionInfo): Record<string, unknown> {
  return {
    settings: {
      enabled: s.enabled,
      provider: s.provider,
      domain: s.domain ?? '',
      protocol: s.protocol ?? 'http',
      default_image: s.defaultImage ?? '',
      api_key_set: Boolean(s.apiKey),
      api_key_preview: maskApiKey(s.apiKey ?? ''),
    },
  };
}

function modelSettingsBody(config: RuntimeModelConfig, options: RuntimeModelConfig[] = []): Record<string, unknown> {
  const body: Record<string, unknown> = { config: publicModelConfig(config) };
  if (options.length) body.options = options.map(publicModelConfig);
  return body;
}

function parseProtocol(value: string | undefined): 'anthropic' | 'openai' {
  if (!value || value === 'anthropic') return 'anthropic';
  if (value === 'openai') return 'openai';
  throw new HttpError(400, 'protocol 只支持 openai / anthropic');
}

function modelConfigFromBody(
  body: Record<string, unknown>,
  current: RuntimeModelConfig,
  options: RuntimeModelConfig[] = [],
): RuntimeModelConfig {
  const requestedId = str(body, 'id') ?? str(body, 'model_id');
  const hasExplicitFields = [
    'protocol',
    'base_url',
    'baseURL',
    'api_key',
    'apiKey',
    'model',
    'context_window_tokens',
    'contextWindowTokens',
    'context_keep_images',
    'contextKeepImages',
  ].some((key) => body[key] !== undefined);
  const selected = requestedId ? options.find((option) => option.id === requestedId || option.model === requestedId) : undefined;
  if (requestedId && !hasExplicitFields) {
    if (!selected) throw new HttpError(400, `未知模型：${requestedId}`);
    return { ...selected };
  }
  const base = selected ?? current;
  const protocol = parseProtocol(str(body, 'protocol') ?? base.protocol);
  const baseURL = (str(body, 'base_url') ?? str(body, 'baseURL') ?? base.baseURL).trim();
  const model = (str(body, 'model') ?? base.model).trim();
  const id = (str(body, 'id') ?? (selected ? base.id : model)).trim();
  const apiKeyInput = str(body, 'api_key') ?? str(body, 'apiKey');
  const apiKey = apiKeyInput && apiKeyInput.trim() ? apiKeyInput.trim() : base.apiKey;
  if (!baseURL) throw new HttpError(400, 'base_url 必填');
  if (!apiKey) throw new HttpError(400, 'api_key 必填');
  if (!model) throw new HttpError(400, 'model 必填');
  return {
    id: id || model,
    protocol,
    baseURL,
    apiKey,
    model,
    contextWindowTokens: parseContextWindowTokens(body, base.contextWindowTokens),
    contextKeepImages: parseContextKeepImages(body, base.contextKeepImages),
    effort: parseEffort(str(body, 'effort'), base.effort),
  };
}

function parseContextKeepImages(body: Record<string, unknown>, current: number | undefined): number | undefined {
  const value = body.context_keep_images ?? body.contextKeepImages;
  if (value === undefined) return current;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'context_keep_images 必须是 >= 0 的整数');
  return Math.floor(n);
}

const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 解析推理深度；缺省/非法保留当前值。 */
function parseEffort(value: string | undefined, current: RuntimeModelConfig['effort']): RuntimeModelConfig['effort'] {
  if (value === undefined) return current;
  return (EFFORTS as readonly string[]).includes(value) ? (value as RuntimeModelConfig['effort']) : current;
}

function parseContextWindowTokens(body: Record<string, unknown>, current: number | undefined): number | undefined {
  const value = body.context_window_tokens ?? body.contextWindowTokens;
  if (value === undefined) return current;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'context_window_tokens 必须是正整数');
  return Math.floor(n);
}

function contextWindowTokens(config?: Pick<RuntimeModelConfig, 'contextWindowTokens'>): number {
  return config?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** 发送给模型前压缩历史的 token 预算 = 上下文窗口 − 输出预留 − 安全余量。 */
function contextBudgetTokens(config?: Pick<RuntimeModelConfig, 'contextWindowTokens'>): number {
  return budgetForWindow(contextWindowTokens(config));
}

/** 触发摘要压缩的阈值：历史 token 超过预算的这个比例时，把最旧的消息摘要成一段。 */
const COMPACTION_TRIGGER_RATIO = 0.85;
/** 摘要压缩时保留原样的最近消息条数（更早的进摘要）。 */
const COMPACTION_KEEP_RECENT = 8;

/** 触发摘要压缩的 token 阈值（runAgent 在轮次边界按此检查，含首轮）。 */
function compactionTriggerTokens(config?: Pick<RuntimeModelConfig, 'contextWindowTokens'>): number {
  return Math.floor(contextBudgetTokens(config) * COMPACTION_TRIGGER_RATIO);
}

/** 历史里保留图片的最近带图消息条数（配置可调，默认 1）。 */
function keepImagesOf(config?: Pick<RuntimeModelConfig, 'contextKeepImages'>): number {
  return config?.contextKeepImages ?? 1;
}

const SUMMARY_SYSTEM = [
  '你是对话历史压缩器。把给定的较早对话浓缩成一段简洁摘要，供后续对话继续参考。',
  '必须保留：用户目标与关键决策、已执行的操作与结论、涉及的资源/文件/命令、尚未完成的事项与已知报错。',
  '不要编造；不要复述寒暄；用中文，尽量紧凑。',
].join('\n');

/** 用模型把一段较早的消息摘要成纯文本（图片/超长结果已在渲染时裁剪，避免摘要请求本身超窗）。 */
async function summarizeMessages(model: ChatModel, stale: Msg[], signal?: AbortSignal): Promise<string> {
  let text = '';
  for await (const ev of model.stream({
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', text: `请压缩以下对话历史：\n\n${renderForSummary(stale)}` }],
    tools: [],
    maxTokens: 2000,
    signal,
  })) {
    if (ev.type === 'text_delta') text += ev.text;
  }
  return text.trim();
}

function sessionIdFromBody(body: Record<string, unknown>): string {
  return sessionIdValue(body.sessionId) ?? newSessionId();
}

function profileFromBody(body: Record<string, unknown>): string | undefined {
  return str(body, 'profile') ?? str(body, 'sandboxProfile');
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number(value ?? '');
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return Number.isFinite(value as number) || t !== 'number';
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (t === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

const IMAGE_DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;

function attachmentItems(body: Record<string, unknown>): Record<string, unknown>[] {
  const raw = body.attachments;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.slice(0, 10).filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  );
}

function imageAttachmentData(o: Record<string, unknown>): { mimeType: string; data: string } | undefined {
  if (typeof o.data !== 'string') return undefined;
  const match = IMAGE_DATA_URL_RE.exec(o.data.trim());
  return match ? { mimeType: match[1]!.toLowerCase(), data: match[2]! } : undefined;
}

/**
 * 附件文本清单。图片附件只列元信息（图像本体走 contentBlocks，避免 base64 内联进 text
 * 后绕过 keep-last-K 剥离 / 硬裁剪，一张大图就能把请求顶爆）。
 */
function attachmentPrompt(body: Record<string, unknown>): string {
  const lines = attachmentItems(body).map((o, idx) => {
    const name = typeof o.name === 'string' && o.name ? o.name : `attachment-${idx + 1}`;
    const type = typeof o.type === 'string' && o.type ? o.type : 'application/octet-stream';
    const size = typeof o.size === 'number' && Number.isFinite(o.size) ? `${o.size} bytes` : 'unknown size';
    const image = imageAttachmentData(o);
    const data = !image && typeof o.data === 'string' && o.data ? `\n${o.data}` : '';
    const note = image ? '（图片见消息内容块）' : '';
    return `- ${name} (${type}, ${size})${note}${data}`;
  }).filter(Boolean);
  return lines.length ? `[上传附件]\n${lines.join('\n')}` : '';
}

/** 图片附件 → user 消息的 image 内容块（受上下文治理的 keep-last-K / 占位符剥离约束）。 */
function attachmentImageBlocks(body: Record<string, unknown>): ToolContentBlock[] {
  return attachmentItems(body)
    .map(imageAttachmentData)
    .filter((img): img is { mimeType: string; data: string } => Boolean(img))
    .map((img) => ({ type: 'image' as const, mimeType: img.mimeType, data: img.data }));
}

function textFromBody(body: Record<string, unknown>): string | undefined {
  return str(body, 'task') ?? str(body, 'text') ?? str(body, 'message');
}

function userTextFromBody(body: Record<string, unknown>, fallback = '请分析上传附件。'): string {
  const rawTask = textFromBody(body)?.trim();
  const uploaded = attachmentPrompt(body);
  if (!rawTask && !uploaded) throw new HttpError(400, 'task 必填');
  return [rawTask || fallback, uploaded].filter(Boolean).join('\n\n');
}

function userMessageFromBody(body: Record<string, unknown>): Msg {
  const blocks = attachmentImageBlocks(body);
  return { role: 'user', text: userTextFromBody(body), contentBlocks: blocks.length ? blocks : undefined };
}

function parseGoalTask(text: string): { goalMode: boolean; task: string } {
  const match = /^\/goal(?:\s+|$)([\s\S]*)$/i.exec(text.trim());
  if (!match) return { goalMode: false, task: text };
  const task = match[1]?.trim() || '请自主完成这个目标任务。';
  return { goalMode: true, task };
}

function browserStreamView(sessionId: string): string {
  const sid = JSON.stringify(sessionId);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; overflow-x: hidden; }
    body { background: #0f172a; color: #d6e2ff; font: 14px system-ui, sans-serif; }
    header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; padding: 10px 12px; border-bottom: 1px solid #263449; }
    img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
    .error { color: #fecaca; padding: 12px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header><strong>Local browser preview</strong><span id="status">connecting</span></header>
  <img id="screen" alt="browser preview" />
  <div id="error" class="error"></div>
  <script>
    const sessionId = ${sid};
    async function refresh() {
      const token = localStorage.getItem('aiop_token');
      if (!token) {
        document.getElementById('status').textContent = 'not logged in';
        return;
      }
      try {
        const response = await fetch('/v1/browser/screenshot', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
          body: JSON.stringify({ sessionId })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || response.statusText);
        const image = body.result && body.result.contentBlocks && body.result.contentBlocks.find((block) => block.type === 'image');
        if (image) document.getElementById('screen').src = 'data:' + image.mimeType + ';base64,' + image.data;
        document.getElementById('status').textContent = new Date().toLocaleTimeString();
        document.getElementById('error').textContent = '';
      } catch (err) {
        document.getElementById('status').textContent = 'error';
        document.getElementById('error').textContent = String(err && err.message ? err.message : err);
      }
    }
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

async function dispatchDirectTool(
  rt: Runtime,
  ctx: RequestContext,
  sessionId: string,
  name: string,
  args: JsonValue,
): Promise<Record<string, unknown>> {
  if (!rt.tools.has(name)) throw new HttpError(409, `工具未启用：${name}`);
  const call: ToolCall = { id: randomUUID(), name, args };
  const toolCtx = { sessionId, tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role };
  const decision = await rt.policy.check(call, toolCtx);
  if (decision.blocked) throw new HttpError(403, decision.reason ?? '策略阻止了该操作');
  if (decision.needApproval) throw new HttpError(409, decision.reason ?? '该操作需要审批，无法直接执行');
  const result = await rt.tools.dispatch(call, toolCtx);
  return { ok: !result.isError, sessionId, result };
}

/** MCP server 增删/重连后，把注册表里的 mcp__ 工具与 manager 当前状态对齐。 */
function syncMcpTools(rt: Runtime): void {
  if (!rt.mcp) return;
  for (const def of rt.tools.defs()) {
    if (def.name.startsWith('mcp__')) rt.tools.unregister(def.name);
  }
  for (const t of rt.mcp.tools()) rt.tools.register(t);
}

/** 持久化当前 MCP server 配置（平台级，落 default 租户设置；失败仅记日志不阻塞请求）。 */
async function persistMcpServers(rt: Runtime): Promise<void> {
  if (!rt.mcp) return;
  try {
    await rt.store.setMcpServers({ tenantId: rt.defaultContext.tenantId }, rt.mcp.configs());
  } catch (err) {
    log.error({ err: String(err) }, 'MCP 配置持久化失败');
  }
}

/** 用户状态短缓存（60s）：禁用/软删除用户的存量 JWT 在分钟级内失效，又不至于每请求打库。 */
const USER_STATUS_TTL_MS = 60_000;
const statusCaches = new WeakMap<Runtime, Map<string, { active: boolean; at: number }>>();

async function assertUserActive(rt: Runtime, ctx: RequestContext): Promise<void> {
  let cache = statusCaches.get(rt);
  if (!cache) {
    cache = new Map();
    statusCaches.set(rt, cache);
  }
  const key = `${ctx.tenantId}/${ctx.userId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < USER_STATUS_TTL_MS) {
    if (!cached.active) throw new HttpError(401, '账号已被禁用');
    return;
  }
  // 无用户行（CLI 默认身份 / 遗留数据）不拦：状态门只对存在且被禁用的账号生效。
  const user = await rt.store.getUser(ctx.tenantId, ctx.userId).catch(() => undefined);
  const active = !user || user.status !== 'disabled';
  cache.set(key, { active, at: Date.now() });
  if (!active) throw new HttpError(401, '账号已被禁用');
}

/** 用户状态变更后清缓存，让禁用/恢复立即生效。 */
function invalidateUserStatus(rt: Runtime, tenantId: string, userId: string): void {
  statusCaches.get(rt)?.delete(`${tenantId}/${userId}`);
}

/** 校验 Bearer token 并返回身份；失败抛 401。 */
async function requireAuth(rt: Runtime, req: Req): Promise<RequestContext> {
  const ctx = await authenticate(rt.authProvider, req.headers.authorization);
  if (!ctx) throw new HttpError(401, '未认证或 token 无效');
  await assertUserActive(rt, ctx);
  return ctx;
}

/** 组装 HTTP + SSE 服务。所有处理无本地状态，可多副本水平扩展。 */
export function createHttpServer(rt: Runtime): http.Server {
  const secret = new TextEncoder().encode(rt.jwtSecret);
  const approvals = new InMemoryApprovalStore();
  const questions = new InMemoryQuestionStore();
  const activeRuns: ActiveAgentRuns = new Map();
  const compactionWatermarks: CompactionWatermarks = new Map();

  return http.createServer((req, res) => {
    handle(rt, secret, approvals, questions, activeRuns, compactionWatermarks, req, res).catch((err) => {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof AuthzError) return sendJson(res, 403, { error: err.message });
      log.error({ err }, '请求处理异常');
      if (!res.headersSent) sendJson(res, 500, { error: '内部错误' });
      else res.end();
    });
  });
}

async function handle(
  rt: Runtime,
  secret: Uint8Array,
  approvals: InMemoryApprovalStore,
  questions: InMemoryQuestionStore,
  activeRuns: ActiveAgentRuns,
  compactionWatermarks: CompactionWatermarks,
  req: Req,
  res: Res,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const route = `${method} ${path}`;

  // —— 健康检查（无需认证）——
  if (route === 'GET /healthz') return sendJson(res, 200, { ok: true });
  if (route === 'GET /readyz') return sendJson(res, 200, { ok: true });
  if (route === 'GET /v1/browser/stream-view') {
    return sendHtml(res, 200, browserStreamView(url.searchParams.get('sessionId') || 'default'));
  }

  // —— 文件下载（能力 URL：令牌自带签名，无需 Bearer，锚点点击即可下载）——
  const downloadMatch = /^\/v1\/files\/([^/]+)$/.exec(path);
  if (method === 'GET' && downloadMatch) {
    if (!rt.downloads) throw new HttpError(404, '下载未启用');
    const opened = await rt.downloads.open(decodeURIComponent(downloadMatch[1]!)).catch(() => undefined);
    if (!opened) throw new HttpError(404, '下载链接无效或已过期');
    res.writeHead(200, {
      'content-type': opened.meta.mime || 'application/octet-stream',
      'content-length': opened.size,
      'content-disposition': contentDisposition(opened.meta.name),
      'cache-control': 'private, no-store',
    });
    opened.stream.on('error', () => { if (!res.writableEnded) res.end(); });
    opened.stream.pipe(res);
    return;
  }

  if (method === 'GET' && await sendWebAsset(res, path, rt.frameAncestors)) return;

  // —— 本地登录 ——
  if (route === 'POST /auth/login') {
    const body = await readJson(req);
    const tenantId = str(body, 'tenantId') ?? 'default';
    const username = str(body, 'username');
    const password = str(body, 'password');
    if (!username || !password) throw new HttpError(400, 'username/password 必填');
    const token = await rt.authProvider.login(tenantId, username, password);
    if (!token) throw new HttpError(401, '登录失败：用户名或口令错误');
    return sendJson(res, 200, { token });
  }

  // —— AIOS 嵌入登录：token exchange（宿主页 postMessage 传来的 AIOS token → aiop JWT）——
  if (route === 'POST /auth/aios/exchange') {
    if (!rt.aiosAuth) throw new HttpError(400, '未启用 AIOS 登录');
    const body = await readJson(req);
    const aiosToken = str(body, 'token');
    if (!aiosToken) throw new HttpError(400, 'token 必填');
    try {
      const { token, ctx, user } = await rt.aiosAuth.exchange({
        token: aiosToken,
        refreshToken: str(body, 'refreshToken'),
        expiredTime: str(body, 'expiredTime'),
      });
      invalidateUserStatus(rt, ctx.tenantId, ctx.userId);
      await rt.audit?.record({
        kind: 'auth', action: 'aios-exchange', tenantId: ctx.tenantId,
        detail: { userId: ctx.userId, role: ctx.role },
      });
      return sendJson(res, 200, {
        token,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        role: ctx.role,
        displayName: user.displayName ?? user.username,
      });
    } catch (err) {
      if (err instanceof AiosAuthError) throw new HttpError(401, err.message);
      throw err;
    }
  }

  // —— OIDC：发起登录 ——
  if (route === 'GET /auth/oidc/start') {
    if (!(rt.authProvider instanceof OidcAuthProvider)) throw new HttpError(400, '未启用 OIDC');
    const start = await rt.authProvider.authorizationUrl();
    // state + codeVerifier 签进短时 JWT cookie，保持无状态、可多副本
    const stateToken = await new SignJWT({ s: start.state, v: start.codeVerifier })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(secret);
    res.setHeader('set-cookie', `${OIDC_COOKIE}=${stateToken}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`);
    return sendJson(res, 200, { url: start.url });
  }

  // —— OIDC：回调 ——
  if (method === 'GET' && path === '/auth/callback') {
    if (!(rt.authProvider instanceof OidcAuthProvider)) throw new HttpError(400, '未启用 OIDC');
    const cookie = parseCookies(req.headers.cookie)[OIDC_COOKIE];
    if (!cookie) throw new HttpError(400, '缺少 OIDC state cookie（请重新发起登录）');
    let state: string, codeVerifier: string;
    try {
      const { payload } = await jwtVerify(cookie, secret);
      state = payload.s as string;
      codeVerifier = payload.v as string;
    } catch {
      throw new HttpError(400, 'OIDC state cookie 无效或已过期');
    }
    const token = await rt.authProvider.handleCallback(url.href, { state, codeVerifier });
    res.setHeader('set-cookie', `${OIDC_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    return sendJson(res, 200, { token });
  }

  // —— 以下均需认证 ——
  if (route === 'POST /v1/agent') return runAgentSse(rt, approvals, questions, activeRuns, compactionWatermarks, req, res);

  if (route === 'GET /v1/me') {
    const ctx = await requireAuth(rt, req);
    const user = await rt.store.getUser(ctx.tenantId, ctx.userId).catch(() => undefined);
    return sendJson(res, 200, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      role: ctx.role,
      username: user?.username,
      displayName: user?.displayName ?? user?.username,
      authProvider: user?.authProvider,
    });
  }

  if (route === 'GET /v1/sessions') {
    const ctx = await requireAuth(rt, req);
    const limit = intParam(url.searchParams.get('limit') ?? url.searchParams.get('pageSize'), 50, 1, 100);
    const page = intParam(url.searchParams.get('page'), 0, 0, 100000);
    const offset = page > 0
      ? (page - 1) * limit
      : intParam(url.searchParams.get('offset'), 0, 0, 1000000);
    const [sessions, total] = await Promise.all([
      rt.store.listSessions(ctx, limit, offset),
      rt.store.countSessions(ctx),
    ]);
    return sendJson(res, 200, {
      sessions,
      total,
      limit,
      offset,
      hasMore: offset + sessions.length < total,
    });
  }

  if (route === 'POST /v1/sessions') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const session = await rt.store.createSession(ctx, {
      sessionId: sessionIdFromBody(body),
      title: str(body, 'title') ?? '新会话',
    });
    return sendJson(res, 201, { session });
  }

  if (route === 'GET /v1/tools') {
    const ctx = await requireAuth(rt, req);
    const tools = [
      ...rt.tools.defs()
        .filter((def) => !(rt.skillRegistry && (def.name === 'load_skill' || def.name.startsWith('skill__'))))
        .map((def) => ({
          name: def.name,
          description: def.description,
          category: toolCategory(def.name),
          inputSchema: def.inputSchema,
        })),
      // 技能按查看者过滤：public ∪ 自己的 ∪ shared（服务端过滤，不信前端）。
      ...(rt.skillRegistry?.listFor(ctx).map((skill) => publicSkill(skill, rt.skillRegistry!, ctx)) ?? []),
    ];
    const groups = tools.reduce<Record<string, number>>((acc, tool) => {
      const category = typeof tool.category === 'string' ? tool.category : 'builtin';
      acc[category] = (acc[category] ?? 0) + 1;
      return acc;
    }, {});
    return sendJson(res, 200, { tools, groups });
  }

  if (route === 'POST /v1/skills/import') {
    // 上传放开给所有登录用户：管理员 → _public（全员可见）；普通用户 → users/<uid>（默认私有）。
    const ctx = await requireAuth(rt, req);
    if (!rt.skillRegistry) throw new HttpError(409, '未启用技能目录');
    const body = await readJson(req, SKILL_IMPORT_MAX_BODY);
    const filename = str(body, 'filename');
    const data = str(body, 'data');
    if (!filename || !data) throw new HttpError(400, 'filename/data 必填');
    if (!/\.zip$/i.test(filename)) throw new HttpError(400, '仅支持导入 zip 技能包');

    const imported = await importSkillZip({
      rootDir: rt.skillRegistry.importRootFor(ctx),
      filename,
      data: decodeSkillImportData(data),
    });
    await rt.skillRegistry.setOwner(imported.skillDir, ctx.userId);
    await rt.skillRegistry.scan();
    rt.systemExtra = rt.skillRegistry.summaries();
    const skill = rt.skillRegistry.list().find((item) => resolve(item.dir) === resolve(imported.skillDir));
    if (!skill) throw new HttpError(422, '导入后未发现有效技能');
    await rt.audit?.record({
      kind: 'auth', action: 'skill-imported', tenantId: ctx.tenantId,
      detail: { skill: skill.name, by: ctx.userId, visibility: skill.visibility },
    });
    return sendJson(res, 201, { skill: publicSkill(skill, rt.skillRegistry, ctx) });
  }

  // 共享 / 取消共享：仅所有者（private ↔ shared；对应前端"共享"按钮）。
  const skillShareMatch = /^\/v1\/skills\/([^/]+)\/(share|unshare)$/.exec(path);
  if (method === 'POST' && skillShareMatch) {
    const ctx = await requireAuth(rt, req);
    if (!rt.skillRegistry) throw new HttpError(409, '未启用技能目录');
    const name = decodeURIComponent(skillShareMatch[1]!);
    const skill = requireManagedSkill(rt, ctx, name);
    try {
      const updated = await rt.skillRegistry.setShared(skill.name, skillShareMatch[2] === 'share');
      rt.systemExtra = rt.skillRegistry.summaries();
      await rt.audit?.record({
        kind: 'auth', action: skillShareMatch[2] === 'share' ? 'skill-shared' : 'skill-unshared',
        tenantId: ctx.tenantId, detail: { skill: skill.name, by: ctx.userId },
      });
      return sendJson(res, 200, { skill: publicSkill(updated, rt.skillRegistry, ctx) });
    } catch (err) {
      throw skillHttpError(err);
    }
  }

  const skillFilesMatch = /^\/v1\/skills\/([^/]+)\/files$/.exec(path);
  if (method === 'GET' && skillFilesMatch) {
    const ctx = await requireAuth(rt, req);
    if (!rt.skillRegistry) throw new HttpError(409, '未启用技能目录');
    const name = decodeURIComponent(skillFilesMatch[1]!);
    // 可见性检查：越权技能等同不存在（404，不泄露存在性）。
    if (!rt.skillRegistry.getFor(name, ctx)) throw new HttpError(404, `未找到技能 ${name}`);
    const requestedPath = url.searchParams.get('path') ?? '';
    try {
      const entries = await rt.skillRegistry.listDir(name, requestedPath);
      return sendJson(res, 200, {
        path: requestedPath,
        parentPath: requestedPath ? parentSkillPath(requestedPath) : null,
        entries,
      });
    } catch (err) {
      if (String(err).includes('不是目录')) {
        try {
          return sendJson(res, 200, await rt.skillRegistry.readFile(name, requestedPath));
        } catch (readErr) {
          throw skillHttpError(readErr);
        }
      }
      throw skillHttpError(err);
    }
  }

  const skillActionMatch = /^\/v1\/skills\/([^/]+)\/(enable|disable)$/.exec(path);
  if (method === 'POST' && skillActionMatch) {
    const ctx = await requireAuth(rt, req);
    if (!rt.skillRegistry) throw new HttpError(409, '未启用技能目录');
    const name = decodeURIComponent(skillActionMatch[1]!);
    const managed = requireManagedSkill(rt, ctx, name);
    const enabled = skillActionMatch[2] === 'enable';
    try {
      const skill = await rt.skillRegistry.setEnabled(managed.name, enabled);
      rt.systemExtra = rt.skillRegistry.summaries();
      return sendJson(res, 200, { skill: publicSkill(skill, rt.skillRegistry, ctx) });
    } catch (err) {
      throw skillHttpError(err);
    }
  }

  const skillDeleteMatch = /^\/v1\/skills\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && skillDeleteMatch) {
    const ctx = await requireAuth(rt, req);
    if (!rt.skillRegistry) throw new HttpError(409, '未启用技能目录');
    const body = await readJson(req);
    if (body.confirm !== true) throw new HttpError(400, '删除技能需要 confirm=true');
    const name = decodeURIComponent(skillDeleteMatch[1]!);
    const managed = requireManagedSkill(rt, ctx, name);
    try {
      await rt.skillRegistry.delete(managed.name);
      rt.systemExtra = rt.skillRegistry.summaries();
      await rt.audit?.record({
        kind: 'auth', action: 'skill-deleted', tenantId: ctx.tenantId,
        detail: { skill: managed.name, by: ctx.userId },
      });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      throw skillHttpError(err);
    }
  }

  // —— MCP server 管理 ——
  if (route === 'GET /v1/mcp/servers') {
    await requireAuth(rt, req);
    if (!rt.mcp) throw new HttpError(409, '未启用 MCP');
    return sendJson(res, 200, { servers: rt.mcp.list() });
  }

  if (route === 'POST /v1/mcp/servers') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    if (!rt.mcp) throw new HttpError(409, '未启用 MCP');
    const body = await readJson(req);
    const name = str(body, 'name');
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || name.includes('__')) {
      throw new HttpError(400, 'name 必填，仅限字母/数字/-/_ 且不含连续下划线');
    }
    const parsed = McpServerSchema.safeParse(body.config ?? body);
    if (!parsed.success) throw new HttpError(400, `配置无效：${parsed.error.issues.map((i) => i.message).join('; ')}`);
    const cfg = parsed.data;
    if (cfg.transport === 'stdio' && !cfg.command) throw new HttpError(400, 'stdio 需要 command');
    if (cfg.transport !== 'stdio' && !cfg.url) throw new HttpError(400, `${cfg.transport} 需要 url`);
    if (rt.mcp.list().some((s) => s.name === name)) throw new HttpError(409, `MCP server 已存在: ${name}`);
    const info = await rt.mcp.add(name, cfg);
    syncMcpTools(rt);
    await persistMcpServers(rt);
    return sendJson(res, 201, { server: info });
  }

  const mcpReconnectMatch = /^\/v1\/mcp\/servers\/([^/]+)\/reconnect$/.exec(path);
  if (method === 'POST' && mcpReconnectMatch) {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    if (!rt.mcp) throw new HttpError(409, '未启用 MCP');
    const name = decodeURIComponent(mcpReconnectMatch[1]!);
    if (!rt.mcp.list().some((s) => s.name === name)) throw new HttpError(404, `MCP server 不存在: ${name}`);
    const info = await rt.mcp.reconnect(name);
    syncMcpTools(rt);
    return sendJson(res, 200, { server: info });
  }

  const mcpDeleteMatch = /^\/v1\/mcp\/servers\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && mcpDeleteMatch) {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    if (!rt.mcp) throw new HttpError(409, '未启用 MCP');
    const name = decodeURIComponent(mcpDeleteMatch[1]!);
    const removed = await rt.mcp.remove(name);
    if (!removed) throw new HttpError(404, `MCP server 不存在: ${name}`);
    syncMcpTools(rt);
    await persistMcpServers(rt);
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /v1/tools/call') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const name = str(body, 'name');
    if (!name) throw new HttpError(400, 'name 必填');
    const args = body.args === undefined ? {} : body.args;
    if (!isJsonValue(args)) throw new HttpError(400, 'args 必须是 JSON 值');
    return sendJson(res, 200, await dispatchDirectTool(rt, ctx, sessionIdFromBody(body), name, args));
  }

  if (route === 'GET /v1/sandboxes') {
    await requireAuth(rt, req);
    return sendJson(res, 200, { sandboxes: rt.sandboxes?.list() ?? [], profiles: rt.sandboxProfiles ?? [] });
  }

  if (route === 'POST /v1/sandbox/run-code') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const code = str(body, 'code');
    if (!code) throw new HttpError(400, 'code 必填');
    const args: Record<string, JsonValue> = { code };
    const language = str(body, 'language');
    if (language) args.language = language;
    const profile = profileFromBody(body);
    if (profile) args.profile = profile;
    return sendJson(res, 200, await dispatchDirectTool(
      rt,
      ctx,
      sessionIdFromBody(body),
      profile ? 'sandbox_run_code' : 'sbx__run_code',
      args,
    ));
  }

  if (route === 'POST /v1/sandbox/run-command') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const command = str(body, 'command');
    if (!command) throw new HttpError(400, 'command 必填');
    const args: Record<string, JsonValue> = { command };
    const profile = profileFromBody(body);
    if (profile) args.profile = profile;
    return sendJson(res, 200, await dispatchDirectTool(
      rt,
      ctx,
      sessionIdFromBody(body),
      profile ? 'sandbox_run_command' : 'sbx__run_command',
      args,
    ));
  }

  if (route === 'POST /v1/browser/stream') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const sessionId = sessionIdFromBody(body);
    const payload = await dispatchDirectTool(rt, ctx, sessionId, 'desktop_stream_url', {});
    const result = payload.result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const r = result as Record<string, unknown>;
      if (typeof r.content === 'string' && r.content.includes('data:text/html')) {
        r.content = `浏览器预览地址：/v1/browser/stream-view?sessionId=${encodeURIComponent(sessionId)}`;
      }
    }
    return sendJson(res, 200, payload);
  }

  if (route === 'POST /v1/browser/navigate') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const browserUrl = str(body, 'url');
    if (!browserUrl) throw new HttpError(400, 'url 必填');
    return sendJson(res, 200, await dispatchDirectTool(rt, ctx, sessionIdFromBody(body), 'browser_navigate', { url: browserUrl }));
  }

  if (route === 'POST /v1/browser/click') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const x = Number(body.x);
    const y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, 'x/y 必须是数字');
    return sendJson(res, 200, await dispatchDirectTool(rt, ctx, sessionIdFromBody(body), 'browser_click', { x, y }));
  }

  if (route === 'POST /v1/browser/type') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const text = str(body, 'text');
    if (typeof text !== 'string') throw new HttpError(400, 'text 必填');
    return sendJson(res, 200, await dispatchDirectTool(rt, ctx, sessionIdFromBody(body), 'browser_type', { text }));
  }

  if (route === 'POST /v1/browser/screenshot') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    return sendJson(res, 200, await dispatchDirectTool(rt, ctx, sessionIdFromBody(body), 'browser_screenshot', {}));
  }

  // —— 设置：运行时 LLM 配置 ——
  if (route === 'GET /v1/settings/llm') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    const config = await rt.store.getLlmSettings(ctx) ?? currentModelConfig(rt);
    return sendJson(res, 200, modelSettingsBody(config, rt.modelOptions));
  }
  if (route === 'POST /v1/settings/llm') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    const current = await rt.store.getLlmSettings(ctx) ?? currentModelConfig(rt);
    const next = modelConfigFromBody(await readJson(req), current, rt.modelOptions);
    await rt.store.setLlmSettings(ctx, next);
    if (rt.updateModel) rt.updateModel(next);
    else {
      rt.model = createModel(next.id, next);
      rt.modelConfig = { ...next };
    }
    return sendJson(res, 200, modelSettingsBody(next, rt.modelOptions));
  }
  if (route === 'POST /v1/settings/llm/test') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    const body = await readJson(req);
    const hasBody = Object.keys(body).length > 0;
    const current = await rt.store.getLlmSettings(ctx) ?? currentModelConfig(rt);
    const config = hasBody ? modelConfigFromBody(body, current, rt.modelOptions) : current;
    const model = hasBody ? createModel(config.id, config) : rt.model;
    let text = '';
    try {
      for await (const e of model.stream({
        system: '',
        messages: [{ role: 'user', text: '请只回复 OK，用于测试模型连接。' }],
        tools: [],
        maxTokens: 32,
      })) {
        if (e.type === 'text_delta') text += e.text;
      }
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : '模型连接测试失败');
    }
    return sendJson(res, 200, { ok: true, text: text.trim(), ...modelSettingsBody(config, rt.modelOptions) });
  }

  // —— 设置：沙箱服务端连接 ——
  if (route === 'GET /v1/settings/sandbox') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    return sendJson(res, 200, sandboxSettingsBody(rt.sandboxSettings ?? { enabled: false, provider: 'e2b' }));
  }
  if (route === 'POST /v1/settings/sandbox') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    const body = await readJson(req);
    const current = rt.sandboxSettings ?? { enabled: false, provider: 'e2b' as const };
    const provider = str(body, 'provider') ?? current.provider;
    if (provider !== 'local' && provider !== 'e2b' && provider !== 'opensandbox') {
      throw new HttpError(400, 'provider 只支持 local / e2b / opensandbox');
    }
    const protocol = str(body, 'protocol');
    if (protocol !== undefined && protocol !== 'http' && protocol !== 'https') {
      throw new HttpError(400, 'protocol 只支持 http / https');
    }
    const apiKeyRaw = str(body, 'api_key');
    const next: SandboxSettings = {
      provider,
      domain: (str(body, 'domain') ?? current.domain ?? '').trim() || undefined,
      protocol: (protocol as 'http' | 'https' | undefined) ?? current.protocol,
      // api_key 缺省保持不变；传空字符串表示清除
      apiKey: apiKeyRaw === undefined ? current.apiKey : apiKeyRaw.trim() || undefined,
      defaultImage: (str(body, 'default_image') ?? current.defaultImage ?? '').trim() || undefined,
    };
    await rt.store.setSandboxSettings(ctx, next);
    if (rt.updateSandbox) rt.updateSandbox(next);
    else rt.sandboxSettings = { ...current, ...next };
    return sendJson(res, 200, sandboxSettingsBody(rt.sandboxSettings ?? { ...next, provider, enabled: current.enabled }));
  }

  // —— 设置：定时任务运行时长 ——
  if (route === 'GET /v1/settings/scheduler') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    const settings = await rt.store.getSchedulerSettings(ctx);
    return sendJson(res, 200, {
      settings: { max_run_minutes: Math.round((settings?.maxRunMs ?? DEFAULT_TASK_MAX_RUN_MS) / 60_000) },
    });
  }
  if (route === 'POST /v1/settings/scheduler') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    const body = await readJson(req);
    const n = Number(body.max_run_minutes ?? body.maxRunMinutes);
    if (!Number.isFinite(n) || n < 1) throw new HttpError(400, 'max_run_minutes 必须是 >= 1 的整数');
    const minutes = Math.floor(n);
    await rt.store.setSchedulerSettings(ctx, { maxRunMs: minutes * 60_000 });
    return sendJson(res, 200, { settings: { max_run_minutes: minutes } });
  }

  // —— 交互式审批 ——
  if (route === 'GET /v1/approvals') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'approve');
    return sendJson(res, 200, { approvals: approvals.list(ctx.tenantId) });
  }
  const approvalMatch = /^\/v1\/approvals\/([^/]+)\/(approve|deny)$/.exec(path);
  if (method === 'POST' && approvalMatch) {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'approve');
    const id = decodeURIComponent(approvalMatch[1]!);
    const ok = approvalMatch[2] === 'approve'
      ? await approvals.approve(id, ctx.tenantId)
      : await approvals.deny(id, ctx.tenantId);
    if (!ok) throw new HttpError(404, '审批不存在或已处理');
    return sendJson(res, 200, { ok: true });
  }

  // —— ask_user 交互式提问 ——
  if (route === 'GET /v1/questions') {
    const ctx = await requireAuth(rt, req);
    return sendJson(res, 200, { questions: questions.list(ctx.tenantId) });
  }
  const questionMatch = /^\/v1\/questions\/([^/]+)\/answer$/.exec(path);
  if (method === 'POST' && questionMatch) {
    const ctx = await requireAuth(rt, req);
    const id = decodeURIComponent(questionMatch[1]!);
    const body = await readJson(req);
    const rawAnswers = body.answers;
    if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
      throw new HttpError(400, 'answers 必须是 {问题: [选中项]} 对象');
    }
    const answers: QuestionAnswers = {};
    for (const [q, v] of Object.entries(rawAnswers as Record<string, unknown>)) {
      answers[q] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    }
    const ok = questions.answer(id, ctx.tenantId, answers);
    if (!ok) throw new HttpError(404, '问题不存在或已回答');
    return sendJson(res, 200, { ok: true });
  }

  // GET /v1/sessions/{id}/messages
  const msgMatch = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(path);
  if (method === 'GET' && msgMatch) {
    const ctx = await requireAuth(rt, req);
    const messages = await rt.store.listMessages(ctx, decodeURIComponent(msgMatch[1]!));
    return sendJson(res, 200, { messages });
  }

  const sessionAppendMatch = /^\/v1\/sessions\/([^/]+)\/append$/.exec(path);
  if (method === 'POST' && sessionAppendMatch) {
    const ctx = await requireAuth(rt, req);
    const sessionId = decodeURIComponent(sessionAppendMatch[1]!);
    const message = userMessageFromBody(await readJson(req));
    const activeRun = findActiveRun(activeRuns, activeRunKey(ctx, sessionId));
    if (activeRun) {
      activeRun.append(message);
      return sendJson(res, 200, { ok: true, sessionId, queued: true });
    }
    await rt.store.appendMessage(ctx, sessionId, message);
    return sendJson(res, 200, { ok: true, sessionId, queued: false });
  }

  const sessionContextMatch = /^\/v1\/sessions\/([^/]+)\/context$/.exec(path);
  if (method === 'GET' && sessionContextMatch) {
    const ctx = await requireAuth(rt, req);
    const sessionId = decodeURIComponent(sessionContextMatch[1]!);
    const usage = await rt.store.getSessionContextUsage(ctx, sessionId, contextWindowTokens(currentModelConfig(rt)));
    return sendJson(res, 200, { sessionId, ...usage });
  }

  const sessionTerminateMatch = /^\/v1\/sessions\/([^/]+)\/terminate$/.exec(path);
  if (method === 'POST' && sessionTerminateMatch) {
    const ctx = await requireAuth(rt, req);
    const sessionId = decodeURIComponent(sessionTerminateMatch[1]!);
    const aborted = abortActiveRuns(activeRuns, activeRunKey(ctx, sessionId));
    return sendJson(res, 200, { ok: true, sessionId, aborted });
  }

  const sessionDeleteMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && sessionDeleteMatch) {
    const ctx = await requireAuth(rt, req);
    const sessionId = decodeURIComponent(sessionDeleteMatch[1]!);
    const ok = await rt.store.deleteSession(ctx, sessionId);
    if (!ok) throw new HttpError(404, '会话不存在');
    compactionWatermarks.delete(activeRunKey(ctx, sessionId));
    // 会话关闭即销毁其名下沙箱（含集群 sessionId:cluster 键）；best-effort，不阻塞响应。
    void rt.sandboxes?.disposeSession(sessionId);
    return sendJson(res, 200, { ok: true });
  }

  // —— 定时任务 ——
  if (route === 'GET /v1/schedule') {
    const ctx = await requireAuth(rt, req);
    return sendJson(res, 200, { tasks: await rt.store.listScheduledTasks(ctx) });
  }
  if (route === 'POST /v1/schedule') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'task:create');
    const body = await readJson(req);
    const sessionId = sessionIdFromBody(body);
    const cron = str(body, 'cron');
    const task = str(body, 'task');
    if (!cron || !task) throw new HttpError(400, 'cron/task 必填');
    const title = str(body, 'title')?.trim() ?? '';
    const preApproved = body.preApproved === true;
    if (preApproved) requirePermission(ctx, 'approve'); // 预批准属审批权
    const created = await rt.store.createScheduledTask(ctx, {
      sessionId, cron, title, task, preApproved, enabled: body.enabled !== false,
    });
    return sendJson(res, 201, { task: created });
  }
  const schedRunsMatch = /^\/v1\/schedule\/(\d+)\/runs$/.exec(path);
  if (method === 'GET' && schedRunsMatch) {
    const ctx = await requireAuth(rt, req);
    const runs = await rt.store.listTaskRuns(ctx, Number(schedRunsMatch[1]));
    return sendJson(res, 200, { runs });
  }
  const schedMatch = /^\/v1\/schedule\/(\d+)\/(enable|disable)$/.exec(path);
  if (method === 'POST' && schedMatch) {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'task:create');
    await rt.store.setTaskEnabled(ctx, Number(schedMatch[1]), schedMatch[2] === 'enable');
    return sendJson(res, 200, { ok: true });
  }
  const schedUpdateMatch = /^\/v1\/schedule\/(\d+)$/.exec(path);
  if (method === 'PATCH' && schedUpdateMatch) {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'task:create');
    const body = await readJson(req);
    const patch: ScheduledTaskPatch = {};
    const cron = str(body, 'cron');
    if (cron !== undefined) {
      if (!isValidCron(cron)) throw new HttpError(400, `非法 cron 表达式: ${cron}`);
      patch.cron = cron;
    }
    const task = str(body, 'task');
    if (task !== undefined) {
      if (!task.trim()) throw new HttpError(400, 'task 不能为空');
      patch.task = task;
    }
    const title = str(body, 'title');
    if (title !== undefined) patch.title = title.trim();
    if (body.preApproved !== undefined) {
      if (typeof body.preApproved !== 'boolean') throw new HttpError(400, 'preApproved 必须是布尔值');
      if (body.preApproved) requirePermission(ctx, 'approve'); // 预批准属审批权
      patch.preApproved = body.preApproved;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
      patch.enabled = body.enabled;
    }
    if (!Object.keys(patch).length) throw new HttpError(400, '没有可更新的字段（cron/title/task/preApproved/enabled）');
    const updated = await rt.store.updateScheduledTask(ctx, Number(schedUpdateMatch[1]), patch);
    if (!updated) throw new HttpError(404, '定时任务不存在');
    return sendJson(res, 200, { task: updated });
  }
  if (method === 'DELETE' && schedUpdateMatch) {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'task:create');
    const ok = await rt.store.deleteScheduledTask(ctx, Number(schedUpdateMatch[1]));
    if (!ok) throw new HttpError(404, '定时任务不存在');
    return sendJson(res, 200, { ok: true });
  }
  const schedRunNowMatch = /^\/v1\/schedule\/(\d+)\/run$/.exec(path);
  if (method === 'POST' && schedRunNowMatch) {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'task:create');
    const id = Number(schedRunNowMatch[1]);
    const task = await rt.store.getScheduledTask(ctx, id);
    if (!task) throw new HttpError(404, '定时任务不存在');
    if (runningManualTasks.has(id)) throw new HttpError(409, '该任务正在手动执行中');
    // 异步执行（任务可能跑很久），结果照常写入 task_runs；前端轮询执行记录即可。
    runningManualTasks.add(id);
    const runner = createScheduledTaskRunner(rt);
    void runner(task)
      .then((result) => rt.store.recordTaskRun({ taskId: id, ...result }))
      .catch((err) => rt.store.recordTaskRun({ taskId: id, status: 'error', detail: String(err) }))
      .catch((err) => log.error({ taskId: id, err: String(err) }, '手动执行记录失败'))
      .finally(() => runningManualTasks.delete(id));
    return sendJson(res, 202, { ok: true, taskId: id, started: true });
  }

  // —— 审计 ——
  if (route === 'GET /v1/audit') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'audit:read');
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const events = await rt.store.listAudit(ctx, {
      sessionId: url.searchParams.get('sessionId') ?? undefined,
      kind: url.searchParams.get('kind') ?? undefined,
      limit: Number.isFinite(limit) ? limit : 100,
    });
    return sendJson(res, 200, { events });
  }

  // —— 管理：租户 / 用户 ——
  if (route === 'GET /v1/admin/tenants') {
    const ctx = await requireAuth(rt, req);
    return sendJson(res, 200, { tenants: await listTenants(ctx, rt.store) });
  }
  if (route === 'POST /v1/admin/tenants') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const id = str(body, 'id');
    if (!id) throw new HttpError(400, 'id 必填');
    await createTenant(ctx, rt.store, { id, name: str(body, 'name') ?? id });
    return sendJson(res, 201, { ok: true });
  }
  if (route === 'POST /v1/admin/users') {
    const ctx = await requireAuth(rt, req);
    if (!(rt.authProvider instanceof LocalAuthProvider)) {
      throw new HttpError(400, 'OIDC 模式下用户由 IdP 管理，不支持本地建号');
    }
    const body = await readJson(req);
    const tenantId = str(body, 'tenantId') ?? ctx.tenantId;
    const username = str(body, 'username');
    const password = str(body, 'password');
    const role = (str(body, 'role') ?? 'user') as Role;
    if (!username || !password) throw new HttpError(400, 'username/password 必填');
    // 占位即封禁：同名行（含 disabled）存在时拒绝，防止新建同名账号继承视觉身份。
    if (await rt.store.getUserByUsername(tenantId, username)) {
      throw new HttpError(409, `用户名已存在：${username}`);
    }
    const user = await createUser(ctx, rt.authProvider, { tenantId, username, password, role });
    if (str(body, 'displayName')) {
      await rt.store.updateUser(tenantId, user.id, { displayName: str(body, 'displayName') });
    }
    await rt.audit?.record({
      kind: 'auth', action: 'user-created', tenantId,
      detail: { by: ctx.userId, target: user.id, role },
    });
    return sendJson(res, 201, { user: await rt.store.getUser(tenantId, user.id) ?? user });
  }

  // —— 管理：用户列表 / 软删除 / 禁用恢复（DESIGN-aios-integration §8.5）——
  if (route === 'GET /v1/admin/users') {
    const ctx = await requireAuth(rt, req);
    const tenantId = url.searchParams.get('tenantId') ?? ctx.tenantId;
    if (!canManageUsersOf(ctx, tenantId)) throw new AuthzError(`权限不足：无法管理租户 ${tenantId} 的用户`);
    return sendJson(res, 200, { users: await rt.store.listUsers(tenantId) });
  }

  const adminUserActionMatch = /^\/v1\/admin\/users\/([^/]+)\/(disable|enable)$/.exec(path);
  if (method === 'POST' && adminUserActionMatch) {
    const ctx = await requireAuth(rt, req);
    const tenantId = url.searchParams.get('tenantId') ?? ctx.tenantId;
    const target = await rt.store.getUser(tenantId, decodeURIComponent(adminUserActionMatch[1]!));
    if (!target) throw new HttpError(404, '用户不存在');
    const enabled = adminUserActionMatch[2] === 'enable';
    const updated = await setUserEnabled({ store: rt.store, credentials: rt.credentials, audit: rt.audit }, ctx, target, enabled);
    invalidateUserStatus(rt, tenantId, target.id);
    return sendJson(res, 200, { user: updated });
  }

  const adminUserDeleteMatch = /^\/v1\/admin\/users\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && adminUserDeleteMatch) {
    const ctx = await requireAuth(rt, req);
    const tenantId = url.searchParams.get('tenantId') ?? ctx.tenantId;
    const target = await rt.store.getUser(tenantId, decodeURIComponent(adminUserDeleteMatch[1]!));
    if (!target) throw new HttpError(404, '用户不存在');
    // 默认保留原 username（占位即封禁，防经 JIT 复活）；?tombstone=true 显式释放用户名。
    const tombstone = url.searchParams.get('tombstone') === 'true';
    const updated = await softDeleteUser({ store: rt.store, credentials: rt.credentials, audit: rt.audit }, ctx, target, { tombstone });
    invalidateUserStatus(rt, tenantId, target.id);
    return sendJson(res, 200, { user: updated });
  }

  sendJson(res, 404, { error: `未知路由: ${route}` });
}

function toolCategory(name: string): string {
  if (name === 'load_skill' || name.startsWith('skill__')) return 'skill';
  if (name.startsWith('mcp__')) return 'mcp';
  if (name.startsWith('sbx__') || name.startsWith('sandbox_') || name.startsWith('browser_') || name === 'desktop_stream_url') return 'sandbox';
  if (name.includes('schedule')) return 'schedule';
  if (name === 'kubectl') return 'ops';
  return 'builtin';
}

function decodeSkillImportData(data: string): Buffer {
  if (data.startsWith('data:')) {
    const match = /^data:[^,]*;base64,(.*)$/s.exec(data);
    if (!match) throw new HttpError(400, '技能包 data URL 必须是 base64');
    return decodeBase64(match[1]!);
  }
  return decodeBase64(data);
}

function decodeBase64(raw: string): Buffer {
  const compact = raw.replace(/\s+/g, '');
  if (!compact) throw new HttpError(400, '技能包数据为空');
  const data = Buffer.from(compact, 'base64');
  if (!data.length) throw new HttpError(400, '技能包数据为空');
  return data;
}

function publicSkill(skill: Skill, registry: SkillRegistry, viewer?: RequestContext): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    category: 'skill',
    source: '本地',
    enabled: skill.enabled,
    status: skill.enabled ? '已启用' : '已禁用',
    owner: skill.owner,
    visibility: skill.visibility,
    // 前端据此显示管理按钮；真正的权限判定始终在服务端各路由。
    canManage: registry.canManage(skill, viewer),
    files: skill.files.filter((file) => !file.isDirectory && file.path !== 'SKILL.md').map((file) => file.path),
    fileEntries: skill.files,
  };
}

/**
 * 技能管理护栏：不可见 → 404（不泄露存在性）；可见但非所有者 → 403。
 * 只有所有者能启停/删除/共享自己的技能；无主存量技能由 tenant:manage 管理员代管。
 */
function requireManagedSkill(rt: Runtime, ctx: RequestContext, name: string): Skill {
  const registry = rt.skillRegistry;
  if (!registry) throw new HttpError(409, '未启用技能目录');
  const skill = registry.get(name);
  if (!skill || !registry.visibleTo(skill, ctx)) throw new HttpError(404, `未找到技能 ${name}`);
  if (!registry.canManage(skill, ctx)) throw new HttpError(403, '仅技能所有者可执行该操作');
  return skill;
}

function parentSkillPath(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

function skillHttpError(err: unknown): HttpError {
  const message = err instanceof Error ? err.message : String(err || '技能操作失败');
  if (message.includes('未找到技能')) return new HttpError(404, message);
  if (message.includes('非法技能文件路径') || message.includes('不是目录') || message.includes('不是文件')) {
    return new HttpError(400, message);
  }
  return new HttpError(500, message);
}

function activeRunKey(ctx: RequestContext, sessionId: string): string {
  return JSON.stringify([ctx.tenantId, sessionId]);
}

function addActiveRun(activeRuns: ActiveAgentRuns, key: string, run: ActiveAgentRun): void {
  const set = activeRuns.get(key) ?? new Set<ActiveAgentRun>();
  set.add(run);
  activeRuns.set(key, set);
}

function removeActiveRun(activeRuns: ActiveAgentRuns, key: string, run: ActiveAgentRun): void {
  const set = activeRuns.get(key);
  if (!set) return;
  set.delete(run);
  if (!set.size) activeRuns.delete(key);
}

function findActiveRun(activeRuns: ActiveAgentRuns, key: string): ActiveAgentRun | undefined {
  const set = activeRuns.get(key);
  if (!set?.size) return undefined;
  return [...set].find((run) => !run.abort.signal.aborted);
}

function abortActiveRuns(activeRuns: ActiveAgentRuns, key: string): number {
  const set = activeRuns.get(key);
  if (!set?.size) return 0;
  let aborted = 0;
  for (const run of set) {
    if (run.abort.signal.aborted) continue;
    run.abort.abort(new Error(RUN_TERMINATED_MESSAGE));
    aborted++;
  }
  return aborted;
}

function abortReasonMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return RUN_TERMINATED_MESSAGE;
}

/** POST /v1/agent：流式（SSE）运行一次 agent，自动续接会话历史并持久化。 */
async function runAgentSse(
  rt: Runtime,
  approvals: InMemoryApprovalStore,
  questions: InMemoryQuestionStore,
  activeRuns: ActiveAgentRuns,
  compactionWatermarks: CompactionWatermarks,
  req: Req,
  res: Res,
): Promise<void> {
  const ctx = await requireAuth(rt, req);
  const body = await readJson(req);
  const userText = userTextFromBody(body);
  const taskBlocks = attachmentImageBlocks(body);
  const parsedTask = parseGoalTask(userText);
  const sessionId = sessionIdFromBody(body);

  // 同一会话互斥：并发运行会各自加载相同历史再各自落库，导致历史交错重复，
  // 且压缩落库（replaceMessages）会覆盖对方新写的消息。运行中追加消息请走 /append。
  if (findActiveRun(activeRuns, activeRunKey(ctx, sessionId))) {
    throw new HttpError(409, '该会话已有正在运行的任务；可通过 append 追加消息，或先终止当前运行');
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  let closed = false;
  const sse = (event: string, data: unknown): void => {
    if (closed || res.destroyed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  sse('session', { sessionId });
  const abort = new AbortController();
  const pendingMessages: Msg[] = [];
  const activeKey = activeRunKey(ctx, sessionId);
  const activeRun: ActiveAgentRun = {
    abort,
    append: (message) => pendingMessages.push(message),
    drain: () => pendingMessages.splice(0),
  };
  const onClose = () => {
    closed = true;
    if (!abort.signal.aborted) abort.abort(new Error('客户端连接已关闭'));
  };
  addActiveRun(activeRuns, activeKey, activeRun);
  res.on('close', onClose);
  const toolCtx = { sessionId, tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role };

  try {
    // 续接历史：加载该会话既有消息作为上下文。
    // 必须在 addActiveRun 之后加载：此后并发 append 都进内存队列走 drain，
    // 不会在 listMessages 与 replaceMessages 之间直写库被压缩覆盖。
    const prior = await rt.store.listMessages(ctx, sessionId);
    const modelConfig = currentModelConfig(rt);
    const triggerTokens = compactionTriggerTokens(modelConfig);
    const result = await runAgent({
      model: rt.model,
      tools: rt.tools,
      policy: rt.policy,
      filterToolDefs: (defs) => rt.permissionRules?.filterToolDefs(defs) ?? defs,
      hooks: rt.hooks,
      askUser: async (qs: QuestionSpec[]): Promise<QuestionAnswers | null> => {
        if (abort.signal.aborted) return null;
        const { pending, promise } = questions.create({
          tenantId: ctx.tenantId ?? '',
          sessionId,
          userId: ctx.userId ?? '',
          questions: qs,
        });
        const onAbort = () => questions.cancel(pending.id);
        abort.signal.addEventListener('abort', onAbort, { once: true });
        try {
          sse('question_required', pending);
          return await promise;
        } finally {
          abort.signal.removeEventListener('abort', onAbort);
        }
      },
      requestPlanApproval: async (plan): Promise<boolean> => {
        if (abort.signal.aborted) return false;
        // 复用问题机制：一道“批准/拒绝”单选题承载变更方案审批。
        const q: QuestionSpec = {
          question: `请审批变更方案：${plan.summary}`,
          header: '变更审批',
          options: [{ label: '批准' }, { label: '拒绝' }],
        };
        const { pending, promise } = questions.create({
          tenantId: ctx.tenantId ?? '',
          sessionId,
          userId: ctx.userId ?? '',
          questions: [q],
        });
        const onAbort = () => questions.cancel(pending.id);
        abort.signal.addEventListener('abort', onAbort, { once: true });
        try {
          // 附上完整方案供前端渲染（question_required 事件里带 plan）。
          sse('change_plan_required', { ...pending, plan });
          const answers = await promise;
          const approved = answers?.[q.question]?.includes('批准') ?? false;
          if (approved) rt.planState.approve(sessionId);
          await rt.audit?.record({
            kind: 'policy', action: approved ? 'plan-approved' : 'plan-rejected',
            tenantId: ctx.tenantId, sessionId, detail: { plan },
          });
          return approved;
        } finally {
          abort.signal.removeEventListener('abort', onAbort);
        }
      },
      approval: new InteractiveApprovalGate({
        store: approvals,
        emit: (pending) => sse('approval_required', pending),
        signal: abort.signal,
        diff: async ({ call, ctx: diffCtx }) => {
          if (call.name !== 'kubectl') return undefined;
          const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
            ? { ...call.args, dryRun: true }
            : call.args;
          const dryRun = await rt.tools.dispatch({ ...call, id: `${call.id}:dry-run`, args }, diffCtx);
          return dryRun.content;
        },
      }),
      // 技能摘要按当前用户过滤（他人私有技能对模型也不可见），与列表/执行链路同一套可见性。
      system: [
        parsedTask.goalMode ? GOAL_MODE_SYSTEM : '',
        rt.skillRegistry ? rt.skillRegistry.summariesFor(ctx) : rt.systemExtra,
      ].filter(Boolean).join('\n\n'),
      ctx: toolCtx,
      messages: prior,
      task: parsedTask.task,
      taskContentBlocks: taskBlocks,
      signal: abort.signal,
      // 步数不设限：任务跑到完成为止，由终止接口 / 断连中止兜底，中途摘要压缩保证不超窗。
      contextBudgetTokens: contextBudgetTokens(modelConfig),
      keepImages: keepImagesOf(modelConfig),
      // 摘要压缩：runAgent 在每个轮次边界检查（含首轮，新任务与附件一并计入），长 run 中途也能压缩。
      summarize: (stale) => summarizeMessages(rt.model, stale, abort.signal),
      compactionTriggerTokens: triggerTokens,
      compactionKeepRecent: COMPACTION_KEEP_RECENT,
      compactionWatermarkTokens: compactionWatermarks.get(activeKey),
      drainPendingMessages: activeRun.drain,
      onEvent: (e) => {
        if (e.type === 'context_compacted') {
          // 摘要后仍超触发线：记跨请求水位，历史没涨够前的下一次运行不再白跑摘要。
          if (e.afterTokens > triggerTokens) compactionWatermarks.set(activeKey, e.afterTokens + COMPACTION_RETRY_GROWTH_TOKENS);
          else compactionWatermarks.delete(activeKey);
          log.info({ sessionId, ...e }, '历史摘要压缩');
        }
        sse(e.type, e);
      },
    });
    if (result.compacted) {
      // 运行期间发生过摘要压缩：历史已被改写，整体替换落库（事务），并保持会话时间线更新。
      await rt.store.replaceMessages(ctx, sessionId, result.messages);
      await rt.store.touchSession(ctx, sessionId, { updatedAt: new Date() });
    } else {
      // 仅持久化本轮新增消息（task + 后续），一次事务批量落库，避免中途失败留下半截轮次。
      await rt.store.appendMessages(ctx, sessionId, result.messages.slice(prior.length));
    }
    const context = await rt.store.getSessionContextUsage(ctx, sessionId, contextWindowTokens(modelConfig));
    const cost = estimateCost(result.usage, modelConfig.pricing);
    await rt.audit?.record({
      kind: 'usage', action: 'agent', tenantId: ctx.tenantId, sessionId,
      detail: { ...result.usage, steps: result.steps, context, cost },
    });
    sse('done', { sessionId, steps: result.steps, text: result.text, usage: { ...result.usage, context, cost }, context, cost });
  } catch (err) {
    if (abort.signal.aborted) {
      sse('terminated', { sessionId, reason: abortReasonMessage(abort.signal.reason) });
    } else {
      log.error({ err }, 'agent 运行失败');
      sse('error', { error: err instanceof Error ? err.message : '运行失败' });
    }
  } finally {
    // 先摘除注册再冲刷残留：摘除后新 append 直写库，不会再进内存队列。
    // 残留消息（末次 drain 之后 / 运行报错或被终止时入队的）落库，避免用户消息静默丢失。
    removeActiveRun(activeRuns, activeKey, activeRun);
    const leftover = activeRun.drain();
    for (const m of leftover) {
      try {
        await rt.store.appendMessage(ctx, sessionId, m);
      } catch (err) {
        log.warn({ err, sessionId }, '运行结束后残留消息落库失败');
      }
    }
    res.off('close', onClose);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}
