import type { TerminalTab } from '../../../../../shared/types'
import { XTermInstance } from '../XTermInstance'

export interface TerminalPanelViewProps {
  style: React.CSSProperties
  visibleTabs: TerminalTab[]
  allTabs: TerminalTab[]
  activeId: string | null
  onSelectTab: (id: string, cwd: string) => void
  onCloseTab: (id: string) => void
  onNewTab: () => void
  onClosePanel: () => void
}

export function TerminalPanelView({
  style,
  visibleTabs,
  allTabs,
  activeId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onClosePanel
}: TerminalPanelViewProps): React.JSX.Element {
  return (
    <div
      style={style}
      className="flex flex-col bg-bg-primary border-t border-border overflow-hidden"
    >
      <div className="flex items-center gap-0.5 px-2 py-1 bg-bg-secondary border-b border-border shrink-0">
        {visibleTabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id, tab.cwd)}
            className={`group flex items-center gap-1 px-2.5 h-6 rounded text-[11px] cursor-default transition-colors select-none ${
              tab.id === activeId
                ? 'bg-bg-primary text-text-primary'
                : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
            }`}
          >
            <span className="truncate max-w-[120px]">{tab.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onCloseTab(tab.id)
              }}
              className="w-3.5 h-3.5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-bg-tertiary text-[10px]"
            >
              &times;
            </button>
          </div>
        ))}
        <button
          onClick={onNewTab}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover text-sm"
          title="New terminal"
        >
          +
        </button>
        <button
          onClick={onClosePanel}
          className="ml-auto w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover text-[10px]"
          title="Close terminal panel"
        >
          &times;
        </button>
      </div>

      <div className="flex-1 min-h-0 relative overflow-hidden">
        {allTabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === activeId ? 'block' : 'none' }}
          >
            <XTermInstance terminalId={tab.id} isActive={tab.id === activeId} />
          </div>
        ))}
        {visibleTabs.length === 0 && (
          <div className="h-full flex items-center justify-center text-text-muted text-xs">
            Press{' '}
            <span className="font-mono mx-1 px-1 py-0.5 bg-bg-tertiary rounded text-text-secondary">
              +
            </span>{' '}
            to open a terminal
          </div>
        )}
      </div>
    </div>
  )
}
