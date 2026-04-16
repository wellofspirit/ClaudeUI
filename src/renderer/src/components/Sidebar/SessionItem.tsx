import { useState, useEffect, useRef, memo } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { useShallow } from 'zustand/react/shallow'
import type { SessionInfo } from '../../../../shared/types'
import { PermissionsDialog } from '../PermissionsDialog'

/** Convert mouse event coords to zoom-adjusted position for fixed-position menus */
function contextMenuPosition(e: React.MouseEvent): { x: number; y: number } {
  const zoom = useSessionStore.getState().settings.uiFontScale
  return { x: e.clientX / zoom, y: e.clientY / zoom }
}

export const SessionItem = memo(function SessionItem({
  info,
  active,
  onClick,
  onDoubleClick,
  onToggleWatch,
  onPin,
  onUnpin,
  onRemove,
  isRenaming,
  onStartRename,
  onFinishRename,
  onCancelRename,
  onAutoRename,
  draggable,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop
}: {
  info: SessionInfo
  active: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onToggleWatch?: () => void
  onPin?: () => void
  onUnpin?: () => void
  onRemove?: () => void
  isRenaming?: boolean
  onStartRename?: () => void
  onFinishRename?: (title: string) => void
  onCancelRename?: () => void
  onAutoRename?: () => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}): React.JSX.Element {
  // Self-subscribe to session status fields — avoids parent needing the full sessions map
  const { isRunning, isSdkActive, isWatching, needsAttention } = useSessionStore(
    useShallow((s) => {
      const sess = s.sessions[info.sessionId]
      return {
        isRunning: sess?.status?.state === 'running',
        isSdkActive: !!sess?.sdkActive,
        isWatching: !!sess?.isWatching,
        needsAttention: !!sess?.needsAttention
      }
    })
  )
  const isWorktree = useSessionStore((s) => !!s.worktreeInfoMap[info.sessionId])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const renameCommittedRef = useRef(false)
  const [permissionsOpen, setPermissionsOpen] = useState(false)

  const dotColor = needsAttention && !active
    ? 'bg-warning animate-pulse'
    : isRunning
      ? 'bg-green-400 animate-pulse'
      : isSdkActive
        ? 'bg-green-400'
        : isWatching
          ? 'bg-blue-400'
          : 'bg-text-muted/30'

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    setContextMenu(contextMenuPosition(e))
  }

  // Close context menu on outside click
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

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (isRenaming && renameRef.current) {
      renameCommittedRef.current = false
      setRenameValue('')
      renameRef.current.focus()
    }
  }, [isRenaming])

  const handleRenameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      renameCommittedRef.current = true
      onFinishRename?.(renameValue)
    } else if (e.key === 'Escape') {
      renameCommittedRef.current = true
      onCancelRename?.()
    }
  }

  return (
    <>
      <div
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={handleContextMenu}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDrop={onDrop}
        style={{ padding: '0 5px' }}
        className={`
          group flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors
          ${active ? 'text-text-primary bg-bg-tertiary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}
        `}
      >
        <span className="shrink-0 w-[14px] h-[14px] flex items-center justify-center">
          <span className={`inline-block w-[6px] h-[6px] rounded-full ${dotColor} ${onRemove ? 'group-hover:hidden' : ''}`} />
          {onRemove && (
            <span
              onClick={(e) => { e.stopPropagation(); onRemove() }}
              className="hidden group-hover:flex items-center justify-center w-[14px] h-[14px] rounded text-text-muted hover:text-text-primary transition-colors cursor-pointer"
              title="Remove from recent"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </span>
          )}
        </span>
        {isRenaming ? (
          <input
            ref={renameRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => { setTimeout(() => { if (!renameCommittedRef.current) onCancelRename?.() }, 0) }}
            placeholder="Enter to auto-generate"
            className="flex-1 min-w-0 bg-transparent border-b border-accent text-[13px] text-text-primary outline-none placeholder:text-text-muted/50"
          />
        ) : (
          <span className="truncate flex-1">{info.title}</span>
        )}
      {/* Worktree indicator */}
      {isWorktree && (
        <span className="shrink-0 text-mode-edit opacity-60" title="Worktree session">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
            <path d="M12 12v3" />
          </svg>
        </span>
      )}
      {/* Pin/Unpin button */}
      {onPin && (
        <span
          onClick={(e) => { e.stopPropagation(); onPin() }}
          className="shrink-0 opacity-0 group-hover:opacity-50 text-text-muted hover:!opacity-80 transition-opacity cursor-pointer"
          title="Pin session"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 17v5" />
            <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24z" />
          </svg>
        </span>
      )}
      {onUnpin && (
        <span
          onClick={(e) => { e.stopPropagation(); onUnpin() }}
          className="shrink-0 opacity-0 group-hover:opacity-50 text-text-muted hover:!opacity-80 transition-opacity cursor-pointer"
          title="Unpin session"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 17v5" />
            <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24z" />
          </svg>
        </span>
      )}
      {onToggleWatch && !isSdkActive && (
        <span
          onClick={(e) => { e.stopPropagation(); onToggleWatch() }}
          className={`shrink-0 transition-opacity cursor-pointer ${
            isWatching ? 'opacity-80 text-blue-400' : 'opacity-0 group-hover:opacity-50 text-text-muted hover:!opacity-80'
          }`}
          title={isWatching ? 'Stop watching' : 'Watch session'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
      )}
    </div>
    {contextMenu && (
      <div
        ref={contextMenuRef}
        className="fixed z-[9999] py-1 rounded-lg bg-bg-tertiary border border-border shadow-lg grid"
        style={{ left: contextMenu.x, top: contextMenu.y }}
      >
        <button
          onClick={() => {
            setContextMenu(null)
            onStartRename?.()
          }}
          className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
        >
          Rename session
        </button>
        <button
          onClick={() => {
            setContextMenu(null)
            onAutoRename?.()
          }}
          className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
        >
          Auto rename
        </button>
        <button
          onClick={() => {
            setContextMenu(null)
            setPermissionsOpen(true)
          }}
          className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
        >
          Edit permissions
        </button>
        {isSdkActive && (
          <button
            onClick={() => {
              setContextMenu(null)
              window.api.cancelSession(info.sessionId)
            }}
            className="w-full text-left px-3 py-1.5 text-[13px] text-red-400 hover:bg-bg-hover hover:text-red-300 transition-colors cursor-default"
          >
            Disconnect
          </button>
        )}
      </div>
    )}
    <PermissionsDialog
      open={permissionsOpen}
      onClose={() => setPermissionsOpen(false)}
      cwd={info.cwd}
    />
  </>
  )
})
