import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useSessionStore,
  selectVisibleTerminalTabs,
  selectActiveTerminalId,
  selectAllTerminalTabs
} from '../../../stores/session-store'
import { isNeedsStepUpError } from '../../../../../shared/remote-protocol'
import type { TerminalAvailability } from '../../../../../shared/types'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { TerminalStepUpPrompt } from '../TerminalStepUpPrompt'
import { DESKTOP_AVAILABILITY } from '../terminal-availability'
import { useTerminalPool } from '../terminal-pool'
import { nextFreeSlot } from '../pool-slot'
import { TerminalPanelView } from './View'
import { TerminalMobileView } from './TerminalMobileView'

interface Props {
  /**
   * The desktop bottom panel's height, owned by SessionView's drag handle. The
   * mobile takeover is fullscreen and has no height to receive, so this is
   * optional — a frozen empty object rather than a fresh `{}` per render, which
   * would hand the view a new style identity on every re-render.
   */
  style?: React.CSSProperties
}

const NO_STYLE: React.CSSProperties = Object.freeze({})

export function TerminalPanel({ style = NO_STYLE }: Props): React.JSX.Element {
  // Presentation fork only (the SkillsDialog / PermissionsDialog pattern): every
  // question this container asks — availability, the pool, the step-up ceremony
  // — is answered identically for both surfaces below.
  const isMobile = useIsMobile()
  const visibleTabs = useSessionStore(useShallow(selectVisibleTerminalTabs))
  const activeId = useSessionStore(selectActiveTerminalId)
  const allTabs = useSessionStore(useShallow(selectAllTerminalTabs))
  const addTerminalTab = useSessionStore((s) => s.addTerminalTab)
  const closeTerminalTab = useSessionStore((s) => s.closeTerminalTab)
  const removeTerminalTab = useSessionStore((s) => s.removeTerminalTab)
  const setActiveTerminal = useSessionStore((s) => s.setActiveTerminal)
  const setTerminalPanelOpen = useSessionStore((s) => s.setTerminalPanelOpen)

  // Optional chaining, like every other platform probe in the renderer: a
  // re-render can be flushed after a test harness (or a teardown path) has
  // dropped `window.api`, and "no api" is never "web".
  const isWeb = window.api?.platform === 'web'
  const [availability, setAvailability] = useState<TerminalAvailability | null>(
    isWeb ? null : DESKTOP_AVAILABILITY
  )

  const cwd = useSessionStore((s) => {
    const id = s.activeSessionId
    return id ? (s.sessions[id]?.cwd ?? '') : ''
  })

  /** Capability honesty: the affordance is driven by the server's answer only. */
  const refreshAvailability = useCallback(async (): Promise<void> => {
    if (!isWeb) return
    try {
      setAvailability(await window.api.terminalAvailability())
    } catch {
      // An older host (or a dropped connection) means "no terminal here" —
      // never optimistically render a shell we cannot actually drive.
      setAvailability({
        allowed: false,
        granted: false,
        needsStepUp: false,
        readsAllowed: false,
        stepUp: null
      })
    }
  }, [isWeb])

  /**
   * Ask for a fresh presence proof from the keystroke path (ADR-054).
   *
   * The web bundle installs `__STEP_UP_REQUEST__`; this component is shared with
   * the desktop build, which has no ceremony at all — hence the optional call
   * rather than an import. A granted ceremony re-reads availability, which is
   * what turns the panel from watching back into typing.
   */
  const requestStepUp = useCallback((): void => {
    const request = (
      window as unknown as { __STEP_UP_REQUEST__?: (channel: string) => Promise<boolean> }
    ).__STEP_UP_REQUEST__
    if (!request) return
    void request('terminal:write').then((granted) => {
      if (granted) void refreshAvailability()
    })
  }, [refreshAvailability])

  /**
   * An ACT was refused for staleness: the grant decayed between the availability
   * check and the click (ADR-054).
   *
   * Keeps whatever step-up params the last query returned — only the grant died
   * — and, deliberately, whatever it said about WATCHING. Acting was refused; a
   * refusal to act says nothing about reading, so flattening `readsAllowed` here
   * would wall off a terminal the connection may still see, which is the exact
   * regression the read/act split exists to prevent.
   */
  const markActRefused = useCallback((): void => {
    setAvailability((prev) => ({
      allowed: true,
      granted: false,
      needsStepUp: true,
      readsAllowed: prev?.readsAllowed,
      stepUp: prev?.stepUp ?? null
    }))
  }, [])

  useEffect(() => {
    void refreshAvailability()
  }, [refreshAvailability])

  // The server can revoke under us: the owner flips the toggle off, or the
  // grant decays while the panel sits open. Re-ask rather than leaving a dead
  // terminal that silently stops echoing.
  useEffect(() => {
    if (!isWeb) return
    return window.api.onTerminalDetached(() => {
      void refreshAvailability()
    })
  }, [isWeb, refreshAvailability])

  // Terminals are an ordered per-cwd POOL shared by every surface: "+" asks for
  // the lowest slot this surface is not already showing. If a live pty sits
  // there — this surface DETACHED from it, or another surface owns it — the open
  // re-attaches instead of spawning, and the strip says so.
  const nextSlot = nextFreeSlot(visibleTabs)
  // Web asks only once the server has said "granted": every `shell` channel is
  // refused before that, and a query we know will fail is noise on the wire.
  //
  // The tab SET is the re-ask trigger, not this panel's own actions: a pty can
  // appear without "+" being pressed (opening the panel auto-opens slot 0), and
  // an answer taken before that shell existed is exactly the stale one that
  // makes a running shell invisible after its tab is detached.
  const tabKey = visibleTabs.map((t) => `${t.poolIndex ?? ''}:${t.id}`).join(',')
  // `terminal:pool` is a shell READ (ADR-054), so the gate is `readsAllowed`, not
  // `granted`: a connection whose act window decayed can still be told which
  // slots are live, and asking is what keeps the "+" indicator honest while the
  // panel is in its watching state. `granted` is kept in the disjunction for an
  // older host that answers no `readsAllowed` at all.
  const canReadShells = !isWeb || !!availability?.granted || !!availability?.readsAllowed
  const { liveSlots, refresh: refreshPool } = useTerminalPool(cwd, canReadShells, tabKey)

  const handleNewTab = async (): Promise<void> => {
    const target = cwd || '.'
    const index = nextSlot
    try {
      const terminalId = await window.api.createTerminal(target, index)
      // No explicit pool re-ask here: adding the tab changes the tab key, which
      // is what the hook watches. The one path that does NOT change it —
      // resolving to a tab we already show — has not changed the pool either.
      //
      // Defensive: a slot we believed free resolving to a pty we already show
      // (possible if another surface reshuffled the pool between render and
      // click) must select that tab, never duplicate it.
      if (allTabs.some((t) => t.id === terminalId)) {
        setActiveTerminal(terminalId, target)
        return
      }
      addTerminalTab({ id: terminalId, title: 'Terminal', cwd: target, poolIndex: index })
    } catch (err) {
      if (isWeb && isNeedsStepUpError(err)) {
        markActRefused()
        return
      }
      throw err
    }
  }

  /**
   * Close a tab. The default KILLS the pty behind it; `detach` only drops the
   * tab (ADR-062).
   *
   * Closing was detach-only from the moment terminals became a shared per-cwd
   * pool, on the reasoning that a close must never take a shell away from
   * another viewer. In practice closing a terminal means "stop it": the kill sat
   * behind Shift or a confirmed menu item nobody found, the cold sweep only
   * reaps cwds with no live session (i.e. never the one you are working in), and
   * the phone's chip — no modifier, no right-click — had no kill at all. So the
   * modifier moved to the SAFE half instead.
   *
   * The kill is sequenced, not best-effort: the tab is dropped only once
   * `terminal:kill` resolves. A close that could not do what it says must stay
   * undone — dropping the tab anyway would read as "stopped" while the process
   * kept running, which is the one thing the inversion must not introduce. Main
   * resolves a kill of an already-gone id without error, so "the pty died on its
   * own" still closes the tab cleanly.
   */
  const handleCloseTab = useCallback(
    (id: string, detach?: boolean): void => {
      if (detach) {
        // The pty may be open on another surface: let go, kill nothing. The
        // attachment itself rides the XTermInstance unmount.
        closeTerminalTab(id)
        return
      }
      void window.api
        .killTerminal(id)
        .then(() => {
          closeTerminalTab(id)
          refreshPool()
        })
        .catch((err: unknown) => {
          // The grant decayed between the availability check and the click: the
          // tab stays, and the panel recovers into the ceremony exactly as "+"
          // does. No silent fallback to a detach — see the doc comment.
          if (isWeb && isNeedsStepUpError(err)) {
            markActRefused()
            return
          }
          console.error('[TerminalPanel] kill failed; keeping the tab:', err)
        })
    },
    [closeTerminalTab, refreshPool, isWeb, markActRefused]
  )

  // Listen for PTY exit events. The exit is also how a kill this surface did
  // NOT issue (another device, or the shell exiting on its own) reaches the
  // indicator — the pool has one fewer live slot the moment it fires.
  useEffect(() => {
    const unsub = window.api.onTerminalExit(({ terminalId }) => {
      removeTerminalTab(terminalId)
      refreshPool()
    })
    return unsub
  }, [removeTerminalTab, refreshPool])

  // The step-up WALL, narrowed by ADR-054's read/act split: a connection that
  // may still watch gets the terminal itself (read-only) rather than a prompt in
  // front of shells it is entitled to see. `readsAllowed` is absent on an older
  // host, which therefore keeps the pre-ADR-054 wall exactly as it was.
  const readOnly = isWeb && !!availability?.readsAllowed && !availability.granted

  // Everything both presentations need, resolved once. The two surfaces differ
  // in CHROME only — a phone cannot use a hover-revealed close or a drag handle
  // — so any divergence here would be a bug, not a design.
  const surfaceProps = {
    visibleTabs,
    allTabs,
    activeId,
    onSelectTab: setActiveTerminal,
    onCloseTab: handleCloseTab,
    onNewTab: handleNewTab,
    onClosePanel: () => setTerminalPanelOpen(false),
    nextSlot,
    nextSlotRunning: liveSlots.has(nextSlot),
    readOnly,
    onBlockedInput: requestStepUp
  }

  if (
    isWeb &&
    (!availability || !availability.allowed || (availability.needsStepUp && !readOnly))
  ) {
    // The gate BODY is shared; only the frame around it differs, so the phone
    // runs the identical ADR-054 ceremony (same component, same testids) inside
    // a takeover instead of inside a 200px strip.
    const gate = !availability ? (
      <div
        data-testid="TerminalPanel.checking"
        className="h-full flex items-center justify-center text-text-muted text-xs"
      >
        Checking terminal access…
      </div>
    ) : !availability.allowed ? (
      <div
        data-testid="TerminalPanel.unavailable"
        className="h-full flex flex-col items-center justify-center gap-1 px-6 text-center text-text-muted text-xs"
      >
        <div>Remote terminal is turned off.</div>
        <div className="text-[10px] text-text-muted/70 max-w-[380px] leading-snug">
          Turn on “Allow remote terminal” in Settings › Remote on the desktop app to open a shell
          from here.
        </div>
      </div>
    ) : (
      <TerminalStepUpPrompt
        passkey={availability.passkey}
        onGranted={() => void refreshAvailability()}
      />
    )

    if (isMobile) return <TerminalMobileView {...surfaceProps} gate={gate} />

    return (
      <div
        data-testid="TerminalPanel"
        style={style}
        className="flex flex-col bg-bg-primary border-t border-border overflow-hidden"
      >
        <div className="flex items-center gap-0.5 px-2 py-1 bg-bg-secondary border-b border-border shrink-0">
          <button
            data-testid="TerminalPanel.close"
            onClick={() => setTerminalPanelOpen(false)}
            className="ml-auto w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover text-[10px]"
            title="Close terminal panel"
          >
            &times;
          </button>
        </div>
        <div className="flex-1 min-h-0">{gate}</div>
      </div>
    )
  }

  if (isMobile) return <TerminalMobileView {...surfaceProps} />

  return <TerminalPanelView style={style} {...surfaceProps} />
}
