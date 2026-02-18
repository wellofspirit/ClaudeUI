import { useEffect, useRef } from 'react'
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
  const setGitStatus = useSessionStore((s) => s.setGitStatus)
  const prevCwdRef = useRef<string | null>(null)

  // Check if cwd is a git repo when it changes
  useEffect(() => {
    if (!cwd || !activeSessionId) return
    if (cwd === prevCwdRef.current) return
    prevCwdRef.current = cwd

    window.api.gitCheckRepo(cwd).then((isRepo) => {
      setIsGitRepo(activeSessionId, isRepo)
      if (isRepo) {
        // Fetch initial status
        window.api.gitGetStatus(cwd).then((status) => {
          setGitStatus(activeSessionId, status)
        }).catch(() => {})
      }
    }).catch(() => {
      setIsGitRepo(activeSessionId, false)
    })
  }, [cwd, activeSessionId, setIsGitRepo, setGitStatus])

  // Start/stop git polling when cwd changes
  useEffect(() => {
    if (!cwd || !isGitRepo) return

    window.api.gitStartWatching(cwd)
    return () => {
      window.api.gitStopWatching(cwd)
    }
  }, [cwd, isGitRepo])
}
