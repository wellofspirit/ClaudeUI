import { useEffect, useCallback } from 'react'
import { useAutomationStore } from '../../../stores/automation-store'
import { AutomationRunHistoryView } from './View'

export function AutomationRunHistory(): React.JSX.Element {
  const selectedAutomationId = useAutomationStore((s) => s.selectedAutomationId)
  const selectedRunId = useAutomationStore((s) => s.selectedRunId)
  const runs = useAutomationStore((s) =>
    selectedAutomationId ? s.runs[selectedAutomationId] : undefined
  )
  const runMessages = useAutomationStore((s) => s.runMessages)
  const setRunMessages = useAutomationStore((s) => s.setRunMessages)
  const clearRunSelection = useAutomationStore((s) => s.clearRunSelection)
  const streamingText = useAutomationStore((s) => s.streamingText)
  const isRunProcessing = useAutomationStore((s) => s.isRunProcessing)

  const run = runs?.find((r) => r.id === selectedRunId) ?? null

  useEffect(() => {
    if (!selectedAutomationId || !selectedRunId) return
    setRunMessages(null)
    useAutomationStore.getState().clearStreamingText()
    window.api
      .loadAutomationRunHistory(selectedAutomationId, selectedRunId)
      .then((msgs) => {
        setRunMessages(msgs)
      })
      .catch((err) => {
        window.api.logError('AutomationRunHistory', `Failed to load run ${selectedRunId}: ${err}`)
        // Fall back to empty list so the UI shows "No messages recorded" instead of "Loading..."
        setRunMessages([])
      })
  }, [selectedAutomationId, selectedRunId, setRunMessages])

  const handleSend = useCallback(
    (text: string) => {
      if (!selectedAutomationId) return
      window.api.sendAutomationMessage(selectedAutomationId, text)
    },
    [selectedAutomationId]
  )

  const handleStop = useCallback(() => {
    if (!selectedAutomationId || !selectedRunId) return
    window.api.cancelAutomationRun(selectedAutomationId)
    window.api.dismissAutomationRun(selectedAutomationId, selectedRunId)
  }, [selectedAutomationId, selectedRunId])

  return (
    <AutomationRunHistoryView
      run={run}
      runMessages={runMessages}
      streamingText={streamingText}
      isRunProcessing={isRunProcessing}
      onBack={clearRunSelection}
      onStop={handleStop}
      onSend={handleSend}
    />
  )
}
