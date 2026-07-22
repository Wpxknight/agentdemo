import { runAgent, type RunAgentOptions, type RunAgentResult } from './core.js';
import type { AgentKernel } from './kernel.js';

/** 现有 runAgent() 的零行为变更适配器。 */
export class LegacyAgentKernel implements AgentKernel {
  readonly name = 'legacy' as const;

  run(options: RunAgentOptions): Promise<RunAgentResult> {
    return runAgent(options);
  }
}
