import type { RunAgentOptions, RunAgentResult } from './run-types.js';
import type { AgentKernel, AgentKernelName } from './kernel.js';
import { PiAIOPAgentKernel } from './pi/kernel.js';
import {
  createPiPlatformKernel,
  emitPiCompatEvent,
  fromPiKernelMessages,
  piToolDefinitions,
  toPiKernelMessages,
} from './pi/kernel.js';
import {
  DurableAgentRuntime,
  FifoModelConcurrencyController,
  type KernelMessage,
  type ModelConcurrencyController,
  type RuntimeStore,
} from '@aiop/agent-runtime-core';
import { AgentPlatformError } from '@aiop/control-contracts';
import type { AgentRunBinding, Store } from '../db/store.js';
import { AgentRunCancelledError, AgentRunCoordinator } from './run-coordinator.js';
import { reqContext } from './tools.js';
import { ResourceConcurrencyController } from '@aiop/pi-runtime';
import { createAIOPToolRuntime } from './pi/tool-runtime.js';

export type { AgentRunBinding } from '../db/store.js';

export interface AgentRunBindingStore {
  getAgentRunBinding(tenantId: string, runId: string): Promise<AgentRunBinding | undefined>;
  putAgentRunBindingIfAbsent(binding: AgentRunBinding): Promise<boolean>;
}

export interface AgentRuntimeOptions {
  kernel?: AgentKernel;
  prepareOptions?: (options: RunAgentOptions) => RunAgentOptions;
  configuredName?: AgentKernelName;
  bindingStore?: AgentRunBindingStore;
  runCoordinator?: AgentRunCoordinator;
  runtimeStore?: RuntimeStore;
  runStore?: Store;
  modelConcurrency?: ModelConcurrencyController;
  toolConcurrency?: ResourceConcurrencyController;
}

/** 供 HTTP、CLI、Scheduler 共用的稳定 Agent 运行入口。 */
export class AgentRuntime {
  readonly kernel: AgentKernel;
  private readonly prepareOptions: (options: RunAgentOptions) => RunAgentOptions;
  private readonly configuredName: AgentKernelName;
  private readonly bindingStore?: AgentRunBindingStore;
  private readonly runCoordinator?: AgentRunCoordinator;
  private readonly runtimeStore?: RuntimeStore;
  private readonly runStore?: Store;
  private readonly modelConcurrency: ModelConcurrencyController;
  private readonly toolConcurrency: ResourceConcurrencyController;

  constructor(options: AgentRuntimeOptions = {}) {
    this.kernel = options.kernel ?? new PiAIOPAgentKernel();
    this.prepareOptions = options.prepareOptions ?? ((runOptions) => runOptions);
    this.configuredName = options.configuredName ?? this.kernel.name;
    this.bindingStore = options.bindingStore;
    this.runCoordinator = options.runCoordinator;
    this.runtimeStore = options.runtimeStore;
    this.runStore = options.runStore;
    this.modelConcurrency = options.modelConcurrency ?? new FifoModelConcurrencyController();
    this.toolConcurrency = options.toolConcurrency ?? new ResourceConcurrencyController();
  }

  get kernelName(): AgentKernelName {
    return this.configuredName;
  }

  async run(options: RunAgentOptions): Promise<RunAgentResult> {
    const prepared = this.prepareOptions(options);
    if (this.kernel.name !== 'pi') return this.kernel.run(prepared);
    if (prepared.rolloutMode === 'replay') {
      if (!this.runtimeStore) {
        throw new AgentPlatformError({
          code: 'RUN_STATE_CONFLICT', message: 'Replay requires a Durable Runtime Store', retryable: false,
        });
      }
      return this.replayDurablePi(prepared);
    }
    await this.ensurePiBinding(prepared);
    if (this.runtimeStore && prepared.runId) return this.runDurablePi(prepared);
    if (!prepared.runId || !this.runCoordinator) return this.kernel.run(prepared);
    const execution = await this.runCoordinator.start(reqContext(prepared.ctx), prepared.runId);
    try {
      const result = await this.kernel.run({
        ...prepared,
        runLifecycle: execution,
        runGuard: () => execution.guard(),
      });
      await execution.succeed(result);
      return result;
    } catch (error) {
      const lifecycleError = prepared.signal?.aborted
        ? new AgentRunCancelledError(abortMessage(prepared.signal.reason))
        : error;
      await execution.fail(lifecycleError);
      throw error;
    }
  }

  private async runDurablePi(options: RunAgentOptions): Promise<RunAgentResult> {
    const toolRuntime = createAIOPToolRuntime(
      options, this.runtimeStore!.toolLedger, this.toolConcurrency,
    );
    const kernel = createPiPlatformKernel(options, this.modelConcurrency, toolRuntime);
    let compacted = false;
    const runtime = new DurableAgentRuntime({
      store: this.runtimeStore!,
      kernels: [kernel],
      defaultKernel: 'pi',
      modelBinding: {
        provider: 'aiop', model: options.model.id, contextWindowTokens: options.contextBudgetTokens,
        rolloutMode: options.rolloutMode,
        comparisonRunId: options.comparisonRunId,
      },
      tools: piToolDefinitions(options),
      observeEvent: (event) => {
        if (event.type === 'context_compacted') compacted = true;
        emitPiCompatEvent(event, options.onEvent);
      },
    });
    const identity = {
      tenantId: options.ctx.tenantId ?? 'default',
      actorId: options.ctx.userId ?? '',
      roles: [options.ctx.role ?? 'user'],
    };
    const handle = options.resumeFromCheckpoint
      ? await runtime.resume({
          identity, runId: options.runId!, signal: options.signal,
          resolution: options.interactionResolution,
        })
      : await runtime.run({
          runId: options.runId,
          identity,
          sessionId: options.ctx.sessionId,
          input: [],
          messages: toPiKernelMessages(options.messages ?? [], options.task, options.taskContentBlocks),
          limits: { maxTurns: options.maxSteps },
          signal: options.signal,
        });
    const result = await handle.result();
    const committed = await this.runtimeStore!.turns.getLastCommitted({
      tenantId: identity.tenantId, runId: options.runId!,
    });
    const messages = fromPiKernelMessages(committed?.messages ?? []);
    const rollout = await this.rolloutComparison(options, result.usage);
    if (rollout && options.rolloutMode === 'dry-run' && committed) {
      await this.runtimeStore!.events.append({
        tenantId: identity.tenantId,
        runId: options.runId!,
        attemptId: committed.attemptId,
        turnNo: committed.turnNo,
        kernel: 'pi',
        kernelVersion: '0.82.1',
        correlationId: options.runId!,
        type: 'rollout_comparison',
        detail: {
          mode: rollout.mode,
          sourceRunId: rollout.sourceRunId ?? null,
          outcome: result.status,
          usage: usageDetail(result.usage),
          sourceUsage: rollout.sourceUsage ? usageDetail(rollout.sourceUsage) : null,
          usageDelta: rollout.usageDelta ? usageDetail(rollout.usageDelta) : null,
        },
        createdAt: new Date(),
      });
    }
    const now = new Date();
    await this.runStore?.updateAgentRun(identity.tenantId, options.runId!, {
      status: result.status,
      stepCount: committed?.turnNo ?? 0,
      usage: result.usage,
      errorMessage: result.error?.message ?? null,
      completedAt: result.status === 'waiting' ? null : now,
      updatedAt: now,
      clearLease: true,
    });
    if (result.status === 'cancelled') {
      throw new AgentRunCancelledError(result.error?.message ?? 'Agent run cancelled');
    }
    if (result.status === 'failed' || result.status === 'recovery_required') {
      throw new AgentPlatformError(result.error ?? {
        code: result.status === 'recovery_required' ? 'TOOL_RESULT_UNKNOWN' : 'MODEL_PROVIDER_ERROR',
        message: `Agent run ${result.status}`,
        retryable: false,
      });
    }
    return {
      messages,
      text: result.text ?? '',
      steps: committed?.turnNo ?? 0,
      usage: result.usage,
      compacted,
      rollout,
    };
  }

  private async replayDurablePi(options: RunAgentOptions): Promise<RunAgentResult> {
    const sourceRunId = options.comparisonRunId ?? options.runId;
    if (!sourceRunId) {
      throw new AgentPlatformError({
        code: 'RUN_STATE_CONFLICT', message: 'Replay requires comparisonRunId or runId', retryable: false,
      });
    }
    const tenantId = options.ctx.tenantId ?? 'default';
    const source = await this.runtimeStore!.runs.get({ tenantId, runId: sourceRunId });
    if (!source || source.actorId !== (options.ctx.userId ?? '') || source.sessionId !== options.ctx.sessionId) {
      throw new AgentPlatformError({ code: 'RUN_NOT_FOUND', message: 'Replay source run not found', retryable: false });
    }
    const committed = await this.runtimeStore!.turns.getLastCommitted({ tenantId, runId: sourceRunId });
    if (!committed) {
      throw new AgentPlatformError({ code: 'RUN_NOT_FOUND', message: 'Replay source has no committed transcript', retryable: false });
    }
    const messages = fromPiKernelMessages(committed.messages);
    return {
      messages,
      text: lastReplayText(committed.messages),
      steps: committed.turnNo,
      usage: committed.usage,
      compacted: false,
      rollout: {
        mode: 'replay',
        sourceRunId,
        sourceUsage: committed.usage,
        usageDelta: zeroUsageDelta(),
      },
    };
  }

  private async rolloutComparison(
    options: RunAgentOptions,
    usage: RunAgentResult['usage'],
  ): Promise<RunAgentResult['rollout']> {
    if (options.rolloutMode !== 'dry-run') return undefined;
    const sourceRunId = options.comparisonRunId;
    if (!sourceRunId) return { mode: 'dry-run' };
    const source = await this.runtimeStore!.turns.getLastCommitted({
      tenantId: options.ctx.tenantId ?? 'default', runId: sourceRunId,
    });
    return {
      mode: 'dry-run',
      sourceRunId,
      sourceUsage: source?.usage,
      usageDelta: source ? subtractUsage(usage, source.usage) : undefined,
    };
  }

  private async ensurePiBinding(options: RunAgentOptions): Promise<void> {
    if (!options.runId || !this.bindingStore) return;
    const tenantId = options.ctx.tenantId ?? 'default';
    const userId = options.ctx.userId ?? '';
    const existing = await this.bindingStore.getAgentRunBinding(tenantId, options.runId);
    if (existing) return this.validateBinding(existing, options);
    const binding: AgentRunBinding = {
      tenantId,
      userId,
      sessionId: options.ctx.sessionId,
      runId: options.runId,
      kernel: 'pi',
      kernelVersion: '0.82.1',
      runtimeVersion: '1',
      graphName: '',
      graphVersion: '',
      createdAt: new Date(),
    };
    if (await this.bindingStore.putAgentRunBindingIfAbsent(binding)) return;
    const raced = await this.bindingStore.getAgentRunBinding(tenantId, options.runId);
    if (!raced) throw new Error('Agent run binding 写入冲突');
    this.validateBinding(raced, options);
  }

  private validateBinding(binding: AgentRunBinding, options: RunAgentOptions): void {
    if (binding.userId !== (options.ctx.userId ?? '') || binding.sessionId !== options.ctx.sessionId) {
      throw new Error('Agent run binding 与当前用户或会话不匹配');
    }
    if (binding.kernel !== 'pi') {
      throw new Error(`Agent Kernel 不可用：${binding.kernel}@${binding.kernelVersion ?? 'unknown'}`);
    }
  }
}

/** 兼容测试和外部调用方构造的旧 Runtime fixture。 */
export const defaultAgentRuntime = new AgentRuntime();

export function resolveAgentRuntime(runtime?: AgentRuntime): AgentRuntime {
  return runtime ?? defaultAgentRuntime;
}

export function createConfiguredAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    kernels?: { pi?: AgentKernel };
    bindingStore?: AgentRunBindingStore;
    runStore?: Store;
    runtimeStore?: RuntimeStore;
  } = {},
): AgentRuntime {
  assertPiKernelConfiguration(env);
  const modelConcurrency = new FifoModelConcurrencyController({
    maxConcurrentPerTenantModel: modelConcurrencyLimit(env.AIOP_PI_MAX_CONCURRENT_MODEL_CALLS),
  });
  const toolConcurrency = new ResourceConcurrencyController(toolConcurrencyLimit(
    env.AIOP_PI_MAX_CONCURRENT_TOOLS_PER_RESOURCE, 'AIOP_PI_MAX_CONCURRENT_TOOLS_PER_RESOURCE', 1,
  ));
  const pi = options.kernels?.pi ?? new PiAIOPAgentKernel(modelConcurrency);
  const piMode = resolvePiMode(env.AIOP_PI_MODE);
  return new AgentRuntime({
    kernel: pi,
    prepareOptions: piOptionGate(env, piMode),
    configuredName: 'pi',
    bindingStore: options.bindingStore,
    runCoordinator: options.runStore ? new AgentRunCoordinator(options.runStore) : undefined,
    runtimeStore: options.runtimeStore,
    runStore: options.runStore,
    modelConcurrency,
    toolConcurrency,
  });
}

function assertPiKernelConfiguration(env: NodeJS.ProcessEnv): void {
  const configured = env.AIOP_AGENT_KERNEL?.trim().toLowerCase();
  if (configured && configured !== 'pi') {
    throw new Error('AIOP_AGENT_KERNEL is retired; only pi is supported');
  }
}

function toolConcurrencyLimit(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer: ${value}`);
  return parsed;
}

function modelConcurrencyLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 4;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`AIOP_PI_MAX_CONCURRENT_MODEL_CALLS must be a positive integer: ${value}`);
  }
  return parsed;
}

function abortMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' && reason ? reason : 'Agent run cancelled';
}

function csv(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean));
}

type PiMode = 'read-only' | 'dry-run' | 'replay' | 'full';

function resolvePiMode(value: string | undefined): PiMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'full') return 'full';
  if (normalized === 'read-only' || normalized === 'dry-run' || normalized === 'replay') {
    return normalized;
  }
  throw new Error('AIOP_PI_MODE must be one of read-only, dry-run, replay, full');
}

function piOptionGate(env: NodeJS.ProcessEnv, mode: PiMode) {
  const readOnlySessions = csv(env.AIOP_PI_READ_ONLY_SESSIONS);
  return (options: RunAgentOptions): RunAgentOptions => {
    const prepared = {
      ...options,
      rolloutMode: mode,
      comparisonRunId: options.comparisonRunId ?? (env.AIOP_PI_COMPARISON_RUN_ID?.trim() || undefined),
    };
    const restriction = mode === 'dry-run' || mode === 'replay'
      ? 'none'
      : mode === 'read-only' || readOnlySessions.has(options.ctx.sessionId)
        ? 'read-only'
        : 'full';
    if (restriction === 'full') return prepared;
    const existing = options.filterToolDefs;
    return {
      ...prepared,
      filterToolDefs: (defs) => {
        const visible = existing?.(defs) ?? defs;
        return restriction === 'none' ? [] : visible.filter((tool) => isReadTool(tool.name));
      },
    };
  };
}

function lastReplayText(messages: readonly KernelMessage[]): string {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (!assistant || assistant.role !== 'assistant') return '';
  return assistant.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
}

function subtractUsage(
  current: RunAgentResult['usage'],
  source: RunAgentResult['usage'],
): RunAgentResult['usage'] {
  return {
    inputTokens: current.inputTokens - source.inputTokens,
    outputTokens: current.outputTokens - source.outputTokens,
    cacheReadTokens: current.cacheReadTokens - source.cacheReadTokens,
    cacheCreationTokens: current.cacheCreationTokens - source.cacheCreationTokens,
  };
}

function zeroUsageDelta(): RunAgentResult['usage'] {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function usageDetail(usage: RunAgentResult['usage']) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
  };
}

function isReadTool(name: string): boolean {
  return /^(get|list|read|search|fetch|describe|query)(_|$)/i.test(name);
}
