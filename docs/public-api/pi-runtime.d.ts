// file: index.d.ts
export * from './pi/agent.js';
export * from './pi/compatibility.js';
export * from './pi/compaction.js';
export { EventCodec } from './pi/event-codec.js';
export type { EventCodecOptions } from './pi/event-codec.js';
export * from './pi/message-codec.js';
export * from './pi/models.js';
export * from './pi/session.js';
export * from './pi/skills.js';
export * from './pi/tool-bridge.js';

// file: pi/agent.d.ts
import type { AgentInputMessage, AgentRunEvent } from '@aiop/control-contracts';
import { AgentHarness, type AgentHarnessResources, type AgentHarnessTool, type Session, type SessionCreateOptions, type SessionMetadata, type SessionRepo, type SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { Model, Models } from '@earendil-works/pi-ai';
import { EventCodec, type EventCodecOptions } from './event-codec.js';
export interface PiAgentSessionFactoryOptions<TMetadata extends SessionMetadata, TCreateOptions extends SessionCreateOptions, TListOptions> {
    repository: SessionRepo<TMetadata, TCreateOptions, TListOptions>;
    models: Models;
    model: Model<any>;
    systemPrompt?: string;
    tools?: AgentHarnessTool<undefined>[];
    resources?: AgentHarnessResources;
}
type RequiredKeys<T> = {
    [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];
type SessionCreateField<TCreateOptions extends SessionCreateOptions> = [
    RequiredKeys<Omit<TCreateOptions, 'id'>>
] extends [never] ? {
    session?: Omit<TCreateOptions, 'id'>;
} : {
    session: Omit<TCreateOptions, 'id'>;
};
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
export declare class PiAgentSessionFactory<TMetadata extends SessionMetadata = SessionMetadata, TCreateOptions extends SessionCreateOptions = SessionCreateOptions, TListOptions = void> {
    private readonly options;
    constructor(options: PiAgentSessionFactoryOptions<TMetadata, TCreateOptions, TListOptions>);
    create(input: CreatePiAgentSessionInput<TCreateOptions>): Promise<PiAgentSession<TMetadata>>;
    load(input: LoadPiAgentSessionInput<TMetadata>): Promise<PiAgentSession<TMetadata>>;
    private wrap;
}
export declare class PiAgentSession<TMetadata extends SessionMetadata = SessionMetadata> {
    private readonly session;
    private readonly harness;
    private readonly eventCodec;
    private closed;
    private closePromise?;
    private pendingMessage?;
    private activeRun?;
    private governedToolScope;
    private removeGovernedToolHook;
    constructor(session: Session<TMetadata>, harness: AgentHarness, initialMessage: AgentInputMessage, eventCodec: EventCodec);
    continue(signal?: AbortSignal): AsyncIterable<AgentRunEvent>;
    private iterate;
    steer(message: AgentInputMessage): Promise<void>;
    followUp(message: AgentInputMessage): Promise<void>;
    abort(): Promise<void>;
    setTools(tools: AgentHarnessTool<undefined>[]): Promise<void>;
    tools(): AgentHarnessTool<undefined>[];
    metadata(): Promise<TMetadata>;
    entries(): Promise<SessionTreeEntry[]>;
    close(): Promise<void>;
    private installGovernedToolHook;
    private ensureOpen;
}
export {};

// file: pi/compaction.d.ts
import { compact, type CompactionError, type CompactionPreparation, type CompactionSettings, type Result, type SessionTreeEntry } from '@earendil-works/pi-agent-core';
export declare const preparePiCompaction: (entries: readonly SessionTreeEntry[], settings: CompactionSettings) => Result<CompactionPreparation | undefined, CompactionError>;
export declare const compactPiCompaction: typeof compact;
export type { CompactionPreparation, CompactionSettings };

// file: pi/compatibility.d.ts
import type { Usage } from '@earendil-works/pi-ai';
export type CompatibleContentBlock = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    mimeType: string;
    data: string;
} | {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: string;
};
export interface PiContentExtension {
    version: 1;
    kind: 'pi_content_block';
    value: unknown;
    index?: number;
}
export type CompatibleAgentMessage = {
    role: 'user';
    content: string | CompatibleContentBlock[];
    timestamp: number;
    extensions?: PiContentExtension[];
} | {
    role: 'assistant';
    content: CompatibleContentBlock[];
    api: string;
    provider: string;
    model: string;
    responseModel?: string;
    responseId?: string;
    diagnostics?: unknown[];
    usage: Usage;
    stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
    errorMessage?: string;
    timestamp: number;
    extensions?: PiContentExtension[];
} | {
    role: 'toolResult';
    toolCallId: string;
    toolName: string;
    content: CompatibleContentBlock[];
    details?: unknown;
    usage?: Usage;
    addedToolNames?: string[];
    isError: boolean;
    timestamp: number;
    extensions?: PiContentExtension[];
};

// file: pi/event-codec.d.ts
import type { AgentRunEvent, JsonValue } from '@aiop/control-contracts';
import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core';
export interface EventCodecOptions {
    tenantId: string;
    runId: string;
    attemptId: string;
    turnNo: number;
    correlationId: string;
    sequence: () => bigint;
    now?: () => Date;
}
export declare class EventCodec {
    private readonly options;
    private readonly now;
    constructor(options: EventCodecOptions);
    fromPi(event: AgentHarnessEvent): AgentRunEvent;
}
export declare function toDurableJsonValue(value: unknown): JsonValue;

// file: pi/governed-tool-state.d.ts
import type { ToolCall, ToolResult } from '@aiop/control-contracts';
import type { AgentHarnessEvent, AgentHarnessTool } from '@earendil-works/pi-agent-core';
export interface GovernedToolFailure {
    call: ToolCall;
    result: ToolResult;
}
export interface GovernedToolFailureTracker {
    failures: Map<string, GovernedToolFailure[]>;
}
interface GovernedToolDescriptor {
    createScoped(): {
        tool: AgentHarnessTool<undefined>;
        tracker: GovernedToolFailureTracker;
    };
}
export interface GovernedToolScope {
    tools: AgentHarnessTool<undefined>[];
    patch(event: Extract<AgentHarnessEvent, {
        type: 'tool_result';
    }>): {
        details: unknown;
        isError: true;
    } | undefined;
    hasPending(): boolean;
    clear(): void;
}
export declare function createGovernedToolFailureTracker(): GovernedToolFailureTracker;
export declare function markGovernedToolPrototype(tool: AgentHarnessTool<undefined>, descriptor: GovernedToolDescriptor): void;
export declare function markScopedGovernedTool(tool: AgentHarnessTool<undefined>, tracker: GovernedToolFailureTracker): void;
export declare function recordGovernedToolFailure(tracker: GovernedToolFailureTracker, toolCallId: string, failure: GovernedToolFailure): void;
export declare function scopeGovernedTools(tools: readonly AgentHarnessTool<undefined>[]): GovernedToolScope;
export declare function adoptGovernedToolScope(tools: readonly AgentHarnessTool<undefined>[]): GovernedToolScope;
export {};

// file: pi/message-codec.d.ts
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { CompatibleAgentMessage } from './compatibility.js';
export declare class MessageCodec {
    toPi(message: CompatibleAgentMessage): AgentMessage;
    fromPi(message: AgentMessage): CompatibleAgentMessage;
}

// file: pi/models.d.ts
export type { Model, Models } from '@earendil-works/pi-ai';
/** Pi model calls are delegated directly to Models; this layer intentionally owns no retry policy. */
export declare const PI_KERNEL_VERSION = "0.82.1";

// file: pi/session.d.ts
export { InMemorySessionRepo, JsonlSessionRepo, Session, type SessionMetadata, type SessionRepo, type SessionTreeEntry, } from '@earendil-works/pi-agent-core';

// file: pi/skills.d.ts
export { formatSkillsForSystemPrompt, loadSourcedSkills, loadSkills, type Skill, type SkillDiagnostic, } from '@earendil-works/pi-agent-core';

// file: pi/tool-bridge.d.ts
import type { JsonValue, ToolCall, ToolDefinition, ToolResult } from '@aiop/control-contracts';
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core';
export interface GovernedTool {
    definition: ToolDefinition;
    /** Optional migration resolver. New durable integrations should supply a stable logical id. */
    logicalCallId?: (toolCallId: string, argumentsValue: JsonValue) => string;
    execute(call: ToolCall, context: GovernedToolExecutionContext): Promise<ToolResult>;
}
export interface GovernedToolExecutionContext {
    signal?: AbortSignal;
    logicalCallId: string;
    piContext?: unknown;
}
export interface GovernedToolBridgeOptions {
    resolveLogicalCallId?: (input: {
        toolCallId: string;
        tool: ToolDefinition;
        arguments: JsonValue;
    }) => string;
}
export declare class GovernedToolExecutionError extends Error {
    readonly call: ToolCall;
    readonly result: ToolResult;
    constructor(message: string, call: ToolCall, result: ToolResult, cause?: unknown);
}
export declare function bridgeGovernedTools(tools: readonly GovernedTool[], options?: GovernedToolBridgeOptions): AgentHarnessTool<undefined>[];
