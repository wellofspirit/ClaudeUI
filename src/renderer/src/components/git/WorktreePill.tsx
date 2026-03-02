import { useState, useRef, useEffect } from 'react'
import { useActiveSession } from '../../stores/session-store'

export function WorktreePill(): React.JSX.Element | null {
  const worktreeInfo = useActiveSession((s) => s.worktreeInfo)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return
    const handler = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popoverOpen])

  if (!worktreeInfo) return null

  const displayName = worktreeInfo.worktreeName.length > 16
    ? worktreeInfo.worktreeName.slice(0, 15) + '\u2026'
    : worktreeInfo.worktreeName

  const handleCopyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(worktreeInfo.worktreePath)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setPopoverOpen(!popoverOpen)}
        className="flex items-baseline gap-1.5 px-2 py-1 rounded-md text-[12px] text-mode-edit hover:bg-bg-hover transition-colors cursor-default"
        title={`Worktree: ${worktreeInfo.worktreeName}`}
      >
        {/* Git tree/fork icon */}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 relative top-[1.5px]">
          <circle cx="12" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <circle cx="18" cy="6" r="3" />
          <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
          <path d="M12 12v3" />
        </svg>
        <span className="truncate max-w-[100px] font-mono">{displayName}</span>
      </button>
      {popoverOpen && (
        <div
          ref={popoverRef}
          className="absolute top-full left-0 mt-1 z-50 w-[260px] rounded-lg bg-bg-tertiary border border-border shadow-lg p-3"
        >
          <div className="flex flex-col gap-2 text-[12px]">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Worktree</span>
              <span className="font-mono text-mode-edit truncate max-w-[160px]" title={worktreeInfo.worktreeName}>{worktreeInfo.worktreeName}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Branch</span>
              <span className="font-mono text-text-primary truncate max-w-[160px]" title={worktreeInfo.worktreeBranch}>{worktreeInfo.worktreeBranch}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="font-mono text-[11px] text-text-muted truncate max-w-[200px]" title={worktreeInfo.worktreePath}>
                {worktreeInfo.worktreePath}
              </span>
              <button
                onClick={handleCopyPath}
                className="shrink-0 px-1.5 py-0.5 rounded text-[11px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                title="Copy path"
              >
                {copied ? '✓' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
