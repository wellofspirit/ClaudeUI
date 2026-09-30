/**
 * Background system detection (ADR-082 §3): runs `detectHarnesses`, saves the
 * result to the detection cache and invalidates the resolver for each
 * harness, so the next spawn reads the new answer. Nothing on a spawn path
 * waits on it.
 *
 * - At most one run is in flight. A request during a run queues one follow-up
 *   for the union of the requested harnesses; every request made during the
 *   same run shares that follow-up.
 * - Triggers: once shortly after boot (`startDetectionScheduler`, from
 *   `startCoreServices`), for every harness; the resolver, when a System
 *   selection finds the cache missing or stale (`reason: 'stale'`); and
 *   later the Installed page's "detect now" (S4, `reason: 'user'`).
 * - A `stale` request is debounced: a harness detected within the last
 *   `minIntervalMs`, or already in the run in flight, is not detected again.
 *   The resolver asks on every fresh resolution, and a cache that cannot be
 *   written would otherwise ask forever.
 * - Never throws or rejects into a caller. One info line per run, with counts
 *   per verdict; paths only at debug.
 */
import type { HarnessDetection, HarnessId } from '../../../shared/harness-types'
import { HARNESS_IDS } from '../../../shared/harness-types'
import { logger } from '../../services/logger'
import { invalidateHarness, setDetectionRequester } from '../resolve'
import { saveDetectionCache } from './detection-cache'
import { detectHarnesses } from './detect'

export type DetectionReason = 'boot' | 'stale' | 'user'

export interface DetectionStatus {
  running: boolean
  /** ISO time the last run finished. */
  lastRunAt?: string
}

export interface DetectionSchedulerDeps {
  detect?: (ids: readonly HarnessId[]) => Promise<HarnessDetection[]>
  save?: (detections: readonly HarnessDetection[]) => void
  invalidate?: (id: HarnessId) => void
  now?: () => Date
  /** How long a harness's detection satisfies a `stale` request (default 60 s). */
  minIntervalMs?: number
}

export interface DetectionScheduler {
  /** Detect `ids` (every harness by default). Resolves when a run covering them has finished. */
  request(ids?: readonly HarnessId[], reason?: DetectionReason): Promise<void>
  status(): DetectionStatus
}

const DEFAULT_MIN_INTERVAL_MS = 60_000

function summary(detections: readonly HarnessDetection[]): string {
  return detections
    .map((d) => {
      const counts = new Map<string, number>()
      for (const install of d.installs) {
        counts.set(install.verdict, (counts.get(install.verdict) ?? 0) + 1)
      }
      const parts = [...counts].map(([verdict, n]) => `${n} ${verdict}`)
      return `${d.id} ${parts.length > 0 ? parts.join(', ') : 'none'}`
    })
    .join('; ')
}

export function createDetectionScheduler(deps: DetectionSchedulerDeps = {}): DetectionScheduler {
  const detect = deps.detect ?? ((ids: readonly HarnessId[]) => detectHarnesses(ids))
  const save =
    deps.save ?? ((detections: readonly HarnessDetection[]) => saveDetectionCache(detections))
  const invalidate = deps.invalidate ?? ((id: HarnessId) => invalidateHarness(id))
  const now = deps.now ?? (() => new Date())
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS

  /** The harnesses of the run in flight, or null when idle. */
  let inFlight: ReadonlySet<HarnessId> | null = null
  /** The follow-up queued behind the run in flight. */
  let queued: {
    ids: Set<HarnessId>
    reasons: Set<DetectionReason>
    done: Promise<void>
    settle: () => void
  } | null = null
  const lastDetected = new Map<HarnessId, number>()
  let lastRunAt: string | undefined

  /** One detection. Never rejects; `inFlight` is the caller's to manage. */
  async function runOnce(ids: readonly HarnessId[], reasons: string): Promise<void> {
    try {
      // Off the caller's stack: the resolver asks from inside a resolution.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const detections = await detect(ids)
      try {
        save(detections)
      } catch (err) {
        logger.warn(
          'harness',
          `could not save harness detection: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      logger.info('harness', `detection (${reasons}): ${summary(detections)}`)
      for (const d of detections) {
        for (const i of d.installs) {
          logger.debug(
            'harness',
            `detected ${d.id} ${i.verdict} ${i.version ?? '-'} ${i.displayPath} -> ${i.realPath}${i.reason ? ` (${i.reason})` : ''}`
          )
        }
      }
    } catch (err) {
      logger.warn(
        'harness',
        `harness detection failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const finished = now()
    lastRunAt = finished.toISOString()
    for (const id of ids) lastDetected.set(id, finished.getTime())
    // Even after a failure: the resolver then re-reads whatever the cache
    // holds. Still in flight here, so a `stale` request this triggers is
    // dropped rather than looping.
    for (const id of ids) {
      try {
        invalidate(id)
      } catch (err) {
        logger.warn('harness', `invalidating ${id} after detection failed`, err)
      }
    }
  }

  /** Run `ids`, then every follow-up queued meanwhile, then go idle. */
  async function drain(ids: readonly HarnessId[], reason: DetectionReason): Promise<void> {
    await runOnce(ids, reason)
    while (queued) {
      const next = queued
      queued = null
      inFlight = next.ids
      await runOnce([...next.ids], [...next.reasons].join(', '))
      next.settle()
    }
    inFlight = null
  }

  function request(
    ids: readonly HarnessId[] = HARNESS_IDS,
    reason: DetectionReason = 'user'
  ): Promise<void> {
    let wanted = [...new Set(ids)]
    if (reason === 'stale') {
      const at = now().getTime()
      wanted = wanted.filter((id) => {
        if (inFlight?.has(id) || queued?.ids.has(id)) return false
        const last = lastDetected.get(id)
        return last === undefined || at - last >= minIntervalMs
      })
    }
    if (wanted.length === 0) return queued?.done ?? Promise.resolve()

    if (!inFlight) {
      inFlight = new Set(wanted)
      return drain(wanted, reason)
    }
    if (!queued) {
      let settle!: () => void
      const done = new Promise<void>((resolve) => {
        settle = resolve
      })
      queued = { ids: new Set(), reasons: new Set(), done, settle }
    }
    for (const id of wanted) queued.ids.add(id)
    queued.reasons.add(reason)
    return queued.done
  }

  return {
    request,
    status: () => ({ running: inFlight !== null, ...(lastRunAt ? { lastRunAt } : {}) })
  }
}

// ── The app's scheduler ───────────────────────────────────────────────────────

const scheduler = createDetectionScheduler()

/** Detect `ids` (every harness by default) in the background. Never rejects. */
export function requestDetection(
  ids?: readonly HarnessId[],
  reason: DetectionReason = 'user'
): Promise<void> {
  return scheduler.request(ids, reason)
}

/** Whether a detection is running, and when the last one finished. */
export function detectionStatus(): DetectionStatus {
  return scheduler.status()
}

/**
 * Set by an instance that must not probe the machine (test runs set it in
 * their setup files; a secondary instance such as the Playwright verifier may).
 */
export const DISABLE_DETECTION_ENV = 'CLAUDEUI_DISABLE_HARNESS_DETECTION'

/**
 * Arm background detection for this process: the resolver's stale-cache
 * requests, and one run for every harness `bootDelayMs` after boot (an
 * unref'd timer, so it never holds the process or delays startup). A no-op
 * when `CLAUDEUI_DISABLE_HARNESS_DETECTION=1`. Returns a disarm function.
 */
export function startDetectionScheduler(options: { bootDelayMs?: number } = {}): () => void {
  if (process.env[DISABLE_DETECTION_ENV] === '1') {
    logger.info('harness', `background harness detection disabled (${DISABLE_DETECTION_ENV})`)
    return () => {}
  }
  setDetectionRequester((id) => {
    void scheduler.request([id], 'stale')
  })
  const timer = setTimeout(() => {
    void scheduler.request(HARNESS_IDS, 'boot')
  }, options.bootDelayMs ?? 3000)
  timer.unref?.()
  return () => {
    clearTimeout(timer)
    setDetectionRequester(null)
  }
}
