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
  // there — this surface closed its tab (a close DETACHES), or another surface
  // owns it — the open re-attaches instead of spawning, and the strip says so.
  const nextSlot = nextFreeSlot(visibleTabs)
  // Web asks only once the server has said "granted": every `shell` channel is
  // refused before that, and a query we know will fail is noise on the wire.
  //
  // The tab SET is the re-ask trigger, not this panel's own actions: a pty can
  // appear without "+" being pressed (opening the panel auto-opens slot 0), and
  // an answer taken before that shell existed is exactly the stale one that
  // makes a running shell invisible after its tab is closed.
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
      // The grant decayed between the availability check and the click. Keep
      // whatever step-up params the last query returned — only the grant died.
      if (isWeb && isNeedsStepUpError(err)) {
        setAvailability((prev) => ({
          allowed: true,
          granted: false,
          needsStepUp: true,
          // Acting was refused; WATCHING is a separate question this refusal
          // says nothing about, so the previous answer stands. Flattening it to
          // false here would wall off a terminal the connection may still read
          // — the exact regression the read/act split exists to prevent.
          readsAllowed: prev?.readsAllowed,
          stepUp: prev?.stepUp ?? null
        }))
        return
      }
      throw err
    }
  }

  /**
   * Close a tab, and KILL the pty behind it when asked (Shift-click on the ×,
   * or the tab menu's confirmed "Kill shell").
   *
   * Closing became detach-only when terminals became a shared per-cwd pool, which
   * left no way at all to stop a runaway process (a dev server, a `tail -f`) from
   * the UI: the cold sweep only reaps cwds with no live session, i.e. never the
   * one you are working in. The kill is always the EXPLICIT half — an unmodified
   * click, and the plain menu item, must not take a shell away from another
   * viewer by accident.
   *
   * The tab goes either way. A refused kill (decayed grant, pty already gone) is
   * swallowed: closing the tab is the part the operator can always have, and the
   * pool query is what re-tells them whether the shell survived.
   */
  const handleCloseTab = useCallback(
    (id: string, kill?: boolean): void => {
      if (kill) {
        // Best-effort: a pty that is already gone (or a decayed grant) must
        // still close the tab, which is the part the user asked for.
        void window.api
          .killTerminal(id)
          .catch(() => {})
          .finally(() => refreshPool())
      }
      closeTerminalTab(id)
    },
    [closeTerminalTab, refreshPool]
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
