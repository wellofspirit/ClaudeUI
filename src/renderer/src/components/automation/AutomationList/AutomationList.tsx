import { useCallback, useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import { useAutomationStore } from '../../../stores/automation-store'
import type { Automation, AutomationRun } from '../../../../../shared/types'
import { AutomationListView } from './View'

interface AutomationListProps {
  className?: string
}

export function AutomationList({ className }: AutomationListProps): React.JSX.Element {
  const automations = useAutomationStore((s) => s.automations)
  const selectedAutomationId = useAutomationStore((s) => s.selectedAutomationId)
  const runs = useAutomationStore((s) => s.runs)
  const setRuns = useAutomationStore((s) => s.setRuns)
  const selectAutomation = useAutomationStore((s) => s.selectAutomation)

  // Fetch runs for any automation we haven't loaded yet so the list can render
  // sparklines + cost totals. Live updates arrive via useAutomationEvents →
  // updateRun, so we only need to backfill the initial state.
  useEffect(() => {
    automations.forEach((a) => {
      if (runs[a.id] !== undefined) return
      window.api
        .listAutomationRuns(a.id)
        .then((r: AutomationRun[]) => setRuns(a.id, r))
        .catch(() => setRuns(a.id, []))
    })
  }, [automations, runs, setRuns])

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

  return (
    <AutomationListView
      className={className}
      automations={automations}
      selectedAutomationId={selectedAutomationId}
      runs={runs}
      onCreate={handleCreate}
      onSelect={selectAutomation}
    />
  )
}
