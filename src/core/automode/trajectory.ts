/**
 * What a dispatched target or a host-run child agent did, kept for its judge
 * and its task card (ADR-087 D1, ADR-088): its own assistant trajectory and
 * the distinct tool_use ids of the turn in flight.
 *
 * A leaf module (type-only shared imports) so both the cross-engine
 * dispatcher and `pi/pi-child-runner.ts` can use it without a require cycle.
 */
import type { ChatMessage } from '../../shared/types'

/** How many of the target's own assistant messages the judge may see (most recent kept). */
export const TARGET_TRAJECTORY_MAX = 200

/**
 * Upsert one of the target's forwarded messages into its trajectory (ADR-087
 * D1): assistant messages only, keyed by message id (a streamed message is
 * re-forwarded as it grows — the latest copy wins, at its first position),
 * insertion-ordered, bounded to {@link TARGET_TRAJECTORY_MAX} by dropping the
 * OLDEST. User-role messages never enter: on a target they are the dispatching
 * agent's prompts or tool results, and `slimTranscript` would render a prompt
 * as a `User:` line — the very authorisation the judge must only take from the
 * parent's human turns.
 */
export function recordTrajectoryMessage(
  trajectory: Map<string, ChatMessage>,
  message: ChatMessage,
  max: number = TARGET_TRAJECTORY_MAX
): void {
  if (message.role !== 'assistant') return
  trajectory.set(message.id, message)
  while (trajectory.size > max) {
    const oldest = trajectory.keys().next().value
    if (oldest === undefined) break
    trajectory.delete(oldest)
  }
}

/**
 * Collect the `tool_use` block IDS from a forwarded assistant message into the
 * per-turn set — the best-effort `toolUses` figure in `TaskNotification.usage`
 * (ADR-033 M4-B) is that set's size at turn end. A SET (not a counter) because
 * the same assistant message is forwarded repeatedly: Claude targets run
 * `includePartialMessages` (each partial re-carries the same blocks under the
 * same betaMessage id), and the opencode SSE tap re-emits the whole rebuilt
 * message on every `message.part.updated` (event-mapper's upsert-by-message-id
 * model). A counter would re-count the same tool_use on every emission.
 * Shared by both directions' streaming taps (and, since ADR-088, by
 * `PiChildRunner`, which streams the pi target and pi subagents).
 */
export function collectToolUseIds(message: ChatMessage, into: Set<string>): void {
  for (const block of message.content) {
    if (block.type === 'tool_use') into.add(block.toolUseId)
  }
}
