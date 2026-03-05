import { useCallback, useEffect, useRef } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import type { DiffComment } from '../../../../shared/types'

interface Props {
  comments: DiffComment[]
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {}
  for (const item of items) {
    const k = key(item)
    if (!result[k]) result[k] = []
    result[k].push(item)
  }
  return result
}

function composeReviewPrompt(comments: DiffComment[]): string {
  const byFile = groupBy(comments, (c) => c.filePath)
  const parts: string[] = ['Please address these review comments on the current git changes:\n']

  for (const [file, fileComments] of Object.entries(byFile)) {
    for (const c of fileComments) {
      const lineLabel = c.endLineNumber > c.lineNumber
        ? `lines ${c.lineNumber}\u2013${c.endLineNumber}`
        : `line ${c.lineNumber}`
      parts.push(`**${file}** (${lineLabel}, ${c.side} side):`)
      if (c.lineContent) {
        // Indent multi-line content as a blockquote
        const quoted = c.lineContent.split('\n').map((l) => `> ${l}`).join('\n')
        parts.push(quoted)
      }
      parts.push(`Comment: "${c.comment}"\n`)
    }
  }

  return parts.join('\n')
}

export function ReviewBar({ comments }: Props): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sdkActive = useActiveSession((s) => s.sdkActive)
  const sessions = useSessionStore((s) => s.sessions)
  const markSdkActive = useSessionStore((s) => s.markSdkActive)
  const clearDiffComments = useSessionStore((s) => s.clearDiffComments)

  const fileCount = new Set(comments.map((c) => c.filePath)).size

  const handleSend = useCallback(async () => {
    if (!activeSessionId || !comments.length) return

    const prompt = composeReviewPrompt(comments)

    // Lazy SDK create if not yet active (same pattern as InputBox.doSend)
    if (!sdkActive) {
      const session = sessions[activeSessionId]
      const isHistorical = session && session.messages.length > 0 && !session.sdkActive
      const resumeId = isHistorical ? activeSessionId : undefined
      await window.api.createSession(
        activeSessionId,
        session?.cwd || '',
        session?.effort ?? 'medium',
        resumeId,
        session?.permissionMode
      )
      markSdkActive(activeSessionId)
    }

    // User message is added by the server-relayed session:user-message event
    await window.api.sendPrompt(activeSessionId, prompt)
    clearDiffComments(activeSessionId)
  }, [activeSessionId, comments, sdkActive, sessions, markSdkActive, clearDiffComments])

  // Stable ref so the keydown handler always sees the latest handleSend
  const sendRef = useRef(handleSend)
  sendRef.current = handleSend

  // ⌘⇧Enter / Ctrl+Shift+Enter to send all comments
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

  if (!comments.length) return null

  return (
    <div className="shrink-0 flex items-center justify-between px-3 py-2 border-t border-border bg-bg-secondary/80">
      <span className="text-[11px] text-text-muted">
        {comments.length} comment{comments.length !== 1 ? 's' : ''}
        {' \u00b7 '}
        {fileCount} file{fileCount !== 1 ? 's' : ''}
      </span>
      <button
        onClick={handleSend}
        className="text-[11px] px-3 py-1 rounded bg-accent text-white hover:bg-accent/90 transition-colors cursor-default"
      >
        Send to Chat
        <span className="ml-1.5 text-[10px] opacity-60">{'\u2318\u21e7\u23ce'}</span>
      </button>
    </div>
  )
}
