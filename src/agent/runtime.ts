import type { RunAgentOptions, RunAgentResult } from './core.js';
import type { AgentKernel, AgentKernelName } from './kernel.js';
import { LegacyAgentKernel } from './legacy-kernel.js';
import { LangGraphAgentKernel } from './langgraph/kernel.js';
import { logger } from '../logger.js';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

export interface AgentRuntimeOptions {
  kernel?: AgentKernel;
}

/** 供 HTTP、CLI、Scheduler 共用的稳定 Agent 运行入口。 */
export class AgentRuntime {
  readonly kernel: AgentKernel;

  constructor(options: AgentRuntimeOptions = {}) {
    this.kernel = options.kernel ?? new LegacyAgentKernel();
  }

  get kernelName(): AgentKernelName {
    return this.kernel.name;
  }

  run(options: RunAgentOptions): Promise<RunAgentResult> {
    return this.kernel.run(options);
  }
}

/** 兼容测试和外部调用方构造的旧 Runtime fixture。 */
export const defaultAgentRuntime = new AgentRuntime();

export function resolveAgentRuntime(runtime?: AgentRuntime): AgentRuntime {
  return runtime ?? defaultAgentRuntime;
}

export function createConfiguredAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: { checkpointer?: BaseCheckpointSaver } = {},
): AgentRuntime {
  const configured = env.AIOP_AGENT_KERNEL?.trim().toLowerCase();
  if (!configured || configured === 'legacy') return new AgentRuntime();
  if (configured !== 'langgraph') {
    logger.warn({ configured }, '未知 Agent Kernel，回退 Legacy Kernel');
    return new AgentRuntime();
  }
  try {
    return new AgentRuntime({ kernel: new LangGraphAgentKernel({ checkpointer: options.checkpointer }) });
  } catch (error) {
    logger.warn({ error: String(error) }, 'LangGraph Kernel 初始化失败，回退 Legacy Kernel');
    return new AgentRuntime();
  }
}
