import { useEffect, useRef, useState } from 'react'
import type { WorktreeInfo } from '../../../../../shared/types'
import { displayCwd } from '../../../../../shared/display-path'
import { useEscapeLayer } from '../../shared/use-escape-layer'
import { useAnchoredMenu } from '../../shared/use-anchored-menu'
import { WORKTREE_MARK } from '../../git/WorktreePill'

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * The ▾ half of the VS Code split button, shown only while the session works in
 * a worktree: the button body opens the worktree, this menu lets the user pick
 * the parent repo instead. Both rows hand the folder to `onOpen` — the same
 * handler the body uses — so the desktop deep link and the web mint flow stay
 * one code path, and a row click still opens the web tab synchronously.
 */
export function VSCodeFolderMenu({
  worktree,
  onOpen
}: {
  worktree: WorktreeInfo
  onOpen: (folder: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const caretRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const anchored = useAnchoredMenu({
    open,
    anchorRef: caretRef,
    menuRef,
    placement: 'down',
    onClose: () => setOpen(false)
  })

  useEscapeLayer(() => setOpen(false), true, open)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const rows = [
    {
      id: 'Worktree',
      folder: worktree.worktreePath,
      title: 'Worktree',
      name: worktree.worktreeName,
      nameClass: 'text-mode-edit',
      mark: (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-mode-edit"
        >
          {WORKTREE_MARK}
        </svg>
      ),
      isDefault: true
    },
    {
      id: 'Parent',
      folder: worktree.gitRoot,
      title: 'Parent repo',
      name: baseName(worktree.gitRoot),
      nameClass: 'text-text-secondary',
      mark: <span className="shrink-0 text-text-muted">↰</span>,
      isDefault: false
    }
  ]

  return (
    <div ref={rootRef} className="flex items-stretch">
      <span aria-hidden className="w-px my-1.5 bg-border" />
      <button
        ref={caretRef}
        data-testid="TopBar.openVSCodeCaret"
        onClick={() => setOpen((o) => !o)}
        title="Choose folder"
        aria-haspopup="menu"
        aria-expanded={open}
        className="px-1 py-1 rounded-r-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default flex items-center"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          data-testid="TopBar.openVSCodeMenu"
          style={anchored?.style}
          className="w-[300px] z-50 bg-bg-primary border border-border rounded-lg shadow-lg p-1 animate-fade-in"
        >
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] text-text-muted">Open in VS Code</div>
          {rows.map((row) => (
            <button
              key={row.id}
              role="menuitem"
              data-testid={`TopBar.openVSCodeMenu${row.id}`}
              onClick={() => {
                setOpen(false)
                onOpen(row.folder)
              }}
              className="w-full flex gap-2.5 text-left rounded-md px-2.5 py-2 text-[12px] text-text-secondary hover:bg-bg-hover transition-colors cursor-default"
            >
              <span className="mt-[2px]">{row.mark}</span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                  <span>{row.title}</span>
                  <span className={`truncate ${row.nameClass}`}>{row.name}</span>
                  {row.isDefault && (
                    <span className="ml-auto shrink-0 text-[10px] text-text-muted border border-border rounded px-1">
                      default
                    </span>
                  )}
                </span>
                <span className="block truncate text-[11px] text-text-muted">
                  {displayCwd(row.folder)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
