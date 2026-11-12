/**
 * Pure assistant-SDK-message → ChatMessage conversion.
 *
 * Used by `claude-session.ts` and by the cross-engine dispatcher's headless
 * Claude targets (`dispatch-claude-targets.ts`), so live and forwarded
 * `session:subagent-message` carry the same `ChatMessage` shape. The block
 * mapping itself lives in `claude-transcript.ts`, shared with transcript replay
 * (`session-history.ts`) and the subagent tail (`subagent-watcher.ts`).
 * `AutomationManager.transformAssistantMessage` is the one separate mapper: it
 * drops unknown and empty blocks on purpose.
 *
 * Deliberately stateless — no `this`, no side effects — so it's safe to call
 * from either a live session or a headless dispatch target.
 */
import { v4 as uuid } from 'uuid'
import type { ChatMessage } from '../../shared/types'
import { claudeAssistantMessage } from './claude-transcript'

export function transformAssistantMessage(msg: Record<string, unknown>): ChatMessage | null {
  // The BetaMessage id (else the frame uuid) is the id partial snapshots dedupe on.
  return claudeAssistantMessage(msg, { fallbackId: uuid, timestamp: Date.now() })
}
