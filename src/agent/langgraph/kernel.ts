import { randomUUID } from 'node:crypto';
import type { AgentKernel } from '../kernel.js';
import type { RunAgentOptions, RunAgentResult } from '../core.js';
import { createAgentGraph } from './graph.js';
import { initialAgentGraphState } from './state.js';

export interface LangGraphAgentKernelOptions {
  threadIdFactory?: () => string;
}

export class LangGraphAgentKernel implements AgentKernel {
  readonly name = 'langgraph' as const;
  private readonly threadIdFactory: () => string;

  constructor(options: LangGraphAgentKernelOptions = {}) {
    this.threadIdFactory = options.threadIdFactory ?? randomUUID;
  }

  async run(options: RunAgentOptions): Promise<RunAgentResult> {
    const messages = options.messages ? [...options.messages] : [];
    if (options.task || options.taskContentBlocks?.length) {
      messages.push({
        role: 'user',
        text: options.task,
        contentBlocks: options.taskContentBlocks?.length ? options.taskContentBlocks : undefined,
      });
    }
    const threadId = this.threadIdFactory();
    const graph = createAgentGraph(options);
    const state = await graph.invoke(
      initialAgentGraphState(messages, options.compactionWatermarkTokens),
      {
        configurable: { thread_id: threadId },
        recursionLimit: Number.isFinite(options.maxSteps)
          ? Math.max(10, (options.maxSteps ?? 1) * 3 + 5)
          : 10_000,
      },
    );
    return {
      messages: state.messages,
      text: state.text,
      steps: state.steps,
      usage: state.usage,
      compacted: state.compacted,
    };
  }
}
