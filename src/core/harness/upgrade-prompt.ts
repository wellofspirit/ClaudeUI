/**
 * The one-time upgrade sheet (ADR-082 §8): on the first launch without the
 * bundled engines, offer to install the harnesses this profile used.
 *
 * A harness is a candidate when all of these hold:
 *
 *   - it is not Claude Code (still bundled);
 *   - this profile has at least one session on it (`session_meta.engine_id`);
 *   - nothing runs for it now (the resolver's `available`);
 *   - its selection is ClaudeUI's copy (`managed`): a System selection that
 *     cannot run is the composer banner's job, not the sheet's;
 *   - detection found no usable System install (the System segment would run
 *     it, so there is nothing to download);
 *   - ClaudeUI can install it on this host (`installable`).
 *
 * The prompt is evaluated once the boot detection has finished (or at once
 * when detection is off), so a usable System install found at boot is not
 * offered. That first evaluation marks the prompt answered silently when there
 * is nothing to offer: a profile that used none, or whose harnesses are all
 * installed, never sees the sheet, then or later. Otherwise the candidates are
 * recomputed on every `harness:state` read until the user answers (Install or
 * Not now); the answer is `upgradePrompt: "answered"` in `harnesses.json`.
 *
 * This module owns the rule and the in-memory "evaluated" latch; the state
 * snapshot (`core/ipc/harness-commands.ts`) feeds it the entries and the
 * session counts.
 */
import type {
  HarnessId,
  HarnessStateEntry,
  HarnessUpgradeCandidate
} from '../../shared/harness-types'
import { HARNESS_IDS } from '../../shared/harness-types'
import { logger } from '../services/logger'
import { saveHarnessesConfig } from './selection-store'

/** The sheet's rows, in harness order. Pure. */
export function upgradeCandidates(
  harnesses: Readonly<Record<HarnessId, HarnessStateEntry>>,
  sessions: Readonly<Record<string, number>>
): HarnessUpgradeCandidate[] {
  const out: HarnessUpgradeCandidate[] = []
  for (const id of HARNESS_IDS) {
    if (id === 'claude') continue
    const entry = harnesses[id]
    const count = sessions[id] ?? 0
    if (!entry || count <= 0) continue
    if (entry.resolved.available) continue
    if (entry.selection.source !== 'managed') continue
    if (entry.system.choice.kind === 'ok') continue
    if (!entry.installable) continue
    out.push({ id, sessions: count })
  }
  return out
}

// ── The evaluated latch and change notifications ─────────────────────────────

let evaluated = false
const listeners = new Set<(ids: readonly HarnessId[]) => void>()

/** Has the boot evaluation run in this process? Before it, nothing is pending. */
export function upgradePromptEvaluated(): boolean {
  return evaluated
}

export function markUpgradePromptEvaluated(): void {
  evaluated = true
}

/** Tell clients the prompt moved (it became pending, or was answered). */
export function notifyUpgradePromptChanged(ids: readonly HarnessId[]): void {
  for (const fn of listeners) {
    try {
      fn(ids)
    } catch (err) {
      logger.warn('harness', 'upgrade prompt listener failed', err)
    }
  }
}

/** Subscribe to `notifyUpgradePromptChanged`. Returns the unsubscribe function. */
export function onUpgradePromptChanged(fn: (ids: readonly HarnessId[]) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The harnesses the sheet can ever offer: every nudge names them all. */
export const UPGRADE_HARNESSES: readonly HarnessId[] = HARNESS_IDS.filter((id) => id !== 'claude')

/** Record the answer in `harnesses.json` (unknown keys survive) and tell clients. */
export function answerUpgradePrompt(file?: string): void {
  saveHarnessesConfig({ upgradePrompt: 'answered' }, file)
  notifyUpgradePromptChanged(UPGRADE_HARNESSES)
}

/** Test seam: forget the latch. */
export function resetUpgradePromptForTests(): void {
  evaluated = false
}
