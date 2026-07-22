import { randomUUID } from 'node:crypto';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { AgentKernel } from '../kernel.js';
import type { RunAgentOptions, RunAgentResult } from '../core.js';
import { createAgentGraph } from './graph.js';
import { initialAgentGraphState } from './state.js';
import { DEFAULT_AGENT_GRAPH_NAME, DEFAULT_AGENT_GRAPH_VERSION } from './registry.js';
import { Command, isInterrupted } from '@langchain/langgraph';

export interface LangGraphAgentKernelOptions {
  threadIdFactory?: () => string;
  checkpointer?: BaseCheckpointSaver;
  graphName?: string;
  graphVersion?: string;
  checkpointRetentionMs?: number;
}

export class LangGraphAgentKernel implements AgentKernel {
  readonly name = 'langgraph' as const;
  private readonly threadIdFactory: () => string;
  private readonly checkpointer?: BaseCheckpointSaver;
  private readonly graphName: string;
  private readonly graphVersion: string;
  private readonly checkpointRetentionMs: number;

  constructor(options: LangGraphAgentKernelOptions = {}) {
    this.threadIdFactory = options.threadIdFactory ?? randomUUID;
    this.checkpointer = options.checkpointer;
    this.graphName = options.graphName ?? DEFAULT_AGENT_GRAPH_NAME;
    this.graphVersion = options.graphVersion ?? DEFAULT_AGENT_GRAPH_VERSION;
    this.checkpointRetentionMs = options.checkpointRetentionMs ?? 24 * 60 * 60 * 1000;
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
    const threadId = options.runId ?? this.threadIdFactory();
    const graph = createAgentGraph(options, this.checkpointer);
    const config = {
        configurable: {
          thread_id: threadId,
          tenant_id: options.ctx.tenantId ?? 'default',
          run_id: threadId,
          graph_name: this.graphName,
          graph_version: this.graphVersion,
          checkpoint_expires_at: new Date(Date.now() + this.checkpointRetentionMs).toISOString(),
        },
        recursionLimit: Number.isFinite(options.maxSteps)
          ? Math.max(10, (options.maxSteps ?? 1) * 3 + 5)
          : 10_000,
      };
    let input: unknown = options.resumeFromCheckpoint
      ? null
      : initialAgentGraphState(messages, options.compactionWatermarkTokens);
    let state: Awaited<ReturnType<typeof graph.invoke>>;
    for (;;) {
      state = await graph.invoke(input as never, config);
      if (!isInterrupted(state)) break;
      if (!options.durableInteractions) throw new Error('LangGraph 运行被中断，但未配置 durable interaction bridge');
      await options.runLifecycle?.waiting({ interactions: state.__interrupt__.length });
      const resolutions = await Promise.all(state.__interrupt__.map(async (entry) => {
        const value = entry.value as { interactionId?: unknown };
        if (typeof value?.interactionId !== 'string') throw new Error('LangGraph interrupt 缺少 interactionId');
        return [entry.id, await options.durableInteractions!.wait(value.interactionId)] as const;
      }));
      input = new Command({
        resume: resolutions.length === 1 ? resolutions[0]![1] : Object.fromEntries(resolutions),
      });
      await options.runLifecycle?.running({ resumedInteractions: resolutions.length });
    }
    return {
      messages: state.messages,
      text: state.text,
      steps: state.steps,
      usage: state.usage,
      compacted: state.compacted,
    };
  }
}
