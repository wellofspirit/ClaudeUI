import { useRef, useCallback, memo } from 'react'
import type { SessionInfo } from '../../../../shared/types'
import { SessionItem } from './SessionItem'

export const PinnedSessionList = memo(function PinnedSessionList({
  pinnedSessions,
  activeSessionId,
  onClickSession,
  onToggleWatch,
  onUnpin,
  onReorder,
  renamingKey,
  renamePrefix,
  onStartRename,
  onFinishRename,
  onAutoRename,
  onCancelRename,
  hiddenSessionIds,
  onHideSession,
  onUnhideSession,
  onDeleteSession
}: {
  pinnedSessions: SessionInfo[]
  activeSessionId: string | null
  onClickSession: (info: SessionInfo) => void
  onToggleWatch: (info: SessionInfo) => void
  onUnpin: (routingId: string) => void
  onReorder: (ids: string[]) => void
  renamingKey: string | null
  renamePrefix: string
  onStartRename: (key: string) => void
  onFinishRename: (id: string, title: string) => void
  onAutoRename: (id: string) => void
  onCancelRename: () => void
  hiddenSessionIds?: Set<string>
  onHideSession?: (info: SessionInfo) => void
  onUnhideSession?: (info: SessionInfo) => void
  onDeleteSession?: (info: SessionInfo) => void
}): React.JSX.Element {
  const dragItemRef = useRef<number | null>(null)
  const dragOverRef = useRef<number | null>(null)

  const handleDragStart = useCallback(
    (idx: number) => (e: React.DragEvent) => {
      dragItemRef.current = idx
      e.dataTransfer.effectAllowed = 'move'
      ;(e.currentTarget as HTMLElement).style.opacity = '0.5'
    },
    []
  )

  const handleDragOver = useCallback(
    (idx: number) => (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      dragOverRef.current = idx
    },
    []
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const from = dragItemRef.current
      const to = dragOverRef.current
      if (from == null || to == null || from === to) return
      const ids = pinnedSessions.map((s) => s.sessionId)
      const [moved] = ids.splice(from, 1)
      ids.splice(to, 0, moved)
      onReorder(ids)
      dragItemRef.current = null
      dragOverRef.current = null
    },
    [pinnedSessions, onReorder]
  )

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).style.opacity = '1'
    dragItemRef.current = null
    dragOverRef.current = null
  }, [])

  return (
    <nav data-testid="PinnedSessionList" className="flex flex-col gap-px">
      {pinnedSessions.map((info, idx) => {
        const sessionHidden = !!hiddenSessionIds?.has(info.sessionId)
        return (
          <SessionItem
            key={info.sessionId}
            info={info}
            active={info.sessionId === activeSessionId}
            onClick={() => onClickSession(info)}
            onToggleWatch={info.projectKey ? () => onToggleWatch(info) : undefined}
            onUnpin={() => onUnpin(info.sessionId)}
            isRenaming={renamingKey === `${renamePrefix}:${info.sessionId}`}
            onStartRename={() => onStartRename(`${renamePrefix}:${info.sessionId}`)}
            onFinishRename={(title) => onFinishRename(info.sessionId, title)}
            onAutoRename={() => onAutoRename(info.sessionId)}
            onCancelRename={onCancelRename}
            hidden={sessionHidden}
            onHide={!sessionHidden && onHideSession ? () => onHideSession(info) : undefined}
            onUnhide={sessionHidden && onUnhideSession ? () => onUnhideSession(info) : undefined}
            onDelete={onDeleteSession && info.projectKey ? () => onDeleteSession(info) : undefined}
            draggable
            onDragStart={handleDragStart(idx)}
            onDragOver={handleDragOver(idx)}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        )
      })}
    </nav>
  )
})
