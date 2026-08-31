import { useCallback, useEffect, useRef, useState } from 'react'
import type { IdeAvailability } from '../../../../shared/remote-protocol'

/**
 * A dropped connection, or a host too old to answer `ide:availability`: "no IDE
 * here". `originAllowed: false` as well as `allowed: false`, so a caller that
 * only looked at the origin axis still reads a refusal — the DENIED constant
 * must never be the most permissive answer in the file.
 */
const DENIED: IdeAvailability = {
  allowed: false,
  granted: false,
  needsStepUp: false,
  originAllowed: false,
  originReason: 'origin-not-allowed',
  probe: { ok: false, reason: 'cli-not-found' },
  runtime: 'stopped'
}

/**
 * What {@link useIdeAvailability} hands back.
 *
 * `refresh` exists because a granted step-up ceremony changes the answer and
 * the caller has to see the new one before it acts (ADR-064 polish: the ceremony
 * now runs BEFORE the tab is opened, so nothing else re-queries in between). It
 * is a no-op on the desktop, which asks the host nothing at all.
 */
export interface IdeAvailabilityHandle {
  availability: IdeAvailability | null
  refresh: () => Promise<void>
}

/**
 * The host's answer to "may this client open VS Code?" — the affordance gate for
 * the TopBar button, and the web half of ADR-064 §5.
 *
 * Mirrors `useTerminalAvailability` including its desktop/web split, with
 * one deliberate difference: **on desktop `availability` is `null` and no IPC is
 * ever issued** — not by the mount query and not by `refresh`. There is no
 * desktop constant to pin because the desktop button is not
 * this feature at all — it resolves to the `vscode://` deep link, which needs no
 * host answer — and the desktop settings pane asks `ide:availability` itself,
 * on demand, to render the CLI probe. Pinning a DESKTOP_AVAILABILITY here would
 * invite a caller to gate the deep-link button on a fabricated answer.
 *
 * On web: asked on mount and re-asked on window `focus`, so an owner flipping
 * the desktop-side toggle is picked up when the operator comes back to the tab.
 *
 * `availability` is `null` on web until the first answer lands — callers gating
 * an affordance on it must render nothing while it is null. An affordance that
 * flashes in and then out is worse than one that appears a beat late.
 *
 * This is the *affordance* gate only, never authorization: `ide:mint-entry`
 * re-checks the toggle, the origin, the CLI and the grant on every call.
 */
export function useIdeAvailability(): IdeAvailabilityHandle {
  // Optional chaining, like every other platform probe in the renderer: a
  // re-render can be flushed after a test harness (or a teardown path) has
  // dropped `window.api`, and "no api" is never "web".
  const isWeb = window.api?.platform === 'web'
  const [availability, setAvailability] = useState<IdeAvailability | null>(null)
  // Was the mount `cancelled` flag; a ref instead because `refresh` is EXPOSED
  // now and an answer can land after the component is gone through a caller's
  // await, not only through the effect this hook owns.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    // The desktop no-IPC contract, kept on the exposed path too: a desktop
    // caller that refreshes must still not produce a single `ide:availability`.
    if (!isWeb) return
    try {
      const next = await window.api.ideAvailability()
      if (mounted.current) setAvailability(next)
    } catch {
      if (mounted.current) setAvailability(DENIED)
    }
  }, [isWeb])

  useEffect(() => {
    if (!isWeb) return
    void refresh()
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [isWeb, refresh])

  // Never leak a web answer to a desktop render: the platform flag can change
  // under a test harness, and the desktop path must see the same `null` it would
  // have seen had the query never run.
  return { availability: isWeb ? availability : null, refresh }
}
