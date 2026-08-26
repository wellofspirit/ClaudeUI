import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalAttachResult } from '../../../../shared/types'
import { useSessionStore, type ThemeId } from '../../stores/session-store'
import { registerTerminalInput } from './terminal-input'
import { attachTouchScroll } from './terminal-touch-scroll'
import '@xterm/xterm/css/xterm.css'

interface Props {
  terminalId: string
  isActive: boolean
  /**
   * Mirror the pty's WIDTH instead of fitting to it (ADR-060) — the mobile
   * surface, where a ~48-column fit garbles a shell the desktop is driving at
   * 120 and PSReadLine's absolute-cursor repaints clamp against the narrower
   * grid. In this mode the instance:
   *
   *  - takes its cols from the pty (attach reply, then `terminal:resized`) and
   *    NEVER pushes its own, so it cannot shrink another surface's shell;
   *  - pushes only ROWS, which stay last-writer-wins exactly as before;
   *  - renders inside a horizontally pannable wrapper, because a mirrored grid
   *    is wider than the phone;
   *  - turns one-finger vertical drags into wheel events, because xterm 6 has no
   *    touch handling at all.
   *
   * Absent (the desktop panel) every one of those is off and the instance is the
   * fit-both-axes terminal it has always been.
   */
  mirrorGrid?: boolean
  /**
   * The connection may WATCH this pty but not act on it (ADR-054's read/act
   * split): the arming proof still holds, so the stream keeps flowing, but the
   * act window has decayed and the server will refuse keystrokes.
   *
   * It refuses them SILENTLY — a `term-input` error would be an oracle for which
   * terminals exist — so the client cannot learn from a dropped frame and has to
   * hold the key back itself. Always false on desktop, which is never gated.
   */
  readOnly?: boolean
  /**
   * A keystroke was held back because {@link Props.readOnly} was set. The panel
   * turns this into a step-up ceremony; the keystroke itself is DROPPED (the
   * user retypes), because buffering input across a ceremony means replaying
   * whatever was typed at a shell whose state has moved on.
   */
  onBlockedInput?: () => void
}

function buildXtermTheme(themeId: ThemeId): Record<string, string> {
  if (themeId === 'light') {
    return {
      background: '#f0f0f0',
      foreground: '#000000',
      cursor: '#3a6fd8',
      cursorAccent: '#f0f0f0',
      selectionBackground: '#3a6fd840',
      black: '#000000',
      red: '#b91c1c',
      green: '#15803d',
      yellow: '#a16207',
      blue: '#3a6fd8',
      magenta: '#6d35c7',
      cyan: '#1a7a6e',
      white: '#f0f0f0',
      brightBlack: '#4b5060',
      brightRed: '#dc2626',
      brightGreen: '#16a34a',
      brightYellow: '#ca8a04',
      brightBlue: '#5284e0',
      brightMagenta: '#9571d4',
      brightCyan: '#4bbcac',
      brightWhite: '#ffffff'
    }
  }
  if (themeId === 'monokai') {
    return {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#272822',
      selectionBackground: '#66d9ef40',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#e6db74',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#e6db74',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5'
    }
  }
  // dark (default)
  return {
    background: '#0d1117',
    foreground: '#d1d5db',
    cursor: '#6c9eff',
    cursorAccent: '#0d1117',
    selectionBackground: '#6c9eff40',
    black: '#0d1117',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#6c9eff',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d1d5db',
    brightBlack: '#4b5261',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93bbff',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#f3f4f6'
  }
}

/** What an attach reply means for sizing. */
type AttachOutcome =
  { kind: 'geometry'; cols: number; rows: number } | { kind: 'legacy' } | { kind: 'gone' }

/**
 * Narrow an attach reply, tolerating an older host.
 *
 * `true` is the pre-ADR-060 shape: the pty is live but its geometry is unknown,
 * so a mirroring client has nothing to mirror and must fit both axes like the
 * desktop. `false` / `{ ok: false }` both mean the terminal is gone.
 */
function readAttach(result: TerminalAttachResult | boolean): AttachOutcome {
  if (result === true) return { kind: 'legacy' }
  if (result === false || !result || result.ok !== true) return { kind: 'gone' }
  return { kind: 'geometry', cols: result.cols, rows: result.rows }
}

export function XTermInstance({
  terminalId,
  isActive,
  readOnly,
  onBlockedInput,
  mirrorGrid
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  /**
   * The mode-appropriate "our box changed, resync the grid" action, published by
   * the mount effect so the tab-visibility effect can run it without knowing
   * which of the two sizing regimes is in force.
   */
  const refitRef = useRef<(() => void) | null>(null)
  /**
   * The mirrored grid, surfaced as data attributes (ADR-027) so the live DOM
   * says what the phone is rendering without measuring pixels. Only ever set in
   * mirror mode — the desktop would just be re-rendering on every window drag.
   */
  const [grid, setGrid] = useState<{ cols: number; rows: number } | null>(null)
  const theme = useSessionStore((s) => s.settings.theme)
  /**
   * Read through a ref for the same reason the input gate is: the mount effect
   * keys on `terminalId` alone. The value is in practice fixed for a mount (the
   * two surfaces are different component trees, so crossing the mobile
   * breakpoint remounts this), and the ref keeps it correct if that ever stops
   * being true for the handlers, without a teardown.
   */
  const mirrorRef = useRef(mirrorGrid)
  mirrorRef.current = mirrorGrid
  /**
   * Read through a ref inside the mount effect: that effect keys on
   * `terminalId` alone and must not re-run (it would tear down the pty
   * attachment and the scrollback with it), so the `onData` handler installed
   * once has to see the CURRENT gate rather than the one that existed at mount.
   */
  const inputGate = useRef({ readOnly, onBlockedInput })
  inputGate.current = { readOnly, onBlockedInput }

  // Initialize Terminal once on mount
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      theme: buildXtermTheme(theme),
      allowProposedApi: true
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    const mirror = mirrorRef.current === true
    /** Guards the async attach continuation against an unmount that beat it. */
    let disposed = false
    /** The pty's width, once known. Null until the attach reply lands. */
    let ptyCols: number | null = null
    /**
     * The host cannot report geometry (pre-ADR-060 build), so there is nothing
     * to mirror and this instance fits both axes like the desktop. Latched
     * rather than re-derived: it must survive the `terminal:resized` event never
     * arriving, which is exactly the symptom of the old host.
     */
    let legacyFit = false

    const publishGrid = (): void => {
      if (!mirror) return
      setGrid({ cols: term.cols, rows: term.rows })
    }

    /** Rows our own box can show right now, or the current rows if unmeasurable. */
    const fittedRows = (): number => fitAddon.proposeDimensions()?.rows ?? term.rows

    /** Fit BOTH axes and push — the desktop regime, and the mirror fallback. */
    const fitBothAndPush = (): void => {
      fitAddon.fit()
      window.api.resizeTerminal(terminalId, term.cols, term.rows)
      publishGrid()
    }

    /**
     * Our box changed. Desktop: refit both axes. Mirror: rows only — cols belong
     * to the pty, and pushing ours would clamp every other surface's shell to
     * the phone's width, which is the whole bug this mode exists to fix.
     */
    const refit = (): void => {
      if (containerRef.current?.offsetWidth === 0) return // hidden tab
      if (!mirror || legacyFit) {
        fitBothAndPush()
        return
      }
      if (ptyCols === null) return // no width to mirror yet — the attach reply owns that
      const rows = fittedRows()
      if (rows === term.rows) return
      term.resize(term.cols, rows)
      window.api.resizeTerminal(terminalId, term.cols, rows)
      publishGrid()
    }
    refitRef.current = refit

    // Defer initial sizing so the container has dimensions. In MIRROR mode there
    // is deliberately nothing to do here: the first push has to wait for the
    // attach reply, because pushing before the pty's width is known would send
    // xterm's 80-column default and shrink a shell the desktop is driving at 120.
    requestAnimationFrame(() => {
      if (!mirror) fitBothAndPush()
    })

    termRef.current = term
    fitAddonRef.current = fitAddon

    // User input -> IPC -> PTY, unless this view is read-only (ADR-054): the
    // server would drop the frame without saying so, so the FIRST key is what
    // asks for a fresh presence proof, and it is dropped rather than buffered.
    const dataDisposable = term.onData((data) => {
      const gate = inputGate.current
      if (gate.readOnly) {
        gate.onBlockedInput?.()
        return
      }
      window.api.writeTerminal(terminalId, data)
    })

    // The seam non-keyboard affordances type through (the mobile accessory key
    // row: Esc/Tab/^C/arrows, which no soft keyboard offers). `input(…, true)`
    // is xterm's "as if the user typed it" entry point, so it lands in the
    // `onData` handler above — the SAME gate, the same write, no second path.
    const unregisterInput = registerTerminalInput(terminalId, (data) => term.input(data, true))

    // PTY output -> terminal. A `replay` chunk is the scrollback ring, i.e. the
    // terminal's ENTIRE history: it must land on a cleared screen so it is never
    // appended to bytes the broadcast desktop lane already delivered for this pty.
    //
    // The clear is IN-BAND (RIS, `ESC c`) rather than `term.reset()` on purpose.
    // `Terminal.write()` is DEFERRED — xterm queues into its WriteBuffer and
    // drains on a later task — while `reset()` runs SYNCHRONOUSLY and does not
    // discard that queue. So `reset(); write(replay)` in a batch that also
    // carried a live chunk resets an empty screen and then draws live+replay,
    // duplicating scrollback in exactly the race this flag exists to close.
    // RIS is parsed in stream order, so it clears precisely the bytes ahead of it.
    const unsub = window.api.onTerminalData(({ terminalId: id, data, replay }) => {
      if (id !== terminalId) return
      term.write(replay ? `\x1bc${data}` : data)
    })

    // Another surface refitted the shared pty (ADR-060). MIRROR mode adopts the
    // new width; the desktop ignores this entirely and stays fit-driven, which
    // is what stops the two from resizing each other.
    //
    // A notice whose COLS match ours is dropped, and that early return is the
    // termination argument: it swallows the echo of our own counter-push, and it
    // swallows a rows-only notice — which is what a SECOND mirroring surface
    // (a phone plus a narrow Electron window) produces, and which would
    // otherwise have the two counter-pushing rows at each other forever.
    // The price is the accepted tmux small-client residual: after a rows-only
    // change elsewhere the pty keeps that surface's rows and this one renders
    // its own, exactly as the desktop already tolerates.
    const unsubResized = window.api.onTerminalResized(({ terminalId: id, cols, rows }) => {
      if (id !== terminalId || !mirror || legacyFit) return
      if (cols === term.cols) return
      ptyCols = cols
      const ownRows = fittedRows()
      term.resize(cols, ownRows)
      publishGrid()
      if (ownRows !== rows) window.api.resizeTerminal(terminalId, cols, ownRows)
    })

    // Multi-attach: subscribe this client to the live PTY. Registered AFTER the
    // data listener on purpose — attaching replays the server-side scrollback
    // ring first, so a listener installed afterwards would miss the history it
    // exists to deliver. Real on both surfaces now that terminals are a per-cwd
    // pool: this tab may have resolved to a pty another surface spawned.
    //
    // The reply also carries the pty's GEOMETRY, which is what a mirroring
    // instance sizes itself from — and why it does no sizing before this lands.
    //
    // The api handle is captured, not re-read on cleanup: detach must go through
    // the same surface the attach did (and `window.api` can be gone by teardown).
    const api = window.api
    // Two-argument `then`, not `.then().catch()`: the rejection handler is for a
    // REFUSED attach (stale tab, decayed grant), and chaining a `.catch` would
    // also swallow a throw from the sizing body — turning a bug in it into a
    // terminal that silently never sizes.
    void api.attachTerminal(terminalId).then(
      (result) => {
        if (disposed || !mirror) return
        const outcome = readAttach(result)
        if (outcome.kind === 'gone') return // stale tab; the panel re-checks the pool
        if (outcome.kind === 'legacy') {
          // Older host: no geometry, no `terminal:resized`. Behave exactly as
          // this component did before mirroring existed.
          legacyFit = true
          fitBothAndPush()
          return
        }
        ptyCols = outcome.cols
        const rows = fittedRows()
        if (term.cols !== outcome.cols || term.rows !== rows) term.resize(outcome.cols, rows)
        publishGrid()
        // Rows stay last-writer-wins: tell the pty what this viewport can show.
        if (rows !== outcome.rows) window.api.resizeTerminal(terminalId, outcome.cols, rows)
      },
      () => {
        /* stale tab / grant decayed — the panel re-checks availability */
      }
    )

    // Fit on resize
    const ro = new ResizeObserver(refit)
    ro.observe(containerRef.current)

    // xterm 6 has no touch handling of its own (see terminal-touch-scroll.ts),
    // so on the mobile surface a finger drag is turned into wheel events here.
    const detachTouch = mirror ? attachTouchScroll(containerRef.current) : null

    return () => {
      disposed = true
      // Clear only our OWN entry: React can mount the replacement before running
      // this cleanup (strict mode, a fast tab reshuffle), and a blind null would
      // strand the live instance with no refit — the same guard
      // `registerTerminalInput` makes for the injector registry.
      if (refitRef.current === refit) refitRef.current = null
      detachTouch?.()
      unsub()
      unsubResized()
      unregisterInput()
      dataDisposable.dispose()
      ro.disconnect()
      term.dispose()
      void api.detachTerminal(terminalId).catch(() => {
        /* the connection is already gone; the server detaches on close anyway */
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId])

  // Refit when tab becomes visible (switching tabs, opening panel)
  useEffect(() => {
    if (!isActive) return
    const term = termRef.current
    if (!term) return
    // Defer until display:block takes effect. `refitRef` is the mount effect's
    // mode-appropriate action — fit both axes on the desktop, rows only when
    // mirroring — so this site never has to know which regime is in force.
    requestAnimationFrame(() => {
      refitRef.current?.()
      term.focus()
    })
  }, [isActive, terminalId])

  // Update theme without reinitializing
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = buildXtermTheme(theme)
    }
  }, [theme])

  const host = (
    <div
      data-testid="XTermInstance"
      ref={containerRef}
      className="h-full w-full"
      style={{ padding: '4px 8px' }}
    />
  )

  if (!mirrorGrid) return host

  // The horizontal axis, which xterm does not have: the grid is the PTY's, so on
  // a phone it is routinely wider than the screen and `.xterm-screen` overflows
  // the host box. Nothing between it and here sets `overflow`, so making this
  // wrapper a scroll container is enough — the overflowing ink becomes real
  // scrollable width with no second copy of the grid's size to keep in step.
  //
  // `touch-action: pan-x` splits the gesture space: the BROWSER owns horizontal
  // panning (native, momentum, free) and terminal-touch-scroll.ts owns vertical.
  // `overflow-y: hidden` keeps this a one-axis container — rows always fit the
  // strip exactly, so xterm's own scrollback is the only vertical axis there is.
  return (
    <div
      data-testid="XTermInstance.panWrapper"
      // Structural (ADR-027): the mirrored geometry, assertable without pixels.
      data-cols={grid?.cols}
      data-rows={grid?.rows}
      className="h-full w-full"
      style={{
        overflowX: 'auto',
        overflowY: 'hidden',
        touchAction: 'pan-x',
        overscrollBehavior: 'contain'
      }}
    >
      {host}
    </div>
  )
}
