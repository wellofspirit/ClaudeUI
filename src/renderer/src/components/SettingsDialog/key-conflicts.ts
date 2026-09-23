/**
 * "Keep them separate" on a key conflict (ADR-074 §6) — remembered for this app
 * run only, and shared by the Manage sheet (which hides its panel) and the list
 * (which hides its "2 different keys" chip), so the two never disagree.
 *
 * Keyed by the VENDOR and both hints, not by a row id: the conflict is one fact
 * about two rows, and a key replaced since is a new conflict worth asking about.
 */

export interface KeyConflictHints {
  opencode: string
  pi: string
}

const dismissed = new Set<string>()

const keyOf = (vendorId: string, hints: KeyConflictHints): string =>
  `${vendorId}\u0000${hints.opencode}\u0000${hints.pi}`

export function isConflictDismissed(vendorId: string, hints: KeyConflictHints): boolean {
  return dismissed.has(keyOf(vendorId, hints))
}

export function dismissConflict(vendorId: string, hints: KeyConflictHints): void {
  dismissed.add(keyOf(vendorId, hints))
}
