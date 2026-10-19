/**
 * Progress of loading a session's transcript, as the loading view shows it
 * (ADR-102).
 *
 * The content-first Claude read (`deferStatusLine`, Arc 2) plans only the
 * transcript pass in bytes: the first frame carries `total = M` (the main
 * transcript's size) and the read's last frame is `done = M`. The status line and
 * the subagent transcripts load afterwards, in the background (see
 * `subagent-prefetch.ts`), and are not part of this bar. This module is a small
 * state machine that turns the frames into one monotonic
 * {@link TranscriptLoadProgress}.
 */

import type { InvokeProgress } from '../../../shared/remote-protocol'

export type TranscriptLoadPhase = 'reading' | 'receiving'

export interface TranscriptLoadProgress {
  /** 0..1, or null when the total is unknown (an engine without byte progress). */
  fraction: number | null
  phase: TranscriptLoadPhase
  doneBytes: number
  totalBytes: number | null
  /** Estimated milliseconds left, or null while it would be a guess. */
  etaMs: number | null
}

/** The ETA is a guess until this fraction is done and this long has passed. */
const ETA_MIN_FRACTION = 0.05
const ETA_MIN_ELAPSED_MS = 300

export interface LoadProgressTracker {
  /** Announce the load: indeterminate until a frame names a total. */
  start(): void
  /** A progress frame from the history read. */
  history(frame: InvokeProgress): void
  /** Everything is in memory and about to be committed: 100% when the total is known. */
  finish(): void
}

export function createLoadProgress(
  emit: (progress: TranscriptLoadProgress) => void,
  now: () => number = Date.now
): LoadProgressTracker {
  const startedAt = now()
  let total: number | null = null
  let done = 0
  let phase: TranscriptLoadPhase = 'reading'

  const push = (etaAllowed = true): void => {
    // Monotonic by construction: `total` is fixed by the first frame and `done`
    // only ever rises (max over frames).
    const f = total !== null && total > 0 ? Math.min(1, done / total) : null
    const elapsed = now() - startedAt
    const etaMs =
      etaAllowed && f !== null && f < 1 && f >= ETA_MIN_FRACTION && elapsed >= ETA_MIN_ELAPSED_MS
        ? (elapsed * (1 - f)) / f
        : null
    emit({ fraction: f, phase, doneBytes: done, totalBytes: total, etaMs })
  }

  return {
    start: () => push(),
    history(frame) {
      // The FIRST frame fixes the plan; a later total is ignored so the bar can
      // never be re-scaled under the user.
      if (total === null && frame.total !== null && frame.total > 0) total = frame.total
      if (total !== null) done = Math.max(done, Math.min(total, frame.done))
      if (frame.phase === 'sending') {
        // The result is being shipped: no more reading, and the size is unknown.
        phase = 'receiving'
        push(false)
        return
      }
      // 'transcript' | 'costs' | anything a future server adds.
      phase = 'reading'
      push()
    },
    finish() {
      if (total === null) return
      done = total
      push(false)
    }
  }
}

/** "~3 s left" under a minute, "~2 min left" after. */
export function formatEta(etaMs: number): string {
  const seconds = Math.max(1, Math.ceil(etaMs / 1000))
  if (seconds < 60) return `~${seconds} s left`
  return `~${Math.ceil(seconds / 60)} min left`
}

/** The line under the bar: "Reading transcript · 42% · ~3 s left". */
export function describeTranscriptLoad(p: TranscriptLoadProgress): string {
  if (p.phase === 'receiving') return 'Receiving…'
  const parts = ['Reading transcript']
  // A percentage, not bytes: simpler to read than "of N MB", and it never claims
  // 100% before the commit (floor).
  if (p.fraction !== null) {
    parts.push(`${Math.floor(p.fraction * 100)}%`)
    if (p.etaMs !== null) parts.push(formatEta(p.etaMs))
  }
  return parts.join(' · ')
}
