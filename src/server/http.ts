import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SignJWT, jwtVerify } from 'jose';
import { logger } from '../logger.js';
import type { Runtime, RuntimeModelConfig } from '../runtime.js';
import { runAgent } from '../agent/core.js';
import { InMemoryApprovalStore, InteractiveApprovalGate } from '../agent/approval.js';
import { authenticate } from './context.js';
import { AuthzError, requirePermission } from '../auth/rbac.js';
import { LocalAuthProvider } from '../auth/local.js';
import { OidcAuthProvider } from '../auth/oidc.js';
import { createTenant, createUser, listTenants } from '../auth/admin.js';
import type { RequestContext, Role } from '../auth/types.js';
import { createModel } from '../model/factory.js';
import type { JsonValue, ToolCall } from '../model/types.js';

const log = logger.child({ mod: 'http' });

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

const OIDC_COOKIE = 'aiop_oidc';

/** 读取并解析 JSON 请求体（限制 8MB，支持聊天附件以 base64 形式上传）。 */
async function readJson(req: Req): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8_000_000) throw new HttpError(413, '请求体过大');
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

async function sendWebAsset(res: Res, path: string): Promise<boolean> {
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
  res.writeHead(200, { 'content-type': contentType(assetPath), 'content-length': buf.length });
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
    api_key_set: Boolean(config.apiKey),
    api_key_preview: maskApiKey(config.apiKey),
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
  const hasExplicitFields = ['protocol', 'base_url', 'baseURL', 'api_key', 'apiKey', 'model'].some((key) => body[key] !== undefined);
  if (requestedId && !hasExplicitFields) {
    const selected = options.find((option) => option.id === requestedId || option.model === requestedId);
    if (!selected) throw new HttpError(400, `未知模型：${requestedId}`);
    return { ...selected };
  }
  const protocol = parseProtocol(str(body, 'protocol') ?? current.protocol);
  const baseURL = (str(body, 'base_url') ?? str(body, 'baseURL') ?? current.baseURL).trim();
  const model = (str(body, 'model') ?? current.model).trim();
  const id = (str(body, 'id') ?? model).trim();
  const apiKeyInput = str(body, 'api_key') ?? str(body, 'apiKey');
  const apiKey = apiKeyInput && apiKeyInput.trim() ? apiKeyInput.trim() : current.apiKey;
  if (!baseURL) throw new HttpError(400, 'base_url 必填');
  if (!apiKey) throw new HttpError(400, 'api_key 必填');
  if (!model) throw new HttpError(400, 'model 必填');
  return { id: id || model, protocol, baseURL, apiKey, model };
}

function sessionIdFromBody(body: Record<string, unknown>): string {
  return str(body, 'sessionId') ?? randomUUID();
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return Number.isFinite(value as number) || t !== 'number';
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (t === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function attachmentPrompt(body: Record<string, unknown>): string {
  const raw = body.attachments;
  if (!Array.isArray(raw) || raw.length === 0) return '';
  const lines = raw.slice(0, 10).map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' && o.name ? o.name : `attachment-${idx + 1}`;
    const type = typeof o.type === 'string' && o.type ? o.type : 'application/octet-stream';
    const size = typeof o.size === 'number' && Number.isFinite(o.size) ? `${o.size} bytes` : 'unknown size';
    const data = typeof o.data === 'string' && o.data ? `\n${o.data}` : '';
    return `- ${name} (${type}, ${size})${data}`;
  }).filter(Boolean);
  return lines.length ? `[上传附件]\n${lines.join('\n')}` : '';
}

function browserStreamView(sessionId: string): string {
  const sid = JSON.stringify(sessionId);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; background: #0f172a; color: #d6e2ff; font: 14px system-ui, sans-serif; }
    header { display: flex; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid #263449; }
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

/** 校验 Bearer token 并返回身份；失败抛 401。 */
async function requireAuth(rt: Runtime, req: Req): Promise<RequestContext> {
  const ctx = await authenticate(rt.authProvider, req.headers.authorization);
  if (!ctx) throw new HttpError(401, '未认证或 token 无效');
  return ctx;
}

/** 组装 HTTP + SSE 服务。所有处理无本地状态，可多副本水平扩展。 */
export function createHttpServer(rt: Runtime): http.Server {
  const secret = new TextEncoder().encode(rt.jwtSecret);
  const approvals = new InMemoryApprovalStore();

  return http.createServer((req, res) => {
    handle(rt, secret, approvals, req, res).catch((err) => {
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
  if (method === 'GET' && await sendWebAsset(res, path)) return;

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
  if (route === 'POST /v1/agent') return runAgentSse(rt, approvals, req, res);

  if (route === 'GET /v1/me') {
    const ctx = await requireAuth(rt, req);
    return sendJson(res, 200, { tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role });
  }

  if (route === 'GET /v1/sessions') {
    const ctx = await requireAuth(rt, req);
    const limit = Number(url.searchParams.get('limit') ?? '50');
    return sendJson(res, 200, { sessions: await rt.store.listSessions(ctx, Number.isFinite(limit) ? limit : 50) });
  }

  if (route === 'GET /v1/tools') {
    await requireAuth(rt, req);
    const tools = rt.tools.defs().map((def) => ({
      name: def.name,
      description: def.description,
      category: toolCategory(def.name),
      inputSchema: def.inputSchema,
    }));
    const groups = tools.reduce<Record<string, number>>((acc, tool) => {
      acc[tool.category] = (acc[tool.category] ?? 0) + 1;
      return acc;
    }, {});
    return sendJson(res, 200, { tools, groups });
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
    const hasSandboxTools = rt.tools.defs().some((def) => toolCategory(def.name) === 'sandbox');
    const sandboxes = hasSandboxTools
      ? [{
          id: 'sandbox-prod',
          status: 'ready',
          type: 'session',
          resources: { cpu: '2 Core', memory: '4 Gi', storage: '50 Gi' },
          actions: ['打开终端', '打开 VNC', '打开浏览器'],
        }]
      : [];
    return sendJson(res, 200, { sandboxes });
  }

  if (route === 'POST /v1/sandbox/run-code') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const code = str(body, 'code');
    if (!code) throw new HttpError(400, 'code 必填');
    const args: Record<string, JsonValue> = { code };
    const language = str(body, 'language');
    if (language) args.language = language;
    return sendJson(res, 200, await dispatchDirectTool(rt, ctx, sessionIdFromBody(body), 'sbx__run_code', args));
  }

  if (route === 'POST /v1/sandbox/run-command') {
    const ctx = await requireAuth(rt, req);
    const body = await readJson(req);
    const command = str(body, 'command');
    if (!command) throw new HttpError(400, 'command 必填');
    return sendJson(res, 200, await dispatchDirectTool(rt, ctx, sessionIdFromBody(body), 'sbx__run_command', { command }));
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
        r.content = `桌面流地址：/v1/browser/stream-view?sessionId=${encodeURIComponent(sessionId)}`;
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
    return sendJson(res, 200, modelSettingsBody(currentModelConfig(rt), rt.modelOptions));
  }
  if (route === 'POST /v1/settings/llm') {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'tenant:manage');
    const next = modelConfigFromBody(await readJson(req), currentModelConfig(rt), rt.modelOptions);
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
    const config = hasBody ? modelConfigFromBody(body, currentModelConfig(rt), rt.modelOptions) : currentModelConfig(rt);
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

  // GET /v1/sessions/{id}/messages
  const msgMatch = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(path);
  if (method === 'GET' && msgMatch) {
    const ctx = await requireAuth(rt, req);
    const messages = await rt.store.listMessages(ctx, decodeURIComponent(msgMatch[1]!));
    return sendJson(res, 200, { messages });
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
    const sessionId = str(body, 'sessionId') ?? randomUUID();
    const cron = str(body, 'cron');
    const task = str(body, 'task');
    if (!cron || !task) throw new HttpError(400, 'cron/task 必填');
    const preApproved = body.preApproved === true;
    if (preApproved) requirePermission(ctx, 'approve'); // 预批准属审批权
    const created = await rt.store.createScheduledTask(ctx, {
      sessionId, cron, task, preApproved, enabled: body.enabled !== false,
    });
    return sendJson(res, 201, { task: created });
  }
  const schedMatch = /^\/v1\/schedule\/(\d+)\/(enable|disable)$/.exec(path);
  if (method === 'POST' && schedMatch) {
    const ctx = await requireAuth(rt, req);
    requirePermission(ctx, 'task:create');
    await rt.store.setTaskEnabled(ctx, Number(schedMatch[1]), schedMatch[2] === 'enable');
    return sendJson(res, 200, { ok: true });
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
    const tenantId = str(body, 'tenantId');
    const username = str(body, 'username');
    const password = str(body, 'password');
    const role = (str(body, 'role') ?? 'user') as Role;
    if (!tenantId || !username || !password) throw new HttpError(400, 'tenantId/username/password 必填');
    const user = await createUser(ctx, rt.authProvider, { tenantId, username, password, role });
    return sendJson(res, 201, { user });
  }

  sendJson(res, 404, { error: `未知路由: ${route}` });
}

function toolCategory(name: string): string {
  if (name === 'load_skill' || name.startsWith('skill__')) return 'skill';
  if (name.startsWith('mcp__')) return 'mcp';
  if (name.startsWith('sbx__') || name.startsWith('browser_') || name === 'desktop_stream_url') return 'sandbox';
  if (name.includes('schedule')) return 'schedule';
  if (name === 'kubectl') return 'ops';
  return 'builtin';
}

/** POST /v1/agent：流式（SSE）运行一次 agent，自动续接会话历史并持久化。 */
async function runAgentSse(rt: Runtime, approvals: InMemoryApprovalStore, req: Req, res: Res): Promise<void> {
  const ctx = await requireAuth(rt, req);
  const body = await readJson(req);
  const rawTask = str(body, 'task')?.trim();
  const uploaded = attachmentPrompt(body);
  if (!rawTask && !uploaded) throw new HttpError(400, 'task 必填');
  const task = [rawTask || '请分析上传附件。', uploaded].filter(Boolean).join('\n\n');
  const sessionId = str(body, 'sessionId') ?? randomUUID();

  // 续接历史：加载该会话既有消息作为上下文
  const prior = await rt.store.listMessages(ctx, sessionId);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const sse = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  sse('session', { sessionId });
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const toolCtx = { sessionId, tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role };

  try {
    const result = await runAgent({
      model: rt.model,
      tools: rt.tools,
      policy: rt.policy,
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
      system: rt.systemExtra,
      ctx: toolCtx,
      messages: prior,
      task,
      onEvent: (e) => sse(e.type, e),
    });
    // 仅持久化本轮新增消息（task + 后续），避免重复落库历史
    for (const m of result.messages.slice(prior.length)) {
      await rt.store.appendMessage(ctx, sessionId, m);
    }
    await rt.audit?.record({
      kind: 'usage', action: 'agent', tenantId: ctx.tenantId, sessionId,
      detail: { ...result.usage, steps: result.steps },
    });
    sse('done', { sessionId, steps: result.steps, text: result.text, usage: result.usage });
  } catch (err) {
    log.error({ err }, 'agent 运行失败');
    sse('error', { error: err instanceof Error ? err.message : '运行失败' });
  } finally {
    res.end();
  }
}
