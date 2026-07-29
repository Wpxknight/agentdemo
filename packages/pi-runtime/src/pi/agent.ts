import type {
  AgentInputMessage, AgentRunEvent, DurableInteractionUpdate, DurableToolLedgerUpdate, IdentityContext, JsonValue,
  ResolvedInteraction, RunExecutionProfile, ToolExecutionOutcome,
} from '@aiop/control-contracts';
import { AgentPlatformError } from '@aiop/control-contracts';
import {
  AgentHarness,
  type AgentHarnessEvent,
  type AgentHarnessResources,
  type AgentHarnessTool,
  type Session,
  type SessionCreateOptions,
  type SessionMetadata,
  type SessionRepo,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core';
import {
  validateToolArguments,
  type AssistantMessage, type ImageContent, type Model, type Models, type ToolResultMessage,
} from '@earendil-works/pi-ai';
import { EventCodec, type EventCodecOptions } from './event-codec.js';
import { createConcurrentModels, type ModelConcurrencyController } from '../model/concurrency.js';
import {
  adoptGovernedToolScope,
  scopeGovernedTools,
  type GovernedToolScope,
} from './governed-tool-state.js';
import { GovernedToolExecutionError, GovernedToolOutcomeError } from './tool-bridge.js';
import { digestToolValue } from '../tools/ledger.js';

export interface PiAgentSessionFactoryOptions<
  TMetadata extends SessionMetadata,
  TCreateOptions extends SessionCreateOptions,
  TListOptions,
> {
  repository: SessionRepo<TMetadata, TCreateOptions, TListOptions>;
  models: Models;
  model: Model<any>;
  modelConcurrency?: ModelConcurrencyController;
  systemPrompt?: string;
  resolveSystemPrompt?(input: { execution?: RunExecutionProfile }): string | undefined;
  tools?: AgentHarnessTool<undefined>[];
  resolveTools?(input: {
    identity?: IdentityContext;
    sessionId?: string;
    events: EventCodecOptions;
    interactionResolution?: ResolvedInteraction;
    execution?: RunExecutionProfile;
  }): Promise<AgentHarnessTool<undefined>[]>;
  resources?: AgentHarnessResources;
}

type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type SessionCreateField<TCreateOptions extends SessionCreateOptions> =
  [RequiredKeys<Omit<TCreateOptions, 'id'>>] extends [never]
    ? { session?: Omit<TCreateOptions, 'id'> }
    : { session: Omit<TCreateOptions, 'id'> };

export type CreatePiAgentSessionInput<TCreateOptions extends SessionCreateOptions = SessionCreateOptions> = {
  id?: string;
  identity?: IdentityContext;
  interactionResolution?: ResolvedInteraction;
  execution?: RunExecutionProfile;
  initialMessage: AgentInputMessage;
  events: EventCodecOptions;
} & SessionCreateField<TCreateOptions>;

export interface LoadPiAgentSessionInput<TMetadata extends SessionMetadata = SessionMetadata> {
  metadata: TMetadata;
  identity?: IdentityContext;
  interactionResolution?: ResolvedInteraction;
  execution?: RunExecutionProfile;
  initialMessage: AgentInputMessage;
  events: EventCodecOptions;
}

export class PiAgentSessionFactory<
  TMetadata extends SessionMetadata = SessionMetadata,
  TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
  TListOptions = void,
> {
  constructor(private readonly options: PiAgentSessionFactoryOptions<TMetadata, TCreateOptions, TListOptions>) {}

  async create(input: CreatePiAgentSessionInput<TCreateOptions>): Promise<PiAgentSession<TMetadata>> {
    const createOptions = { ...input.session, ...(input.id ? { id: input.id } : {}) } as TCreateOptions;
    const tools = await this.resolveTools(
      input.identity, input.id, input.events, input.interactionResolution, input.execution,
    );
    return this.wrap(
      await this.options.repository.create(createOptions), input.initialMessage, input.events, tools, input.identity,
      input.execution,
    );
  }

  async load(input: LoadPiAgentSessionInput<TMetadata>): Promise<PiAgentSession<TMetadata>> {
    const tools = await this.resolveTools(
      input.identity, input.metadata.id, input.events, input.interactionResolution, input.execution,
    );
    return this.wrap(
      await this.options.repository.open(input.metadata), input.initialMessage, input.events, tools, input.identity,
      input.execution,
    );
  }

  private async resolveTools(
    identity: IdentityContext | undefined, sessionId: string | undefined, events: EventCodecOptions,
    interactionResolution?: ResolvedInteraction, execution?: RunExecutionProfile,
  ) {
    return this.options.resolveTools?.({ identity, sessionId, events, interactionResolution, execution })
      ?? this.options.tools ?? [];
  }

  private wrap(
    session: Session<TMetadata>, initialMessage: AgentInputMessage, events: EventCodecOptions,
    tools: AgentHarnessTool<undefined>[],
    identity?: IdentityContext,
    execution?: RunExecutionProfile,
  ): PiAgentSession<TMetadata> {
    const governedTools = scopeGovernedTools(tools);
    const harness = new AgentHarness({
      session,
      models: identity && this.options.modelConcurrency
        ? createConcurrentModels(this.options.models, this.options.modelConcurrency, identity)
        : this.options.models,
      model: this.options.model,
      systemPrompt: this.options.resolveSystemPrompt?.({ execution }) ?? this.options.systemPrompt,
      tools: governedTools.tools,
      resources: this.options.resources,
    });
    return new PiAgentSession(session, harness, initialMessage, new EventCodec(events));
  }
}

export class PiAgentSession<TMetadata extends SessionMetadata = SessionMetadata> {
  private closed = false;
  private closePromise?: Promise<void>;
  private pendingMessage?: AgentInputMessage;
  private activeRun?: { cancel(): Promise<void>; finalize(cancelRunning?: boolean): Promise<void> };
  private governedToolScope: GovernedToolScope;
  private removeGovernedToolHook = () => {};
  private readonly pendingCustomEntries: Array<{
    customType: string; data?: unknown; resolve(id: string): void; reject(error: unknown): void;
  }> = [];
  private customFlushTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: Session<TMetadata>,
    private readonly harness: AgentHarness,
    initialMessage: AgentInputMessage,
    private readonly eventCodec: EventCodec,
  ) {
    this.pendingMessage = initialMessage;
    this.governedToolScope = adoptGovernedToolScope(harness.getTools());
    this.installGovernedToolHook(this.governedToolScope);
  }

  continue(signal?: AbortSignal): AsyncIterable<AgentRunEvent> {
    const owner = this;
    return { [Symbol.asyncIterator]: () => owner.iterate(signal) };
  }

  async replayInteraction(
    resolution: ResolvedInteraction,
    signal?: AbortSignal,
    guard?: () => Promise<void>,
  ): Promise<void> {
    this.ensureOpen();
    if (this.activeRun) throw runStateConflict('Cannot replay an interaction while a Pi run is active');
    if (signal?.aborted) throw abortReason(signal);
    await guard?.();
    const branch = await this.session.getBranch();
    const calls = branch.flatMap((entry) => entry.type === 'message' && entry.message.role === 'assistant'
      ? entry.message.content.filter((block): block is Extract<AssistantMessage['content'][number], { type: 'toolCall' }> =>
          block.type === 'toolCall' && block.id === resolution.toolCallId)
        .map((call) => ({ entry, call }))
      : []);
    if (calls.length !== 1) {
      throw runStateConflict('Resolved interaction original tool call is missing or ambiguous');
    }
    const original = calls[0]!;
    const waiting = branch.flatMap((entry) => {
      if (entry.type !== 'message' || entry.message.role !== 'toolResult'
        || entry.message.toolCallId !== resolution.toolCallId) return [];
      const binding = waitingInteractionBinding(entry.message, resolution, original.call);
      return binding ? [{ entry, binding }] : [];
    });
    if (waiting.length !== 1 || waiting[0]!.entry.parentId !== original.entry.id
      || waiting[0]!.entry.id !== await this.session.getLeafId()) {
      throw runStateConflict('Resolved interaction does not match the committed waiting result');
    }
    const tools = this.harness.getActiveTools().filter((tool) => tool.name === original.call.name);
    const definition = tools.length === 1 ? this.governedToolScope.definition(tools[0]!) : undefined;
    if (!definition) {
      throw runStateConflict('Resolved interaction governed tool is missing or ambiguous');
    }
    if (definition.name !== waiting[0]!.binding.ledger.toolName
      || definition.capability !== waiting[0]!.binding.ledger.capability) {
      throw runStateConflict('Resolved interaction governed tool definition does not match the committed waiting call');
    }
    try {
      validateToolArguments(tools[0]!, original.call);
    } catch {
      throw runStateConflict('Resolved interaction arguments do not match the current governed tool schema');
    }

    let replacement: ToolResultMessage;
    try {
      await guard?.();
      if (signal?.aborted) throw abortReason(signal);
      const result = await tools[0]!.execute(
        resolution.toolCallId, original.call.arguments, signal, undefined, undefined,
      );
      const resultCallId = result.details && typeof result.details === 'object'
        ? (result.details as { callId?: unknown }).callId : undefined;
      if (resultCallId !== resolution.toolCallId) {
        throw new GovernedToolOutcomeError({
          kind: 'recovery_required', message: 'Resolved interaction returned a result for a different tool call',
        });
      }
      this.governedToolScope.patch(replayToolResultEvent(
        resolution.toolCallId, original.call.name, original.call.arguments, result, false,
      ));
      replacement = {
        role: 'toolResult', toolCallId: resolution.toolCallId, toolName: original.call.name,
        content: result.content, details: result.details, usage: result.usage, isError: false,
        timestamp: waiting[0]!.entry.message.timestamp,
      };
    } catch (error) {
      if (error instanceof GovernedToolOutcomeError) {
        this.governedToolScope.patch(replayToolResultEvent(
          resolution.toolCallId, original.call.name, original.call.arguments,
          { content: [{ type: 'text', text: error.message }], details: error.outcome }, true,
        ));
        const outcome = this.governedToolScope.takeOutcome() ?? error;
        if (outcome.outcome.kind === 'waiting') {
          throw runStateConflict('Resolved interaction returned to waiting');
        }
        throw outcome;
      }
      if (!(error instanceof GovernedToolExecutionError) || error.call.id !== resolution.toolCallId
        || error.result.callId !== resolution.toolCallId) throw error;
      this.governedToolScope.patch(replayToolResultEvent(
        resolution.toolCallId, original.call.name, original.call.arguments,
        { content: [{ type: 'text', text: error.result.content }], details: error.result }, true,
      ));
      replacement = {
        role: 'toolResult', toolCallId: resolution.toolCallId, toolName: original.call.name,
        content: [{ type: 'text', text: error.result.content }], details: error.result, isError: true,
        timestamp: waiting[0]!.entry.message.timestamp,
      };
    }
    const resultCallId = replacement.details && typeof replacement.details === 'object'
      ? (replacement.details as { callId?: unknown }).callId : undefined;
    if (resultCallId !== resolution.toolCallId) {
      throw runStateConflict('Resolved interaction returned a result for a different tool call');
    }
    try {
      await this.session.moveTo(original.entry.id);
      await this.session.appendMessage(replacement);
    } catch (error) {
      throw new GovernedToolOutcomeError({
        kind: 'recovery_required', message: 'Resolved tool result could not be committed to the Pi session',
      });
    }
  }

  private async *iterate(signal?: AbortSignal): AsyncGenerator<AgentRunEvent> {
    this.ensureOpen();
    if (this.activeRun) throw new Error('Pi agent session already has an active continue');
    if (!this.pendingMessage) throw new Error('Pi agent session has no pending input');
    if (signal?.aborted) throw abortReason(signal);
    const initialMessage = this.pendingMessage;
    this.pendingMessage = undefined;
    const events: AgentRunEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let forceDone = false;
    let failure: unknown;
    const forwardEvent = (event: AgentHarnessEvent) => {
      events.push(this.eventCodec.fromPi(event));
      wake?.();
      wake = undefined;
    };
    const unsubscribe = this.harness.subscribe((event) => {
      if (event.type === 'save_point' || event.type === 'settled') {
        return this.flushPendingCustomEntries().then(() => { forwardEvent(event); });
      }
      forwardEvent(event);
    });
    let cancelPromise: Promise<void> | undefined;
    const cancel = () => cancelPromise ??= (async () => {
      const errors: unknown[] = [];
      try { await this.harness.abort(); } catch (error) { errors.push(error); }
      try { await this.harness.waitForIdle(); } catch (error) { errors.push(error); }
      throwCollected(errors, 'Pi agent cancellation failed');
    })();
    let removeSignalListener = () => {};
    let finalizePromise: Promise<void> | undefined;
    const active = {
      cancel,
      finalize: (cancelRunning = true) => finalizePromise ??= (async () => {
        const errors: unknown[] = [];
        try {
          if (cancelRunning && !finished) await cancel();
        } catch (error) {
          errors.push(error);
        } finally {
          try { removeSignalListener(); } catch (error) { errors.push(error); }
          try { unsubscribe(); } catch (error) { errors.push(error); }
          forceDone = true;
          events.length = 0;
          if (this.activeRun === active) this.activeRun = undefined;
          try { await this.flushPendingCustomEntries(); } catch (error) { errors.push(error); }
          wake?.();
          wake = undefined;
        }
        throwCollected(errors, 'Pi agent finalization failed');
      })(),
    };
    this.activeRun = active;
    const abort = () => {
      failure = abortReason(signal!);
      cancelPromise = cancel().catch((error) => { failure = error; }).finally(() => { wake?.(); });
    };
    signal?.addEventListener('abort', abort, { once: true });
    removeSignalListener = () => signal?.removeEventListener('abort', abort);
    const { text, images } = promptParts(initialMessage);
    const run = this.harness.prompt(text, images.length ? { images } : undefined).then(
      () => { finished = true; wake?.(); },
      (error) => { failure ??= error; finished = true; wake?.(); },
    );
    try {
      while (!forceDone && (!finished || events.length)) {
        if (events.length) {
          yield events.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      const governedOutcome = this.governedToolScope.takeOutcome();
      if (governedOutcome) throw governedOutcome;
      if (failure) throw failure;
    } finally {
      try { await active.finalize(!finished); } catch (error) {
        if (failure) throw new AggregateError([failure, error], 'Pi agent run and finalization failed');
        throw error;
      }
      if (!finished) await run;
    }
  }

  async steer(message: AgentInputMessage): Promise<void> {
    this.ensureOpen();
    const { text, images } = promptParts(message);
    await this.harness.steer(text, images.length ? { images } : undefined);
  }

  followUp(message: AgentInputMessage): Promise<void> {
    this.ensureOpen();
    const { text, images } = promptParts(message);
    return this.harness.followUp(text, images.length ? { images } : undefined);
  }

  async abort(): Promise<void> {
    if (this.activeRun) await this.activeRun.cancel();
    else if (!this.closed) await this.harness.abort();
  }

  async setTools(tools: AgentHarnessTool<undefined>[]): Promise<void> {
    this.ensureOpen();
    if (this.activeRun) throw new Error('Cannot set Pi tools while an agent run is active');
    const nextScope = scopeGovernedTools(tools);
    if (this.governedToolScope.hasPending()) {
      nextScope.clear();
      throw new Error('Cannot replace Pi tools while governed failures are pending');
    }
    try {
      await this.harness.setTools(nextScope.tools, nextScope.tools.map((tool) => tool.name));
    } catch (error) {
      nextScope.clear();
      throw error;
    }
    this.removeGovernedToolHook();
    this.governedToolScope.clear();
    this.governedToolScope = nextScope;
    this.installGovernedToolHook(nextScope);
  }

  tools(): AgentHarnessTool<undefined>[] {
    return this.harness.getActiveTools();
  }

  metadata(): Promise<TMetadata> {
    return this.session.getMetadata();
  }

  entries(): Promise<SessionTreeEntry[]> {
    return this.session.getEntries();
  }

  leafId(): Promise<string | null> {
    return this.session.getLeafId();
  }

  takeToolExecutionFacts(): {
    ledgerUpdates: DurableToolLedgerUpdate[];
    interactionUpdates: DurableInteractionUpdate[];
  } {
    return this.governedToolScope.takeFacts();
  }

  appendCustomEntry(customType: string, data?: unknown): Promise<string> {
    this.ensureOpen();
    const result = new Promise<string>((resolve, reject) => {
      this.pendingCustomEntries.push({ customType, data, resolve, reject });
    });
    if (!this.activeRun) void this.flushPendingCustomEntries();
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    return this.closePromise ??= (async () => {
      const errors: unknown[] = [];
      const active = this.activeRun;
      try {
        if (active) {
          try { await active.cancel(); } catch (error) { errors.push(error); }
          try { await active.finalize(false); } catch (error) { errors.push(error); }
        } else {
          try { await this.harness.abort(); } catch (error) { errors.push(error); }
          try { await this.harness.waitForIdle(); } catch (error) { errors.push(error); }
        }
      } finally {
        try { this.removeGovernedToolHook(); } catch (error) { errors.push(error); }
      }
      throwCollected(errors, 'Pi agent close failed');
    })();
  }

  private installGovernedToolHook(scope: GovernedToolScope): void {
    const removeHook = this.harness.on('tool_result', (event) => scope.patch(event));
    this.removeGovernedToolHook = () => {
      scope.clear();
      removeHook();
      this.removeGovernedToolHook = () => {};
    };
  }

  private flushPendingCustomEntries(): Promise<void> {
    const flush = async () => {
      while (this.pendingCustomEntries.length) {
        const entry = this.pendingCustomEntries.shift()!;
        try {
          entry.resolve(await this.session.appendCustomEntry(entry.customType, entry.data));
        } catch (error) {
          entry.reject(error);
        }
      }
    };
    const next = this.customFlushTail.then(flush, flush);
    this.customFlushTail = next.catch(() => {});
    return next;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Pi agent session is closed');
  }
}

function throwCollected(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function promptParts(message: AgentInputMessage): { text: string; images: ImageContent[] } {
  const content = message.content ?? [];
  const text = [message.text, ...content.filter((block) => block.type === 'text').map((block) => block.text)]
    .filter((part): part is string => Boolean(part)).join('\n');
  const images = content.filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image')
    .map((block) => ({ type: 'image' as const, data: block.data, mimeType: block.mimeType }));
  return { text, images };
}

function waitingInteractionBinding(
  message: ToolResultMessage,
  resolution: ResolvedInteraction,
  call: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>,
): { ledger: DurableToolLedgerUpdate; interaction: DurableInteractionUpdate } | undefined {
  if (!message.isError || !message.details || typeof message.details !== 'object') return undefined;
  const details = message.details as {
    kind?: unknown;
    outcome?: Extract<ToolExecutionOutcome, { kind: 'waiting' }>;
  };
  const outcome = details.outcome;
  if (details.kind !== 'governed_tool_outcome' || outcome?.kind !== 'waiting'
    || outcome.reason !== resolution.kind || outcome.interactionId !== resolution.interactionId) return undefined;
  const ledgerUpdates = outcome.ledgerUpdates ?? [];
  const interactionUpdates = outcome.interactionUpdates ?? [];
  const ledgers = ledgerUpdates.filter((ledger) => ledger.status === 'pending_approval'
    && ledger.toolCallId === call.id && ledger.toolName === call.name
    && ledger.approvedInteractionId === resolution.interactionId
    && ledger.argsDigest === digestToolValue(call.arguments));
  const interactions = interactionUpdates.filter((interaction) => interaction.status === 'pending'
    && interaction.id === resolution.interactionId && interaction.kind === resolution.kind
    && interaction.toolCallId === call.id);
  if (ledgerUpdates.length !== 1 || interactionUpdates.length !== 1
    || ledgers.length !== 1 || interactions.length !== 1
    || interactions[0]!.tenantId !== ledgers[0]!.tenantId || interactions[0]!.runId !== ledgers[0]!.runId
    || interactions[0]!.attemptId !== ledgers[0]!.attemptId || interactions[0]!.turnNo !== ledgers[0]!.turnNo
    || !waitingPayloadMatches(interactions[0]!.payload, resolution.kind, call)) return undefined;
  return { ledger: ledgers[0]!, interaction: interactions[0]! };
}

function waitingPayloadMatches(
  payload: JsonValue,
  kind: ResolvedInteraction['kind'],
  call: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>,
): boolean {
  if (kind !== 'approval') return digestToolValue(payload) === digestToolValue(call.arguments);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.call || typeof payload.call !== 'object' || Array.isArray(payload.call)) return false;
  const pendingCall = payload.call;
  const toolCallIds = ['id', 'toolCallId'].filter((key) => Object.hasOwn(pendingCall, key))
    .map((key) => pendingCall[key]);
  return toolCallIds.length > 0 && toolCallIds.every((toolCallId) => toolCallId === call.id)
    && pendingCall.name === call.name && Object.hasOwn(pendingCall, 'args')
    && digestToolValue(pendingCall.args) === digestToolValue(call.arguments);
}

function replayToolResultEvent(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  result: { content: Array<{ type: 'text'; text: string } | ImageContent>; details?: unknown; usage?: ToolResultMessage['usage'] },
  isError: boolean,
): Extract<AgentHarnessEvent, { type: 'tool_result' }> {
  return { type: 'tool_result', toolCallId, toolName, input, content: result.content,
    details: result.details, usage: result.usage, isError };
}

function runStateConflict(message: string): AgentPlatformError {
  return new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message, retryable: false });
}
