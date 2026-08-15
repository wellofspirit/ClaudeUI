import { lazy, Suspense } from 'react'
import type { TerminalTab as TerminalTabModel } from '../../../../../shared/types'
import { TerminalTab } from './TerminalTab'

// Lazy: xterm.js + addon-fit + xterm.css must not ride the eager App chunk. This
// panel's container is always mounted (display:none preserves scrollback), so the
// boundary has to be XTermInstance — it mounts once per tab, and tabs start at zero.
const XTermInstance = lazy(() =>
  import('../XTermInstance').then((m) => ({ default: m.XTermInstance }))
)

export interface TerminalPanelViewProps {
  style: React.CSSProperties
  visibleTabs: TerminalTabModel[]
  allTabs: TerminalTabModel[]
  activeId: string | null
  onSelectTab: (id: string, cwd: string) => void
  /**
   * Close this tab. `kill: true` (Shift-click, or the tab menu's confirmed
   * "Kill shell") also terminates the pty behind it — the only UI path that
   * kills a shell now that a plain close merely detaches this surface from the
   * shared per-cwd pool.
   */
  onCloseTab: (id: string, kill?: boolean) => void
  onNewTab: () => void
  onClosePanel: () => void
  /**
   * The pool slot "+" will ask for, and whether a shell is ALREADY running in
   * it. True means the next open re-attaches to a live pty (this surface closed
   * its tab, or another surface owns it) instead of spawning — which is
   * invisible otherwise, because a detached shell leaves nothing on screen.
   */
  nextSlot: number
  nextSlotRunning: boolean
  /**
   * This client may watch these shells but not type into them (ADR-054's
   * read/act split — the arming proof holds, the act window decayed). The
   * stream and the scrollback stay live; the first keystroke asks for a fresh
   * proof instead of reaching the pty.
   */
  readOnly?: boolean
  /** A keystroke was held back — run the step-up ceremony. */
  onBlockedInput?: () => void
}

export function TerminalPanelView({
  style,
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
  onBlockedInput
}: TerminalPanelViewProps): React.JSX.Element {
  return (
    <div
      data-testid="TerminalPanel"
      // Structural, so the live DOM says which of the two shell states this
      // panel is in without reading pixels (ADR-027).
      data-readonly={readOnly ? 'true' : undefined}
      style={style}
      className="flex flex-col bg-bg-primary border-t border-border overflow-hidden"
    >
      <div className="flex items-center gap-0.5 px-2 py-1 bg-bg-secondary border-b border-border shrink-0">
        {visibleTabs.map((tab) => (
          <TerminalTab
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            onSelect={() => onSelectTab(tab.id, tab.cwd)}
            onClose={(kill) => onCloseTab(tab.id, kill)}
          />
        ))}
        <button
          data-testid="TerminalPanel.newTab"
          // Structural, so the live DOM says which of the two things this
          // button does — the label is one glyph either way.
          data-running={nextSlotRunning ? 'true' : undefined}
          onClick={onNewTab}
          className="relative w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover text-sm"
          title={
            nextSlotRunning
              ? // 1-BASED in copy only — the wire (and `nextSlot`) stays 0-based.
                // "slot 0" is an implementation detail leaking into a tooltip;
                // the number a person can check is the tab's position.
                `Re-attach to the shell already running in terminal ${nextSlot + 1}`
              : 'New terminal'
          }
        >
          +
          {nextSlotRunning && (
            <span
              data-testid="TerminalPanel.newTabRunning"
              className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-green-400"
            />
          )}
        </button>
        {/* Read-only is otherwise INVISIBLE: the stream keeps flowing and the
            only symptom is that typing does nothing until the ceremony lands.
            Say so before the user discovers it by pressing keys. */}
        {readOnly && (
          <span
            data-testid="TerminalPanel.readOnly"
            title="Your presence proof has gone stale. Watching still works; press a key to confirm it's you and type again."
            className="ml-2 shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[9px] text-accent"
          >
            Watching
          </span>
        )}
        <button
          data-testid="TerminalPanel.close"
          onClick={onClosePanel}
          className="ml-auto w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover text-[10px]"
          title="Close terminal panel"
        >
          &times;
        </button>
      </div>

      <div className="flex-1 min-h-0 relative overflow-hidden">
        {allTabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === activeId ? 'block' : 'none' }}
          >
            <Suspense
              fallback={
                <div className="h-full flex items-center justify-center text-text-muted text-xs">
                  Loading terminal…
                </div>
              }
            >
              <XTermInstance
                terminalId={tab.id}
                isActive={tab.id === activeId}
                readOnly={readOnly}
                onBlockedInput={onBlockedInput}
              />
            </Suspense>
          </div>
        ))}
        {visibleTabs.length === 0 &&
          (nextSlotRunning ? (
            // The case the pool made invisible: the tab is gone but the shell
            // (a dev server, a `tail -f`) is still running, and nothing on
            // screen said so — the operator reads an empty panel as an empty
            // machine. Reopening re-attaches and replays its scrollback.
            <div
              data-testid="TerminalPanel.emptyRunning"
              className="h-full flex flex-col items-center justify-center gap-1 text-text-muted text-xs"
            >
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />A shell is still running
                here
              </div>
              <div className="text-[10px] text-text-muted/70">
                Press{' '}
                <span className="font-mono mx-0.5 px-1 py-0.5 bg-bg-tertiary rounded text-text-secondary">
                  +
                </span>{' '}
                to re-attach, then right-click the tab to kill it
              </div>
            </div>
          ) : (
            <div
              data-testid="TerminalPanel.empty"
              className="h-full flex items-center justify-center text-text-muted text-xs"
            >
              Press{' '}
              <span className="font-mono mx-1 px-1 py-0.5 bg-bg-tertiary rounded text-text-secondary">
                +
              </span>{' '}
              to open a terminal
            </div>
          ))}
      </div>
    </div>
  )
}
