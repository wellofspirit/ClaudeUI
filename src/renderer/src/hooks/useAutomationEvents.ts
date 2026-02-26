import { useEffect } from 'react'
import { useAutomationStore } from '../stores/automation-store'

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
      window.api.onAutomationRunUpdate(({ automationId, run }) => {
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

      window.api.onAutomationProcessing(({ automationId, isProcessing }) => {
        const store = useAutomationStore.getState()
        if (automationId === store.selectedAutomationId) {
          store.setIsRunProcessing(isProcessing)
          if (!isProcessing) store.clearStreamingText()
        }
      }),

      window.api.onAutomationsChanged((automations) => {
        useAutomationStore.getState().setAutomations(automations)
      }),

      window.api.onAutomationRunMessage(({ automationId, message }) => {
        const store = useAutomationStore.getState()
        store.appendRunMessage(automationId, message)
        // Clear streaming text when a final assistant message arrives
        if (automationId === store.selectedAutomationId && message.role === 'assistant') {
          store.clearStreamingText()
        }
      }),

      window.api.onAutomationStreamEvent(({ automationId, type, text }) => {
        const store = useAutomationStore.getState()
        if (automationId === store.selectedAutomationId && type === 'text') {
          store.appendStreamingText(text)
        }
      })
    ]

    return () => cleanups.forEach((fn) => fn())
  }, [])
}
