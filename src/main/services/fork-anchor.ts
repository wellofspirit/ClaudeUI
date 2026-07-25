/**
 * Pure core of the fork ("branch off") anchor resolver — ENGINE-dispatched
 * (session-history.ts's `resolveForkAnchor`) between two unrelated
 * resolution strategies, both kept free of electron/filesystem imports here
 * so they're unit-testable directly:
 *   - `findForkAnchorUuid` (Claude): matches the renderer's `ChatMessage.id`
 *     against the JSONL transcript. Disk-reading wrapper lives in
 *     session-history.ts (`resolveForkAnchor`'s Claude branch).
 *   - `findPiForkAnchorEntryId` (pi, M5c): POSITION-based — see its own doc
 *     comment below for why. Disk-reading wrapper lives in
 *     pi-session-list.ts (`resolvePiForkAnchor`).
 *
 * Given the parsed JSONL transcript lines of a session and the renderer's
 * `ChatMessage.id` for an assistant message, returns the JSONL line `uuid` to
 * pass to cli.js `--resume-session-at` — the LAST line of that assistant turn
 * (the assistant line itself, or its last trailing `tool_result` line). This
 * keeps the truncated prefix tool-cycle balanced: cli.js slices to
 * `lines.slice(0, w + 1)` where `lines[w].uuid === <anchor>`, so anchoring on a
 * bare assistant line that issued tools would drop the following tool_results
 * and leave a dangling `tool_use` → the API rejects the next turn with a 400.
 *
 * `messageId` is matched against the assistant line's `message.id` (the
 * `msg_xxx` API id the renderer carries for assistant messages), with a
 * fallback to a raw line `uuid` for callers that already hold one.
 */
export function findForkAnchorUuid(
  lines: Array<Record<string, unknown>>,
  messageId: string
): string | null {
  // Find the target assistant line: the LAST line whose message.id matches
  // (persisted turns are single-line, but be defensive); fall back to a direct
  // line-uuid match.
  let targetIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const msg = l.message as Record<string, unknown> | undefined
    if (l.type === 'assistant' && msg && msg.id === messageId) targetIdx = i
  }
  if (targetIdx < 0) targetIdx = lines.findIndex((l) => l.uuid === messageId)
  if (targetIdx < 0) return null

  const target = lines[targetIdx]
  const targetMsg = target.message as Record<string, unknown> | undefined
  const content = Array.isArray(targetMsg?.content)
    ? (targetMsg!.content as Array<Record<string, unknown>>)
    : []
  const pendingToolUseIds = new Set(
    content
      .filter((b) => b.type === 'tool_use' && typeof b.id === 'string')
      .map((b) => b.id as string)
  )

  // No tools → the assistant line itself is a balanced boundary.
  if (pendingToolUseIds.size === 0) {
    return typeof target.uuid === 'string' ? target.uuid : null
  }

  // Walk forward over the immediate tool_result user-lines that resolve this
  // turn's tool_uses. Stop at the next assistant turn.
  let anchorUuid = typeof target.uuid === 'string' ? target.uuid : null
  for (let i = targetIdx + 1; i < lines.length && pendingToolUseIds.size > 0; i++) {
    const l = lines[i]
    if (l.type === 'assistant') break
    if (l.type !== 'user') continue
    const msg = l.message as Record<string, unknown> | undefined
    const blocks = Array.isArray(msg?.content)
      ? (msg!.content as Array<Record<string, unknown>>)
      : []
    const resolvesHere = blocks.some(
      (b) =>
        b.type === 'tool_result' &&
        typeof b.tool_use_id === 'string' &&
        pendingToolUseIds.has(b.tool_use_id as string)
    )
    if (!resolvesHere) continue
    for (const b of blocks) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        pendingToolUseIds.delete(b.tool_use_id as string)
      }
    }
    if (typeof l.uuid === 'string') anchorUuid = l.uuid
  }

  return anchorUuid
}

// ---------------------------------------------------------------------------
// pi fork anchor (position-based — no line/message id to match against)
// ---------------------------------------------------------------------------

/**
 * Sentinel `anchorUuid` value meaning "clone the active branch as-is, do not
 * truncate" — returned when forking the LATEST message (no later user turn
 * exists to drop). Opaque to the renderer/store (flows through
 * `forkOrigin.anchorUuid` → `EngineSpawnOptions.resumeSessionAt` unchanged,
 * same as a real pi entryId would); only `PiSession.doStart` interprets it.
 */
export const PI_FORK_CLONE_LATEST_SENTINEL = 'pi:clone-latest'

/**
 * Pure core of the pi fork-anchor resolver. pi has no stable id ClaudeUI can
 * match a renderer message against (unlike Claude's JSONL line `uuid` —
 * see `findForkAnchorUuid` above): a LIVE assistant `ChatMessage.id` is a
 * uuid synthesized by event-mapper.ts, never pi's own entry id. But the fork
 * POSITION is stable — the store computes `idx`, the target message's index
 * in its own `messages` array, and that array is built by the SAME converter
 * (pi-session-list.ts's `convertPiSessionEntries`) whether live or replayed.
 * So `messages` here must be exactly that converter's output (id = the real
 * pi entryId, role = 'user'|'assistant'|'system') for position `messageIndex`
 * to line up with the caller's `idx`.
 *
 * `fork {entryId}` requires entryId to be a USER message on the active
 * branch (rpc.md) — it drops that entry and everything after. So: walk
 * forward from the slot right after the target for the first `role==='user'`
 * entry (skipping any `system` compaction slot in between — pi's tree
 * truncates by entry id, not by array position, so a compaction entry
 * between the target and the next user turn doesn't change WHAT to drop,
 * only its position) and return its id. If none follows — forking the
 * latest turn — return `PI_FORK_CLONE_LATEST_SENTINEL`: nothing to drop, so
 * `clone` (duplicate the branch at its current position) is the right
 * primitive, not `fork`.
 *
 * `messageIndex` out of range (the target itself isn't on disk yet — a
 * still-in-flight or otherwise unflushed message) returns null, mirroring
 * `findForkAnchorUuid`'s "message-not-found" contract.
 */
export function findPiForkAnchorEntryId(
  messages: Array<{ id: string; role: string }>,
  messageIndex: number
): string | null {
  if (messageIndex < 0 || messageIndex >= messages.length) return null
  for (let i = messageIndex + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') return messages[i].id
  }
  return PI_FORK_CLONE_LATEST_SENTINEL
}
