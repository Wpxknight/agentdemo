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
