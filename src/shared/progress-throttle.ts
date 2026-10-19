import type { InvokeProgress, ProgressReporter } from './remote-protocol'

/** Default spacing between two delivered reports: four a second (ADR-102). */
export const PROGRESS_INTERVAL_MS = 250

export interface ProgressThrottle {
  /** The reporter handed to a handler. Cheap to call as often as it likes. */
  report: ProgressReporter
  /** Deliver the pending (throttled-away) report now, if any. */
  flush(): void
  /**
   * Stop for good: the pending report is dropped, its timer cleared, and every
   * later `report`/`flush` is a no-op. Call after the response is on the wire.
   */
  close(): void
  /** The latest value the handler reported (delivered or not), or null. */
  last(): InvokeProgress | null
}

/**
 * Throttle a handler's progress reports before they reach a transport.
 *
 * - the FIRST report is delivered immediately (the UI gets the total at once);
 * - after that at most one report per `intervalMs`; reports in between are
 *   coalesced and the LATEST one is delivered when the interval elapses;
 * - a completing report (`done >= total`) is delivered immediately;
 * - `flush()` / `close()` give the transport the end-of-call lifecycle: flush the
 *   tail, send the response, close — so no frame trails the response.
 *
 * `send` must not throw into the handler; a throwing `send` is swallowed, since a
 * dead socket / window must never fail the load it is merely watching.
 */
export function createProgressThrottle(
  send: (progress: InvokeProgress) => void,
  intervalMs: number = PROGRESS_INTERVAL_MS
): ProgressThrottle {
  let closed = false
  let lastSentAt = -Infinity
  let pending: InvokeProgress | null = null
  let latest: InvokeProgress | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const deliver = (progress: InvokeProgress): void => {
    clearTimer()
    pending = null
    lastSentAt = Date.now()
    try {
      send(progress)
    } catch {
      // Observability only — see the doc comment.
    }
  }

  const flush = (): void => {
    if (closed || pending === null) return
    deliver(pending)
  }

  const report: ProgressReporter = (progress) => {
    if (closed) return
    latest = progress
    const complete = progress.total !== null && progress.done >= progress.total
    const wait = lastSentAt + intervalMs - Date.now()
    if (complete || wait <= 0) {
      deliver(progress)
      return
    }
    pending = progress
    if (timer === null) timer = setTimeout(flush, wait)
  }

  return {
    report,
    flush,
    close() {
      closed = true
      pending = null
      clearTimer()
    },
    last: () => latest
  }
}

/** A reporter that drops everything — what a `withProgress` handler gets when the transport has none. */
export const noopProgress: ProgressReporter = () => {}

/**
 * The two host-local IPC names of the desktop progress path (ADR-102): the
 * renderer calls `INVOKE_WITH_PROGRESS_CHANNEL` (`(callId, channel, ...args)`)
 * and main answers with `INVOKE_PROGRESS_EVENT` messages `(callId, progress)` to
 * the calling window only. Neither is a sync channel (`channels.ts`).
 */
export const INVOKE_WITH_PROGRESS_CHANNEL = 'invoke:with-progress'
export const INVOKE_PROGRESS_EVENT = 'invoke:progress'
