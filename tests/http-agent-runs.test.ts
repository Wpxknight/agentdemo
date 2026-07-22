import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/server/http.js';
import { MemoryStore } from '../src/db/memory.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { Runtime } from '../src/runtime.js';
import type { RunAgentOptions, RunAgentResult } from '../src/agent/core.js';

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
    kernel: 'langgraph', graphName: 'aiop-agent', graphVersion: 'v1', createdAt,
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
      run: { runId: 'run-user', status: 'failed', graphVersion: 'v1' },
      events: [{ node: 'model', status: 'failed' }],
      interactions: [{ id: 'interaction-secret', kind: 'approval', status: 'resolved' }],
      tools: [{ toolCallId: 'tool-secret', toolName: 'kubectl', status: 'completed' }], canResume: true,
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

  it('accepts safe checkpoint recovery and invokes the runtime with the locked run id', async () => {
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
});
