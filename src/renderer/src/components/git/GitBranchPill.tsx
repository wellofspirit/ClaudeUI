import { useState, useRef } from 'react'
import { useActiveSession } from '../../stores/session-store'
import { GitBranchDropdown } from './GitBranchDropdown'

/**
 * The branch this pill would name, or `null` when there is no pill at all.
 *
 * One copy of "has this session got a branch to act on", because below tier 1
 * the pill is hidden and `TopBar`'s ⋯ menu carries the row that opens the same
 * dropdown — a second derivation there could offer fetch/pull/push for a
 * session the pill itself would have said nothing about.
 *
 * A detached worktree (opencode, Codex) has no branch to name, so the pill
 * names the worktree instead.
 */
export function useBranchPillName(): string | null {
  const isGitRepo = useActiveSession((s) => s.isGitRepo)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const worktreeInfo = useActiveSession((s) => s.worktreeInfo)
  if (!isGitRepo || !gitStatus) return null
  const branch = gitStatus.branch || 'HEAD'
  return branch === 'HEAD' && worktreeInfo ? worktreeInfo.worktreeName : branch
}

/** The branch mark, shared with the ⋯ row that replaces this pill below tier 1
 *  — one drawing, whatever `<svg>` box each surface puts it in. */
export const BRANCH_MARK = (
  <>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 01-9 9" />
  </>
)

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
 * Whether this session runs in a linked worktree - the one pill carries both
 * facts, so the worktree mark replaces the branch mark (tinted purple by the
 * pill) rather than a second pill sitting beside it.
 */
export function useIsWorktreeSession(): boolean {
  return useActiveSession((s) => !!s.worktreeInfo)
}

export function GitBranchPill(): React.JSX.Element | null {
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const syncOp = useActiveSession((s) => s.gitSyncOperation)
  const branchName = useBranchPillName()
  const isWorktree = useIsWorktreeSession()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  if (branchName === null || !gitStatus) return null

  const displayName = branchName.length > 16 ? branchName.slice(0, 15) + '\u2026' : branchName
  const { ahead, behind, trackingBranch } = gitStatus
  const isSyncing = syncOp !== 'idle'

  // Build detailed tooltip
  const tooltipParts = [`${isWorktree ? 'Worktree branch' : 'Branch'}: ${branchName}`]
  if (trackingBranch) {
    if (ahead > 0) tooltipParts.push(`${ahead} ahead`)
    if (behind > 0) tooltipParts.push(`${behind} behind`)
    if (ahead === 0 && behind === 0) tooltipParts.push('up to date')
    tooltipParts.push(`tracking ${trackingBranch}`)
  } else {
    tooltipParts.push('no upstream')
  }

  return (
    <div data-testid="GitBranchPill" className="relative">
      <button
        ref={buttonRef}
        data-testid="GitBranchPill.toggle"
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className={`flex items-baseline gap-1.5 px-2 py-1 rounded-md text-[12px] hover:bg-bg-hover transition-colors cursor-default ${
          isWorktree ? 'text-mode-edit' : 'text-text-muted hover:text-text-primary'
        }`}
        title={tooltipParts.join(' \u00b7 ')}
      >
        {/* Git branch icon, or the worktree mark in a worktree session */}
        <svg
          data-testid="GitBranchPill.mark"
          data-mark={isWorktree ? 'worktree' : 'branch'}
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
          {isWorktree ? WORKTREE_MARK : BRANCH_MARK}
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
        <GitBranchDropdown onClose={() => setDropdownOpen(false)} anchorRef={buttonRef} />
      )}
    </div>
  )
}
