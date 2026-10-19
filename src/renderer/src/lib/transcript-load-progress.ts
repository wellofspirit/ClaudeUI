/**
 * Progress of loading a session's transcript, as the loading view shows it
 * (ADR-102).
 *
 * The Claude history read plans the WHOLE job in bytes (see
 * `loadSessionHistory` in `core/services/session-history.ts`): the first frame
 * carries `total = 2*M + 2*S`, the read's own last frame is `done = 2*M + S`,
 * and the renderer finishes the job by adding the size of each subagent
 * transcript it fetches until `done` reaches `total`. This module is that
 * renderer half — a small state machine that turns the frames and the fetch
 * completions into one monotonic {@link TranscriptLoadProgress}.
 */

import type { InvokeProgress } from '../../../shared/remote-protocol'

export type TranscriptLoadPhase = 'reading' | 'subagents' | 'receiving'

export interface TranscriptLoadProgress {
  /** 0..1, or null when the total is unknown (an engine without byte progress, an old server). */
  fraction: number | null
  phase: TranscriptLoadPhase
  doneBytes: number
  totalBytes: number | null
  /** Estimated milliseconds left, or null while it would be a guess. */
  etaMs: number | null
  /** How many subagent transcripts the load is fetching (the `subagents` phase), else null. */
  subagents: number | null
}

/** The ETA is a guess until this fraction is done and this long has passed. */
const ETA_MIN_FRACTION = 0.05
const ETA_MIN_ELAPSED_MS = 300

export interface LoadProgressTracker {
  /** Announce the load: indeterminate until a frame names a total. */
  start(): void
  /** A progress frame from the history read. */
  history(frame: InvokeProgress): void
  /** The history read is back and `count` subagent transcripts are being fetched. */
  subagentsStarted(count: number): void
  /** One subagent fetch finished; `bytes` is its file size (unknown counts as 0). */
  subagentFetched(bytes: number | undefined): void
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
  let subagents: number | null = null

  const push = (etaAllowed = true): void => {
    // Monotonic by construction: `total` is fixed by the first frame and `done`
    // only ever rises (max over frames, additions for fetches).
    const f = total !== null && total > 0 ? Math.min(1, done / total) : null
    const elapsed = now() - startedAt
    const etaMs =
      etaAllowed && f !== null && f < 1 && f >= ETA_MIN_FRACTION && elapsed >= ETA_MIN_ELAPSED_MS
        ? (elapsed * (1 - f)) / f
        : null
    emit({ fraction: f, phase, doneBytes: done, totalBytes: total, etaMs, subagents })
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
    subagentsStarted(count) {
      phase = 'subagents'
      subagents = count
      push()
    },
    subagentFetched(bytes) {
      phase = 'subagents'
      if (total !== null) done = Math.min(total, done + (bytes ?? 0))
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

/** The line under the bar: "Reading transcript · 12.3 of 40.1 MB · ~3 s left". */
export function describeTranscriptLoad(p: TranscriptLoadProgress): string {
  if (p.phase === 'receiving') return 'Receiving…'
  const label =
    p.phase === 'subagents' && p.subagents
      ? `Loading ${p.subagents} subagent${p.subagents === 1 ? '' : 's'}`
      : 'Reading transcript'
  const parts = [label]
  // A percentage, not bytes: the planned total counts the main transcript and the
  // subagent files twice each (see the module doc), so "of N MB" would claim
  // roughly double the session's real size.
  if (p.fraction !== null) {
    parts.push(`${Math.floor(p.fraction * 100)}%`)
    if (p.etaMs !== null) parts.push(formatEta(p.etaMs))
  }
  return parts.join(' · ')
}
