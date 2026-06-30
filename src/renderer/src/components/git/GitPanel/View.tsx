import type { GitStatusData } from '../../../../../shared/types'
import { GitFileTree } from '../GitFileTree'
import { GitFileDiffView } from '../GitFileDiffView'
import { GitCommitBox } from '../GitCommitBox'
import { FilterTabs } from './FilterTabs'

export interface GitPanelViewProps {
  style?: React.CSSProperties
  gitStatus: GitStatusData | null
  isDouble: boolean
  onClose: () => void
  onToggleLayout: () => void
}

export function GitPanelView({
  style,
  gitStatus,
  isDouble,
  onClose,
  onToggleLayout
}: GitPanelViewProps): React.JSX.Element {
  const stagedCount = gitStatus?.staged.length ?? 0
  const unstagedCount = (gitStatus?.unstaged.length ?? 0) + (gitStatus?.untracked.length ?? 0)

  return (
    <div
      data-testid="GitPanel"
      style={style}
      className="shrink-0 border-l border-border bg-bg-secondary flex flex-col h-full overflow-hidden"
    >
      {/* Panel header */}
      <div className="shrink-0 flex items-center px-4 h-12 border-b border-border [-webkit-app-region:drag]">
        <span className="text-[13px] text-text-secondary font-medium flex-1">Git Changes</span>
        <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          <button
            data-testid="GitPanel.toggleLayout"
            onClick={onToggleLayout}
            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title={isDouble ? 'Switch to single pane' : 'Switch to double pane'}
          >
            {isDouble ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="12" x2="21" y2="12" />
              </svg>
            )}
          </button>
          <button
            data-testid="GitPanel.close"
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {isDouble ? (
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
