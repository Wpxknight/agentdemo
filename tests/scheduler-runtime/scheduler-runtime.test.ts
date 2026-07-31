import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type BoundRunRecovery,
  MemorySchedulerStore,
  MysqlSchedulerStore,
  SchedulerRunner,
  createRunDispatcher,
  type SchedulerMysqlDatabase,
  type ScheduledTask,
} from '../../packages/scheduler-runtime/src/index.js';
import type { DurableRunRuntime, StartRunInput } from '@aiop/control-contracts';
import {
  DurableRunManager,
  MemoryRunStore,
  type ManagedPiSession,
} from '../../packages/pi-runtime/src/index.js';
import type { Kysely } from 'kysely';
import { readMysqlConfig } from '../../src/config/mysql.js';
import { createKysely, createMysqlPool, runMigrations } from '../../src/db/index.js';

const fireTime = new Date('2026-07-29T01:00:00.000Z');
const succeeded = (runId: string) => ({
  runId,
  result: {
    runId, status: 'succeeded' as const,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  },
});
const dispatchSucceeded = async (
  runId: string,
  onStarted?: (runId: string) => Promise<void>,
) => {
  await onStarted?.(runId);
  return succeeded(runId);
};
const succeededHandle = (runId: string) => ({
  runId, status: 'running' as const, events: { async *[Symbol.asyncIterator]() {} },
  result: async () => succeeded(runId).result,
});
const task: ScheduledTask = {
  taskId: 'task-a',
  tenantId: 'tenant-a',
  actorId: 'user-a',
  roles: ['user'],
  sessionId: 'session-a',
  cron: '0 * * * *',
  input: [{ role: 'user', text: 'diagnose' }],
  nextFireAt: fireTime,
};
const taskIdentity = () => ({ tenantId: task.tenantId, actorId: task.actorId, roles: ['user'] as const });

const activeBoundRecovery: BoundRunRecovery = {
  inspect: async () => ({ kind: 'active' }),
  resume: async () => { throw new Error('bound recovery must not run'); },
};

function managedSession(
  id: string,
  continueRun: ManagedPiSession['continue'],
): ManagedPiSession {
  return {
    continue: continueRun,
    async replayInteraction() {},
    async abort() {},
    async close() {},
    async steer() {},
    async followUp() {},
    async appendCustomEntry() { return 'custom'; },
    async entries() { return []; },
    async leafId() { return null; },
    async metadata() { return { id, tenantId: 'tenant-a', createdAt: fireTime.toISOString() }; },
  };
}

describe('SchedulerRunner', () => {
  it('binds the durable Run before waiting for its final result', async () => {
    const base = new MemorySchedulerStore([task]);
    const realBindRun = base.bindRun.bind(base);
    const bindRun = vi.fn((input: Parameters<typeof base.bindRun>[0]) => realBindRun(input));
    const completeFire = vi.spyOn(base, 'completeFire');
    const store = new Proxy(base, {
      get(target, property) {
        if (property === 'bindRun') return bindRun;
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let resolveResult!: (value: import('@aiop/control-contracts').AgentRunResult) => void;
    const result = new Promise<import('@aiop/control-contracts').AgentRunResult>((resolve) => { resolveResult = resolve; });
    const dispatcher = createRunDispatcher({
      run: async () => ({
        runId: 'run-bound', status: 'running', events: { async *[Symbol.asyncIterator]() {} }, result: () => result,
      }),
    } as unknown as DurableRunRuntime);
    const tick = new SchedulerRunner({
      store: store as never, dispatcher, boundRecovery: activeBoundRecovery, workerId: 'worker-a',
    }).tick(fireTime, 1);
    await vi.waitFor(() => expect(bindRun).toHaveBeenCalledWith(expect.objectContaining({
      fireId: 'task-a:2026-07-29T01:00:00.000Z', runId: 'run-bound',
    })));
    expect(completeFire).not.toHaveBeenCalled();
    resolveResult({
      runId: 'run-bound', status: 'succeeded',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    await tick;
    expect(completeFire).toHaveBeenCalledOnce();
    expect((await base.listFires())[0]).toMatchObject({
      state: 'started', runId: 'run-bound', result: { runId: 'run-bound', status: 'succeeded' },
    });
  });

  it('dispatches a due fire once when two workers scan concurrently', async () => {
    const store = new MemorySchedulerStore([task]);
    const startScheduledRun = vi.fn(async (_input, onStarted) => dispatchSucceeded('run-a', onStarted));
    const options = { store, dispatcher: { startScheduledRun }, boundRecovery: activeBoundRecovery, leaseMs: 1_000 };

    const [left, right] = await Promise.all([
      new SchedulerRunner({ ...options, workerId: 'worker-a' }).tick(fireTime, 10),
      new SchedulerRunner({ ...options, workerId: 'worker-b' }).tick(fireTime, 10),
    ]);

    expect(left + right).toBe(1);
    expect(startScheduledRun).toHaveBeenCalledOnce();
    expect(startScheduledRun).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-a',
      fireId: 'task-a:2026-07-29T01:00:00.000Z',
      fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a',
      input: [{ role: 'user', text: 'diagnose' }],
      execution: { unattended: true, preApproved: false },
    }), expect.any(Function));
  });

  it('does not dispatch the same fire time twice', async () => {
    const store = new MemorySchedulerStore([task]);
    const startScheduledRun = vi.fn(async (_input, onStarted) => dispatchSucceeded('run-a', onStarted));
    const runner = new SchedulerRunner({
      store, dispatcher: { startScheduledRun }, boundRecovery: activeBoundRecovery, workerId: 'worker-a',
    });

    expect(await runner.tick(fireTime, 10)).toBe(1);
    expect(await runner.tick(fireTime, 10)).toBe(0);
    expect(startScheduledRun).toHaveBeenCalledOnce();
  });

  it('releases a fire for retry when product Run creation fails', async () => {
    const store = new MemorySchedulerStore([task]);
    const startScheduledRun = vi.fn()
      .mockRejectedValueOnce(new Error('run store unavailable'))
      .mockImplementationOnce(async (_input, onStarted) => dispatchSucceeded('run-b', onStarted));
    const runner = new SchedulerRunner({
      store,
      dispatcher: { startScheduledRun },
      boundRecovery: activeBoundRecovery,
      workerId: 'worker-a',
      retryDelayMs: 1_000,
    });

    expect(await runner.tick(fireTime, 10)).toBe(1);
    expect(await runner.tick(new Date(fireTime.getTime() + 999), 10)).toBe(0);
    expect(await runner.tick(new Date(fireTime.getTime() + 1_000), 10)).toBe(1);
    expect(startScheduledRun).toHaveBeenCalledTimes(2);
    expect((await store.listFires())[0]).toMatchObject({ state: 'started', runId: 'run-b', attempts: 2 });
  });

  it('defers a bound fire after its Run result rejects and continues later fires', async () => {
    const base = new MemorySchedulerStore([task, { ...task, taskId: 'task-b' }]);
    const releaseFire = vi.spyOn(base, 'releaseFire');
    const deferBound = vi.spyOn(base, 'deferBound');
    const resultError = new Error('Durable Run result unavailable');
    const dispatcher = createRunDispatcher({
      run: async (input: StartRunInput) => ({
        runId: input.runId!, status: 'running', events: { async *[Symbol.asyncIterator]() {} },
        result: async () => {
          if (input.runId!.startsWith('task-a:')) throw resultError;
          return succeeded(input.runId!).result;
        },
      }),
    } as unknown as DurableRunRuntime);
    const runner = new SchedulerRunner({
      store: base, dispatcher, boundRecovery: activeBoundRecovery,
      workerId: 'worker-a', retryDelayMs: 100,
    });

    await expect(runner.tick(fireTime, 2)).resolves.toBe(2);
    expect(releaseFire).not.toHaveBeenCalled();
    expect(deferBound).toHaveBeenCalledWith(expect.objectContaining({
      fireId: 'task-a:2026-07-29T01:00:00.000Z',
      retryAt: new Date(fireTime.getTime() + 100),
      error: String(resultError),
    }));
    expect((await base.listFires()).find((fire) => fire.fireId.startsWith('task-a:'))).toMatchObject({
      state: 'bound', retryAt: new Date(fireTime.getTime() + 100), lastError: String(resultError),
    });
    expect((await base.listFires()).find((fire) => fire.fireId.startsWith('task-b:'))).toMatchObject({
      state: 'started', attempts: 1,
    });
  });

  it('defers a bound fire after completion temporarily fails and continues later fires', async () => {
    const base = new MemorySchedulerStore([task, { ...task, taskId: 'task-b' }]);
    const completeFire = vi.spyOn(base, 'completeFire').mockRejectedValueOnce(new Error('temporary completion failure'));
    const releaseFire = vi.spyOn(base, 'releaseFire');
    const deferBound = vi.spyOn(base, 'deferBound');
    const runner = new SchedulerRunner({
      store: base,
      dispatcher: { startScheduledRun: async (input, onStarted) => dispatchSucceeded(input.fireId, onStarted) },
      boundRecovery: activeBoundRecovery,
      workerId: 'worker-a', retryDelayMs: 100,
    });

    await expect(runner.tick(fireTime, 2)).resolves.toBe(2);
    expect(completeFire).toHaveBeenCalledTimes(2);
    expect(releaseFire).not.toHaveBeenCalled();
    expect(deferBound).toHaveBeenCalledWith(expect.objectContaining({
      fireId: 'task-a:2026-07-29T01:00:00.000Z',
      retryAt: new Date(fireTime.getTime() + 100),
      error: 'Error: temporary completion failure',
    }));
    expect((await base.listFires()).find((fire) => fire.fireId.startsWith('task-a:'))).toMatchObject({
      state: 'bound', retryAt: new Date(fireTime.getTime() + 100),
      lastError: 'Error: temporary completion failure',
    });
    expect((await base.listFires()).find((fire) => fire.fireId.startsWith('task-b:'))).toMatchObject({
      state: 'started', attempts: 1,
    });
  });

  it('recovers an expired worker claim and compensates by creating the Run once', async () => {
    const store = new MemorySchedulerStore([task]);
    const [abandoned] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'dead-worker', leaseMs: 1_000 });
    expect(abandoned?.state).toBe('claimed');

    const recoveredAt = new Date(fireTime.getTime() + 1_001);
    const startScheduledRun = vi.fn(async (_input, onStarted) => dispatchSucceeded('run-recovered', onStarted));
    const runner = new SchedulerRunner({
      store, dispatcher: { startScheduledRun }, boundRecovery: activeBoundRecovery, workerId: 'worker-b',
    });
    expect(await runner.tick(recoveredAt, 10)).toBe(1);
    expect(startScheduledRun).toHaveBeenCalledOnce();
    expect((await store.listFires())[0]).toMatchObject({ state: 'started', runId: 'run-recovered', attempts: 2 });
  });

  it('does not re-dispatch a durable Run bound before the worker crashed', async () => {
    const store = new MemorySchedulerStore([task]);
    const [abandoned] = await store.claimDue({
      now: fireTime, limit: 1, workerId: 'dead-worker', leaseMs: 1_000,
    });
    const runId = abandoned!.fireId;
    await store.bindRun({
      fireId: abandoned!.fireId,
      claimToken: abandoned!.claimToken,
      runId,
      boundAt: fireTime,
    });
    expect((await store.listFires())[0]).toMatchObject({
      state: 'bound', runId, attempts: 1,
    });

    const run = vi.fn(async () => { throw new Error('Run creation result unknown'); });
    const findScheduledRun = vi.fn(async () => succeeded(runId));
    const runner = new SchedulerRunner({
      store,
      dispatcher: createRunDispatcher(
        { run } as unknown as DurableRunRuntime,
        { findScheduledRun },
      ),
      boundRecovery: activeBoundRecovery,
      workerId: 'recovery-worker',
      leaseMs: 1_000,
    });

    expect(await runner.tick(new Date(fireTime.getTime() + 1_001), 1)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(findScheduledRun).not.toHaveBeenCalled();
    expect((await store.listFires())[0]).toMatchObject({
      state: 'bound', runId, attempts: 1,
    });
  });

  it('keeps a bound Durable Run active after only the scheduler observation lease expires', async () => {
    let current = fireTime;
    const durableStore = new MemoryRunStore(() => current);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const session = managedSession('session-a', async function* () { await blocked; });
    const durable = new DurableRunManager({
      store: durableStore, workerId: 'durable-a', leaseTtlMs: 10_000, heartbeatMs: 0, now: () => current,
      sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const run = vi.spyOn(durable, 'run');
    const resume = vi.spyOn(durable, 'resume');
    const schedulerStore = new MemorySchedulerStore([task]);
    const boundRecovery: BoundRunRecovery = {
      inspect: async (fire, now) => {
        const record = await durableStore.get({ tenantId: fire.identity.tenantId, runId: fire.runId });
        return record?.leaseExpiresAt && record.leaseExpiresAt > now ? { kind: 'active' } : { kind: 'recoverable' };
      },
      resume: async () => { throw new Error('active Durable Run must not resume'); },
    };
    const abort = new AbortController();
    const firstTick = new SchedulerRunner({
      store: schedulerStore, dispatcher: createRunDispatcher(durable), boundRecovery,
      workerId: 'scheduler-a', leaseMs: 1_000,
    }).tick(current, 1, abort.signal);
    await vi.waitFor(async () => expect((await schedulerStore.listFires())[0]).toMatchObject({
      state: 'bound', runId: task.taskId + ':' + fireTime.toISOString(), attempts: 1,
    }));
    await vi.waitFor(async () => expect((await durableStore.get({
      tenantId: task.tenantId, runId: task.taskId + ':' + fireTime.toISOString(),
    }))?.status).toBe('running'));

    current = new Date(fireTime.getTime() + 1_001);
    const secondTick = await new SchedulerRunner({
      store: schedulerStore, dispatcher: createRunDispatcher(durable), boundRecovery,
      workerId: 'scheduler-b', leaseMs: 1_000,
    }).tick(current, 1);

    expect(secondTick).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    expect((await schedulerStore.listFires())[0]).toMatchObject({ state: 'bound', attempts: 1 });
    abort.abort(new Error('test cleanup'));
    unblock();
    await firstTick.catch(() => undefined);
  });

  it('resumes an expired Durable Run with the same deterministic Run ID and committed session', async () => {
    let current = fireTime;
    const durableStore = new MemoryRunStore(() => current);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const firstSession = managedSession('session-a', async function* () { await blocked; });
    const firstManager = new DurableRunManager({
      store: durableStore, workerId: 'durable-a', leaseTtlMs: 1_000, heartbeatMs: 0, now: () => current,
      sessions: { create: async () => firstSession, load: async () => firstSession }, eventOptions: () => ({}),
    });
    const secondSession = managedSession('session-a', async function* () {});
    const load = vi.fn(async () => secondSession);
    const secondManager = new DurableRunManager({
      store: durableStore, workerId: 'durable-b', leaseTtlMs: 1_000, heartbeatMs: 0, now: () => current,
      sessions: { create: async () => { throw new Error('recovery must not create a session'); }, load },
      eventOptions: () => ({}),
    });
    const firstRun = vi.spyOn(firstManager, 'run');
    const secondRun = vi.spyOn(secondManager, 'run');
    const secondResume = vi.spyOn(secondManager, 'resume');
    const schedulerStore = new MemorySchedulerStore([task]);
    const runId = task.taskId + ':' + fireTime.toISOString();
    const boundRecovery: BoundRunRecovery = {
      inspect: async (fire, now) => {
        const record = await durableStore.get({ tenantId: fire.identity.tenantId, runId: fire.runId });
        if (record?.result) return { kind: 'terminal', result: record.result };
        return record?.leaseExpiresAt && record.leaseExpiresAt > now ? { kind: 'active' } : { kind: 'recoverable' };
      },
      resume: async (fire, signal) => {
        const handle = await secondManager.resume({ identity: fire.identity, runId: fire.runId, signal });
        return handle.result();
      },
    };
    const abort = new AbortController();
    const firstTick = new SchedulerRunner({
      store: schedulerStore, dispatcher: createRunDispatcher(firstManager), boundRecovery,
      workerId: 'scheduler-a', leaseMs: 1_000,
    }).tick(current, 1, abort.signal);
    await vi.waitFor(async () => expect((await durableStore.get({ tenantId: task.tenantId, runId }))?.status).toBe('running'));
    await vi.waitFor(async () => expect((await schedulerStore.listFires())[0]).toMatchObject({ state: 'bound', runId }));

    current = new Date(fireTime.getTime() + 1_001);
    expect(await new SchedulerRunner({
      store: schedulerStore, dispatcher: createRunDispatcher(secondManager), boundRecovery,
      workerId: 'scheduler-b', leaseMs: 1_000,
    }).tick(current, 1)).toBe(1);

    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).not.toHaveBeenCalled();
    expect(secondResume).toHaveBeenCalledWith({
      identity: taskIdentity(), runId, signal: undefined,
    });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ tenantId: task.tenantId }), identity: taskIdentity(),
    }));
    expect(await durableStore.countAttempts({ tenantId: task.tenantId, runId })).toBe(2);
    expect((await schedulerStore.listFires())[0]).toMatchObject({
      state: 'started', runId, attempts: 1, result: { runId, status: 'succeeded' },
    });
    abort.abort(new Error('test cleanup'));
    unblock();
    await firstTick.catch(() => undefined);
  });

  it.each(['succeeded', 'failed', 'cancelled', 'recovery_required', 'waiting'] as const)(
    'completes a terminal bound Durable %s fire without dispatch or resume',
    async (status) => {
      const store = new MemorySchedulerStore([task]);
      const [fire] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'dead', leaseMs: 10 });
      await store.bindRun({ fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime });
      const startScheduledRun = vi.fn();
      const resume = vi.fn();
      const result = { ...succeeded(fire!.fireId).result, status };
      const runner = new SchedulerRunner({
        store, dispatcher: { startScheduledRun }, workerId: 'recovery', leaseMs: 10,
        boundRecovery: { inspect: async () => ({ kind: 'terminal', result }), resume },
      });

      expect(await runner.tick(new Date(fireTime.getTime() + 10), 1)).toBe(1);
      expect(startScheduledRun).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect((await store.listFires())[0]).toMatchObject({ state: 'started', attempts: 1, result: { status } });
    },
  );

  it('releases a bound resume race into a future observation window without a busy loop', async () => {
    const store = new MemorySchedulerStore([task]);
    const [fire] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'dead', leaseMs: 10 });
    await store.bindRun({ fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime });
    const startScheduledRun = vi.fn();
    const resume = vi.fn(async () => { throw new Error('Durable lease race'); });
    const inspect = vi.fn(async () => ({ kind: 'recoverable' as const }));
    const runner = new SchedulerRunner({
      store, dispatcher: { startScheduledRun }, boundRecovery: { inspect, resume },
      workerId: 'recovery', leaseMs: 10, retryDelayMs: 100,
    });
    const expiredAt = new Date(fireTime.getTime() + 10);

    expect(await runner.tick(expiredAt, 1)).toBe(1);
    expect(await runner.tick(new Date(expiredAt.getTime() + 99), 1)).toBe(0);
    expect(resume).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledOnce();
    expect(startScheduledRun).not.toHaveBeenCalled();
    expect((await store.listFires())[0]).toMatchObject({
      state: 'bound', runId: fire!.fireId, attempts: 1,
      retryAt: new Date(expiredAt.getTime() + 100), lastError: 'Error: Durable lease race',
    });
  });

  it('uses the bind-time observation lease before inspecting a queued startup gap', async () => {
    const store = new MemorySchedulerStore([task]);
    const [fire] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'dead', leaseMs: 777 });
    await store.bindRun({ fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime });
    const inspect = vi.fn(async () => ({ kind: 'active' as const }));
    const runner = new SchedulerRunner({
      store, dispatcher: { startScheduledRun: vi.fn() }, boundRecovery: { inspect, resume: vi.fn() },
      workerId: 'observer', leaseMs: 777,
    });

    expect(await runner.tick(new Date(fireTime.getTime() + 776), 1)).toBe(0);
    expect(inspect).not.toHaveBeenCalled();
    expect(await runner.tick(new Date(fireTime.getTime() + 777), 1)).toBe(0);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it('defers a poison bound inspection while continuing later bound and ordinary fires', async () => {
    const store = new MemorySchedulerStore([
      task,
      { ...task, taskId: 'task-b' },
      { ...task, taskId: 'task-c' },
    ]);
    const claimed = await store.claimDue({ now: fireTime, limit: 2, workerId: 'dead', leaseMs: 10 });
    for (const fire of claimed) {
      await store.bindRun({ fireId: fire.fireId, claimToken: fire.claimToken, runId: fire.fireId, boundAt: fireTime });
    }
    const inspect = vi.fn(async (fire: (typeof claimed)[number]) => {
      if (fire.fireId.startsWith('task-a:')) throw new Error('corrupt Durable binding');
      return { kind: 'terminal' as const, result: succeeded(fire.runId!).result };
    });
    const startScheduledRun = vi.fn(async (input, onStarted) => dispatchSucceeded(input.fireId, onStarted));
    const runner = new SchedulerRunner({
      store, dispatcher: { startScheduledRun }, boundRecovery: { inspect: inspect as never, resume: vi.fn() },
      workerId: 'recovery', leaseMs: 10, retryDelayMs: 100,
    });
    const observedAt = new Date(fireTime.getTime() + 10);

    await expect(runner.tick(observedAt, 3)).resolves.toBe(3);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(startScheduledRun).toHaveBeenCalledOnce();
    expect((await store.listFires()).find((fire) => fire.fireId.startsWith('task-a:'))).toMatchObject({
      state: 'bound', attempts: 1, retryAt: new Date(observedAt.getTime() + 100),
      lastError: 'Error: corrupt Durable binding',
    });
    expect((await store.listFires()).filter((fire) => fire.state === 'started')).toHaveLength(2);

    expect(await runner.tick(new Date(observedAt.getTime() + 99), 3)).toBe(0);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('defers a recovered Run when completion fails with the recovery fence still current', async () => {
    const base = new MemorySchedulerStore([task]);
    const [fire] = await base.claimDue({ now: fireTime, limit: 1, workerId: 'dead', leaseMs: 10 });
    await base.bindRun({ fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime });
    const completeFire = vi.spyOn(base, 'completeFire').mockRejectedValueOnce(new Error('stale scheduler claim'));
    const releaseBound = vi.spyOn(base, 'releaseBound');
    const inspect = vi.fn(async () => ({ kind: 'recoverable' as const }));
    const resume = vi.fn(async () => succeeded(fire!.fireId).result);
    const runner = new SchedulerRunner({
      store: base,
      dispatcher: { startScheduledRun: vi.fn() },
      boundRecovery: { inspect, resume },
      workerId: 'recovery', leaseMs: 10,
    });

    await expect(runner.tick(new Date(fireTime.getTime() + 10), 1)).resolves.toBe(1);
    expect(completeFire).toHaveBeenCalledOnce();
    expect(releaseBound).toHaveBeenCalledWith(expect.objectContaining({
      fireId: fire!.fireId,
      retryAt: new Date(fireTime.getTime() + 30_010),
      error: 'Error: stale scheduler claim',
    }));
    expect((await base.listFires())[0]).toMatchObject({
      state: 'bound',
      attempts: 1,
      retryAt: new Date(fireTime.getTime() + 30_010),
      lastError: 'Error: stale scheduler claim',
    });
    expect(await runner.tick(new Date(fireTime.getTime() + 30_009), 1)).toBe(0);
    expect(inspect).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('isolates a stale completion release fence and continues later ordinary work', async () => {
    const base = new MemorySchedulerStore([task, { ...task, taskId: 'task-b' }]);
    const [fire] = await base.claimDue({ now: fireTime, limit: 1, workerId: 'dead', leaseMs: 10 });
    await base.bindRun({ fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime });
    vi.spyOn(base, 'completeFire').mockRejectedValueOnce(new Error('transient completion failure'));
    vi.spyOn(base, 'releaseBound').mockRejectedValueOnce(new Error('stale scheduler claim'));
    const startScheduledRun = vi.fn(async (input, onStarted) => dispatchSucceeded(input.fireId, onStarted));
    const runner = new SchedulerRunner({
      store: base,
      dispatcher: { startScheduledRun },
      boundRecovery: {
        inspect: async () => ({ kind: 'recoverable' }),
        resume: async () => succeeded(fire!.fireId).result,
      },
      workerId: 'recovery', leaseMs: 10,
    });

    await expect(runner.tick(new Date(fireTime.getTime() + 10), 2)).resolves.toBe(2);
    expect(startScheduledRun).toHaveBeenCalledOnce();
    expect((await base.listFires()).find((candidate) => candidate.fireId === fire!.fireId))
      .toMatchObject({ state: 'recovering', attempts: 1 });
    expect((await base.listFires()).find((candidate) => candidate.fireId.startsWith('task-b:')))
      .toMatchObject({ state: 'started', attempts: 1 });
  });

  it('keeps a resume failure primary when releasing the recovery fence is stale', async () => {
    const base = new MemorySchedulerStore([task]);
    const [fire] = await base.claimDue({ now: fireTime, limit: 1, workerId: 'dead', leaseMs: 10 });
    await base.bindRun({ fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime });
    vi.spyOn(base, 'releaseBound').mockRejectedValueOnce(new Error('stale scheduler claim'));
    const runner = new SchedulerRunner({
      store: base,
      dispatcher: { startScheduledRun: vi.fn() },
      boundRecovery: {
        inspect: async () => ({ kind: 'recoverable' }),
        resume: async () => { throw new Error('Durable resume failed'); },
      },
      workerId: 'recovery', leaseMs: 10,
    });

    await expect(runner.tick(new Date(fireTime.getTime() + 10), 1)).resolves.toBe(1);
  });

  it('fences a bound Run from ordinary claim recovery and allows token-fenced recovery', async () => {
    const store = new MemorySchedulerStore([task]);
    const [fire] = await store.claimDue({
      now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1_000,
    });
    const originalToken = fire!.claimToken;
    await store.bindRun({
      fireId: fire!.fireId, claimToken: originalToken, runId: fire!.fireId, boundAt: fireTime,
    });

    const afterSchedulerLease = new Date(fireTime.getTime() + 1_001);
    expect((await store.listFires())[0]).toMatchObject({
      state: 'bound', runId: fire!.fireId, claimToken: originalToken, claimedBy: undefined,
    });
    expect(await store.recoverExpired(afterSchedulerLease)).toBe(0);
    expect(await store.claimDue({ now: afterSchedulerLease, limit: 1, workerId: 'worker-b', leaseMs: 1_000 })).toEqual([]);

    expect(await store.claimBound({
      fireId: fire!.fireId, expectedClaimToken: 'stale-token',
      now: afterSchedulerLease, workerId: 'worker-b', leaseMs: 1_000,
    })).toBeUndefined();
    expect((await store.listFires())[0]).toMatchObject({
      state: 'bound', claimToken: originalToken, claimedBy: undefined, attempts: 1,
    });

    const recovering = await store.claimBound({
      fireId: fire!.fireId, expectedClaimToken: originalToken,
      now: afterSchedulerLease, workerId: 'worker-b', leaseMs: 1_000,
    });
    expect(recovering).toMatchObject({ state: 'recovering', runId: fire!.fireId, claimedBy: 'worker-b' });
    expect(recovering?.claimToken).not.toBe(originalToken);
  });

  it('requires an expired observation lease and due retry window when claiming a bound Run', async () => {
    const store = new MemorySchedulerStore([task]);
    const [fire] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1_000 });
    await store.bindRun({
      fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime,
    });

    expect(await store.claimBound({
      fireId: fire!.fireId, expectedClaimToken: fire!.claimToken,
      now: new Date(fireTime.getTime() + 999), workerId: 'worker-b', leaseMs: 1_000,
    })).toBeUndefined();
    expect((await store.listFires())[0]).toMatchObject({
      state: 'bound', claimToken: fire!.claimToken, attempts: 1,
    });

    const recovering = await store.claimBound({
      fireId: fire!.fireId, expectedClaimToken: fire!.claimToken,
      now: new Date(fireTime.getTime() + 1_001), workerId: 'worker-b', leaseMs: 1_000,
    });
    const retryAt = new Date(fireTime.getTime() + 5_000);
    await store.releaseBound({
      fireId: fire!.fireId, claimToken: recovering!.claimToken, retryAt, error: 'retry later',
    });

    expect(await store.claimBound({
      fireId: fire!.fireId, expectedClaimToken: recovering!.claimToken,
      now: new Date(retryAt.getTime() - 1), workerId: 'worker-c', leaseMs: 1_000,
    })).toBeUndefined();
    expect((await store.listFires())[0]).toMatchObject({
      state: 'bound', claimToken: recovering!.claimToken, retryAt, attempts: 1,
    });
  });

  it('lists only eligible bound fires in order, honors limits, and returns copies', async () => {
    const later = new Date(fireTime.getTime() + 1_000);
    const store = new MemorySchedulerStore([task, { ...task, taskId: 'task-b', nextFireAt: later }]);
    const [first, second] = await store.claimDue({
      now: later, limit: 2, workerId: 'worker-a', leaseMs: 10,
    });
    await store.bindRun({ fireId: first!.fireId, claimToken: first!.claimToken, runId: first!.fireId, boundAt: later });
    await store.bindRun({ fireId: second!.fireId, claimToken: second!.claimToken, runId: second!.fireId, boundAt: later });

    expect(await store.listBound({ now: later, limit: 2 })).toEqual([]);
    const observedAt = new Date(later.getTime() + 10);
    const [listed] = await store.listBound({ now: observedAt, limit: 1 });
    expect(listed).toMatchObject({ fireId: first!.fireId, state: 'bound' });
    listed!.fireTime.setTime(0);
    expect((await store.listBound({ now: observedAt, limit: 2 })).map((fire) => fire.fireId))
      .toEqual([first!.fireId, second!.fireId]);
  });

  it('releases a recovering bound Run without changing its token or attempts', async () => {
    const store = new MemorySchedulerStore([task]);
    const [fire] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1_000 });
    await store.bindRun({
      fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime,
    });
    const recovering = await store.claimBound({
      fireId: fire!.fireId, expectedClaimToken: fire!.claimToken,
      now: new Date(fireTime.getTime() + 1_001), workerId: 'worker-b', leaseMs: 1_000,
    });
    const retryAt = new Date(fireTime.getTime() + 5_000);

    await store.releaseBound({
      fireId: fire!.fireId, claimToken: recovering!.claimToken, retryAt, error: 'result unavailable',
    });

    expect((await store.listFires())[0]).toMatchObject({
      state: 'bound', runId: fire!.fireId, claimToken: recovering!.claimToken,
      claimedBy: undefined, leaseExpiresAt: retryAt, retryAt, attempts: 1, lastError: 'result unavailable',
    });
  });

  it('rejects stale token and state when releasing a bound recovery', async () => {
    const store = new MemorySchedulerStore([task]);
    const [fire] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 10 });
    await store.bindRun({ fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime });
    const recovering = await store.claimBound({
      fireId: fire!.fireId, expectedClaimToken: fire!.claimToken,
      now: new Date(fireTime.getTime() + 10), workerId: 'worker-b', leaseMs: 10,
    });
    await expect(store.releaseBound({
      fireId: fire!.fireId, claimToken: 'stale-token', retryAt: fireTime, error: 'stale',
    })).rejects.toThrow(`stale scheduler claim: ${fire!.fireId}`);
    await store.releaseBound({
      fireId: fire!.fireId, claimToken: recovering!.claimToken, retryAt: fireTime, error: 'retry',
    });
    await expect(store.releaseBound({
      fireId: fire!.fireId, claimToken: recovering!.claimToken, retryAt: fireTime, error: 'stale state',
    })).rejects.toThrow(`stale scheduler claim: ${fire!.fireId}`);
  });

  it('defers only the exact bound observation token without increasing attempts', async () => {
    const store = new MemorySchedulerStore([task]);
    const [fire] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'dead', leaseMs: 10 });
    await store.bindRun({ fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime });
    const retryAt = new Date(fireTime.getTime() + 100);

    await expect(store.deferBound({
      fireId: fire!.fireId, claimToken: 'stale-token', retryAt, error: 'poison',
    })).rejects.toThrow(`stale scheduler claim: ${fire!.fireId}`);
    await store.deferBound({
      fireId: fire!.fireId, claimToken: fire!.claimToken, retryAt, error: 'poison',
    });

    expect((await store.listFires())[0]).toMatchObject({
      state: 'bound', claimToken: fire!.claimToken, attempts: 1,
      leaseExpiresAt: retryAt, retryAt, lastError: 'poison',
    });
  });

  it('returns an expired recovering Run to bound without changing its token or attempts', async () => {
    const store = new MemorySchedulerStore([task]);
    const [fire] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1_000 });
    await store.bindRun({
      fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime,
    });
    const recovering = await store.claimBound({
      fireId: fire!.fireId, expectedClaimToken: fire!.claimToken,
      now: new Date(fireTime.getTime() + 1_001), workerId: 'worker-b', leaseMs: 1_000,
    });
    const recoveryExpiredAt = new Date(fireTime.getTime() + 2_002);

    expect(await store.recoverExpired(recoveryExpiredAt)).toBe(1);
    expect((await store.listFires())[0]).toMatchObject({
      state: 'bound', claimToken: recovering!.claimToken, claimedBy: undefined,
      attempts: 1, retryAt: recoveryExpiredAt,
    });
  });

  it('rejects completion Run mismatches for bound and recovering fires', async () => {
    const boundStore = new MemorySchedulerStore([task]);
    const [boundFire] = await boundStore.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1_000 });
    await boundStore.bindRun({
      fireId: boundFire!.fireId, claimToken: boundFire!.claimToken, runId: boundFire!.fireId, boundAt: fireTime,
    });
    await expect(boundStore.completeFire({
      fireId: boundFire!.fireId, claimToken: boundFire!.claimToken,
      runId: 'different-run', result: succeeded('different-run').result, completedAt: fireTime,
    })).rejects.toThrow();
    expect((await boundStore.listFires())[0]).toMatchObject({
      state: 'bound', runId: boundFire!.fireId, claimToken: boundFire!.claimToken, attempts: 1,
    });

    const recoveringStore = new MemorySchedulerStore([task]);
    const [recoveringFire] = await recoveringStore.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1_000 });
    await recoveringStore.bindRun({
      fireId: recoveringFire!.fireId, claimToken: recoveringFire!.claimToken,
      runId: recoveringFire!.fireId, boundAt: fireTime,
    });
    const recovering = await recoveringStore.claimBound({
      fireId: recoveringFire!.fireId, expectedClaimToken: recoveringFire!.claimToken,
      now: new Date(fireTime.getTime() + 1_001), workerId: 'worker-b', leaseMs: 1_000,
    });
    await expect(recoveringStore.completeFire({
      fireId: recovering!.fireId, claimToken: recovering!.claimToken,
      runId: recovering!.runId, result: succeeded('different-result-run').result, completedAt: fireTime,
    })).rejects.toThrow();
    expect((await recoveringStore.listFires())[0]).toMatchObject({
      state: 'recovering', runId: recovering!.runId, claimToken: recovering!.claimToken, attempts: 1,
    });
  });

  it('completes bound and recovering fires and fences started replays by Run identity', async () => {
    const boundStore = new MemorySchedulerStore([task]);
    const [boundFire] = await boundStore.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1_000 });
    await boundStore.bindRun({
      fireId: boundFire!.fireId, claimToken: boundFire!.claimToken, runId: boundFire!.fireId, boundAt: fireTime,
    });
    const completion = {
      fireId: boundFire!.fireId, claimToken: boundFire!.claimToken, runId: boundFire!.fireId,
      result: succeeded(boundFire!.fireId).result, completedAt: fireTime,
    };
    await boundStore.completeFire(completion);
    await expect(boundStore.completeFire(completion)).resolves.toBeUndefined();
    await expect(boundStore.completeFire({
      ...completion, runId: 'different-run', result: succeeded('different-run').result,
    })).rejects.toThrow();
    await expect(boundStore.completeFire({
      ...completion, result: succeeded('different-result-run').result,
    })).rejects.toThrow();
    expect((await boundStore.listFires())[0]).toMatchObject({
      state: 'started', runId: boundFire!.fireId,
      result: { runId: boundFire!.fireId, status: 'succeeded' }, attempts: 1,
    });

    const recoveringStore = new MemorySchedulerStore([task]);
    const [recoveringFire] = await recoveringStore.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1_000 });
    await recoveringStore.bindRun({
      fireId: recoveringFire!.fireId, claimToken: recoveringFire!.claimToken,
      runId: recoveringFire!.fireId, boundAt: fireTime,
    });
    const recovering = await recoveringStore.claimBound({
      fireId: recoveringFire!.fireId, expectedClaimToken: recoveringFire!.claimToken,
      now: new Date(fireTime.getTime() + 1_001), workerId: 'worker-b', leaseMs: 1_000,
    });
    await recoveringStore.completeFire({
      fireId: recovering!.fireId, claimToken: recovering!.claimToken, runId: recovering!.runId,
      result: succeeded(recovering!.runId).result, completedAt: fireTime,
    });
    expect((await recoveringStore.listFires())[0]).toMatchObject({
      state: 'started', runId: recovering!.runId,
      result: { runId: recovering!.runId, status: 'succeeded' }, attempts: 1,
    });
  });

  it('keeps a long-running bound Run isolated after the ordinary scheduler lease', async () => {
    const store = new MemorySchedulerStore([task]);
    const [fire] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1 });
    await store.bindRun({
      fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime,
    });

    const longAfterLease = new Date(fireTime.getTime() + 60_000);
    expect(await store.recoverExpired(longAfterLease)).toBe(0);
    expect(await store.claimDue({ now: longAfterLease, limit: 1, workerId: 'worker-b', leaseMs: 1_000 })).toEqual([]);
    expect((await store.listFires())[0]).toMatchObject({ state: 'bound', attempts: 1 });
  });

  it('returns isolated copies of stored durable Run results', async () => {
    const store = new MemorySchedulerStore([task]);
    const runner = new SchedulerRunner({
      store,
      dispatcher: { startScheduledRun: async (_input, onStarted) => dispatchSucceeded('run-isolated', onStarted) },
      boundRecovery: activeBoundRecovery,
      workerId: 'worker-a',
    });
    await runner.tick(fireTime, 1);

    const [listed] = await store.listFires();
    listed!.result!.usage.inputTokens = 99;

    expect((await store.listFires())[0]!.result!.usage.inputTokens).toBe(0);
  });
});

describe('scheduler runtime boundaries', () => {
  it('waits for the durable Run result before returning its final status', async () => {
    let resolveResult!: (value: import('@aiop/control-contracts').AgentRunResult) => void;
    const finalResult = new Promise<import('@aiop/control-contracts').AgentRunResult>((resolve) => { resolveResult = resolve; });
    const run = vi.fn(async () => ({
      runId: 'fire-a', status: 'running' as const,
      events: { async *[Symbol.asyncIterator]() {} },
      result: () => finalResult,
    }));
    const dispatcher = createRunDispatcher({ run } as unknown as DurableRunRuntime);
    let settled = false;
    const dispatched = dispatcher.startScheduledRun({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    }).then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveResult({
      runId: 'fire-a', status: 'failed',
      usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      error: { code: 'MODEL_PROVIDER_ERROR', message: 'provider failed', retryable: false },
    });
    await expect(dispatched).resolves.toMatchObject({ runId: 'fire-a', result: { status: 'failed' } });
  });

  it('adapts DurableRunRuntime.run into product Run dispatch', async () => {
    const run = vi.fn(async (_input: StartRunInput) => succeededHandle('run-a'));
    const dispatcher = createRunDispatcher({ run } as unknown as DurableRunRuntime);

    expect(await dispatcher.startScheduledRun({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    })).toEqual(succeeded('run-a'));
    expect(run).toHaveBeenCalledWith({
      runId: 'fire-a',
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a',
      input: [{ role: 'user', text: 'diagnose' }],
    });
  });

  it('preserves unattended policy selection, deadline, and cancellation when dispatching a scheduled Run', async () => {
    const run = vi.fn(async (_input: StartRunInput) => succeededHandle('run-a'));
    const dispatcher = createRunDispatcher({ run } as unknown as DurableRunRuntime);
    const abort = new AbortController();
    const deadlineAt = new Date('2026-07-29T01:05:00.000Z');

    await dispatcher.startScheduledRun({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
      execution: { unattended: true, preApproved: true },
      limits: { deadlineAt },
      signal: abort.signal,
    } as never);

    expect(run).toHaveBeenCalledWith({
      runId: 'fire-a',
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a',
      input: [{ role: 'user', text: 'diagnose' }],
      execution: { unattended: true, preApproved: true },
      limits: { deadlineAt },
      signal: abort.signal,
    });
    abort.abort(new Error('scheduler stopped'));
    expect((run.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  it('treats an existing deterministic Run as successful crash compensation', async () => {
    const run = vi.fn(async () => { throw new Error('数据库写入结果未知'); });
    const findScheduledRun = vi.fn(async () => succeeded('fire-a'));
    const dispatcher = createRunDispatcher(
      { run } as unknown as DurableRunRuntime,
      { findScheduledRun },
    );

    await expect(dispatcher.startScheduledRun({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    })).resolves.toEqual(succeeded('fire-a'));
    expect(findScheduledRun).toHaveBeenCalledWith({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    });
  });

  it('does not repeat startup compensation after a created Run result rejects', async () => {
    const resultError = new Error('Run result stream failed');
    const run = vi.fn(async () => ({
      runId: 'fire-a', status: 'running' as const,
      events: { async *[Symbol.asyncIterator]() {} },
      result: async () => { throw resultError; },
    }));
    const findScheduledRun = vi.fn(async () => succeeded('fire-a'));
    const onStarted = vi.fn(async () => undefined);
    const dispatcher = createRunDispatcher(
      { run } as unknown as DurableRunRuntime,
      { findScheduledRun },
    );

    await expect(dispatcher.startScheduledRun({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    }, onStarted)).rejects.toBe(resultError);
    expect(run).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(findScheduledRun).not.toHaveBeenCalled();
  });

  it('does not infer duplicate Runs from an error message', async () => {
    const error = new Error('Run already exists');
    const run = vi.fn(async () => { throw error; });
    const dispatcher = createRunDispatcher({ run } as unknown as DurableRunRuntime);

    await expect(dispatcher.startScheduledRun({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    })).rejects.toBe(error);
  });

  it('exports the consolidated MySQL scheduler store', () => {
    expect(MysqlSchedulerStore).toBeTypeOf('function');
  });

  it('binds the durable Run and completes legacy history in separate MySQL transactions', async () => {
    const source = await readFile(new URL('../../packages/scheduler-runtime/src/mysql.ts', import.meta.url), 'utf8');
    const bindRun = source.slice(source.indexOf('async bindRun'), source.indexOf('async completeFire'));
    const completeFire = source.slice(source.indexOf('async completeFire'), source.indexOf('async listBound'));

    expect(bindRun).toContain('transaction().execute');
    expect(bindRun).toContain("insertInto('task_agent_runs')");
    expect(bindRun).toContain("updateTable('scheduler_fires')");
    expect(completeFire).toContain('transaction().execute');
    expect(completeFire).toContain("insertInto('task_runs')");
    expect(completeFire).toContain("updateTable('scheduler_fires')");
    expect(completeFire).not.toContain("insertInto('task_agent_runs')");
    expect(completeFire).toContain('onDuplicateKeyUpdate');
    expect(completeFire).toContain('taskRunStatus(input.result)');
    expect(completeFire).toContain('taskRunDetail(input.result)');
    expect(completeFire).not.toContain("status: 'success', detail: input.runId");
    const taskRunDetail = source.slice(
      source.indexOf('function taskRunDetail'), source.indexOf('function parsePayload'),
    );
    expect(taskRunDetail).not.toContain('durableStatus');
  });

  it('MySQL persists bound Runs with exact-token recovery fencing', async () => {
    const source = await readFile(new URL('../../packages/scheduler-runtime/src/mysql.ts', import.meta.url), 'utf8');
    const bindRun = source.slice(source.indexOf('async bindRun'), source.indexOf('async completeFire'));
    const completeFire = source.slice(source.indexOf('async completeFire'), source.indexOf('async listBound'));
    const listBound = source.slice(source.indexOf('async listBound'), source.indexOf('async claimBound'));
    const claimBound = source.slice(source.indexOf('async claimBound'), source.indexOf('async releaseBound'));
    const releaseBound = source.slice(source.indexOf('async releaseBound'), source.indexOf('async deferBound'));
    const deferBound = source.slice(source.indexOf('async deferBound'), source.indexOf('async releaseFire'));
    const releaseFire = source.slice(source.indexOf('async releaseFire'), source.indexOf('async recoverExpired'));
    const recoverExpired = source.slice(
      source.indexOf('async recoverExpired'), source.indexOf('\n}\n\nfunction toBoundFire'),
    );

    expect(bindRun).toContain("state: 'bound'");
    expect(bindRun).toContain('claim_owner: null');
    expect(bindRun).not.toContain('claim_token: null');
    expect(bindRun).not.toContain('lease_expires_at: null');
    expect(listBound).toContain("where('state', '=', 'bound')");
    expect(listBound).toContain("where('run_id', 'is not', null)");
    expect(claimBound).toContain("where('fire_id', '=', input.fireId)");
    expect(claimBound).toContain("where('state', '=', 'bound')");
    expect(claimBound).toContain("where('claim_token', '=', input.expectedClaimToken)");
    expect(claimBound).toContain("where('run_id', 'is not', null)");
    expect(claimBound).toContain("where('lease_expires_at', '<=', input.now)");
    expect(claimBound).toContain('forUpdate().skipLocked()');
    expect(claimBound).toContain("state: 'recovering'");
    expect(releaseBound).toContain("where('state', '=', 'recovering')");
    expect(releaseBound).toContain("where('claim_token', '=', input.claimToken)");
    expect(releaseBound).toContain("state: 'bound'");
    expect(deferBound).toContain("where('fire_id', '=', input.fireId)");
    expect(deferBound).toContain("where('state', '=', 'bound')");
    expect(deferBound).toContain("where('claim_token', '=', input.claimToken)");
    expect(deferBound).toContain('retry_at: input.retryAt');
    expect(deferBound).toContain('last_error: input.error');
    expect(recoverExpired).toContain("where('state', '=', 'claimed')");
    expect(recoverExpired).toContain("where('state', '=', 'recovering')");
    expect(recoverExpired).not.toContain("where('state', '=', 'bound')");
    expect(recoverExpired).toContain('transaction().execute');
    expect(completeFire).toContain("row.state !== 'bound' && row.state !== 'recovering'");
    expect(completeFire).toContain('row.run_id !== input.runId || input.result.runId !== input.runId');
    expect(releaseFire).toContain("where('state', '=', 'claimed')");
  });

  it('dispatches product Runs without importing or entering the Pi loop', async () => {
    const sourceRoot = join(process.cwd(), 'packages/scheduler-runtime/src');
    const files = await sourceFiles(sourceRoot);
    const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');

    expect(source).toContain('startScheduledRun');
    expect(source).not.toContain('@earendil-works/pi-agent-core');
    expect(source).not.toMatch(/resolveAgentRuntime|createAgentSession|\.prompt\s*\(/);
  });
});

describe.runIf(Boolean(process.env.MYSQL_HOST))('MysqlSchedulerStore production contract', () => {
  it('covers competing workers, stable fires, Run failure, lease recovery, and atomic associations', async () => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const schedulerDb = db as unknown as Kysely<SchedulerMysqlDatabase>;
    const suffix = `${Date.now()}`;
    const tenantId = `scheduler-contract-${suffix}`;
    const fireAt = new Date(Date.now() - 60_000);
    const taskIds: number[] = [];
    const insertTask = async (label: string): Promise<number> => {
      const inserted = await db.insertInto('scheduled_tasks').values({
        tenant_id: tenantId, user_id: 'user-a', session_id: `session-${label}`,
        title: label, cron: '* * * * *', task: label, pre_approved: 1, enabled: 1,
        next_run_at: fireAt, last_run_at: null,
      }).executeTakeFirstOrThrow();
      const id = Number(inserted.insertId);
      taskIds.push(id);
      return id;
    };

    try {
      const firstTaskId = await insertTask('competing');
      const startScheduledRun = vi.fn(async (input: { fireId: string }, onStarted) => dispatchSucceeded(input.fireId, onStarted));
      const shared = { dispatcher: { startScheduledRun }, boundRecovery: activeBoundRecovery, leaseMs: 1000 };
      const [left, right] = await Promise.all([
        new SchedulerRunner({ store: new MysqlSchedulerStore(schedulerDb), workerId: 'worker-a', ...shared }).tick(fireAt, 1),
        new SchedulerRunner({ store: new MysqlSchedulerStore(schedulerDb), workerId: 'worker-b', ...shared }).tick(fireAt, 1),
      ]);
      expect(left + right).toBe(1);
      expect(startScheduledRun).toHaveBeenCalledOnce();
      expect(await db.selectFrom('scheduler_fires').selectAll().where('task_id', '=', firstTaskId).execute())
        .toHaveLength(1);
      expect(await db.selectFrom('task_agent_runs').selectAll().where('task_id', '=', firstTaskId).execute())
        .toHaveLength(1);
      expect(await db.selectFrom('task_runs').selectAll().where('task_id', '=', firstTaskId).execute())
        .toEqual([expect.objectContaining({ status: 'success', run_id: expect.any(String), fire_id: expect.any(String) })]);

      const failedTaskId = await insertTask('retry');
      const retryDispatcher = vi.fn()
        .mockRejectedValueOnce(new Error('Run creation failed'))
        .mockImplementation(async (input: { fireId: string }, onStarted) => dispatchSucceeded(input.fireId, onStarted));
      const retryRunner = new SchedulerRunner({
        store: new MysqlSchedulerStore(schedulerDb), dispatcher: { startScheduledRun: retryDispatcher },
        boundRecovery: activeBoundRecovery,
        workerId: 'worker-retry', retryDelayMs: 10,
      });
      expect(await retryRunner.tick(fireAt, 1)).toBe(1);
      expect(await db.selectFrom('scheduler_fires').select(['state', 'last_error'])
        .where('task_id', '=', failedTaskId).executeTakeFirst()).toMatchObject({ state: 'pending' });
      expect(await retryRunner.tick(new Date(fireAt.getTime() + 10), 1)).toBe(1);
      expect(retryDispatcher).toHaveBeenCalledTimes(2);

      const recoveredTaskId = await insertTask('recovery');
      const abandonedStore = new MysqlSchedulerStore(schedulerDb);
      const [abandoned] = await abandonedStore.claimDue({ now: fireAt, limit: 1, workerId: 'dead', leaseMs: 10 });
      expect(abandoned?.taskId).toBe(String(recoveredTaskId));
      const recoveredDispatcher = vi.fn(async (input: { fireId: string }, onStarted) => dispatchSucceeded(input.fireId, onStarted));
      const recoveryRunner = new SchedulerRunner({
        store: new MysqlSchedulerStore(schedulerDb), dispatcher: { startScheduledRun: recoveredDispatcher }, workerId: 'recovery',
        boundRecovery: activeBoundRecovery,
      });
      expect(await recoveryRunner.tick(new Date(fireAt.getTime() + 11), 1)).toBe(1);
      expect(recoveredDispatcher).toHaveBeenCalledOnce();
    } finally {
      if (taskIds.length) {
        await db.deleteFrom('task_runs').where('task_id', 'in', taskIds).execute();
        await db.deleteFrom('task_agent_runs').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('scheduler_fires').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('scheduled_tasks').where('tenant_id', '=', tenantId).execute();
      }
      await db.destroy();
    }
  });

  it('MySQL fences bound Runs from ordinary recovery and completes an exact-token recovery', async () => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const schedulerDb = db as unknown as Kysely<SchedulerMysqlDatabase>;
    const suffix = `${Date.now()}`;
    const tenantId = `scheduler-bound-${suffix}`;
    const fireAt = new Date('1970-01-01T00:00:01.000Z');
    const expiredAt = new Date(fireAt.getTime() + 11);
    let taskId: number | undefined;

    try {
      const inserted = await db.insertInto('scheduled_tasks').values({
        tenant_id: tenantId, user_id: 'user-a', session_id: 'session-bound', title: 'bound',
        cron: '* * * * *', task: 'bound', pre_approved: 1, enabled: 1, next_run_at: fireAt, last_run_at: null,
      }).executeTakeFirstOrThrow();
      taskId = Number(inserted.insertId);
      expect(await db.selectFrom('scheduled_tasks').select('id')
        .where('enabled', '=', 1).where('next_run_at', '<=', fireAt).where('id', '!=', taskId).limit(1).execute())
        .toEqual([]);
      expect(await db.selectFrom('scheduler_fires').select('fire_id')
        .where('state', '=', 'pending')
        .where((eb) => eb.or([eb('retry_at', 'is', null), eb('retry_at', '<=', expiredAt)]))
        .limit(1).execute()).toEqual([]);
      const store = new MysqlSchedulerStore(schedulerDb);
      const [claimed] = await store.claimDue({ now: fireAt, limit: 1, workerId: 'worker-a', leaseMs: 10 });
      expect(claimed).toBeDefined();
      expect(claimed!.taskId).toBe(String(taskId));
      await store.bindRun({
        fireId: claimed!.fireId, claimToken: claimed!.claimToken, runId: claimed!.fireId, boundAt: fireAt,
      });
      expect(await store.recoverExpired(expiredAt)).toBe(0);
      expect(await store.claimDue({ now: expiredAt, limit: 1, workerId: 'ordinary', leaseMs: 10 })).toEqual([]);
      const [bound] = await store.listBound({ now: expiredAt, limit: 1 });
      expect(bound).toMatchObject({ state: 'bound', runId: claimed!.fireId, claimToken: claimed!.claimToken });
      const observationRetryAt = new Date(expiredAt.getTime() + 5);
      await expect(store.deferBound({
        fireId: claimed!.fireId, claimToken: 'wrong-token', retryAt: observationRetryAt, error: 'poison',
      })).rejects.toThrow(`stale scheduler claim: ${claimed!.fireId}`);
      await store.deferBound({
        fireId: claimed!.fireId, claimToken: claimed!.claimToken, retryAt: observationRetryAt, error: 'poison',
      });
      expect(await store.listBound({ now: new Date(observationRetryAt.getTime() - 1), limit: 1 })).toEqual([]);
      expect((await store.listBound({ now: observationRetryAt, limit: 1 }))[0]).toMatchObject({
        state: 'bound', claimToken: claimed!.claimToken, attempts: 1, lastError: 'poison',
      });
      expect(await store.claimBound({
        fireId: claimed!.fireId, expectedClaimToken: 'wrong-token', now: observationRetryAt, workerId: 'worker-b', leaseMs: 10,
      })).toBeUndefined();
      const recovering = await store.claimBound({
        fireId: claimed!.fireId, expectedClaimToken: claimed!.claimToken,
        now: observationRetryAt, workerId: 'worker-b', leaseMs: 10,
      });
      expect(recovering).toMatchObject({ state: 'recovering', runId: claimed!.fireId, attempts: 1 });
      expect(recovering!.claimToken).not.toBe(claimed!.claimToken);
      const retryAt = new Date(expiredAt.getTime() + 100);
      await store.releaseBound({
        fireId: claimed!.fireId, claimToken: recovering!.claimToken, retryAt, error: 'retry',
      });
      const rebound = await store.claimBound({
        fireId: claimed!.fireId, expectedClaimToken: recovering!.claimToken,
        now: retryAt, workerId: 'worker-c', leaseMs: 10,
      });
      const recoveryExpiredAt = new Date(retryAt.getTime() + 11);
      expect(await store.recoverExpired(recoveryExpiredAt)).toBe(1);
      expect((await store.listBound({ now: recoveryExpiredAt, limit: 1 }))[0]).toMatchObject({
        state: 'bound', claimToken: rebound!.claimToken, attempts: 1,
      });
      const finalRecovery = await store.claimBound({
        fireId: claimed!.fireId, expectedClaimToken: rebound!.claimToken,
        now: recoveryExpiredAt, workerId: 'worker-d', leaseMs: 10,
      });
      await expect(store.completeFire({
        fireId: claimed!.fireId, claimToken: finalRecovery!.claimToken, runId: claimed!.fireId,
        result: succeeded('different-result-run').result, completedAt: recoveryExpiredAt,
      })).rejects.toThrow(`scheduled fire Run mismatch: ${claimed!.fireId}`);
      await store.completeFire({
        fireId: claimed!.fireId, claimToken: finalRecovery!.claimToken, runId: claimed!.fireId,
        result: succeeded(claimed!.fireId).result, completedAt: recoveryExpiredAt,
      });
      await expect(store.completeFire({
        fireId: claimed!.fireId, claimToken: finalRecovery!.claimToken, runId: claimed!.fireId,
        result: succeeded(claimed!.fireId).result, completedAt: recoveryExpiredAt,
      })).resolves.toBeUndefined();
      expect(await db.selectFrom('task_runs').selectAll().where('task_id', '=', taskId).execute()).toHaveLength(1);
    } finally {
      if (taskId !== undefined) {
        await db.deleteFrom('task_runs').where('task_id', '=', taskId).execute();
        await db.deleteFrom('task_agent_runs').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('scheduler_fires').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('scheduled_tasks').where('tenant_id', '=', tenantId).execute();
      }
      await db.destroy();
    }
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}
