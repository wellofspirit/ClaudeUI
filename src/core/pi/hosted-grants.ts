/**
 * One-shot `/hosted-tool` execution grants (SECURITY, A1) — shared by
 * PiSession's own bridge and every host-run subagent's bridge (ADR-089), so
 * the mint / consume / withhold-after-abandon rules exist once.
 *
 *  - `mint` records `toolCallId -> toolName` the instant `/tool-call` decided
 *    'allow' for a hosted tool. Without a grant, the bearer token alone would
 *    gate `/hosted-tool` — and that token sits in the pi child's env, reachable
 *    from any already-approved bash command.
 *  - `consume` requires a grant for this EXACT id AND name and deletes it on
 *    the first matching lookup; a mismatched or second use fails closed.
 *  - `abandon` (PiBridgeHost's "Long-poll protocol"): pi stopped waiting for
 *    this exchange. A grant already minted is dropped, and one NOT minted yet
 *    is withheld when its late `allow` arrives (an auto-mode-judged call has
 *    no pending card to force-deny, so its 'allow' can land seconds after the
 *    host dropped the exchange).
 *
 * Both maps are bounded to {@link MAX_HOSTED_GRANTS} entries, oldest evicted
 * first (Map/Set insertion order), so a long-running session cannot grow them
 * without limit. Evicting an old abandonment is safe: the worst case is the
 * pre-fix behaviour for a gate in flight past 256 later abandonments.
 */
export const MAX_HOSTED_GRANTS = 256

export class HostedGrants {
  private readonly grants = new Map<string, string>()
  private readonly abandoned = new Set<string>()

  /**
   * Mint a grant for an allowed hosted-tool call. Returns false (and mints
   * nothing) when the exchange was abandoned before the gate resolved — the
   * allow is then authority for a call pi will never make. The withhold is
   * consumed one-shot, so a LATER exchange reusing the id is unaffected.
   */
  mint(toolCallId: string, toolName: string): boolean {
    if (this.abandoned.delete(toolCallId)) return false
    this.grants.set(toolCallId, toolName)
    if (this.grants.size > MAX_HOSTED_GRANTS) {
      const oldest = this.grants.keys().next().value
      if (oldest !== undefined) this.grants.delete(oldest)
    }
    return true
  }

  /** True (and the grant is gone) iff a grant exists for exactly this id and name. */
  consume(toolCallId: string, toolName: string): boolean {
    const granted = this.grants.get(toolCallId)
    if (granted === undefined || granted !== toolName) return false
    this.grants.delete(toolCallId)
    return true
  }

  /** pi abandoned the `/tool-call` exchange for this id: drop any grant, withhold a late one. */
  abandon(toolCallId: string): void {
    this.grants.delete(toolCallId)
    this.abandoned.add(toolCallId)
    if (this.abandoned.size > MAX_HOSTED_GRANTS) {
      const oldest = this.abandoned.values().next().value
      if (oldest !== undefined) this.abandoned.delete(oldest)
    }
  }

  /** Drop every grant (a turn being torn down must not leave usable tickets behind). */
  clear(): void {
    this.grants.clear()
  }
}

/** The fail-closed result for a `/hosted-tool` call with no matching grant. */
export function notApprovedHostedTool(): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return {
    content: [{ type: 'text', text: 'hosted tool call was not approved through the tool gate' }],
    isError: true
  }
}
