import { useActiveSession } from '../stores/session-store'

/**
 * Is a subagent transcript on its way for `toolUseId`? True when the content-first
 * load's index lists one on disk (bytes > 0) and its bucket is not loaded yet
 * (ADR-102 Arc 2). A card or panel entry reads this to show "Loading…" instead of
 * the markdown result it would otherwise flash and swap, and to request the bucket
 * (`requestSubagentTranscript`) when the user opens it.
 *
 * Goes false the moment the bucket lands, and when the load gave up on it (the index
 * entry is zeroed), so a transcript that cannot be read does not spin forever.
 */
export function useSubagentPending(toolUseId: string): boolean {
  return useActiveSession(
    (s) => (s.subagentIndex?.[toolUseId]?.bytes ?? 0) > 0 && !s.subagentMessages[toolUseId]?.length
  )
}
