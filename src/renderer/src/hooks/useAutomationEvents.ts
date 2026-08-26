import { useEffect } from 'react'
import { onSyncEvent } from '../../../core/shared/sync/client-registry'
import { useAutomationStore } from '../stores/automation-store'

/**
 * True when the selected view should receive this automation's LIVE stream —
 * i.e. the automation is selected AND either no specific run is selected or the
 * selected run is the currently-running one. Prevents a new run's streamed text
 * from leaking into a different (historical) run being viewed (M-RN1). The
 * run-message/stream IPC carries no runId (main-process, out of scope), so we
 * derive the running run from the store's own run list.
 */
function viewingLiveStream(
  store: ReturnType<typeof useAutomationStore.getState>,
  automationId: string
): boolean {
  if (automationId !== store.selectedAutomationId) return false
  const runningRunId = store.runs[automationId]?.find((r) => r.status === 'running')?.id
  if (runningRunId && store.selectedRunId && store.selectedRunId !== runningRunId) return false
  return true
}

/**
 * Registers IPC event listeners for automation run updates and automation changes.
 * Call once from the root layout (SessionView).
 */
export function useAutomationEvents(): void {
  useEffect(() => {
    // Load automations on mount
    window.api.listAutomations().then((automations) => {
      useAutomationStore.getState().setAutomations(automations)
    })

    const cleanups = [
      onSyncEvent('automation:run-update', ({ automationId, run }) => {
        const store = useAutomationStore.getState()
        store.updateRun(automationId, run)
        // Badge only on completion (not on 'running' status)
        if (run.status === 'success' || run.status === 'error') {
          store.incrementBadge()
          // Clear streaming text and processing state when run finishes
          if (automationId === store.selectedAutomationId) {
            store.clearStreamingText()
            store.setIsRunProcessing(false)
          }
        }
      }),

      onSyncEvent('automation:processing', ({ automationId, isProcessing }) => {
        const store = useAutomationStore.getState()
        if (automationId === store.selectedAutomationId) {
          store.setIsRunProcessing(isProcessing)
          if (!isProcessing) store.clearStreamingText()
        }
      }),

      onSyncEvent('automation:changed', (automations) => {
        useAutomationStore.getState().setAutomations(automations)
      }),

      onSyncEvent('automation:run-message', ({ automationId, message }) => {
        const store = useAutomationStore.getState()
        store.appendRunMessage(automationId, message)
        // Clear streaming text when a final assistant message arrives — but only
        // if this stream belongs to the run being viewed (M-RN1).
        if (message.role === 'assistant' && viewingLiveStream(store, automationId)) {
          store.clearStreamingText()
        }
      }),

      onSyncEvent('automation:stream-event', ({ automationId, type, text }) => {
        const store = useAutomationStore.getState()
        if (type === 'text' && viewingLiveStream(store, automationId)) {
          store.appendStreamingText(text)
        }
      })
    ]

    return () => cleanups.forEach((fn) => fn())
  }, [])
}
