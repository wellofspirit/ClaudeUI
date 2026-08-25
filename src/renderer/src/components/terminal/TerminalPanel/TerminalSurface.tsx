import { lazy, Suspense } from 'react'
import type { TerminalTab as TerminalTabModel } from '../../../../../shared/types'

// Lazy: xterm.js + addon-fit + xterm.css must not ride the eager App chunk. The
// desktop panel's container is always mounted (display:none preserves
// scrollback), so the boundary has to be XTermInstance — it mounts once per tab,
// and tabs start at zero. This module is imported statically by both surfaces,
// which is why the split must live HERE and not one level up.
const XTermInstance = lazy(() =>
  import('../XTermInstance').then((m) => ({ default: m.XTermInstance }))
)

export interface TerminalSurfaceProps {
  /** Every tab across every cwd group — kept mounted so scrollback survives a switch. */
  allTabs: TerminalTabModel[]
  /** Tabs for the ACTIVE cwd — the empty states key on this, not on `allTabs`. */
  visibleTabs: TerminalTabModel[]
  activeId: string | null
  /** A shell is already running in the slot "+" would ask for. */
  nextSlotRunning: boolean
  readOnly?: boolean
  onBlockedInput?: () => void
  /**
   * Render the phone's terminal regime (ADR-060): mirror the pty's width rather
   * than fitting to it, pan horizontally, and scroll by touch. Passed by
   * `TerminalMobileView` and by nothing else — the desktop panel omits it and
   * gets the fit-both-axes terminal unchanged.
   *
   * The ADR-048 shape: the presentation forks, the machinery does not. Both
   * surfaces still mount ONE `XTermInstance` per tab through this file.
   */
  mobile?: boolean
}

/**
 * The shell surface itself: one mounted xterm per tab plus the two empty states.
 *
 * Shared verbatim by the desktop bottom panel ({@link TerminalPanelView}) and
 * the phone's fullscreen takeover (`TerminalMobileView`) — the chrome around it
 * differs completely, the terminal does not. Keeping it in one place is what
 * makes "the mobile terminal is the same terminal" true by construction rather
 * than by two copies staying in step: the lazy boundary, the tab-visibility
 * trick (display:none, never unmount), the read-only plumbing and the
 * re-attach hint all live here once.
 */
export function TerminalSurface({
  allTabs,
  visibleTabs,
  activeId,
  nextSlotRunning,
  readOnly,
  onBlockedInput,
  mobile
}: TerminalSurfaceProps): React.JSX.Element {
  return (
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
              mirrorGrid={mobile}
            />
          </Suspense>
        </div>
      ))}
      {visibleTabs.length === 0 &&
        (nextSlotRunning ? (
          // The case the pool made invisible: no tab here, but the shell (a dev
          // server, a `tail -f`) is still running — this surface detached from
          // it, or another surface owns the slot — and nothing on screen said
          // so, so the operator reads an empty panel as an empty machine.
          // Reopening re-attaches and replays its scrollback; closing the tab
          // that comes back is what stops it (ADR-062).
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
              to re-attach, then close its tab to stop it
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
  )
}
