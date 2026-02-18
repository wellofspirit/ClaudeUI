import { useActiveSession, useSessionStore } from '../../stores/session-store'

export function GitChangesPill(): React.JSX.Element | null {
  const isGitRepo = useActiveSession((s) => s.isGitRepo)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const rightPanel = useActiveSession((s) => s.rightPanel)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const openGitPanel = useSessionStore((s) => s.openGitPanel)
  const closeGitPanel = useSessionStore((s) => s.closeGitPanel)

  if (!isGitRepo || !gitStatus) return null

  const totalChanges = gitStatus.files.length
  const { linesAdded, linesRemoved } = gitStatus
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
        className={`flex items-baseline gap-1 px-2 py-1 rounded-md text-[12px] whitespace-nowrap transition-colors cursor-default ${
          isActive ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
        }`}
        title="No changes"
      >
        <span>No Changes</span>
      </button>
    )
  }

  return (
    <button
      onClick={handleClick}
      className={`flex items-baseline gap-1.5 px-2 py-1 rounded-md text-[12px] whitespace-nowrap transition-colors cursor-default ${
        isActive ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
      }`}
      title={`${totalChanges} changed file${totalChanges > 1 ? 's' : ''} · +${linesAdded} -${linesRemoved}`}
    >
      <span className="inline-flex items-baseline gap-1 font-mono tabular-nums">
        <span className="text-green-400">+{linesAdded}</span>
        <span className="text-text-muted">|</span>
        <span className="text-red-400">-{linesRemoved}</span>
      </span>
    </button>
  )
}
