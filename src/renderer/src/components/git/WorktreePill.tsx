import { useState, useRef, useEffect } from 'react'
import { useActiveSession } from '../../stores/session-store'
import { useEscapeLayer } from '../shared/use-escape-layer'

/**
 * The worktree this pill would name, or `null` when there is no pill at all.
 *
 * One copy of the pill's own condition, because below tier 1 the pill is hidden
 * and `TopBar`'s ⋯ menu carries the row that opens the same popover — a second
 * derivation there could offer a worktree panel for a session that has none.
 */
export function useWorktreePillName(): string | null {
  const worktreeInfo = useActiveSession((s) => s.worktreeInfo)
  return worktreeInfo ? worktreeInfo.worktreeName : null
}

/** The worktree mark, shared with the ⋯ row that replaces this pill below tier
 *  1 — one drawing, whatever `<svg>` box each surface puts it in. */
export const WORKTREE_MARK = (
  <>
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
    <path d="M12 12v3" />
  </>
)

/**
 * The pill's panel — worktree, branch, path, Copy.
 *
 * Exported so the ⋯ row that stands in for the pill below tier 1 opens THIS
 * panel rather than a second copy of it. `align` is the only difference between
 * the two callers: hung off the ⋯ it right-aligns under the bar, exactly like
 * the menu it was chosen from.
 */
export function WorktreePopover({
  anchorRef,
  onClose,
  align = 'left'
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  align?: 'left' | 'right'
}): React.JSX.Element | null {
  const worktreeInfo = useActiveSession((s) => s.worktreeInfo)
  const [copied, setCopied] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEscapeLayer(onClose)

  // Close popover on outside click
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [anchorRef, onClose])

  if (!worktreeInfo) return null

  const handleCopyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(worktreeInfo.worktreePath)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      ref={popoverRef}
      data-testid="WorktreePill.popover"
      className={`absolute top-full ${align === 'right' ? 'right-0' : 'left-0'} mt-1 z-50 w-[260px] rounded-lg bg-bg-tertiary border border-border shadow-lg p-3`}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        <div className="flex items-center justify-between">
          <span className="text-text-muted">Worktree</span>
          <span
            className="font-mono text-mode-edit truncate max-w-[160px]"
            title={worktreeInfo.worktreeName}
          >
            {worktreeInfo.worktreeName}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-text-muted">Branch</span>
          <span
            className="font-mono text-text-primary truncate max-w-[160px]"
            title={worktreeInfo.worktreeBranch}
          >
            {worktreeInfo.worktreeBranch}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          <span
            className="font-mono text-[11px] text-text-muted truncate max-w-[200px]"
            title={worktreeInfo.worktreePath}
          >
            {worktreeInfo.worktreePath}
          </span>
          <button
            data-testid="WorktreePill.copyPath"
            onClick={handleCopyPath}
            className="shrink-0 px-1.5 py-0.5 rounded text-[11px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Copy path"
          >
            {copied ? '✓' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function WorktreePill(): React.JSX.Element | null {
  const name = useWorktreePillName()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  if (name === null) return null

  const displayName = name.length > 16 ? name.slice(0, 15) + '…' : name

  return (
    <div data-testid="WorktreePill" className="relative">
      <button
        ref={buttonRef}
        data-testid="WorktreePill.toggle"
        onClick={() => setPopoverOpen(!popoverOpen)}
        className="flex items-baseline gap-1.5 px-2 py-1 rounded-md text-[12px] text-mode-edit hover:bg-bg-hover transition-colors cursor-default"
        title={`Worktree: ${name}`}
      >
        {/* Git tree/fork icon */}
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 relative top-[1.5px]"
        >
          {WORKTREE_MARK}
        </svg>
        <span className="truncate max-w-[100px] font-mono">{displayName}</span>
      </button>
      {popoverOpen && (
        <WorktreePopover anchorRef={buttonRef} onClose={() => setPopoverOpen(false)} />
      )}
    </div>
  )
}
