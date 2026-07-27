import type { RunAgentOptions, RunAgentResult } from './core.js';

/** 可观测、可配置的 Agent 执行内核名称。 */
export type AgentKernelName = 'pi' | 'legacy' | (string & {});

/**
 * AIoP Agent 执行内核稳定边界。
 *
 * 调用方只依赖完整的 RunAgentOptions / RunAgentResult 契约；具体内核不得绕过
 * AIoP 的模型、工具、安全、交互和事件适配能力。
 */
export interface AgentKernel {
  readonly name: AgentKernelName;
  run(options: RunAgentOptions): Promise<RunAgentResult>;
}
