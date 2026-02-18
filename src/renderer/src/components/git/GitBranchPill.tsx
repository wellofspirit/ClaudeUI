import { useState, useRef } from 'react'
import { useActiveSession } from '../../stores/session-store'
import { GitBranchDropdown } from './GitBranchDropdown'

export function GitBranchPill(): React.JSX.Element | null {
  const isGitRepo = useActiveSession((s) => s.isGitRepo)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  if (!isGitRepo || !gitStatus) return null

  const branchName = gitStatus.branch || 'HEAD'
  const displayName = branchName.length > 16 ? branchName.slice(0, 15) + '\u2026' : branchName

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
        title={`Branch: ${branchName}`}
      >
        {/* Git branch icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 01-9 9" />
        </svg>
        <span className="truncate max-w-[100px]">{displayName}</span>
        <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor" className="shrink-0 opacity-50">
          <path d="M3 5l3 3 3-3" />
        </svg>
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
