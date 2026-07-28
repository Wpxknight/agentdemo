import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/server/http.js';
import { MemoryStore } from '../src/db/memory.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { Runtime } from '../src/runtime.js';
import type { RunAgentOptions, RunAgentResult } from '../src/agent/run-types.js';

let server: Server;
let base: string;
let store: MemoryStore;
let adminToken: string;
let userToken: string;
let userId: string;
const run = vi.fn(async (_options: RunAgentOptions): Promise<RunAgentResult> => ({
  messages: [], text: 'recovered', steps: 1, compacted: false,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
}));

async function login(username: string): Promise<string> {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: 'default', username, password: 'pw' }),
  });
  return String((await response.json() as { token: string }).token);
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

beforeAll(async () => {
  store = new MemoryStore();
  await store.createTenant({ id: 'default', name: 'Default' });
  const authProvider = new LocalAuthProvider({ store, secret: 'run-center-secret' });
  const admin = await authProvider.createUser('default', 'admin', 'pw', 'platform_admin');
  const user = await authProvider.createUser('default', 'alice', 'pw', 'user');
  userId = user.id;
  const createdAt = new Date('2026-07-22T00:00:00.000Z');
  await store.putAgentRunBindingIfAbsent({
    tenantId: 'default', userId: user.id, sessionId: 'session-user', runId: 'run-user',
    kernel: 'pi', kernelVersion: '0.82.1', graphName: '', graphVersion: '', createdAt,
  });
  await store.updateAgentRun('default', 'run-user', {
    status: 'failed', errorMessage: 'upstream failed', completedAt: createdAt, updatedAt: createdAt,
  });
  await store.appendAgentRunEvent({
    tenantId: 'default', runId: 'run-user', type: 'node', node: 'model', status: 'failed', createdAt,
  });
  await store.putAgentRunBindingIfAbsent({
    tenantId: 'default', userId: admin.id, sessionId: 'session-admin', runId: 'run-admin',
    kernel: 'langgraph', graphName: 'aiop-agent', graphVersion: 'v1', createdAt: new Date(createdAt.getTime() + 1),
  });

  const rt = {
    agentRuntime: { run },
    model: { id: 'mock', async *stream() { yield { type: 'text_delta' as const, text: 'ok' }; } },
    modelConfig: { id: 'mock', protocol: 'anthropic', baseURL: '', apiKey: '', model: 'mock' },
    tools: new ToolRegistry(), store,
    policy: new AllowAllPolicy(), policyPreApproved: new AllowAllPolicy(),
    permissionRules: { filterToolDefs: <T>(defs: T) => defs },
    hooks: undefined, systemExtra: '', authProvider, jwtSecret: 'run-center-secret',
    audit: { record: async () => {} },
    defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' },
  } as unknown as Runtime;
  server = createHttpServer(rt);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  adminToken = await login('admin');
  userToken = await login('alice');
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('Agent Run Center HTTP API', () => {
  it('lists tenant runs for admins and only owned runs for normal users', async () => {
    const adminResponse = await fetch(`${base}/v1/agent/runs`, { headers: auth(adminToken) });
    expect(adminResponse.status).toBe(200);
    expect((await adminResponse.json() as { runs: Array<{ runId: string }>; total: number })).toMatchObject({ total: 2 });

    const userResponse = await fetch(`${base}/v1/agent/runs?status=failed`, { headers: auth(userToken) });
    expect(userResponse.status).toBe(200);
    expect((await userResponse.json() as { runs: Array<{ runId: string }> }).runs.map((item) => item.runId)).toEqual(['run-user']);
  });

  it('returns a run detail with timeline, interactions and tool ledger', async () => {
    await store.putInteraction({
      id: 'interaction-secret', tenantId: 'default', userId, sessionId: 'session-user', runId: 'run-user',
      kind: 'approval', toolCallId: 'tool-secret', payload: { password: 'must-not-leak' },
      status: 'resolved', resolution: { token: 'must-not-leak' }, expiresAt: new Date('2026-07-23T00:00:00Z'),
      createdAt: new Date('2026-07-22T00:00:01Z'), resolvedAt: new Date('2026-07-22T00:00:02Z'),
    });
    await store.putToolExecutionIfAbsent({
      tenantId: 'default', runId: 'run-user', sessionId: 'session-user', toolCallId: 'tool-secret',
      toolName: 'kubectl', argsDigest: 'digest', status: 'completed',
      result: { id: 'tool-secret', content: 'secret output' }, startedAt: new Date('2026-07-22T00:00:01Z'),
      completedAt: new Date('2026-07-22T00:00:02Z'), updatedAt: new Date('2026-07-22T00:00:02Z'),
    });
    const response = await fetch(`${base}/v1/agent/runs/run-user`, { headers: auth(userToken) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run: { runId: 'run-user', status: 'failed', kernel: 'pi', kernelVersion: '0.82.1' },
      events: [{ node: 'model', status: 'failed' }],
      interactions: [{ id: 'interaction-secret', kind: 'approval', status: 'resolved' }],
      tools: [{ toolCallId: 'tool-secret', toolName: 'kubectl', status: 'completed' }],
      attempts: [], turns: [], canResume: true,
    });
    const raw = JSON.stringify(await (await fetch(`${base}/v1/agent/runs/run-user`, { headers: auth(userToken) })).json());
    expect(raw).not.toContain('must-not-leak');
    expect(raw).not.toContain('secret output');
  });

  it('durably requests cancellation and rejects cross-user control', async () => {
    await store.updateAgentRun('default', 'run-user', { status: 'queued' });
    const own = await fetch(`${base}/v1/agent/runs/run-user/cancel`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    expect(own.status).toBe(200);
    expect(await store.isAgentRunCancellationRequested('default', 'run-user')).toBe(true);

    const denied = await fetch(`${base}/v1/agent/runs/run-admin/cancel`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    expect(denied.status).toBe(404);
  });

  it('exposes sanitized rollout comparison outcomes in Run Center details', async () => {
    await store.appendAgentRunEvent({
      tenantId: 'default', runId: 'run-user', type: 'rollout_comparison', status: 'succeeded',
      detail: {
        mode: 'dry-run', sourceRunId: 'run-control', outcome: 'succeeded',
        usage: { inputTokens: 10, outputTokens: 2 },
        sourceUsage: { inputTokens: 8, outputTokens: 3 },
        usageDelta: { inputTokens: 2, outputTokens: -1 },
      },
      createdAt: new Date(),
    });
    const response = await fetch(`${base}/v1/agent/runs/run-user`, { headers: auth(userToken) });
    const detail = await response.json() as { events: Array<{ type: string; detail?: unknown }> };

    expect(detail.events).toContainEqual(expect.objectContaining({
      type: 'rollout_comparison',
      detail: expect.objectContaining({ mode: 'dry-run', sourceRunId: 'run-control', outcome: 'succeeded' }),
    }));
    expect(JSON.stringify(detail.events)).not.toContain('secret output');
  });

  it('accepts safe kernel-independent recovery and invokes the runtime with the locked run id', async () => {
    await store.updateAgentRun('default', 'run-user', { cancelRequestedAt: null, status: 'failed' });
    const response = await fetch(`${base}/v1/agent/runs/run-user/resume`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-user', resumeFromCheckpoint: true,
      ctx: expect.objectContaining({ tenantId: 'default', userId: expect.any(String), sessionId: 'session-user' }),
    })));
  });

  it.each([
    ['approve', true],
    ['deny', false],
  ] as const)('automatically recovers a resolved approval (%s) once with a trusted resolution', async (action, value) => {
    run.mockClear();
    const id = `approval-auto-${action}`;
    await store.updateAgentRun('default', 'run-user', { status: 'waiting', waitingReason: 'approval' });
    await store.putInteraction({
      id, tenantId: 'default', userId, sessionId: 'session-user', runId: 'run-user',
      kind: 'approval', toolCallId: `call-${action}`, payload: { id }, status: 'pending',
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
    });

    const first = await fetch(`${base}/v1/approvals/${id}/${action}`, {
      method: 'POST', headers: auth(adminToken), body: '{}',
    });
    expect(first.status).toBe(200);
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-user', resumeFromCheckpoint: true,
      interactionResolution: { interactionId: id, value },
    })));
    const calls = run.mock.calls.length;

    const duplicate = await fetch(`${base}/v1/approvals/${id}/${action}`, {
      method: 'POST', headers: auth(adminToken), body: '{}',
    });
    expect(duplicate.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).toHaveBeenCalledTimes(calls);

    const conflict = await fetch(`${base}/v1/approvals/${id}/${action === 'approve' ? 'deny' : 'approve'}`, {
      method: 'POST', headers: auth(adminToken), body: '{}',
    });
    expect(conflict.status).toBe(409);
    const events = await store.listAgentRunEvents({ tenantId: 'default', userId, role: 'user' }, 'run-user');
    const requested = events.findLast((event) => event.type === 'recovery' && event.status === 'requested');
    expect(requested?.detail).toMatchObject({ reason: 'interaction_resolved', kind: 'approval' });
    expect(requested?.detail).not.toHaveProperty('value');
  });

  it.each(['question', 'plan'] as const)('automatically recovers a resolved %s without exposing answers in events', async (kind) => {
    run.mockClear();
    const id = `${kind}-auto`;
    const answers = { 'Continue?': [kind === 'plan' ? '批准' : 'Yes'] };
    await store.updateAgentRun('default', 'run-user', { status: 'waiting', waitingReason: kind });
    await store.putInteraction({
      id, tenantId: 'default', userId, sessionId: 'session-user', runId: 'run-user',
      kind, toolCallId: `call-${kind}`, payload: { id, questions: [] }, status: 'pending',
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
    });
    const response = await fetch(`${base}/v1/questions/${id}/answer`, {
      method: 'POST', headers: auth(userToken), body: JSON.stringify({ answers }),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-user', resumeFromCheckpoint: true,
      interactionResolution: { interactionId: id, value: answers },
    })));
    const events = await store.listAgentRunEvents({ tenantId: 'default', userId, role: 'user' }, 'run-user');
    const requested = events.findLast((event) => event.type === 'recovery' && event.status === 'requested');
    expect(requested?.detail).toMatchObject({ reason: 'interaction_resolved', kind });
    expect(JSON.stringify(requested?.detail)).not.toContain('Continue?');
  });

  it('records a sanitized recovery failure after a successful interaction resolve', async () => {
    run.mockClear();
    run.mockRejectedValueOnce(new Error('sensitive model failure detail'));
    const id = 'approval-recovery-failure';
    await store.updateAgentRun('default', 'run-user', { status: 'waiting', waitingReason: 'approval' });
    await store.putInteraction({
      id, tenantId: 'default', userId, sessionId: 'session-user', runId: 'run-user',
      kind: 'approval', toolCallId: 'call-failure', payload: {}, status: 'pending',
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
    });
    const response = await fetch(`${base}/v1/approvals/${id}/approve`, {
      method: 'POST', headers: auth(adminToken), body: '{}',
    });
    expect(response.status).toBe(200);
    await vi.waitFor(async () => {
      const record = await store.getAgentRun({ tenantId: 'default', userId, role: 'user' }, 'run-user');
      expect(record?.status).toBe('recovery_required');
    });
    const events = await store.listAgentRunEvents({ tenantId: 'default', userId, role: 'user' }, 'run-user');
    const failed = events.findLast((event) => event.type === 'recovery' && event.status === 'failed');
    expect(failed?.detail).toMatchObject({
      reason: 'runtime_error', interactionId: id, errorType: 'Error',
    });
    expect(JSON.stringify(failed?.detail)).not.toContain('sensitive model failure detail');
  });

  it('keeps session-busy protection when interaction recovery races another active run', async () => {
    run.mockClear();
    run.mockImplementationOnce(async (options) => new Promise<RunAgentResult>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    const activeResponse = await fetch(`${base}/v1/agent`, {
      method: 'POST', headers: auth(userToken),
      body: JSON.stringify({ task: 'hold session', sessionId: 'session-user' }),
    });
    expect(activeResponse.status).toBe(200);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    const id = 'approval-session-busy';
    await store.updateAgentRun('default', 'run-user', { status: 'waiting', waitingReason: 'approval' });
    await store.putInteraction({
      id, tenantId: 'default', userId, sessionId: 'session-user', runId: 'run-user',
      kind: 'approval', toolCallId: 'call-busy', payload: {}, status: 'pending',
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
    });
    const resolved = await fetch(`${base}/v1/approvals/${id}/approve`, {
      method: 'POST', headers: auth(adminToken), body: '{}',
    });
    expect(resolved.status).toBe(200);
    await vi.waitFor(async () => {
      const record = await store.getAgentRun({ tenantId: 'default', userId, role: 'user' }, 'run-user');
      expect(record).toMatchObject({ status: 'recovery_required', errorMessage: '同一会话已有运行中的任务' });
    });
    const events = await store.listAgentRunEvents({ tenantId: 'default', userId, role: 'user' }, 'run-user');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'recovery', status: 'blocked', detail: { reason: 'session_busy' },
    }));

    await fetch(`${base}/v1/sessions/session-user/terminate`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    await activeResponse.body?.cancel().catch(() => undefined);
  });

  it('rejects explicit resume while a durable interaction is still pending', async () => {
    run.mockClear();
    await store.updateAgentRun('default', 'run-user', { status: 'failed', waitingReason: 'approval' });
    await store.putInteraction({
      id: 'approval-pending-resume', tenantId: 'default', userId, sessionId: 'session-user', runId: 'run-user',
      kind: 'approval', toolCallId: 'call-pending', payload: {}, status: 'pending',
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
    });
    const response = await fetch(`${base}/v1/agent/runs/run-user/resume`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('pending Interaction') });
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps historical LangGraph runs query-only and rejects recovery', async () => {
    await store.updateAgentRun('default', 'run-admin', { status: 'failed', updatedAt: new Date() });
    const detail = await fetch(`${base}/v1/agent/runs/run-admin`, { headers: auth(adminToken) });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      run: { runId: 'run-admin', kernel: 'langgraph' },
      canResume: false,
      recoveryBlockedReason: expect.stringContaining('仅供查询'),
    });

    const response = await fetch(`${base}/v1/agent/runs/run-admin/resume`, {
      method: 'POST', headers: auth(adminToken), body: '{}',
    });
    expect(response.status).toBe(409);
    expect(run).not.toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-admin' }));
  });

  it('replays durable SSE events strictly after Last-Event-ID', async () => {
    await store.appendAgentRunEvent({
      tenantId: 'default', runId: 'run-user', type: 'turn_committed', status: 'succeeded', createdAt: new Date(),
    });
    const response = await fetch(`${base}/v1/agent/runs/run-user/events`, {
      headers: { ...auth(userToken), 'last-event-id': '1' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).not.toContain('id: 1\n');
    expect(body).toContain('id: 2\n');
    expect(body).toContain('"sequence":2');
  });
});
