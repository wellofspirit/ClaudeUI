import { useAutomationStore } from '../../stores/automation-store'
import { AutomationConfig } from './AutomationConfig'
import { AutomationRunHistory } from './AutomationRunHistory'

interface AutomationDetailProps {
  className?: string
}

export function AutomationDetail({ className }: AutomationDetailProps): React.JSX.Element {
  const selectedAutomationId = useAutomationStore((s) => s.selectedAutomationId)
  const selectedRunId = useAutomationStore((s) => s.selectedRunId)

  if (!selectedAutomationId) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-center text-text-muted">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-3 opacity-30">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <p className="text-sm">Select an automation to configure</p>
          <p className="text-xs mt-1">or create a new one from the left panel</p>
        </div>
      </div>
    )
  }

  if (selectedRunId) {
    return (
      <div className={className}>
        <AutomationRunHistory />
      </div>
    )
  }

  return (
    <div className={className}>
      <AutomationConfig />
    </div>
  )
}
