import { type AgentKernel, type KernelControl, type KernelExit, type KernelMessage, type KernelRunInput, type ModelConcurrencyController, type ModelProvider, type ToolRuntime } from '@aiop/agent-contracts';
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
