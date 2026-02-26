import { AutomationList } from './AutomationList'
import { AutomationDetail } from './AutomationDetail'
import { useAutomationStore } from '../../stores/automation-store'

interface AutomationViewProps {
  onClose: () => void
}

export function AutomationView({ onClose }: AutomationViewProps): React.JSX.Element {
  const clearBadge = useAutomationStore((s) => s.clearBadge)

  // Clear badge when viewing automation page
  clearBadge()

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg-primary/95 backdrop-blur-sm border-b border-border/30">
        <div className="flex items-center justify-between px-4 py-2.5" style={{ paddingTop: window.api.platform === 'darwin' ? 38 : 8 }}>
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-text-accent">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span className="text-sm font-semibold text-text-primary">Automations</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 2-pane layout */}
      <div className="flex-1 flex min-h-0">
        <AutomationList className="w-[280px] shrink-0 border-r border-border/30 overflow-y-auto" />
        <AutomationDetail className="flex-1 min-w-0 overflow-y-auto" />
      </div>
    </div>
  )
}
