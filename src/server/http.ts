import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { logger } from '../logger.js';
import type { Runtime } from '../runtime.js';
import { runAgent } from '../agent/core.js';
import { AutoDenyGate } from '../agent/approval.js';
import { authenticate } from './context.js';
import { AuthzError, requirePermission } from '../auth/rbac.js';
import { LocalAuthProvider } from '../auth/local.js';
import { OidcAuthProvider } from '../auth/oidc.js';
import { createTenant, createUser, listTenants } from '../auth/admin.js';
import type { RequestContext, Role } from '../auth/types.js';

const log = logger.child({ mod: 'http' });

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

const OIDC_COOKIE = 'aiop_oidc';

/** 读取并解析 JSON 请求体（限制 1MB）。 */
async function readJson(req: Req): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, '请求体过大');
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

/** 校验 Bearer token 并返回身份；失败抛 401。 */
async function requireAuth(rt: Runtime, req: Req): Promise<RequestContext> {
  const ctx = await authenticate(rt.authProvider, req.headers.authorization);
  if (!ctx) throw new HttpError(401, '未认证或 token 无效');
  return ctx;
}

/** 组装 HTTP + SSE 服务。所有处理无本地状态，可多副本水平扩展。 */
export function createHttpServer(rt: Runtime): http.Server {
  const secret = new TextEncoder().encode(rt.jwtSecret);

  return http.createServer((req, res) => {
    handle(rt, secret, req, res).catch((err) => {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof AuthzError) return sendJson(res, 403, { error: err.message });
      log.error({ err }, '请求处理异常');
      if (!res.headersSent) sendJson(res, 500, { error: '内部错误' });
      else res.end();
    });
  });
}

async function handle(rt: Runtime, secret: Uint8Array, req: Req, res: Res): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const route = `${method} ${path}`;

  // —— 健康检查（无需认证）——
  if (route === 'GET /healthz') return sendJson(res, 200, { ok: true });
  if (route === 'GET /readyz') return sendJson(res, 200, { ok: true });

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
  if (route === 'POST /v1/agent') return runAgentSse(rt, req, res);

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

/** POST /v1/agent：流式（SSE）运行一次 agent，自动续接会话历史并持久化。 */
async function runAgentSse(rt: Runtime, req: Req, res: Res): Promise<void> {
  const ctx = await requireAuth(rt, req);
  const body = await readJson(req);
  const task = str(body, 'task');
  if (!task) throw new HttpError(400, 'task 必填');
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

  try {
    const result = await runAgent({
      model: rt.model,
      tools: rt.tools,
      policy: rt.policy,
      approval: new AutoDenyGate(), // HTTP 无交互审批通道：需审批的操作一律拒绝
      system: rt.systemExtra,
      ctx: { sessionId, tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role },
      messages: prior,
      task,
      onEvent: (e) => sse(e.type, e),
    });
    // 仅持久化本轮新增消息（task + 后续），避免重复落库历史
    for (const m of result.messages.slice(prior.length)) {
      await rt.store.appendMessage(ctx, sessionId, m);
    }
    sse('done', { sessionId, steps: result.steps, text: result.text });
  } catch (err) {
    log.error({ err }, 'agent 运行失败');
    sse('error', { error: err instanceof Error ? err.message : '运行失败' });
  } finally {
    res.end();
  }
}
