import type { Msg, StreamEvent } from '../../model/types.js';
import { compactMessages, estimateTokens, isUserInputMsg, planCompaction, summaryMessage } from '../context.js';

export interface BoundaryCompactionOptions {
  summarize?: (stale: Msg[]) => Promise<string>;
  triggerTokens?: number;
  keepRecent?: number;
  keepImages?: number;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
}

/** 在模型轮次边界执行摘要压缩；失败时保持原消息并继续运行。 */
export async function compactAtBoundary(
  messages: Msg[],
  watermark: number,
  options: BoundaryCompactionOptions,
): Promise<boolean> {
  if (!options.summarize || !options.triggerTokens) return false;
  const beforeTokens = estimateTokens(messages);
  if (beforeTokens <= options.triggerTokens || beforeTokens <= watermark) return false;
  const { stale, recent } = planCompaction(messages, options.keepRecent ?? 8);
  if (!stale.length) return false;
  try {
    const summary = (await options.summarize(stale)).trim();
    throwIfAborted(options.signal);
    if (!summary) return false;
    const keptUserInputs = stale.filter(isUserInputMsg);
    const next = compactMessages(
      [...keptUserInputs, summaryMessage(summary), ...recent],
      0,
      options.keepImages ?? 1,
    );
    messages.splice(0, messages.length, ...next);
    options.onEvent?.({
      type: 'context_compacted',
      summarizedMessages: stale.length,
      beforeTokens,
      afterTokens: estimateTokens(messages),
    });
    return true;
  } catch {
    throwIfAborted(options.signal);
    return false;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === 'string' && signal.reason ? signal.reason : '运行已终止');
}
