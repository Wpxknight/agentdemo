import type { RunAgentOptions, RunAgentResult } from './core.js';
import type { AgentKernel, AgentKernelName } from './kernel.js';
import { LegacyAgentKernel } from './legacy-kernel.js';

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
