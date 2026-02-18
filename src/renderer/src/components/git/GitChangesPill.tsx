import { useActiveSession, useSessionStore } from '../../stores/session-store'

export function GitChangesPill(): React.JSX.Element | null {
  const isGitRepo = useActiveSession((s) => s.isGitRepo)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const rightPanel = useActiveSession((s) => s.rightPanel)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const openGitPanel = useSessionStore((s) => s.openGitPanel)
  const closeGitPanel = useSessionStore((s) => s.closeGitPanel)

  if (!isGitRepo || !gitStatus) return null

  const modified = gitStatus.files.filter((f) => f.index === 'M' || f.working === 'M').length
  const added = gitStatus.files.filter((f) => f.index === 'A' || f.working === '?' || f.index === '?').length
  const deleted = gitStatus.files.filter((f) => f.index === 'D' || f.working === 'D').length
  const totalChanges = gitStatus.files.length
  const isActive = rightPanel === 'git'

  const handleClick = (): void => {
    if (!activeSessionId) return
    if (isActive) {
      closeGitPanel(activeSessionId)
    } else {
      openGitPanel(activeSessionId)
    }
  }

  if (totalChanges === 0) {
    return (
      <button
        onClick={handleClick}
        className={`flex items-center gap-1 px-2 py-1 rounded-md text-[12px] transition-colors cursor-default ${
          isActive ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
        }`}
        title="Working tree clean"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span>Clean</span>
      </button>
    )
  }

  return (
    <button
      onClick={handleClick}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] transition-colors cursor-default ${
        isActive ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
      }`}
      title={`${totalChanges} changed file${totalChanges > 1 ? 's' : ''}`}
    >
      {/* Delta icon */}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3L2 21h20L12 3z" />
      </svg>
      <span className="flex items-center gap-1">
        {modified > 0 && <span className="text-yellow-400">{modified}M</span>}
        {added > 0 && <span className="text-green-400">+{added}</span>}
        {deleted > 0 && <span className="text-red-400">-{deleted}</span>}
      </span>
    </button>
  )
}
