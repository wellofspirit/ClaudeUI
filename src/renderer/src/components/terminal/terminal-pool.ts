import { useCallback, useEffect, useState } from 'react'

/**
 * The "nothing known" answer, shared so that clearing twice is not two renders.
 * Read-only by type — every consumer only asks it `.has()`.
 */
const NO_SLOTS: ReadonlySet<number> = new Set()

/**
 * Which slots of `cwd`'s terminal pool are running a shell right now.
 *
 * Terminals are an ordered per-cwd POOL shared by every surface, and a DETACH
 * (Shift-click, or the tab menu — a plain close kills since ADR-062) lets go of
 * a slot without stopping it — so pressing "+" can land on a shell that has
 * been running since before the tab was detached (or on a phone's shell). The
 * client cannot infer that: `terminal:create` answers with a bare id whether it
 * spawned or attached, so the fact has to be asked for.
 *
 * PULL, not push: there is no pool event on the wire, and inventing one would
 * mean a new replicated channel for a hint. The panel re-asks at the moments
 * the answer can have changed for THIS surface (mount, cwd change, `key`) plus
 * window `focus`, which is what catches a change another surface made — the
 * same cadence, and the same reasoning, as {@link useTerminalAvailability}.
 *
 * `key` is any client-side fact whose change could mean a different pool — in
 * practice the caller's tab set. Deriving the re-ask from the TAB SET rather
 * than from the panel's own actions is deliberate: a pty can appear without the
 * panel doing anything (opening the panel auto-opens slot 0 through
 * `toggle-terminal.ts`), and a live walk caught exactly that — the shell was
 * running, its tab detached, and the strip said nothing because the last answer
 * predated the shell.
 *
 * A refusal (no grant, decayed grant, host that predates the channel) resolves
 * to "nothing known" — an EMPTY set, never a guess. The indicator's whole job
 * is to be honest about a shell that exists; claiming one that may not is worse
 * than staying quiet.
 *
 * `enabled` is the caller's gate (web: only once availability says granted), so
 * an ungranted client never fires a query it knows will be refused.
 */
export function useTerminalPool(
  cwd: string,
  enabled: boolean,
  key = ''
): { liveSlots: ReadonlySet<number>; refresh: () => void } {
  const [liveSlots, setLiveSlots] = useState<ReadonlySet<number>>(NO_SLOTS)
  // Bumped by `refresh()`; the effect below is keyed on it, so a refresh always
  // re-runs the query WITH the current cwd rather than closing over a stale one.
  const [nonce, setNonce] = useState(0)
  // The cwd the current answer DESCRIBES — see the reset below.
  const [answeredFor, setAnsweredFor] = useState(cwd)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // Keep the SAME set object when the answer has not changed. Every query
  // otherwise hands React a fresh Set and re-renders the panel — and the
  // window-`focus` re-ask makes that "on every alt-tab", for an answer that is
  // usually identical.
  const store = useCallback((slots: readonly number[]): void => {
    setLiveSlots((prev) =>
      prev.size === slots.length && slots.every((s) => prev.has(s)) ? prev : new Set(slots)
    )
  }, [])

  // Changing directory INVALIDATES the answer immediately, in render — not when
  // the next query resolves a round trip later (a visible gap over remote).
  // Keeping the old set for that window would badge the new directory with the
  // old one's shells, i.e. state a fact about the wrong machine. Deliberately
  // not done for `nonce`/`key` bumps: those re-ask about the SAME directory,
  // where the last answer is stale at worst, never about something else.
  if (answeredFor !== cwd) {
    setAnsweredFor(cwd)
    store([])
  }

  useEffect(() => {
    if (!enabled || !cwd) {
      store([])
      return
    }
    let cancelled = false
    const ask = async (): Promise<void> => {
      try {
        // Optional chaining on the method, not just on `api`: a host built
        // before this channel existed has no such member, and the panel must
        // degrade to "no indicator" rather than throw on every refresh.
        const slots = (await window.api?.terminalPool?.(cwd)) ?? []
        if (!cancelled) store(slots)
      } catch {
        if (!cancelled) store([])
      }
    }
    void ask()
    const onFocus = (): void => {
      void ask()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [cwd, enabled, nonce, key, store])

  return { liveSlots, refresh }
}
