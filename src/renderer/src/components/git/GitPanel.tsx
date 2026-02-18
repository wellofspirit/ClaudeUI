import { useEffect, useCallback } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { GitFileTree } from './GitFileTree'
import { GitFileDiffView } from './GitFileDiffView'
import { GitCommitBox } from './GitCommitBox'

interface Props {
  style?: React.CSSProperties
}

export function GitPanel({ style }: Props): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const cwd = useActiveSession((s) => s.cwd)
  const gitStatus = useActiveSession((s) => s.gitStatus)
  const gitPanelLayout = useSessionStore((s) => s.settings.gitPanelLayout)
  const closeGitPanel = useSessionStore((s) => s.closeGitPanel)
  const setGitStatus = useSessionStore((s) => s.setGitStatus)
  const setGitSelectedFile = useSessionStore((s) => s.setGitSelectedFile)
  const updateSettings = useSessionStore((s) => s.updateSettings)

  // Fetch initial status when panel opens and auto-select first file
  useEffect(() => {
    if (!cwd || !activeSessionId) return
    window.api.gitGetStatus(cwd).then((status) => {
      setGitStatus(activeSessionId, status)
      // Auto-select first file if nothing is selected yet
      const current = useSessionStore.getState().sessions[activeSessionId]?.gitSelectedFile
      if (!current && status.files.length > 0) {
        setGitSelectedFile(activeSessionId, status.files[0].path)
      }
    }).catch(() => {})
  }, [cwd, activeSessionId, setGitStatus, setGitSelectedFile])

  const handleClose = useCallback(() => {
    if (activeSessionId) closeGitPanel(activeSessionId)
  }, [activeSessionId, closeGitPanel])

  const toggleLayout = useCallback(() => {
    updateSettings({ gitPanelLayout: gitPanelLayout === 'single' ? 'double' : 'single' })
  }, [gitPanelLayout, updateSettings])

  const stagedCount = gitStatus?.staged.length ?? 0
  const unstagedCount = (gitStatus?.unstaged.length ?? 0) + (gitStatus?.untracked.length ?? 0)

  const isDouble = gitPanelLayout === 'double'

  return (
    <div style={style} className="shrink-0 border-l border-border bg-bg-secondary flex flex-col h-full overflow-hidden">
      {/* Panel header */}
      <div className="shrink-0 flex items-center px-4 h-10 border-b border-border">
        <span className="text-[13px] text-text-secondary font-medium flex-1">Git Changes</span>
        <div className="flex items-center gap-1">
          {/* Layout toggle */}
          <button
            onClick={toggleLayout}
            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title={isDouble ? 'Switch to single pane' : 'Switch to double pane'}
          >
            {isDouble ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="12" x2="21" y2="12" />
              </svg>
            )}
          </button>
          {/* Close */}
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {isDouble ? (
        /* Double-pane: diff on left, file list + commit on right */
        <div className="flex-1 flex min-h-0">
          <div className="flex-1 min-w-0 flex flex-col border-r border-border">
            <GitFileDiffView />
          </div>
          <div className="w-[260px] shrink-0 flex flex-col min-h-0">
            <FilterTabs stagedCount={stagedCount} unstagedCount={unstagedCount} />
            <div className="flex-1 overflow-y-auto min-h-0">
              <GitFileTree />
            </div>
            <GitCommitBox />
          </div>
        </div>
      ) : (
        /* Single-pane: file tree on top, diff below, commit at bottom */
        <div className="flex-1 flex flex-col min-h-0">
          <FilterTabs stagedCount={stagedCount} unstagedCount={unstagedCount} />
          <div className="shrink-0 max-h-[40%] overflow-y-auto border-b border-border">
            <GitFileTree />
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            <GitFileDiffView />
          </div>
          <GitCommitBox />
        </div>
      )}
    </div>
  )
}

function FilterTabs({ stagedCount, unstagedCount }: { stagedCount: number; unstagedCount: number }): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const gitFileFilter = useActiveSession((s) => s.gitFileFilter)
  const setGitFileFilter = useSessionStore((s) => s.setGitFileFilter)

  const tabs: Array<{ key: 'staged' | 'unstaged' | 'all'; label: string; count: number }> = [
    { key: 'staged', label: 'Staged', count: stagedCount },
    { key: 'unstaged', label: 'Unstaged', count: unstagedCount },
    { key: 'all', label: 'All', count: stagedCount + unstagedCount }
  ]

  return (
    <div className="shrink-0 flex border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => activeSessionId && setGitFileFilter(activeSessionId, tab.key)}
          className={`flex-1 px-2 py-1.5 text-[11px] font-medium transition-colors cursor-default ${
            gitFileFilter === tab.key
              ? 'text-text-primary border-b-2 border-accent'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          {tab.label} ({tab.count})
        </button>
      ))}
    </div>
  )
}
