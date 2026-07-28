// file: context-manager.d.ts
import type { AgentRunUsage } from '@aiop/control-contracts';
import type { KernelMessage } from '@aiop/agent-runtime-core';
export interface ContextUsage {
    tokens: number;
    usageTokens: number;
    trailingTokens: number;
}
export interface CompactionPolicy {
    contextWindowTokens: number;
    reserveTokens: number;
    keepRecentTokens: number;
    enabled?: boolean;
}
export interface PreparedCompaction {
    tokensBefore: number;
    summarizedMessages: number;
    retainedMessages: KernelMessage[];
    handle: unknown;
}
export interface CompactedContext {
    summary: string;
    tokensBefore: number;
    usage?: AgentRunUsage;
    retainedMessages: KernelMessage[];
}
export interface ContextCompletionInput {
    system: string;
    messages: readonly KernelMessage[];
    sourceMessages: readonly KernelMessage[];
    maxTokens?: number;
    signal?: AbortSignal;
}
export interface ContextCompletionResult {
    text: string;
    usage?: AgentRunUsage;
}
export interface PiContextManagerOptions {
    complete(input: ContextCompletionInput): Promise<ContextCompletionResult>;
}
export interface ContextManager {
    inspect(messages: readonly KernelMessage[]): Promise<ContextUsage>;
    shouldCompact(usage: ContextUsage, policy: CompactionPolicy): boolean;
    contextTokens(usage: AgentRunUsage): number;
    prepare(messages: readonly KernelMessage[], policy: CompactionPolicy): PreparedCompaction | undefined;
    compact(input: {
        prepared: PreparedCompaction;
        instructions?: string;
        signal?: AbortSignal;
    }): Promise<CompactedContext>;
}
export declare class PiContextManager implements ContextManager {
    private readonly options?;
    constructor(options?: PiContextManagerOptions | undefined);
    inspect(messages: readonly KernelMessage[]): Promise<ContextUsage>;
    shouldCompact(usage: ContextUsage, policy: CompactionPolicy): boolean;
    contextTokens(usage: AgentRunUsage): number;
    prepare(messages: readonly KernelMessage[], policy: CompactionPolicy): PreparedCompaction | undefined;
    compact(input: {
        prepared: PreparedCompaction;
        instructions?: string;
        signal?: AbortSignal;
    }): Promise<CompactedContext>;
}

// file: index.d.ts
import { type ToolRuntime } from '@aiop/control-contracts';
import type { AgentKernel, KernelControl, KernelExit, KernelMessage, KernelRunInput, ModelConcurrencyController, ModelProvider } from '@aiop/agent-runtime-core';
import type { ContextManager } from './context-manager.js';
export * from './context-manager.js';
export interface PiAgentKernelOptions {
    modelProvider: ModelProvider;
    modelConcurrency?: ModelConcurrencyController;
    toolRuntime: ToolRuntime;
    systemPrompt?: string;
    protocolVersion?: string;
    getFollowUpMessages?: () => Promise<readonly KernelMessage[]>;
    transformContext?: (messages: readonly KernelMessage[], signal?: AbortSignal) => Promise<readonly KernelMessage[]>;
    context?: {
        manager: ContextManager;
        triggerTokens: number;
        keepRecentMessages: number;
        watermarkTokens?: number;
        summaryPrefix?: string;
    };
}
export declare class PiAgentKernel implements AgentKernel {
    private readonly options;
    readonly descriptor: {
        name: "pi";
        version: string;
        protocolVersion: string;
    };
    constructor(options: PiAgentKernelOptions);
    run(input: KernelRunInput, control: KernelControl): Promise<KernelExit>;
    private compactContext;
    private createTools;
    private resolveInteraction;
    private createStreamFn;
    private pumpModel;
    private forwardEvent;
}
