import {
  compact,
  prepareCompaction,
  type CompactionError,
  type CompactionPreparation,
  type CompactionSettings,
  type AgentMessage,
  type Result,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core';

export const preparePiCompaction = (
  messagesOrEntries: readonly AgentMessage[] | readonly SessionTreeEntry[],
  settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> => prepareCompaction(
  isSessionEntries(messagesOrEntries) ? [...messagesOrEntries] : messagesOrEntries.map((message, index) => ({
    type: 'message' as const,
    id: `message-${index}`,
    parentId: index ? `message-${index - 1}` : null,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  })),
  settings,
);

export const compactPiCompaction: typeof compact = compact;
export type { CompactionPreparation, CompactionSettings };

function isSessionEntries(
  values: readonly AgentMessage[] | readonly SessionTreeEntry[],
): values is readonly SessionTreeEntry[] {
  return values.length === 0 || ('id' in values[0]! && 'parentId' in values[0]!);
}
