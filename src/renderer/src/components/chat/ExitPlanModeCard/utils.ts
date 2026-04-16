import { useSessionStore } from '../../../stores/session-store'

/**
 * Wait for the SDK's permission mode status message to arrive.
 * When ExitPlanMode is allowed, the SDK sends a status change back to 'default'.
 * We must wait for that before setting our desired mode, otherwise the SDK's
 * status change will overwrite ours.
 */
export function waitForModeChange(): Promise<void> {
  return new Promise((resolve) => {
    const state = useSessionStore.getState()
    const rid = state.activeSessionId
    const currentMode = rid ? state.sessions[rid]?.permissionMode : 'default'
    const unsub = useSessionStore.subscribe((s) => {
      const mode = rid ? s.sessions[rid]?.permissionMode : 'default'
      if (mode !== currentMode) {
        unsub()
        resolve()
      }
    })
    setTimeout(() => {
      unsub()
      resolve()
    }, 2000)
  })
}
