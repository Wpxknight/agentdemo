import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../../src/server/http.js';
import { LocalAuthProvider } from '../../src/auth/local.js';
import { MemoryStore } from '../../src/db/memory.js';
import { ToolRegistry } from '../../src/agent/tools.js';
import { AllowAllPolicy } from '../../src/agent/policy.js';
import { createConfiguredAgentRuntime } from '../../src/agent/runtime.js';
import type { AgentKernel } from '../../src/agent/kernel.js';
import type { Runtime } from '../../src/runtime.js';

interface SseEvent {
  name: string;
  data: Record<string, unknown>;
}

let server: Server;
let baseUrl: string;
let token: string;
let userId: string;
let store: MemoryStore;
const kernelRun = vi.fn<AgentKernel['run']>();

const authHeaders = (): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

function parseSse(body: string): SseEvent[] {
  return body.trim().split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n');
    return {
      name: lines.find((line) => line.startsWith('event: '))?.slice(7) ?? '',
      data: JSON.parse(lines.find((line) => line.startsWith('data: '))?.slice(6) ?? '{}') as Record<string, unknown>,
    };
  });
}

beforeAll(async () => {
  store = new MemoryStore();
  await store.createTenant({ id: 'default', name: 'Default' });
  const authProvider = new LocalAuthProvider({ store, secret: 'runtime-contract-secret' });
  const user = await authProvider.createUser('default', 'contract-user', 'pw', 'user');
  userId = user.id;
  token = (await authProvider.login('default', 'contract-user', 'pw'))!;

  kernelRun.mockImplementation(async (options) => {
    options.onEvent?.({ type: 'text_delta', text: 'contract reply' });
    return {
      messages: [{ role: 'assistant', text: 'contract reply' }],
      text: 'contract reply',
      steps: 1,
      compacted: false,
      usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  });
  const kernel: AgentKernel = { name: 'pi', run: kernelRun };
  const agentRuntime = createConfiguredAgentRuntime({}, {
    kernels: { pi: kernel }, bindingStore: store, runStore: store,
  });
  const runtime = {
    agentRuntime,
    model: { id: 'contract-model', async *stream() { yield { type: 'text_delta' as const, text: 'unused' }; } },
    modelConfig: { id: 'contract-model', protocol: 'anthropic', baseURL: '', apiKey: '', model: 'contract-model' },
    tools: new ToolRegistry(), store,
    policy: new AllowAllPolicy(), policyPreApproved: new AllowAllPolicy(),
    permissionRules: { filterToolDefs: <T>(defs: T) => defs },
    authProvider, jwtSecret: 'runtime-contract-secret', systemExtra: '',
    audit: { record: async () => undefined },
    defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' },
  } as unknown as Runtime;
  server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('runtime HTTP compatibility contracts', () => {
  it('creates a durable Run and preserves public SSE event names and fields', async () => {
    const response = await fetch(`${baseUrl}/v1/agent`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ task: 'freeze the contract', sessionId: 'contract-session' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events = parseSse(await response.text());
    const session = events.find((event) => event.name === 'session');
    expect(session).toMatchObject({
      name: 'session',
      data: { sessionId: 'contract-session', runId: expect.any(String) },
    });
    expect(events.find((event) => event.name === 'text_delta')).toMatchObject({
      data: { type: 'text_delta', text: 'contract reply' },
    });
    expect(events.find((event) => event.name === 'done')).toMatchObject({
      data: { sessionId: 'contract-session', steps: 1, text: 'contract reply' },
    });

    const runId = String(session!.data.runId);
    const list = await fetch(`${baseUrl}/v1/agent/runs?sessionId=contract-session`, { headers: authHeaders() });
    expect(list.status).toBe(200);
    expect((await list.json() as { runs: unknown[] }).runs).toContainEqual(expect.objectContaining({
      runId, sessionId: 'contract-session', status: 'succeeded', kernel: 'pi', kernelVersion: '0.82.1',
    }));
  });

  it('preserves the Session Message DTO role and content fields', async () => {
    await store.appendMessage(
      { tenantId: 'default', userId, role: 'user' },
      'contract-session',
      { role: 'user', text: 'freeze the contract' },
    );
    await store.appendMessage(
      { tenantId: 'default', userId, role: 'user' },
      'contract-session',
      { role: 'tool', toolResults: [{ id: 'tool-message', content: 'ok' }] },
    );
    const response = await fetch(`${baseUrl}/v1/sessions/contract-session/messages`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = await response.json() as { messages: Array<Record<string, unknown>> };
    for (const message of body.messages) {
      expect(message).toMatchObject({ role: expect.stringMatching(/^(user|assistant|tool)$/) });
    }
    expect(body.messages).toContainEqual(expect.objectContaining({ role: 'user', text: 'freeze the contract' }));
    expect(body.messages).toContainEqual(expect.objectContaining({ role: 'assistant', text: 'contract reply' }));
    expect(body.messages).toContainEqual(expect.objectContaining({
      role: 'tool', toolResults: [expect.objectContaining({ id: 'tool-message', content: 'ok' })],
    }));
  });

  it('preserves cancel and resume response structures', async () => {
    const createdAt = new Date('2026-07-28T00:00:00.000Z');
    await store.putAgentRunBindingIfAbsent({
      tenantId: 'default', userId, sessionId: 'cancel-session', runId: 'run-cancel-contract',
      kernel: 'pi', kernelVersion: '0.82.1', graphName: '', graphVersion: '', createdAt,
    });
    const cancelled = await fetch(`${baseUrl}/v1/agent/runs/run-cancel-contract/cancel`, {
      method: 'POST', headers: authHeaders(), body: '{}',
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ ok: true, abortedLocal: expect.any(Number) });
    expect(await store.isAgentRunCancellationRequested('default', 'run-cancel-contract')).toBe(true);

    await store.putAgentRunBindingIfAbsent({
      tenantId: 'default', userId, sessionId: 'resume-session', runId: 'run-resume-contract',
      kernel: 'pi', kernelVersion: '0.82.1', graphName: '', graphVersion: '', createdAt,
    });
    await store.updateAgentRun('default', 'run-resume-contract', { status: 'failed', completedAt: createdAt });
    const resumed = await fetch(`${baseUrl}/v1/agent/runs/run-resume-contract/resume`, {
      method: 'POST', headers: authHeaders(), body: '{}',
    });
    expect(resumed.status).toBe(202);
    expect(await resumed.json()).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(kernelRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-resume-contract', resumeFromCheckpoint: true,
      ctx: expect.objectContaining({ sessionId: 'resume-session' }),
    })));
  });

  it('preserves Run event, Interaction and Tool Ledger query fields', async () => {
    const createdAt = new Date('2026-07-28T01:00:00.000Z');
    await store.putAgentRunBindingIfAbsent({
      tenantId: 'default', userId, sessionId: 'detail-session', runId: 'run-detail-contract',
      kernel: 'pi', kernelVersion: '0.82.1', graphName: '', graphVersion: '', createdAt,
    });
    await store.updateAgentRun('default', 'run-detail-contract', { status: 'failed', completedAt: createdAt });
    await store.appendAgentRunEvent({
      tenantId: 'default', runId: 'run-detail-contract', type: 'node', node: 'model', status: 'failed', createdAt,
    });
    await store.putInteraction({
      id: 'interaction-contract', tenantId: 'default', userId, sessionId: 'detail-session',
      runId: 'run-detail-contract', kind: 'approval', toolCallId: 'tool-contract', payload: {},
      status: 'resolved', resolution: true, expiresAt: new Date('2026-07-29T01:00:00.000Z'), createdAt,
    });
    await store.putToolExecutionIfAbsent({
      tenantId: 'default', runId: 'run-detail-contract', sessionId: 'detail-session',
      toolCallId: 'tool-contract', toolName: 'kubectl', argsDigest: 'digest', status: 'completed',
      result: { id: 'tool-contract', content: 'private output' }, startedAt: createdAt,
      completedAt: createdAt, updatedAt: createdAt,
    });

    const detailResponse = await fetch(`${baseUrl}/v1/agent/runs/run-detail-contract`, { headers: authHeaders() });
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      run: { runId: 'run-detail-contract', sessionId: 'detail-session', status: 'failed', kernel: 'pi' },
      events: [{ type: 'node', runId: 'run-detail-contract', node: 'model', status: 'failed' }],
      interactions: [{ id: 'interaction-contract', kind: 'approval', status: 'resolved', toolCallId: 'tool-contract' }],
      tools: [{ toolCallId: 'tool-contract', toolName: 'kubectl', status: 'completed' }],
      canCancel: false, canResume: true,
    });

    const eventResponse = await fetch(`${baseUrl}/v1/agent/runs/run-detail-contract/events`, { headers: authHeaders() });
    expect(eventResponse.status).toBe(200);
    const event = parseSse(await eventResponse.text())[0];
    expect(event).toMatchObject({
      name: 'node',
      data: { type: 'node', runId: 'run-detail-contract', node: 'model', status: 'failed' },
    });
  });
});
