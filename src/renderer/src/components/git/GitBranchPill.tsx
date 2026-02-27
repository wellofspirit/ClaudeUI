import { useState, useRef } from 'react'
import { useActiveSession } from '../../stores/session-store'
import { GitBranchDropdown } from './GitBranchDropdown'

export function GitBranchPill(): React.JSX.Element | null {
  const isGitRepo = useActiveSession((s) => s.isGitRepo)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const syncOp = useActiveSession((s) => s.gitSyncOperation)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  if (!isGitRepo || !gitStatus) return null

  const branchName = gitStatus.branch || 'HEAD'
  const displayName = branchName.length > 16 ? branchName.slice(0, 15) + '\u2026' : branchName
  const { ahead, behind, trackingBranch } = gitStatus
  const isSyncing = syncOp !== 'idle'

  // Build detailed tooltip
  const tooltipParts = [`Branch: ${branchName}`]
  if (trackingBranch) {
    if (ahead > 0) tooltipParts.push(`${ahead} ahead`)
    if (behind > 0) tooltipParts.push(`${behind} behind`)
    if (ahead === 0 && behind === 0) tooltipParts.push('up to date')
    tooltipParts.push(`tracking ${trackingBranch}`)
  } else {
    tooltipParts.push('no upstream')
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="flex items-baseline gap-1.5 px-2 py-1 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
        title={tooltipParts.join(' \u00b7 ')}
      >
        {/* Git branch icon */}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 relative top-[1.5px]">
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 01-9 9" />
        </svg>
        <span className="truncate max-w-[100px] font-mono">{displayName}</span>

        {/* Sync status indicators */}
        {isSyncing ? (
          <span className="text-[10px] text-accent animate-spin inline-block">⟳</span>
        ) : trackingBranch ? (
          <span className="flex items-baseline gap-1 text-[10px] font-mono tabular-nums">
            {ahead > 0 && <span className="text-accent">↑{ahead}</span>}
            {behind > 0 && <span className="text-yellow-400">↓{behind}</span>}
          </span>
        ) : (
          <span className="text-[10px] text-text-muted/60 italic">local</span>
        )}
      </button>
      {dropdownOpen && (
        <GitBranchDropdown
          onClose={() => setDropdownOpen(false)}
          anchorRef={buttonRef}
        />
      )}
    </div>
  )
}
