import { wildcardMatch } from './wildcard'

/**
 * ADR-085 S2 — the host-side "allow for this session" memory of ONE ClaudeUI
 * opencode chat.
 *
 * Why host-side. opencode's own memory is the `approved` list an `always`
 * reply fills (vendor/opencode-src/packages/opencode/src/permission/index.ts
 * `reply()`: each `info.always` pattern is pushed as an allow rule). That list
 * lives in the per-directory Instance state, not in the session, and `ask()`
 * evaluates EVERY session's request against `ruleset, approved` with
 * last-match-wins (`evaluate` → `findLast`) — so an approved pattern outranks
 * the compiled deny/ask rules, for every chat, child session and dispatch
 * target in that folder, until the server exits, with no rule, judge or card
 * in the way (H1 / review B1). One innocent `git push origin feat` approved
 * for the session let every later `git push --force …` run server-side.
 * ClaudeUI therefore never replies `always` any more; it replies `once` and
 * remembers the approval here.
 *
 * Keyed by the ask's own `always` patterns (the owner's "Session approvals
 * keying"): opencode already computed them — for a shell call the arity prefix
 * plus ` *` per statement (`tool/shell.ts`: `git push origin feat` →
 * `git push *`), `["*"]` for edit / webfetch / MCP (`tool/edit.ts`,
 * `tool/webfetch.ts`, `session/tools.ts`), the directory globs for
 * `external_directory`. That is exactly what an `always` used to approve, so
 * the UX a click buys is unchanged; only where the memory lives moves.
 *
 * Scope: one instance per OpencodeSession (per ClaudeUI chat), covering that
 * chat's own asks and its task children's; nothing here ever reaches the
 * server, and another chat in the same folder never sees it.
 *
 * Order: the caller consults it AFTER the user's deny/ask rules (the host
 * pre-check, `host-precheck.ts`), so a session allow can never beat a rule —
 * pi parity: in `decideWithSource` (`pi/permission-engine.ts`)
 * `sessionAllows` sits after the ask tier.
 */
export class OpencodeSessionAllows {
  /** permission → the `always` patterns approved under it (insertion order). */
  private readonly byPermission = new Map<string, string[]>()

  /** Remember an approved ask: one entry per `always` pattern under its permission. */
  add(permission: string, always: readonly string[]): void {
    // No `always` → nothing to remember: opencode's own `reply()` loops over
    // `info.always` too, so such an ask was never rememberable there either.
    if (always.length === 0) return
    const stored = this.byPermission.get(permission) ?? []
    for (const pattern of always) {
      if (!stored.includes(pattern)) stored.push(pattern)
    }
    this.byPermission.set(permission, stored)
  }

  /**
   * Covered iff EVERY pattern (an absent/empty list = `['*']`) wildcard-matches
   * a stored pattern of that permission. The same test opencode's `reply()`
   * cascade runs over `approved` (`item.info.patterns.every(pattern =>
   * evaluate(item.info.permission, pattern, approved).action === "allow")`),
   * permission compared by `Wildcard.match` as its `evaluate` does.
   *
   * `platform` is injectable like {@link wildcardMatch}'s (win32 matches
   * case-insensitively).
   */
  covers(
    permission: string,
    patterns: readonly string[] | undefined,
    platform: NodeJS.Platform = process.platform
  ): boolean {
    const stored: string[] = []
    for (const [storedPermission, list] of this.byPermission) {
      if (wildcardMatch(permission, storedPermission, platform)) stored.push(...list)
    }
    if (stored.length === 0) return false
    const list = patterns && patterns.length > 0 ? patterns : ['*']
    return list.every((pattern) => stored.some((s) => wildcardMatch(pattern, s, platform)))
  }

  /** How many patterns are remembered, across every permission. */
  get size(): number {
    let n = 0
    for (const list of this.byPermission.values()) n += list.length
    return n
  }
}
