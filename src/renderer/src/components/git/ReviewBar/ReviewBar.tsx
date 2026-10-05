import { useCallback, useEffect, useRef } from 'react'
import {
  hasResumableTranscript,
  useActiveSession,
  useSessionStore
} from '../../../stores/session-store'
import type { DiffComment } from '../../../../../shared/types'
import { sessionSpawnEffort, spawnAnnouncement } from '../../../lib/session-effort'
import { composeReviewPrompt } from './utils'
import { ReviewBarView } from './View'

interface Props {
  comments: DiffComment[]
}

export function ReviewBar({ comments }: Props): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sdkActive = useActiveSession((s) => s.sdkActive)
  const sessions = useSessionStore((s) => s.sessions)
  const markSdkActive = useSessionStore((s) => s.markSdkActive)
  const clearDiffComments = useSessionStore((s) => s.clearDiffComments)
  const selectedEngineId = useActiveSession((s) => s.selectedEngineId)

  const fileCount = new Set(comments.map((c) => c.filePath)).size

  const handleSend = useCallback(async () => {
    if (!activeSessionId || !comments.length) return

    const prompt = composeReviewPrompt(comments)

    // Lazy SDK create if not yet active
    if (!sdkActive) {
      const session = sessions[activeSessionId]
      const isHistorical = session && hasResumableTranscript(session) && !session.sdkActive
      const resumeId = isHistorical ? activeSessionId : undefined
      const state = useSessionStore.getState()
      // The spawn's own resolver, so the review respawn runs what the composer
      // shows (per-model starting effort, not a hardcoded 'medium'). Codex's
      // native tiers are not the Claude ladder: it keeps the old fallback.
      const effort =
        session && selectedEngineId !== 'codex'
          ? sessionSpawnEffort(state, session)
          : (session?.effort ?? 'medium')
      await window.api.createSession(
        activeSessionId,
        session?.cwd || '',
        effort,
        resumeId,
        session?.permissionMode,
        // The session's own pick, NOT undefined: an absent model makes the
        // opencode resolver substitute a catalog fallback, and since 0065eef the
        // birth event announces the resolved model to every replica — an
        // undefined here would overwrite the user's picker with that fallback.
        session?.selectedModel,
        undefined,
        undefined,
        undefined,
        selectedEngineId,
        spawnAnnouncement(state, session, effort)
      )
      markSdkActive(activeSessionId)
    }

    await window.api.sendPrompt(activeSessionId, prompt)
    clearDiffComments(activeSessionId)
  }, [
    activeSessionId,
    comments,
    sdkActive,
    sessions,
    markSdkActive,
    clearDiffComments,
    selectedEngineId
  ])

  // Stable ref so the keydown handler always sees the latest handleSend
  const sendRef = useRef(handleSend)
  sendRef.current = handleSend

  // Cmd+Shift+Enter to send all comments
  useEffect(() => {
    if (!comments.length) return

    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        sendRef.current()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [comments.length])

  return <ReviewBarView comments={comments} fileCount={fileCount} onSend={handleSend} />
}
