import { useEffect, useState } from 'react'
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
 * The host's answer to "may this client open VS Code?" — the affordance gate for
 * the TopBar button, and the web half of ADR-064 §5.
 *
 * Mirrors `useTerminalAvailability` including its desktop/web split, with
 * one deliberate difference: **on desktop this returns `null` and issues no
 * IPC**. There is no desktop constant to pin because the desktop button is not
 * this feature at all — it resolves to the `vscode://` deep link, which needs no
 * host answer — and the desktop settings pane asks `ide:availability` itself,
 * on demand, to render the CLI probe. Pinning a DESKTOP_AVAILABILITY here would
 * invite a caller to gate the deep-link button on a fabricated answer.
 *
 * On web: asked on mount and re-asked on window `focus`, so an owner flipping
 * the desktop-side toggle is picked up when the operator comes back to the tab.
 *
 * Returns `null` on web until the first answer lands — callers gating an
 * affordance on this must render nothing while it is null. An affordance that
 * flashes in and then out is worse than one that appears a beat late.
 *
 * This is the *affordance* gate only, never authorization: `ide:mint-entry`
 * re-checks the toggle, the origin, the CLI and the grant on every call.
 */
export function useIdeAvailability(): IdeAvailability | null {
  // Optional chaining, like every other platform probe in the renderer: a
  // re-render can be flushed after a test harness (or a teardown path) has
  // dropped `window.api`, and "no api" is never "web".
  const isWeb = window.api?.platform === 'web'
  const [availability, setAvailability] = useState<IdeAvailability | null>(null)

  useEffect(() => {
    if (!isWeb) return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.api.ideAvailability()
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

  // Never leak a web answer to a desktop render: the platform flag can change
  // under a test harness, and the desktop path must see the same `null` it would
  // have seen had the query never run.
  return isWeb ? availability : null
}
