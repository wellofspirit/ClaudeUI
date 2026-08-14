import { useEffect, useState } from 'react'
import type { TerminalAvailability } from '../../../../shared/types'

/**
 * The desktop renderer IS the host surface: it holds a non-decaying `shell`
 * grant, so it never consults `terminal:availability`. The remote toggle
 * governs *remote* access, never the local shell — same reasoning as
 * TerminalService.availability(). Pinning this as a constant (rather than
 * awaiting the same query) keeps every desktop code path free of terminal IPC.
 */
export const DESKTOP_AVAILABILITY: TerminalAvailability = {
  allowed: true,
  granted: true,
  needsStepUp: false,
  // No ceremony on desktop, so no proof params to carry.
  stepUp: null
}

/** An older host, or a dropped connection: "no terminal here". */
const DENIED: TerminalAvailability = {
  allowed: false,
  granted: false,
  needsStepUp: false,
  stepUp: null
}

/**
 * The host's answer to "can this client have a shell at all?".
 *
 * Desktop resolves synchronously to {@link DESKTOP_AVAILABILITY} and issues NO
 * IPC. Web asks `terminal:availability` on mount and re-asks on window `focus`,
 * so an owner flipping the desktop-side toggle is picked up when the user comes
 * back to the tab — a trivially cheap query at human frequency.
 *
 * Returns `null` on web until the first answer lands: callers that gate an
 * affordance on this must render nothing while it is null. An affordance that
 * flashes in and then out is worse than one that appears a beat late.
 *
 * This is the *affordance* gate only. TerminalPanel keeps its own copy of the
 * question (including the step-up ceremony) — defense in depth: nothing may
 * render a shell surface on the strength of a button having been visible.
 */
export function useTerminalAvailability(): TerminalAvailability | null {
  // Optional chaining, like every other platform probe in the renderer: a
  // re-render can be flushed after a test harness (or a teardown path) has
  // dropped `window.api`, and "no api" is never "web".
  const isWeb = window.api?.platform === 'web'
  const [availability, setAvailability] = useState<TerminalAvailability | null>(
    isWeb ? null : DESKTOP_AVAILABILITY
  )

  useEffect(() => {
    if (!isWeb) return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.api.terminalAvailability()
        if (!cancelled) setAvailability(next)
      } catch {
        if (!cancelled) setAvailability(DENIED)
      }
    }
    void refresh()
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [isWeb])

  return availability
}
