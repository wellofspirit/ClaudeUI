/**
 * The GENERIC step-up gate (ADR-054 series 2).
 *
 * ## The problem it exists to solve
 *
 * Under ADR-052 exactly one surface could be refused for staleness — the
 * terminal — so exactly one component owned the cure, inline, in the panel that
 * asked. ADR-054 made the refusal general: the settings verbs demand a fresh
 * presence proof on EVERY tier, and the `strong` tier demands one for every
 * non-shell mutation (a chat send, a git commit, a config write). Teaching each
 * of those call sites to recognise `needs-step-up`, run a ceremony and retry
 * would be the same rule written in a dozen places, and the twelfth one would be
 * the one that forgets.
 *
 * So it lives HERE, wrapping `RemoteConnection.invoke` (see `setInvokeGate`):
 *
 *  1. forward the call;
 *  2. on `needs-step-up`, ask the UI for ONE ceremony;
 *  3. if it succeeded, retry the original invoke exactly ONCE;
 *  4. otherwise rethrow the ORIGINAL refusal, so a call site that already knows
 *     what to do with it (the terminal panel) still gets its answer.
 *
 * Call sites need no changes at all, which is the property that makes this
 * correct-by-default for the verbs nobody has thought about yet.
 *
 * ## Single-flight, deliberately
 *
 * A phone waking up fires several mutations at once, and a strong-tier window
 * that lapsed lapsed for all of them. Every refusal that arrives while a
 * ceremony is pending JOINS that ceremony rather than starting another: one
 * biometric prompt, then N retries. Without this the operator would face a
 * prompt storm — and worse, concurrent `startAuthentication()` calls race the
 * server's single-use, connection-bound challenge, so the second one is not just
 * annoying but likely to fail.
 *
 * ## Retry exactly once
 *
 * A second refusal after a *successful* ceremony is not a freshness problem —
 * the window was just armed — so retrying again would be a loop against
 * something a ceremony cannot fix (a revoked capability, a toggle turned off).
 * One retry, then the truth.
 *
 * ## Web only
 *
 * The desktop renderer is the host anchor: its connection is exempt from the
 * whole tier table and can never be answered `needs-step-up`. Nothing installs
 * this gate there, so the desktop path is not merely inert — it does not exist.
 */

import { isNeedsSettingsSessionError, isNeedsStepUpError } from '../shared/remote-protocol'

/** What the UI is being asked for while a ceremony is pending. */
export interface StepUpDemand {
  /**
   * The channel whose refusal opened the ceremony — the FIRST one, when several
   * joined. Used for copy ("to change these settings", "to open a shell"), never
   * for a decision: the server refused for freshness, and freshness is a fact
   * about the connection rather than the verb.
   */
  channel: string
}

export interface StepUpGate {
  /** Install on the connection: `connection.setInvokeGate(gate.intercept)`. */
  intercept: (channel: string, attempt: () => Promise<unknown>) => Promise<unknown>
  /**
   * Subscribe to the pending demand. `null` means no ceremony is owed and the
   * prompt must not be rendered. Returns the unsubscribe; fires immediately
   * with the current value so a late subscriber cannot miss an open demand.
   */
  subscribe: (cb: (demand: StepUpDemand | null) => void) => () => void
  /**
   * Settle the pending ceremony. `true` ⇒ the server confirmed a fresh proof
   * and the queued calls retry; `false` ⇒ the user dismissed it (or it failed
   * unrecoverably) and every queued call rethrows its original refusal.
   * Idempotent and safe to call with nothing pending.
   */
  settle: (granted: boolean) => void
  /**
   * Open a ceremony WITHOUT a refusal behind it, and resolve with its outcome.
   *
   * The keystroke path needs this: the server drops a stale `term-input` frame
   * silently (an error would be an oracle for which terminals exist), so the
   * client has to decide from `terminal:availability` that it is in the
   * read-only state and prompt on the first key itself. Joins the same
   * single-flight as a refusal-driven ceremony.
   */
  request: (channel: string) => Promise<boolean>
}

export function createStepUpGate(): StepUpGate {
  let demand: StepUpDemand | null = null
  /** Resolvers of everyone waiting on the ceremony currently on screen. */
  let waiters: ((granted: boolean) => void)[] = []
  const listeners = new Set<(demand: StepUpDemand | null) => void>()

  const publish = (): void => {
    for (const listener of listeners) listener(demand)
  }

  /**
   * Join (or open) the one pending ceremony. Resolves with the verdict — never
   * rejects, because "the user said no" is an outcome the caller must handle
   * rather than an error to propagate.
   */
  const ceremony = (channel: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      waiters.push(resolve)
      if (demand) return
      demand = { channel }
      publish()
    })

  return {
    intercept: async (channel, attempt) => {
      try {
        return await attempt()
      } catch (err) {
        // NEVER cure a locked settings editor (ADR-054 §6 amendment). The typed
        // `needs-settings-session` means "the operator must deliberately unlock
        // the settings pane" — turning it into an ambient ceremony-and-retry
        // would re-create exactly the invisible administering authority the
        // amendment removed: a stale pane firing a save would raise a biometric
        // prompt the operator did not ask for, and a tap would silently reopen
        // the mode. Checked BEFORE the step-up predicate because both are
        // substring matches and only their order guarantees which one wins.
        if (isNeedsSettingsSessionError(err)) throw err
        if (!isNeedsStepUpError(err)) throw err
        const granted = await ceremony(channel)
        // Rethrow the ORIGINAL refusal rather than a synthesised "cancelled":
        // call sites that already branch on `needs-step-up` (the terminal
        // panel's own inline prompt) must keep working unchanged.
        if (!granted) throw err
        return await attempt()
      }
    },

    subscribe: (cb) => {
      listeners.add(cb)
      cb(demand)
      return () => {
        listeners.delete(cb)
      }
    },

    settle: (granted) => {
      if (!demand) return
      demand = null
      // Snapshot and clear BEFORE resolving: a retry that is refused again
      // re-enters `ceremony()` synchronously from a `.then`, and it must open a
      // NEW demand rather than be appended to the list being drained.
      const pending = waiters
      waiters = []
      publish()
      for (const resolve of pending) resolve(granted)
    },

    request: (channel) => ceremony(channel)
  }
}
