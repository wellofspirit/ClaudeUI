import { useEffect } from 'react'
import { useSessionStore, normalizeCwd } from '../stores/session-store'

const COLD_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

/** Timers for orphaned cwd groups awaiting cleanup. */
const coldTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Watches for terminal cwd groups that have no active session.
 * After 10 minutes of being orphaned, kills the PTYs and removes the group.
 */
export function useTerminalColdCleanup(): void {
  useEffect(() => {
    const unsub = useSessionStore.subscribe((state) => {
      // Compute active cwds from all sessions
      const activeCwds = new Set<string>()
      for (const session of Object.values(state.sessions)) {
        if (session.cwd) activeCwds.add(normalizeCwd(session.cwd))
      }

      // Compute terminal cwds that have at least one tab
      const terminalCwds = new Set<string>()
      for (const [cwd, group] of Object.entries(state.terminalGroups)) {
        if (group.tabs.length > 0) terminalCwds.add(cwd)
      }

      // Start timers for newly orphaned cwds
      for (const cwd of terminalCwds) {
        if (!activeCwds.has(cwd) && !coldTimers.has(cwd)) {
          coldTimers.set(
            cwd,
            setTimeout(() => {
              coldTimers.delete(cwd)
              window.api.killTerminalsByCwd(cwd)
              useSessionStore.getState().removeTerminalGroup(cwd)
            }, COLD_TIMEOUT_MS)
          )
        }
      }

      // Cancel timers for cwds that became active again
      for (const [cwd, timer] of coldTimers) {
        if (activeCwds.has(cwd)) {
          clearTimeout(timer)
          coldTimers.delete(cwd)
        }
      }
    })

    return () => {
      unsub()
      // Clean up all pending timers on unmount
      for (const timer of coldTimers.values()) clearTimeout(timer)
      coldTimers.clear()
    }
  }, [])
}
