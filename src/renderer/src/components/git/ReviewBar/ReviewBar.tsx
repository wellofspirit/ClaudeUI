import { useCallback, useEffect, useRef } from 'react'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import type { DiffComment } from '../../../../../shared/types'
import { spawnSession } from '../../../lib/session-spawn'
import { composeReviewPrompt } from './utils'
import { ReviewBarView } from './View'

interface Props {
  comments: DiffComment[]
}

export function ReviewBar({ comments }: Props): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sdkActive = useActiveSession((s) => s.sdkActive)
  const clearDiffComments = useSessionStore((s) => s.clearDiffComments)

  const fileCount = new Set(comments.map((c) => c.filePath)).size

  const handleSend = useCallback(async () => {
    if (!activeSessionId || !comments.length) return

    const prompt = composeReviewPrompt(comments)

    // Lazy SDK create if not yet active
    if (!sdkActive) await spawnSession(activeSessionId)

    await window.api.sendPrompt(activeSessionId, prompt)
    clearDiffComments(activeSessionId)
  }, [activeSessionId, comments, sdkActive, clearDiffComments])

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
