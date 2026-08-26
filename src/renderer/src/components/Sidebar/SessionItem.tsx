import { useState, useEffect, useRef, memo } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { useShallow } from 'zustand/react/shallow'
import type { SessionInfo } from '../../../../shared/types'
import { PermissionsDialog } from '../PermissionsDialog'
import { useContextMenu } from '../../hooks/useContextMenu'
import { EngineLogo } from '../shared/EngineLogo'

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
  onHide,
  onUnhide,
  onDelete,
  hidden,
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
  /** Hide this session from the sidebar (persists to config) */
  onHide?: () => void
  /** Restore a previously hidden session */
  onUnhide?: () => void
  /** Permanently delete the session from disk (opens confirm modal upstream) */
  onDelete?: () => void
  /** When true, renders in a dimmed/italic style */
  hidden?: boolean
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
  const menu = useContextMenu()
  const [renameValue, setRenameValue] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const renameCommittedRef = useRef(false)
  const [permissionsOpen, setPermissionsOpen] = useState(false)

  const dotColor =
    needsAttention && !active
      ? 'bg-warning animate-pulse'
      : isRunning
        ? 'bg-green-400 animate-pulse'
        : isSdkActive
          ? 'bg-green-400'
          : isWatching
            ? 'bg-blue-400'
            : 'bg-text-muted/30'

  // Right-side icon overlay is sized to its actual icon count. Each icon ≈20px
  // (icon + gap) tightly wrapped, plus 5px right padding, plus a 40px blur-in
  // transition zone extending to the left.
  const rightIconCount =
    (isWorktree ? 1 : 0) + (onPin || onUnpin ? 1 : 0) + (onToggleWatch && !isSdkActive ? 1 : 0)
  const blurWidthPx = rightIconCount * 20 + 45
  const blurTransitionPct = Math.round((40 / blurWidthPx) * 100)

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
        data-testid="SessionItem"
        data-id={info.sessionId}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={menu.open}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDrop={onDrop}
        style={{ padding: '0 5px' }}
        className={`
          group relative flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors
          ${active ? 'text-text-primary bg-bg-tertiary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}
          ${hidden ? 'opacity-45 italic' : ''}
        `}
      >
        <span className="shrink-0 w-[14px] h-[14px] flex items-center justify-center">
          <span
            className={`inline-block w-[6px] h-[6px] rounded-full ${dotColor} ${onRemove ? 'group-hover:hidden' : ''}`}
          />
          {onRemove && (
            <span
              data-testid="SessionItem.remove"
              onClick={(e) => {
                e.stopPropagation()
                onRemove()
              }}
              className="hidden group-hover:flex items-center justify-center w-[14px] h-[14px] rounded text-text-muted hover:text-text-primary transition-colors cursor-pointer"
              title="Remove from recent"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </span>
          )}
        </span>
        {isRenaming ? (
          <input
            data-testid="SessionItem.renameInput"
            ref={renameRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => {
              setTimeout(() => {
                if (!renameCommittedRef.current) onCancelRename?.()
              }, 0)
            }}
            placeholder="Enter to auto-generate"
            className="flex-1 min-w-0 bg-transparent border-b border-accent text-[13px] text-text-primary outline-none placeholder:text-text-muted/50"
          />
        ) : (
          <span
            className="overflow-hidden whitespace-nowrap flex-1 min-w-0 flex items-center gap-1"
            style={{
              WebkitMaskImage:
                'linear-gradient(to right, black calc(100% - 12px), transparent 100%)',
              maskImage: 'linear-gradient(to right, black calc(100% - 12px), transparent 100%)'
            }}
            title={info.title}
          >
            <EngineLogo
              engineId={info.engineId ?? 'claude'}
              size={10}
              className="shrink-0 opacity-80"
            />
            {info.title}
          </span>
        )}
        {/* Backdrop blur underlay (hover-only) — width scales to the actual icon count so the
            tinted strip is no wider than needed. Progressively blurs + darkens the text so
            icons stand out against a uniform field. */}
        {!isRenaming && rightIconCount > 0 && (
          <div
            className="absolute right-0 top-0 h-full pointer-events-none rounded-r-md opacity-0 group-hover:opacity-100 transition-opacity session-icon-backdrop"
            style={{
              width: `${blurWidthPx}px`,
              backdropFilter: 'blur(5px)',
              WebkitBackdropFilter: 'blur(5px)',
              maskImage: `linear-gradient(to right, transparent 0, black ${blurTransitionPct}%)`,
              WebkitMaskImage: `linear-gradient(to right, transparent 0, black ${blurTransitionPct}%)`
            }}
          />
        )}
        {/* Icon overlay (hover-only) — floats over the blurred backdrop */}
        {!isRenaming && (
          <div className="absolute right-[5px] top-0 h-full flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {isWorktree && (
              <span className="shrink-0 text-mode-edit opacity-100" title="Worktree session">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="18" r="3" />
                  <circle cx="6" cy="6" r="3" />
                  <circle cx="18" cy="6" r="3" />
                  <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                  <path d="M12 12v3" />
                </svg>
              </span>
            )}
            {onPin && (
              <span
                data-testid="SessionItem.pin"
                onClick={(e) => {
                  e.stopPropagation()
                  onPin()
                }}
                className="shrink-0 text-text-primary opacity-90 hover:opacity-100 transition-opacity cursor-pointer"
                title="Pin session"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 17v5" />
                  <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24z" />
                </svg>
              </span>
            )}
            {onUnpin && (
              <span
                data-testid="SessionItem.unpin"
                onClick={(e) => {
                  e.stopPropagation()
                  onUnpin()
                }}
                className="shrink-0 text-text-primary opacity-90 hover:opacity-100 transition-opacity cursor-pointer"
                title="Unpin session"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 17v5" />
                  <path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24z" />
                </svg>
              </span>
            )}
            {onToggleWatch && !isSdkActive && (
              <span
                data-testid="SessionItem.toggleWatch"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleWatch()
                }}
                className={`shrink-0 transition-opacity cursor-pointer opacity-90 hover:opacity-100 ${
                  isWatching ? 'text-blue-400' : 'text-text-primary'
                }`}
                title={isWatching ? 'Stop watching' : 'Watch session'}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </span>
            )}
          </div>
        )}
      </div>
      {menu.isOpen && (
        <div
          ref={menu.ref}
          className="fixed z-[9999] py-1 rounded-lg bg-bg-tertiary border border-border shadow-lg grid"
          style={menu.style}
        >
          <button
            onClick={() => {
              menu.close()
              onStartRename?.()
            }}
            className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
          >
            Rename session
          </button>
          <button
            onClick={() => {
              menu.close()
              onAutoRename?.()
            }}
            className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
          >
            Auto rename
          </button>
          <button
            onClick={() => {
              menu.close()
              setPermissionsOpen(true)
            }}
            className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
          >
            Edit permissions
          </button>
          {isSdkActive && (
            <button
              onClick={() => {
                menu.close()
                window.api.cancelSession(info.sessionId)
              }}
              className="w-full text-left px-3 py-1.5 text-[13px] text-red-400 hover:bg-bg-hover hover:text-red-300 transition-colors cursor-default"
            >
              Disconnect
            </button>
          )}
          {(onHide || onUnhide || onDelete) && <div className="h-px bg-border my-1" />}
          {onHide && !hidden && (
            <button
              onClick={() => {
                menu.close()
                onHide()
              }}
              className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
            >
              Hide session
            </button>
          )}
          {onUnhide && hidden && (
            <button
              onClick={() => {
                menu.close()
                onUnhide()
              }}
              className="w-full text-left px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
            >
              Unhide session
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => {
                menu.close()
                onDelete()
              }}
              className="w-full text-left px-3 py-1.5 text-[13px] text-red-400 hover:bg-red-500/15 hover:text-red-300 transition-colors cursor-default"
            >
              Delete session...
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
