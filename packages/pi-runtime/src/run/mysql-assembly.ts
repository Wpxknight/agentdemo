import { randomUUID } from 'node:crypto';
import type { AgentHarnessResources, AgentHarnessTool } from '@earendil-works/pi-agent-core';
import type { Model, Models } from '@earendil-works/pi-ai';
import type { Kysely } from 'kysely';
import { PiAgentSessionFactory, type PiAgentSessionFactoryOptions } from '../pi/agent.js';
import type { EventCodecOptions } from '../pi/event-codec.js';
import { MysqlRunStore } from '../store/mysql.js';
import { PiMysqlSessionRepo } from '../store/pi-session-mysql.js';
import { DurableRunManager, type DurableRunManagerOptions, type DurableRunSessionFactory } from './manager.js';

export interface MysqlDurablePiRuntimeOptions {
  db: Kysely<any>;
  store?: MysqlRunStore;
  models: Models;
  model: Model<any>;
  resolveModel?: PiAgentSessionFactoryOptions<any, any, any>['resolveModel'];
  modelConcurrency?: PiAgentSessionFactoryOptions<any, any, any>['modelConcurrency'];
  systemPrompt?: string;
  resolveSystemPrompt?: PiAgentSessionFactoryOptions<any, any, any>['resolveSystemPrompt'];
  tools?: AgentHarnessTool<undefined>[];
  resolveTools?: PiAgentSessionFactoryOptions<any, any, any>['resolveTools'];
  resources?: AgentHarnessResources;
  workerId?: string;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  inboxClaimTtlMs?: number;
  inboxPollMs?: number;
  now?: () => Date;
}

export function createMysqlDurablePiRuntime(options: MysqlDurablePiRuntimeOptions) {
  const store = options.store ?? new MysqlRunStore(options.db, false, options.now);
  const sessions = new PiMysqlSessionRepo(options.db, true);
  const factory = new PiAgentSessionFactory({
    repository: sessions, models: options.models, model: options.model, resolveModel: options.resolveModel,
    modelConcurrency: options.modelConcurrency,
    systemPrompt: options.systemPrompt, resolveSystemPrompt: options.resolveSystemPrompt,
    tools: options.tools, resolveTools: options.resolveTools, resources: options.resources,
  });
  const sequences = new Map<string, bigint>();
  const eventOptions: DurableRunManagerOptions['eventOptions'] = (input): EventCodecOptions => {
    const key = `${input.tenantId}\0${input.runId}\0${input.attemptId}\0${input.turnNo}`;
    return {
      ...input,
      correlationId: randomUUID(),
      sequence: () => {
        const next = (sequences.get(key) ?? 0n) + 1n;
        sequences.set(key, next);
        return next;
      },
      now: options.now,
    };
  };
  const runtime = new DurableRunManager({
    store,
    sessions: factory as unknown as DurableRunSessionFactory,
    eventOptions,
    workerId: options.workerId,
    leaseTtlMs: options.leaseTtlMs,
    heartbeatMs: options.heartbeatMs,
    inboxClaimTtlMs: options.inboxClaimTtlMs,
    inboxPollMs: options.inboxPollMs,
    now: options.now,
  });
  return { runtime, store, sessions, factory };
}
