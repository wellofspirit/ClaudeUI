import { useEffect, useRef, useState } from 'react'
import { onSyncAnswered } from '../../../core/shared/sync/client-registry'
import { useSessionStore, useActiveSession } from '../stores/session-store'

/**
 * Watches the active session's cwd for git repo status.
 *
 * States this client's INTEREST as a replace set (`git:watch {cwds}`, phase 5
 * S2); the union of every connection's set is what the host polls. That is why
 * there is no "stop" call — an empty set IS the stop, and a socket that dies takes
 * its interest with it.
 *
 * Re-sent on every answered `sync` for exactly the reason `useStreamWatch` is: the
 * set is per-CONNECTION, so a phone that backgrounded and reconnected holds none,
 * and its git pill would sit on stale state until the working tree next changed.
 */
export function useGitWatcher(): void {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const cwd = useActiveSession((s) => s.cwd)
  const isGitRepo = useActiveSession((s) => s.isGitRepo)
  const setIsGitRepo = useSessionStore((s) => s.setIsGitRepo)

  // Check if cwd is a git repo when session or cwd changes
  useEffect(() => {
    if (!cwd || !activeSessionId) return

    // Just check if it's a git repo — don't fetch status here. A `git:watch`
    // always answers with a status (a fresh poller's first tick, or the cached
    // one), so it arrives via the git:status-update event without the extra call.
    window.api
      .gitCheckRepo(cwd)
      .then((isRepo) => {
        setIsGitRepo(activeSessionId, isRepo)
      })
      .catch(() => {
        setIsGitRepo(activeSessionId, false)
      })
  }, [cwd, activeSessionId, setIsGitRepo])

  // Bumped by every answered sync — the initial one, a resync, and every
  // reconnect. A counter, so two reconnects in a row both re-fire the effect.
  const [connectionGeneration, setConnectionGeneration] = useState(0)
  const watched = useRef<string | null>(null)
  watched.current = cwd && isGitRepo ? cwd : null

  useEffect(() => onSyncAnswered(() => setConnectionGeneration((n) => n + 1)), [])

  useEffect(() => {
    void window.api.watchGit(watched.current ? [watched.current] : []).catch(() => {
      // A refusal leaves this client without live git status; the next answered
      // sync retries. Silent on purpose — a toast for a missing pill is noise.
    })
  }, [cwd, isGitRepo, connectionGeneration])
}
