import type { AgentInputMessage, AgentRunEvent } from '@aiop/control-contracts';
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
  resources?: AgentHarnessResources;
}

type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type SessionCreateField<TCreateOptions extends SessionCreateOptions> =
  [RequiredKeys<Omit<TCreateOptions, 'id'>>] extends [never]
    ? { session?: Omit<TCreateOptions, 'id'> }
    : { session: Omit<TCreateOptions, 'id'> };

export type CreatePiAgentSessionInput<TCreateOptions extends SessionCreateOptions = SessionCreateOptions> = {
  id?: string;
  initialMessage: AgentInputMessage;
  events: EventCodecOptions;
} & SessionCreateField<TCreateOptions>;

export interface LoadPiAgentSessionInput<TMetadata extends SessionMetadata = SessionMetadata> {
  metadata: TMetadata;
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
    return this.wrap(await this.options.repository.create(createOptions), input.initialMessage, input.events);
  }

  async load(input: LoadPiAgentSessionInput<TMetadata>): Promise<PiAgentSession<TMetadata>> {
    return this.wrap(await this.options.repository.open(input.metadata), input.initialMessage, input.events);
  }

  private wrap(session: Session<TMetadata>, initialMessage: AgentInputMessage, events: EventCodecOptions): PiAgentSession<TMetadata> {
    const harness = new AgentHarness({
      session,
      models: this.options.models,
      model: this.options.model,
      systemPrompt: this.options.systemPrompt,
      tools: this.options.tools,
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

  constructor(
    private readonly session: Session<TMetadata>,
    private readonly harness: AgentHarness,
    initialMessage: AgentInputMessage,
    private readonly eventCodec: EventCodec,
  ) {
    this.pendingMessage = initialMessage;
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
    const unsubscribe = this.harness.subscribe((event) => {
      events.push(this.eventCodec.fromPi(event));
      wake?.();
      wake = undefined;
    });
    let cancelPromise: Promise<void> | undefined;
    const cancel = () => cancelPromise ??= (async () => {
      await this.harness.abort();
      await this.harness.waitForIdle();
    })();
    let removeSignalListener = () => {};
    let finalizePromise: Promise<void> | undefined;
    const active = {
      cancel,
      finalize: (cancelRunning = true) => finalizePromise ??= (async () => {
        if (cancelRunning && !finished) await cancel();
        removeSignalListener();
        unsubscribe();
        forceDone = true;
        events.length = 0;
        if (this.activeRun === active) this.activeRun = undefined;
        wake?.();
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
      if (failure) throw failure;
    } finally {
      try { await active.finalize(!finished); } catch (error) { failure ??= error; }
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

  setTools(tools: AgentHarnessTool<undefined>[]): Promise<void> {
    this.ensureOpen();
    return this.harness.setTools(tools, tools.map((tool) => tool.name));
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

  async close(): Promise<void> {
    this.closed = true;
    return this.closePromise ??= (async () => {
      const active = this.activeRun;
      if (active) {
        await active.cancel();
        await active.finalize(false);
      } else {
        await this.harness.abort();
        await this.harness.waitForIdle();
      }
    })();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Pi agent session is closed');
  }
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
