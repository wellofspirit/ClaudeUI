import { useVisualViewportHeight } from '../../../hooks/useIsMobile'
import { sendTerminalInput } from '../terminal-input'
import { TerminalSurface } from './TerminalSurface'
import type { TerminalPanelViewProps } from './View'

export interface TerminalMobileViewProps extends Omit<TerminalPanelViewProps, 'style'> {
  /**
   * The panel's pre-shell state (checking access / remote terminal off / the
   * step-up prompt), rendered by the container so BOTH surfaces show the same
   * ADR-054 ceremony. Present means "there is no terminal to look at yet": the
   * tab strip, the "+" and the accessory keys are all suppressed, because every
   * one of them would act on a shell this client has not been granted.
   */
  gate?: React.ReactNode
}

/**
 * The keys a soft keyboard does not have.
 *
 * `data-key` is the structural handle (ADR-027) and `bytes` is what the pty
 * receives — the same sequences xterm emits for the physical keys, so a shell,
 * a pager and a full-screen TUI cannot tell the two apart.
 */
const ACCESSORY_KEYS: ReadonlyArray<{ key: string; label: string; bytes: string; title: string }> =
  [
    { key: 'esc', label: 'Esc', bytes: '\x1b', title: 'Escape' },
    { key: 'tab', label: 'Tab', bytes: '\t', title: 'Tab' },
    { key: 'ctrl-c', label: '^C', bytes: '\x03', title: 'Ctrl+C (interrupt)' },
    { key: 'left', label: '←', bytes: '\x1b[D', title: 'Left' },
    { key: 'up', label: '↑', bytes: '\x1b[A', title: 'Up' },
    { key: 'down', label: '↓', bytes: '\x1b[B', title: 'Down' },
    { key: 'right', label: '→', bytes: '\x1b[C', title: 'Right' }
  ]

/**
 * Never take focus off xterm's hidden textarea.
 *
 * A button that focuses itself dismisses the soft keyboard, so every accessory
 * key would cost two taps: one to send Esc, one to bring the keyboard back. The
 * default action of `pointerdown` is what moves focus (and what synthesizes the
 * compatibility `mousedown`), so cancelling it there — plus `tabIndex={-1}` —
 * keeps the caret, and the keyboard, exactly where they were. `click` is NOT
 * suppressed by this: the spec keeps dispatching it.
 */
function keepFocusOnTerminal(e: { preventDefault: () => void }): void {
  e.preventDefault()
}

function ChevronLeft(): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

/**
 * The phone's terminal: a fullscreen takeover, not a bottom panel.
 *
 * A 25%-height strip under a chat is unusable on a 360px screen, and the desktop
 * panel's chrome (hover-revealed tab closes, a right-click kill menu, a drag
 * handle) is built for a pointer that does not exist here. So the CHROME is
 * re-cut for touch — back affordance, always-visible chip closes, an accessory
 * key row — while everything below it is the same machinery: the same
 * {@link TerminalSurface} (one xterm per tab, the same lazy boundary, the same
 * empty states), the same availability/pool/step-up container above it, and the
 * same read-only banner testid the desktop strip carries.
 *
 * Height comes from the VISUAL viewport, not `inset-0`: `position: fixed` is
 * laid out against the LAYOUT viewport, which does not shrink when the soft
 * keyboard opens — so a full-height takeover would put the accessory keys (and
 * the shell prompt) underneath the keyboard, which is precisely where they are
 * needed. Following the height also drives the resize: the xterm container
 * shrinks, its ResizeObserver fires, and the existing fit → `terminal:resize`
 * path runs. No mobile-specific resize code exists.
 *
 * Only ever mounted on mobile (TerminalPanel forks on `useIsMobile`), which is
 * why the viewport hook is called with a literal `true`.
 */
export function TerminalMobileView({
  visibleTabs,
  allTabs,
  activeId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onClosePanel,
  nextSlot,
  nextSlotRunning,
  readOnly,
  onBlockedInput,
  gate
}: TerminalMobileViewProps): React.JSX.Element {
  const visualHeight = useVisualViewportHeight(true)

  return (
    <div
      data-testid="TerminalMobileView"
      // Structural, so the live DOM says which of the two shell states this
      // takeover is in without reading pixels (ADR-027) — same attribute the
      // desktop panel carries.
      data-readonly={readOnly ? 'true' : undefined}
      // `top-0` + an explicit height rather than `inset-0`: see the doc comment.
      // The dvh fallback is for a host with no visualViewport (jsdom, an old
      // WebView) — full height is the right answer when nothing can be known
      // about a keyboard.
      style={{ height: visualHeight ? `${visualHeight}px` : '100dvh' }}
      className="fixed left-0 right-0 top-0 z-[100] bg-bg-primary flex flex-col animate-fade-in"
    >
      <div
        className="shrink-0 flex items-center gap-1 px-2 min-h-12 border-b border-border"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <button
          data-testid="TerminalMobileView.back"
          onClick={onClosePanel}
          className="flex items-center gap-0.5 shrink-0 -ml-1 px-1 py-2 text-text-secondary hover:text-text-primary transition-colors"
          title="Close terminal"
        >
          <ChevronLeft />
          <span className="text-[13px] font-medium">Terminal</span>
        </button>

        {gate ? (
          <span className="flex-1" />
        ) : (
          // The chips scroll, the back button and "+" do not: on a 360px screen
          // a fourth tab must never push the only way out off the edge.
          <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto">
            {visibleTabs.map((tab) => (
              <div
                key={tab.id}
                data-testid="TerminalMobileView.tabChip"
                data-id={tab.id}
                data-active={tab.id === activeId ? 'true' : undefined}
                onClick={() => onSelectTab(tab.id, tab.cwd)}
                className={`shrink-0 flex items-center gap-0.5 pl-2.5 pr-1 h-7 rounded-full text-[12px] select-none transition-colors ${
                  tab.id === activeId
                    ? 'bg-bg-tertiary text-text-primary'
                    : 'text-text-muted bg-bg-secondary'
                }`}
              >
                <span className="truncate max-w-[92px]">{tab.title}</span>
                {/* Always visible — the desktop chip reveals this on hover,
                    which on touch means "never". Detach only: killing a shell
                    every device shares is not a thing a stray thumb may do. */}
                <button
                  data-testid="TerminalMobileView.tabClose"
                  data-id={tab.id}
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseTab(tab.id)
                  }}
                  className="w-5 h-5 shrink-0 flex items-center justify-center rounded-full text-[11px] text-text-muted"
                  title="Close (the shell keeps running)"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Read-only is otherwise INVISIBLE: the stream keeps flowing and the
            only symptom is that typing does nothing until the ceremony lands.
            Same testid as the desktop strip — one assertion covers both. */}
        {readOnly && (
          <span
            data-testid="TerminalPanel.readOnly"
            title="Your presence proof has gone stale. Watching still works; press a key to confirm it's you and type again."
            className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[9px] text-accent"
          >
            Watching
          </span>
        )}

        {!gate && (
          <button
            data-testid="TerminalMobileView.newTab"
            // Structural, so the live DOM says which of the two things this
            // button does — the label is one glyph either way.
            data-running={nextSlotRunning ? 'true' : undefined}
            onClick={onNewTab}
            className="relative shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-text-muted text-base"
            title={
              nextSlotRunning
                ? // 1-BASED in copy only — the wire (and `nextSlot`) stays 0-based.
                  `Re-attach to the shell already running in terminal ${nextSlot + 1}`
                : 'New terminal'
            }
          >
            +
            {nextSlotRunning && (
              <span
                data-testid="TerminalPanel.newTabRunning"
                className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-green-400"
              />
            )}
          </button>
        )}
      </div>

      {gate ? (
        <div className="flex-1 min-h-0">{gate}</div>
      ) : (
        <>
          <TerminalSurface
            allTabs={allTabs}
            visibleTabs={visibleTabs}
            activeId={activeId}
            nextSlotRunning={nextSlotRunning}
            readOnly={readOnly}
            onBlockedInput={onBlockedInput}
          />
          <div
            data-testid="TerminalMobileView.keyRow"
            // Above the home indicator, and never wrapping: the keys share the
            // width evenly (`flex-1`), so seven of them fit a 360px screen
            // without a second row appearing under the fold.
            style={{ paddingBottom: 'calc(0.375rem + env(safe-area-inset-bottom))' }}
            className="shrink-0 flex flex-nowrap items-stretch gap-1 px-1.5 pt-1.5 border-t border-border bg-bg-secondary"
          >
            {ACCESSORY_KEYS.map((k) => (
              <button
                key={k.key}
                type="button"
                data-testid="TerminalMobileView.key"
                data-key={k.key}
                title={k.title}
                // Not in the tab order and never focused: see keepFocusOnTerminal.
                tabIndex={-1}
                onPointerDown={keepFocusOnTerminal}
                onMouseDown={keepFocusOnTerminal}
                // Straight into xterm's own input path, so read-only refusal and
                // the step-up ceremony apply to these exactly as they do to a
                // typed key. Nothing here knows about `terminal:write`.
                onClick={() => sendTerminalInput(activeId, k.bytes)}
                disabled={!activeId}
                className="flex-1 min-w-0 h-9 flex items-center justify-center rounded-md bg-bg-tertiary text-[13px] font-mono text-text-secondary select-none active:bg-bg-hover disabled:opacity-40"
              >
                {k.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
