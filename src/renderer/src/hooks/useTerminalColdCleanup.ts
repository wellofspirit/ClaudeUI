import { useEffect } from 'react'
import { useSessionStore, normalizeCwd } from '../stores/session-store'
import { sessionWorkdir } from '../lib/session-workdir'

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
      // Every directory a session holds: its workdir (terminal groups are keyed by it, so a
      // session in a worktree keeps that group alive) AND its spawn cwd, whose terminals opened
      // before the session entered the worktree must not be reaped behind the user's back.
      const activeCwds = new Set<string>()
      for (const session of Object.values(state.sessions)) {
        const workdir = sessionWorkdir(session)
        if (workdir) activeCwds.add(normalizeCwd(workdir))
        if (session.cwd) activeCwds.add(normalizeCwd(session.cwd))
      }

      // Every cwd that has a terminal group, INCLUDING one whose tabs are all
      // closed: closing a tab now only detaches this surface (terminals are a
      // shared per-cwd pool), so a tabless group can still have live shells
      // behind it. Dropping the `tabs.length > 0` filter is what keeps this the
      // reaper for exactly those.
      const terminalCwds = new Set(Object.keys(state.terminalGroups))

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
