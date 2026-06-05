/**
 * Pure core of the fork ("branch off") anchor resolver. Kept free of electron
 * / filesystem imports so it can be unit-tested directly; the disk-reading
 * wrapper lives in session-history.ts (`resolveForkAnchor`).
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
    const blocks = Array.isArray(msg?.content) ? (msg!.content as Array<Record<string, unknown>>) : []
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
