import type { RequestContext } from '../../auth/types.js';
import type { Store } from '../../db/store.js';
import type { ToolContentBlock } from '../../model/types.js';
import type { RunAgentResult } from '../run-types.js';

export interface CommitSuccessInput {
  ctx: RequestContext;
  sessionId: string;
  priorMessageCount: number;
  result: RunAgentResult;
  durationMs: number;
}

export interface CommitFailureInput {
  ctx: RequestContext;
  sessionId: string;
  task?: string;
  taskContentBlocks?: ToolContentBlock[];
  streamedText: string;
  streamedThinking: string;
  durationMs: number;
  error: unknown;
  terminated: boolean;
}

export class SessionCommitter {
  constructor(private readonly store: Store) {}

  async commitSuccess(input: CommitSuccessInput): Promise<void> {
    const finalAssistant = input.result.messages.findLast((message) => message.role === 'assistant');
    if (finalAssistant) finalAssistant.durationMs = input.durationMs;
    if (input.result.compacted) {
      await this.store.replaceMessages(input.ctx, input.sessionId, input.result.messages);
      await this.store.touchSession(input.ctx, input.sessionId, { updatedAt: new Date() });
      return;
    }
    await this.store.appendMessages(
      input.ctx,
      input.sessionId,
      input.result.messages.slice(input.priorMessageCount),
    );
  }

  async commitFailure(input: CommitFailureInput): Promise<void> {
    const finalLine = input.terminated
      ? '已终止当前运行。'
      : `运行失败：${input.error instanceof Error ? input.error.message : '运行失败'}`;
    const assistantText = [input.streamedText.trim(), finalLine].filter(Boolean).join('\n\n');
    await this.store.appendMessages(input.ctx, input.sessionId, [
      {
        role: 'user',
        text: input.task,
        contentBlocks: input.taskContentBlocks?.length ? input.taskContentBlocks : undefined,
      },
      {
        role: 'assistant',
        text: assistantText,
        thinking: input.streamedThinking.trim() || undefined,
        durationMs: input.durationMs,
      },
    ]);
  }
}
