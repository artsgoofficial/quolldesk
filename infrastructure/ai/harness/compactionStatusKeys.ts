/** i18n keys for compaction status — resolved in useAgentCompactionUi. */
export const QUOLL_COMPACTION_STATUS_KEYS = {
  preTurn: 'ai.chat.compactingContext',
  step: 'ai.chat.compactingStep',
  retry: 'ai.chat.compactionRetry',
} as const;

export type QuollCompactionStatusKey =
  typeof QUOLL_COMPACTION_STATUS_KEYS[keyof typeof QUOLL_COMPACTION_STATUS_KEYS];
