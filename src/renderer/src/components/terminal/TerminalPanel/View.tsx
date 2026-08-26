import type { TerminalTab as TerminalTabModel } from '../../../../../shared/types'
import { TerminalTab } from './TerminalTab'
import { TerminalSurface } from './TerminalSurface'

export interface TerminalPanelViewProps {
  style: React.CSSProperties
  visibleTabs: TerminalTabModel[]
  allTabs: TerminalTabModel[]
  activeId: string | null
  onSelectTab: (id: string, cwd: string) => void
  /**
   * Close this tab. The default KILLS the pty behind it (ADR-062) — closing a
   * terminal is taken to mean stopping it. `detach: true` (Shift-click, or the
   * tab menu's "Detach") only lets this surface go, leaving the shell running
   * for anyone else attached to the shared per-cwd pool.
   */
  onCloseTab: (id: string, detach?: boolean) => void
  onNewTab: () => void
  onClosePanel: () => void
  /**
   * The pool slot "+" will ask for, and whether a shell is ALREADY running in
   * it. True means the next open re-attaches to a live pty (this surface
   * detached from it, or another surface owns it) instead of spawning — which is
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
            onClose={(detach) => onCloseTab(tab.id, detach)}
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

      <TerminalSurface
        allTabs={allTabs}
        visibleTabs={visibleTabs}
        activeId={activeId}
        nextSlotRunning={nextSlotRunning}
        readOnly={readOnly}
        onBlockedInput={onBlockedInput}
      />
    </div>
  )
}
