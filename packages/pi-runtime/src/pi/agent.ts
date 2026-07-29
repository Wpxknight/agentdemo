import type {
  AgentInputMessage, AgentRunEvent, DurableInteractionUpdate, DurableToolLedgerUpdate, IdentityContext,
  InteractionResolution,
} from '@aiop/control-contracts';
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
import type { ImageContent, Model, Models } from '@earendil-works/pi-ai';
import { EventCodec, type EventCodecOptions } from './event-codec.js';
import {
  adoptGovernedToolScope,
  scopeGovernedTools,
  type GovernedToolScope,
} from './governed-tool-state.js';

export interface PiAgentSessionFactoryOptions<
  TMetadata extends SessionMetadata,
  TCreateOptions extends SessionCreateOptions,
  TListOptions,
> {
  repository: SessionRepo<TMetadata, TCreateOptions, TListOptions>;
  models: Models;
  model: Model<any>;
  systemPrompt?: string;
  tools?: AgentHarnessTool<undefined>[];
  resolveTools?(input: {
    identity?: IdentityContext;
    sessionId?: string;
    events: EventCodecOptions;
    interactionResolution?: InteractionResolution;
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
  interactionResolution?: InteractionResolution;
  initialMessage: AgentInputMessage;
  events: EventCodecOptions;
} & SessionCreateField<TCreateOptions>;

export interface LoadPiAgentSessionInput<TMetadata extends SessionMetadata = SessionMetadata> {
  metadata: TMetadata;
  identity?: IdentityContext;
  interactionResolution?: InteractionResolution;
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
    const tools = await this.resolveTools(input.identity, input.id, input.events, input.interactionResolution);
    return this.wrap(await this.options.repository.create(createOptions), input.initialMessage, input.events, tools);
  }

  async load(input: LoadPiAgentSessionInput<TMetadata>): Promise<PiAgentSession<TMetadata>> {
    const tools = await this.resolveTools(input.identity, input.metadata.id, input.events, input.interactionResolution);
    return this.wrap(await this.options.repository.open(input.metadata), input.initialMessage, input.events, tools);
  }

  private async resolveTools(
    identity: IdentityContext | undefined, sessionId: string | undefined, events: EventCodecOptions,
    interactionResolution?: InteractionResolution,
  ) {
    return this.options.resolveTools?.({ identity, sessionId, events, interactionResolution }) ?? this.options.tools ?? [];
  }

  private wrap(
    session: Session<TMetadata>, initialMessage: AgentInputMessage, events: EventCodecOptions,
    tools: AgentHarnessTool<undefined>[],
  ): PiAgentSession<TMetadata> {
    const governedTools = scopeGovernedTools(tools);
    const harness = new AgentHarness({
      session,
      models: this.options.models,
      model: this.options.model,
      systemPrompt: this.options.systemPrompt,
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
