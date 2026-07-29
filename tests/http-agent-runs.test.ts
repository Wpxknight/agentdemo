import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/server/http.js';
import { MemoryStore } from '../src/db/memory.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { Runtime } from '../src/runtime.js';
import type { ResumeRunInput, RunHandle } from '@aiop/control-contracts';

let server: Server;
let base: string;
let store: MemoryStore;
let adminToken: string;
let userToken: string;
let userId: string;
const resume = vi.fn(async (input: ResumeRunInput) => completedHandle(input.runId));
const cancel = vi.fn(async () => undefined);

function completedHandle(runId: string): RunHandle {
  return {
    runId,
    status: 'running',
    events: { async *[Symbol.asyncIterator]() {} },
    result: async () => ({
      runId, status: 'succeeded',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
  };
}

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
  await store.durableRunStore().create({ record: {
    tenantId: 'default', actorId: user.id, sessionId: 'session-user', runId: 'run-user',
    kernel: 'pi', kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    createdAt, updatedAt: createdAt,
  } });
  await store.updateAgentRun('default', 'run-user', {
    status: 'failed', errorMessage: 'upstream failed', completedAt: createdAt, updatedAt: createdAt,
  });
  await store.appendAgentRunEvent({
    tenantId: 'default', runId: 'run-user', type: 'node', node: 'model', status: 'failed', createdAt,
  });
  await store.durableRunStore().create({ record: {
    tenantId: 'default', actorId: admin.id, sessionId: 'session-admin', runId: 'run-admin',
    kernel: 'pi', kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    createdAt: new Date(createdAt.getTime() + 1), updatedAt: new Date(createdAt.getTime() + 1),
  } });
  const rt = {
    durableRunRuntime: {
      run: vi.fn(async () => completedHandle('unused')),
      resume,
      cancel,
      append: vi.fn(async () => undefined),
    },
    model: { id: 'mock', async *stream() {} },
    tools: new ToolRegistry(), store,
    policy: new AllowAllPolicy(), policyPreApproved: new AllowAllPolicy(),
    permissionRules: { filterToolDefs: <T>(defs: T) => defs },
    systemExtra: '', authProvider, jwtSecret: 'run-center-secret',
    audit: { record: async () => undefined },
    defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' },
  } as unknown as Runtime;
  server = createHttpServer(rt);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  adminToken = await login('admin');
  userToken = await login('alice');
});

beforeEach(() => {
  resume.mockClear();
  cancel.mockClear();
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('mandatory durable Run Center HTTP API', () => {
  it('lists tenant runs for admins and only owned runs for normal users', async () => {
    const adminResponse = await fetch(`${base}/v1/agent/runs`, { headers: auth(adminToken) });
    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.json()).toMatchObject({ total: 2 });

    const userResponse = await fetch(`${base}/v1/agent/runs?status=failed`, { headers: auth(userToken) });
    expect(userResponse.status).toBe(200);
    expect((await userResponse.json() as { runs: Array<{ runId: string }> }).runs.map((item) => item.runId))
      .toEqual(['run-user']);
  });

  it('returns a sanitized detail timeline with interactions and tool ledger', async () => {
    await store.putInteraction({
      id: 'interaction-secret', tenantId: 'default', userId, sessionId: 'session-user', runId: 'run-user',
      kind: 'approval', toolCallId: 'tool-secret', payload: { password: 'must-not-leak' },
      status: 'resolved', resolution: { token: 'must-not-leak' },
      expiresAt: new Date('2026-07-23T00:00:00Z'), createdAt: new Date('2026-07-22T00:00:01Z'),
      resolvedAt: new Date('2026-07-22T00:00:02Z'),
    });
    await store.putToolExecutionIfAbsent({
      tenantId: 'default', runId: 'run-user', sessionId: 'session-user', toolCallId: 'tool-secret',
      toolName: 'kubectl', argsDigest: 'digest', status: 'completed',
      result: { id: 'tool-secret', content: 'secret output' }, startedAt: new Date('2026-07-22T00:00:01Z'),
      completedAt: new Date('2026-07-22T00:00:02Z'), updatedAt: new Date('2026-07-22T00:00:02Z'),
    });
    const response = await fetch(`${base}/v1/agent/runs/run-user`, { headers: auth(userToken) });
    expect(response.status).toBe(200);
    const detail = await response.json();
    expect(detail).toMatchObject({
      run: { runId: 'run-user', status: 'failed', kernel: 'pi', kernelVersion: '0.82.1' },
      events: [{ node: 'model', status: 'failed' }],
      interactions: [{ id: 'interaction-secret', kind: 'approval', status: 'resolved' }],
      tools: [{ toolCallId: 'tool-secret', toolName: 'kubectl', status: 'completed' }],
      attempts: [], turns: [], canResume: true,
    });
    expect(JSON.stringify(detail)).not.toContain('must-not-leak');
    expect(JSON.stringify(detail)).not.toContain('secret output');
  });

  it('durably cancels owned runs and rejects cross-user control', async () => {
    await store.updateAgentRun('default', 'run-user', { status: 'queued', cancelRequestedAt: null });
    const own = await fetch(`${base}/v1/agent/runs/run-user/cancel`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    expect(own.status).toBe(200);
    expect(await store.isAgentRunCancellationRequested('default', 'run-user')).toBe(true);
    expect(cancel).toHaveBeenCalledWith({
      identity: { tenantId: 'default', actorId: userId, roles: ['user'] }, runId: 'run-user',
    });

    const denied = await fetch(`${base}/v1/agent/runs/run-admin/cancel`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    expect(denied.status).toBe(404);
  });

  it('starts explicit recovery through durable resume', async () => {
    await store.updateAgentRun('default', 'run-user', {
      status: 'failed', cancelRequestedAt: null, errorMessage: 'failed', completedAt: new Date(),
    });
    const response = await fetch(`${base}/v1/agent/runs/run-user/resume`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledWith({
      identity: { tenantId: 'default', actorId: userId, roles: ['user'] }, runId: 'run-user',
    }));
    await vi.waitFor(async () => {
      const recovery = (await store.listAgentRunEvents({ tenantId: 'default', userId, role: 'user' }, 'run-user'))
        .filter((event) => event.type === 'recovery');
      expect(recovery.slice(-3).map((event) => event.status)).toEqual(['requested', 'started', 'succeeded']);
      expect((await store.durableRunStore().events.list({ tenantId: 'default', runId: 'run-user' }))
        .slice(-3).map((event) => (event.detail as { recoveryStatus?: string }).recoveryStatus))
        .toEqual(['requested', 'started', 'succeeded']);
    });
  });

  it('automatically recovers a resolved interaction once and rejects conflicting races', async () => {
    const interactionId = 'approval-auto';
    await store.updateAgentRun('default', 'run-user', { status: 'waiting', waitingReason: 'approval' });
    await store.putInteraction({
      id: interactionId, tenantId: 'default', userId, sessionId: 'session-user', runId: 'run-user',
      kind: 'approval', toolCallId: 'call-auto', payload: {}, status: 'pending',
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
    });

    const [first, duplicate] = await Promise.all([
      fetch(`${base}/v1/approvals/${interactionId}/approve`, {
        method: 'POST', headers: auth(adminToken), body: '{}',
      }),
      fetch(`${base}/v1/approvals/${interactionId}/approve`, {
        method: 'POST', headers: auth(adminToken), body: '{}',
      }),
    ]);
    expect([first.status, duplicate.status].sort()).toEqual([200, 200]);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(resume).toHaveBeenCalledWith({
      identity: expect.objectContaining({ tenantId: 'default', roles: ['platform_admin'] }),
      runId: 'run-user', resolution: { interactionId, value: true },
    });

    const conflict = await fetch(`${base}/v1/approvals/${interactionId}/deny`, {
      method: 'POST', headers: auth(adminToken), body: '{}',
    });
    expect(conflict.status).toBe(409);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('supervises immediate recovery failures and drains returned handles', async () => {
    await store.updateAgentRun('default', 'run-user', { status: 'failed', waitingReason: null });
    resume.mockRejectedValueOnce(new Error('authorization=Bearer-secret token=top-secret immediate failure'));
    const first = await fetch(`${base}/v1/agent/runs/run-user/resume`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    expect(first.status).toBe(202);
    await vi.waitFor(async () => {
      expect(resume).toHaveBeenCalledOnce();
      expect(await store.getAgentRun({ tenantId: 'default', userId, role: 'user' }, 'run-user')).toMatchObject({
        status: 'recovery_required', errorMessage: expect.stringContaining('[redacted]'),
      });
      const recovery = (await store.listAgentRunEvents({ tenantId: 'default', userId, role: 'user' }, 'run-user'))
        .filter((event) => event.type === 'recovery');
      expect(recovery.slice(-3).map((event) => event.status)).toEqual(['requested', 'started', 'failed']);
      expect(JSON.stringify(recovery.at(-1))).not.toContain('top-secret');
    });

    const drained = vi.fn();
    const result = vi.fn(async () => { throw new Error('password=hunter2 handle failure'); });
    resume.mockResolvedValueOnce({
      runId: 'run-user', status: 'running',
      events: { async *[Symbol.asyncIterator]() { drained(); } }, result,
    });
    const second = await fetch(`${base}/v1/agent/runs/run-user/resume`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    expect(second.status).toBe(202);
    await vi.waitFor(() => {
      expect(drained).toHaveBeenCalledOnce();
      expect(result).toHaveBeenCalledOnce();
    });
    await vi.waitFor(async () => {
      expect(await store.getAgentRun({ tenantId: 'default', userId, role: 'user' }, 'run-user')).toMatchObject({
        status: 'recovery_required', errorMessage: expect.stringContaining('[redacted]'),
      });
      const recovery = (await store.listAgentRunEvents({ tenantId: 'default', userId, role: 'user' }, 'run-user'))
        .filter((event) => event.type === 'recovery');
      expect(recovery.slice(-3).map((event) => event.status)).toEqual(['requested', 'started', 'failed']);
      expect(JSON.stringify(recovery.at(-1))).not.toContain('hunter2');
    });
  });

  it('does not overwrite a newer waiting state when a stale recovery supervisor fails', async () => {
    const durable = store.durableRunStore();
    const markRecovery = vi.spyOn(durable, 'markRecoveryRequired');
    const startedAt = new Date();
    await store.updateAgentRun('default', 'run-user', {
      status: 'failed', waitingReason: null, cancelRequestedAt: null, completedAt: startedAt, updatedAt: startedAt,
    });
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    let supervisorObservedLease!: () => void;
    const leaseObserved = new Promise<void>((resolve) => { supervisorObservedLease = resolve; });
    let firstClaim!: Awaited<ReturnType<typeof durable.claim>>;
    resume.mockImplementationOnce(async (input) => {
      firstClaim = await durable.claim({
        identity: input.identity, runId: input.runId, workerId: 'worker-a', now: startedAt,
        leaseTtlMs: 60_000, resume: true,
      });
      return {
        runId: input.runId, status: 'running',
        events: { async *[Symbol.asyncIterator]() { supervisorObservedLease(); await failureGate; } },
        result: async () => { throw new Error('delayed worker-a failure'); },
      };
    });

    const response = await fetch(`${base}/v1/agent/runs/run-user/resume`, {
      method: 'POST', headers: auth(userToken), body: '{}',
    });
    expect(response.status).toBe(202);
    await leaseObserved;
    expect(firstClaim).toBeTruthy();
    const reclaimedAt = new Date(startedAt.getTime() + 60_001);
    const second = await durable.claim({
      identity: { tenantId: 'default', actorId: userId, roles: ['user'] }, runId: 'run-user',
      workerId: 'worker-b', now: reclaimedAt, leaseTtlMs: 60_000, resume: true,
    });
    await durable.commitTurn({
      tenantId: 'default', runId: 'run-user', attemptId: second!.attemptId, turnNo: 1,
      fencingToken: second!.fencingToken, checkpoint: {}, events: [], status: 'waiting', waitingReason: 'approval',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      committedAt: new Date(reclaimedAt.getTime() + 1),
    });

    releaseFailure();
    await vi.waitFor(async () => {
      const recovery = (await store.listAgentRunEvents({ tenantId: 'default', userId, role: 'user' }, 'run-user'))
        .filter((event) => event.type === 'recovery');
      expect(recovery.at(-1)?.status).toBe('failed');
    });
    expect(markRecovery).toHaveBeenCalledWith(expect.objectContaining({
      expectedLease: { ownerId: 'worker-a', token: firstClaim!.fencingToken },
    }));
    await expect(markRecovery.mock.results.at(-1)?.value).resolves.toBe(false);
    await expect(durable.get({ tenantId: 'default', runId: 'run-user' })).resolves.toMatchObject({
      status: 'waiting', waitingReason: 'approval', leaseToken: second!.fencingToken,
    });
    markRecovery.mockRestore();
  });

  it('replays SSE events strictly after Last-Event-ID', async () => {
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
