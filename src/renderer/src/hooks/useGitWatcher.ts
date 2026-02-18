import { useEffect } from 'react'
import { useSessionStore, useActiveSession } from '../stores/session-store'

/**
 * Watches the active session's cwd for git repo status.
 * Starts/stops polling and checks if the directory is a git repo.
 */
export function useGitWatcher(): void {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const cwd = useActiveSession((s) => s.cwd)
  const isGitRepo = useActiveSession((s) => s.isGitRepo)
  const setIsGitRepo = useSessionStore((s) => s.setIsGitRepo)

  // Check if cwd is a git repo when session or cwd changes
  useEffect(() => {
    if (!cwd || !activeSessionId) return

    // Just check if it's a git repo — don't fetch status here.
    // gitStartWatching does an initial poll immediately, so status
    // will arrive via the git:status-update event without the extra call.
    window.api.gitCheckRepo(cwd).then((isRepo) => {
      setIsGitRepo(activeSessionId, isRepo)
    }).catch(() => {
      setIsGitRepo(activeSessionId, false)
    })
  }, [cwd, activeSessionId, setIsGitRepo])

  // Start/stop git polling when cwd changes
  useEffect(() => {
    if (!cwd || !isGitRepo) return

    window.api.gitStartWatching(cwd)
    return () => {
      window.api.gitStopWatching(cwd)
    }
  }, [cwd, isGitRepo])
}
