import { useState, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { useAutomationStore } from '../../../stores/automation-store'
import type { Automation } from '../../../../../shared/types'
import { AutomationListView } from './View'

interface AutomationListProps {
  className?: string
}

export function AutomationList({ className }: AutomationListProps): React.JSX.Element {
  const automations = useAutomationStore((s) => s.automations)
  const selectedAutomationId = useAutomationStore((s) => s.selectedAutomationId)
  const selectedRunId = useAutomationStore((s) => s.selectedRunId)
  const runs = useAutomationStore((s) => s.runs)
  const selectAutomation = useAutomationStore((s) => s.selectAutomation)
  const selectRun = useAutomationStore((s) => s.selectRun)

  const [expandedId, setExpandedId] = useState<string | null>(null)

  const handleCreate = useCallback((): void => {
    const newAutomation: Automation = {
      id: uuid(),
      name: 'New Automation',
      prompt: '',
      cwd: '',
      schedule: { type: 'interval', intervalMs: 3600000 },
      permissions: { allow: [], deny: [] },
      enabled: false,
      lastRunAt: null,
      lastRunStatus: null,
      createdAt: Date.now()
    }
    window.api.saveAutomation(newAutomation)
    selectAutomation(newAutomation.id)
  }, [selectAutomation])

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  const handleLoadRuns = useCallback((automationId: string) => {
    window.api.listAutomationRuns(automationId)
      .then((r) => {
        useAutomationStore.getState().setRuns(automationId, r)
      })
      .catch((err) => {
        window.api.logError('AutomationList', `Failed to list runs for ${automationId}: ${err}`)
        // Set empty runs so the UI shows "No runs yet" instead of staying blank
        useAutomationStore.getState().setRuns(automationId, [])
      })
  }, [])

  return (
    <AutomationListView
      className={className}
      automations={automations}
      selectedAutomationId={selectedAutomationId}
      selectedRunId={selectedRunId}
      runs={runs}
      expandedId={expandedId}
      onToggleExpand={handleToggleExpand}
      onCreate={handleCreate}
      onSelect={selectAutomation}
      onSelectRun={selectRun}
      onLoadRuns={handleLoadRuns}
    />
  )
}
