import { useEffect, useState } from 'react'
import type { TerminalTab as TerminalTabModel } from '../../../../../shared/types'
import { useContextMenu } from '../../../hooks/useContextMenu'

export interface TerminalTabProps {
  tab: TerminalTabModel
  active: boolean
  onSelect: () => void
  /**
   * Close this tab. `kill: true` also TERMINATES the pty behind it, for every
   * surface; the default merely detaches this one.
   */
  onClose: (kill?: boolean) => void
}

const MENU_ITEM =
  'w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default'
const MENU_ITEM_DANGER =
  'w-full text-left px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/15 hover:text-red-300 transition-colors cursor-default'

/**
 * One tab in the terminal strip, with the right-click menu that owns the only
 * DISCOVERABLE way to kill a shell.
 *
 * Closing is detach-only (terminals are a shared per-cwd pool — another surface
 * may be watching this very pty), which left the operator with no visible way
 * to stop a runaway process: the cold sweep never reaps the cwd you are working
 * in, and the Shift-click shortcut is invisible until you already know it. So
 * the menu spells both actions out, and the destructive one asks first —
 * IN-MENU, because a modal for "did you mean the other item" is more ceremony
 * than a two-word confirm and would steal focus from the shell.
 *
 * Shift-click on the × stays as the shortcut for anyone who learned it; the
 * menu is what teaches it.
 */
export function TerminalTab({ tab, active, onSelect, onClose }: TerminalTabProps): React.JSX.Element {
  const menu = useContextMenu()
  const [confirmingKill, setConfirmingKill] = useState(false)

  // A menu dismissed mid-confirm (outside click, or a second right-click) must
  // reopen at the safe step — never with the destructive button already armed.
  useEffect(() => {
    if (!menu.isOpen) setConfirmingKill(false)
  }, [menu.isOpen])

  const closeMenu = (): void => {
    menu.close()
    setConfirmingKill(false)
  }

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
          title="Close (detach) — Shift-click to kill, right-click for more"
          onClick={(e) => {
            e.stopPropagation()
            // Shift is the kill modifier: a plain close leaves the shell
            // running for the other surfaces attached to this pool slot.
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
          {confirmingKill ? (
            <>
              <div
                data-testid="TerminalTab.killWarning"
                className="px-3 py-1.5 text-[11px] text-text-muted leading-snug"
              >
                End this shell for every attached device?
              </div>
              <button
                data-testid="TerminalTab.confirmKill"
                onClick={() => {
                  closeMenu()
                  onClose(true)
                }}
                className={MENU_ITEM_DANGER}
              >
                Kill shell
              </button>
              <button
                data-testid="TerminalTab.cancelKill"
                onClick={() => setConfirmingKill(false)}
                className={MENU_ITEM}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                data-testid="TerminalTab.menuClose"
                onClick={() => {
                  closeMenu()
                  onClose(false)
                }}
                className={MENU_ITEM}
              >
                Close tab (keep shell running)
              </button>
              <div className="h-px bg-border my-1" />
              <button
                data-testid="TerminalTab.menuKill"
                onClick={() => setConfirmingKill(true)}
                className={MENU_ITEM_DANGER}
              >
                Kill terminal…
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}
