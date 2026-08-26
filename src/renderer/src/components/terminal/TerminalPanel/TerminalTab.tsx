import type { TerminalTab as TerminalTabModel } from '../../../../../shared/types'
import { useContextMenu } from '../../../hooks/useContextMenu'

export interface TerminalTabProps {
  tab: TerminalTabModel
  active: boolean
  onSelect: () => void
  /**
   * Close this tab. The default TERMINATES the pty behind it, for every surface;
   * `detach: true` only lets this surface go and leaves the shell running.
   */
  onClose: (detach?: boolean) => void
}

const MENU_ITEM =
  'w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default'
const MENU_ITEM_DANGER =
  'w-full text-left px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/15 hover:text-red-300 transition-colors cursor-default'

/**
 * One tab in the terminal strip, with the right-click menu that spells out what
 * closing a shell does.
 *
 * Closing a terminal MEANS "stop it" (ADR-062), so the × kills and the modifier
 * guards the safe half. It used to be the other way round: terminals are a
 * shared per-cwd pool — another surface may be watching this very pty — so
 * closing detached and a kill needed Shift or a confirmed menu item. That
 * ordering optimized for the rare reader at the cost of the common intent, and
 * it left the phone (no modifier, no right-click) with no stop at all.
 *
 * The kill therefore no longer asks: an in-menu confirm in front of the exact
 * action one unmodified click performs is ceremony that teaches nothing. What
 * the menu still does is teach — it names the two outcomes for what they do to
 * the SHELL, with the destructive one first because it is the default, and the
 * × tooltip advertises the modifier for anyone who wants the other one.
 */
export function TerminalTab({
  tab,
  active,
  onSelect,
  onClose
}: TerminalTabProps): React.JSX.Element {
  const menu = useContextMenu()

  return (
    <>
      <div
        data-testid="TerminalTab"
        data-id={tab.id}
        data-active={active ? 'true' : undefined}
        onClick={onSelect}
        onContextMenu={menu.open}
        className={`group flex items-center gap-1 px-2.5 h-6 rounded text-[11px] cursor-default transition-colors select-none ${
          active
            ? 'bg-bg-primary text-text-primary'
            : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
        }`}
      >
        <span className="truncate max-w-[120px]">{tab.title}</span>
        <button
          data-testid="TerminalTab.close"
          data-id={tab.id}
          title="Close (kill) — Shift-click to detach, right-click for more"
          onClick={(e) => {
            e.stopPropagation()
            // Shift is the DETACH modifier now: a plain close ends the shell,
            // which is what closing a terminal is taken to mean.
            onClose(e.shiftKey)
          }}
          className="w-3.5 h-3.5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-bg-tertiary text-[10px]"
        >
          &times;
        </button>
      </div>
      {menu.isOpen && (
        <div
          data-testid="TerminalTab.menu"
          data-id={tab.id}
          ref={menu.ref}
          // The menu is the tab's SIBLING (fragment), not its child, so nothing
          // here bubbles into the tab's onClick — no stopPropagation needed, and
          // the "clicking the menu must not select the tab" test pins that
          // outcome rather than any guard. Right-click IS suppressed: without
          // it the browser's own context menu opens on top of this one on the
          // web surface.
          onContextMenu={(e) => e.preventDefault()}
          className="fixed z-[9999] py-1 rounded-lg bg-bg-tertiary border border-border shadow-lg grid min-w-[190px]"
          style={menu.style}
        >
          <button
            data-testid="TerminalTab.menuKill"
            onClick={() => {
              menu.close()
              onClose(false)
            }}
            className={MENU_ITEM_DANGER}
          >
            Kill shell
          </button>
          <div className="h-px bg-border my-1" />
          <button
            data-testid="TerminalTab.menuDetach"
            onClick={() => {
              menu.close()
              onClose(true)
            }}
            className={MENU_ITEM}
          >
            Detach (keep shell running)
          </button>
        </div>
      )}
    </>
  )
}
