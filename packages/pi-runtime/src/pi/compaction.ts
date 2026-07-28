import {
  compact,
  prepareCompaction,
  type CompactionError,
  type CompactionPreparation,
  type CompactionSettings,
  type Result,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core';

export const preparePiCompaction = (
  entries: readonly SessionTreeEntry[],
  settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> => prepareCompaction([...entries], settings);

export const compactPiCompaction: typeof compact = compact;
export type { CompactionPreparation, CompactionSettings };
