import { useState, useEffect, useRef, useCallback } from 'react'
import { useSessionStore } from '../../stores/session-store'
import type { DirectoryGroup, SessionInfo } from '../../../../shared/types'
import { SessionItem } from './SessionItem'

/** Convert mouse event coords to zoom-adjusted position for fixed-position menus */
function contextMenuPosition(e: React.MouseEvent): { x: number; y: number } {
  const zoom = useSessionStore.getState().settings.uiFontScale
  return { x: e.clientX / zoom, y: e.clientY / zoom }
}

export function DirectoryItem({
  group,
  expanded,
  activeSessionId,
  sessions,
  onClick,
  onDoubleClick,
  onSessionClick,
  onSessionDoubleClick,
  onToggleWatch,
  onViewWorktrees,
  renamingKey,
  renamePrefix,
  onStartRename,
  onFinishRename,
  onAutoRename,
  onCancelRename
}: {
  group: DirectoryGroup
  expanded: boolean
  activeSessionId: string | null
  sessions: Record<string, { status?: { state: string }; sdkActive?: boolean; isWatching?: boolean; needsAttention?: boolean }>
  onClick: () => void
  onDoubleClick: () => void
  onSessionClick: (info: SessionInfo) => void
  onSessionDoubleClick: (info: SessionInfo) => void
  onToggleWatch: (info: SessionInfo) => void
  onViewWorktrees?: () => void
  renamingKey: string | null
  renamePrefix: string
  onStartRename: (key: string) => void
  onFinishRename: (id: string, title: string) => void
  onAutoRename: (id: string) => void
  onCancelRename: () => void
}): React.JSX.Element {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleClick = useCallback(() => {
    // Delay single-click to distinguish from double-click
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      onClick()
    }, 250)
  }, [onClick])

  const handleDoubleClick = useCallback(() => {
    // Cancel pending single-click so the directory doesn't toggle
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    onDoubleClick()
  }, [onDoubleClick])

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    setContextMenu(contextMenuPosition(e))
  }

  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent): void => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    }
  }, [])

  return (
    <div>
      <div
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        style={{ padding: '0 5px' }}
        className="flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors text-text-secondary hover:text-text-primary hover:bg-bg-hover"
      >
        <span className="shrink-0 text-text-muted">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <path d="M8 5l8 7-8 7z" />
          </svg>
        </span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
        <span className="truncate flex-1">{group.folderName}</span>
        <span className="text-[10px] text-text-muted">{group.sessions.length}</span>
      </div>
      {expanded && (
        <div className="ml-3">
          {group.sessions.map((info) => {
            const s = sessions[info.sessionId]
            return (
              <SessionItem
                key={info.sessionId}
                info={info}
                active={info.sessionId === activeSessionId}
                isRunning={s?.status?.state === 'running'}
                isSdkActive={s?.sdkActive}
                isWatching={s?.isWatching}
                needsAttention={s?.needsAttention}
                onClick={() => onSessionClick(info)}
                onDoubleClick={() => onSessionDoubleClick(info)}
                onToggleWatch={() => onToggleWatch(info)}
                isRenaming={renamingKey === `${renamePrefix}:${info.sessionId}`}
                onStartRename={() => onStartRename(`${renamePrefix}:${info.sessionId}`)}
                onFinishRename={(title) => onFinishRename(info.sessionId, title)}
                onAutoRename={() => onAutoRename(info.sessionId)}
                onCancelRename={onCancelRename}
              />
            )
          })}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] py-1 rounded-lg bg-bg-tertiary border border-border shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {onViewWorktrees && (
            <button
              onClick={() => { setContextMenu(null); onViewWorktrees() }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-left cursor-default"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted">
                <circle cx="12" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                <path d="M12 12v3" />
              </svg>
              View worktrees
            </button>
          )}
          <button
            onClick={() => {
              setContextMenu(null)
              onDoubleClick()
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-left cursor-default"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="shrink-0 text-text-muted">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
            </svg>
            New session here
          </button>
        </div>
      )}
    </div>
  )
}
