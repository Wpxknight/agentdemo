import type { AgentInputMessage } from '@aiop/control-contracts';
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

export interface CreatePiAgentSessionInput<TCreateOptions extends SessionCreateOptions = SessionCreateOptions> {
  id?: string;
  session?: Omit<TCreateOptions, 'id'>;
  initialMessage: AgentInputMessage;
}

export interface LoadPiAgentSessionInput<TMetadata extends SessionMetadata = SessionMetadata> {
  metadata: TMetadata;
  initialMessage: AgentInputMessage;
}

export class PiAgentSessionFactory<
  TMetadata extends SessionMetadata = SessionMetadata,
  TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
  TListOptions = void,
> {
  constructor(private readonly options: PiAgentSessionFactoryOptions<TMetadata, TCreateOptions, TListOptions>) {}

  async create(input: CreatePiAgentSessionInput<TCreateOptions>): Promise<PiAgentSession<TMetadata>> {
    const createOptions = { ...input.session, ...(input.id ? { id: input.id } : {}) } as TCreateOptions;
    return this.wrap(await this.options.repository.create(createOptions), input.initialMessage);
  }

  async load(input: LoadPiAgentSessionInput<TMetadata>): Promise<PiAgentSession<TMetadata>> {
    return this.wrap(await this.options.repository.open(input.metadata), input.initialMessage);
  }

  private wrap(session: Session<TMetadata>, initialMessage: AgentInputMessage): PiAgentSession<TMetadata> {
    const harness = new AgentHarness({
      session,
      models: this.options.models,
      model: this.options.model,
      systemPrompt: this.options.systemPrompt,
      tools: this.options.tools,
      resources: this.options.resources,
    });
    return new PiAgentSession(session, harness, initialMessage);
  }
}

export class PiAgentSession<TMetadata extends SessionMetadata = SessionMetadata> {
  private closed = false;

  constructor(
    private readonly session: Session<TMetadata>,
    private readonly harness: AgentHarness,
    private readonly initialMessage: AgentInputMessage,
  ) {}

  continue(signal?: AbortSignal): AsyncIterable<AgentHarnessEvent> {
    this.ensureOpen();
    if (signal?.aborted) {
      return {
        async *[Symbol.asyncIterator]() {
          throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
        },
      };
    }
    const events: AgentHarnessEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: unknown;
    const unsubscribe = this.harness.subscribe((event) => {
      events.push(event);
      wake?.();
      wake = undefined;
    });
    const abort = () => { void this.harness.abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    const { text, images } = promptParts(this.initialMessage);
    const run = this.harness.prompt(text, images.length ? { images } : undefined).then(
      () => { finished = true; wake?.(); },
      (error) => { failure = error; finished = true; wake?.(); },
    );
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!finished || events.length) {
            if (events.length) {
              yield events.shift()!;
              continue;
            }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
          if (failure) throw failure;
        } finally {
          signal?.removeEventListener('abort', abort);
          unsubscribe();
        }
      },
    };
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
    this.ensureOpen();
    await this.harness.abort();
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
    if (this.closed) return;
    await this.harness.abort();
    await this.harness.waitForIdle();
    this.closed = true;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Pi agent session is closed');
  }
}

function promptParts(message: AgentInputMessage): { text: string; images: ImageContent[] } {
  const content = message.content ?? [];
  const text = [message.text, ...content.filter((block) => block.type === 'text').map((block) => block.text)]
    .filter((part): part is string => Boolean(part)).join('\n');
  const images = content.filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image')
    .map((block) => ({ type: 'image' as const, data: block.data, mimeType: block.mimeType }));
  return { text, images };
}
