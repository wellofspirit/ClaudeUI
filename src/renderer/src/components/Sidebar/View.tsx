import type {
  DirectoryGroup,
  PluginViewWithOwner,
  SessionInfo,
  WorktreeInfo,
  ActiveView
} from '../../../../shared/types'
import { WorktreesModal } from '../WorktreesModal'
import { WorktreeCleanupModal } from '../WorktreeCleanupModal'
import { NavItem, SafeSvgIcon } from './NavItem'
import { DirectoryItem } from './DirectoryItem'
import { SessionItem } from './SessionItem'
import { PinnedSessionList } from './PinnedSessionList'
import { SettingsPanel } from './SettingsPanel'
import { DeleteConfirmModal } from './DeleteConfirmModal'
import { ProviderToggle } from '../shared/ProviderToggle'

export type DeleteTarget =
  | {
      kind: 'session'
      sessionId: string
      projectKey: string
      title: string
      provider?: import('../../../../shared/types').ProviderId
    }
  | { kind: 'project'; projectKey: string; folderName: string; sessionCount: number }

export interface SidebarViewProps {
  style?: React.CSSProperties
  platform: string
  uiFontScale: number
  activeSessionId: string | null
  activeView: ActiveView
  pluginViews: PluginViewWithOwner[]
  automationBadge: number
  pinnedSessionIds: string[]
  pinnedSessions: SessionInfo[]
  watchingSessions: SessionInfo[]
  recentSessions: SessionInfo[]
  augmentedDirs: DirectoryGroup[]
  hiddenSessionSet: Set<string>
  hiddenProjectSet: Set<string>
  hasAnyHidden: boolean
  showHidden: boolean
  expandedDir: string | null
  renamingKey: string | null
  worktreesModalCwd: string | null
  deleteTarget: DeleteTarget | null
  cleanupWorktree: { sessionId: string; worktreeInfo: WorktreeInfo } | null
  onToggleCollapse?: () => void
  onNewSession: () => void
  onNewSessionDblClick: () => void
  onSetActiveView: (v: ActiveView) => void
  onShowHiddenToggle: () => void
  onSetRenamingKey: (key: string | null) => void
  onClickSession: (info: SessionInfo) => void
  onToggleWatch: (info: SessionInfo) => void
  onPin: (sessionId: string) => void
  onUnpin: (sessionId: string) => void
  onReorderPinned: (ids: string[]) => void
  onFinishRename: (sessionId: string, title: string) => void
  onAutoRename: (sessionId: string) => void
  onRemoveRecent: (info: SessionInfo) => void
  onDirClick: (key: string) => void
  onDirDoubleClick: (group: DirectoryGroup) => void
  onSessionDoubleClick: (info: SessionInfo) => void
  onViewWorktrees: (cwd: string) => void
  onCloseWorktreesModal: () => void
  onHideSession: (info: SessionInfo) => void
  onUnhideSession: (info: SessionInfo) => void
  onDeleteSession: (info: SessionInfo) => void
  onHideProject: (key: string) => void
  onUnhideProject: (key: string) => void
  onDeleteProject: (group: DirectoryGroup) => void
  onConfirmDelete: () => Promise<void>
  onCancelDelete: () => void
  onWorktreeCleanupKeep: () => void
  onWorktreeCleanupRemove: () => void
  onWorktreeCleanupCancel: () => void
}

export function SidebarView(props: SidebarViewProps): React.JSX.Element {
  const {
    style,
    platform,
    uiFontScale,
    activeSessionId,
    activeView,
    pluginViews,
    automationBadge,
    pinnedSessionIds,
    pinnedSessions,
    watchingSessions,
    recentSessions,
    augmentedDirs,
    hiddenSessionSet,
    hiddenProjectSet,
    hasAnyHidden,
    showHidden,
    expandedDir,
    renamingKey,
    worktreesModalCwd,
    deleteTarget,
    cleanupWorktree,
    onToggleCollapse,
    onNewSession,
    onNewSessionDblClick,
    onSetActiveView,
    onShowHiddenToggle,
    onSetRenamingKey,
    onClickSession,
    onToggleWatch,
    onPin,
    onUnpin,
    onReorderPinned,
    onFinishRename,
    onAutoRename,
    onRemoveRecent,
    onDirClick,
    onDirDoubleClick,
    onSessionDoubleClick,
    onViewWorktrees,
    onCloseWorktreesModal,
    onHideSession,
    onUnhideSession,
    onDeleteSession,
    onHideProject,
    onUnhideProject,
    onDeleteProject,
    onConfirmDelete,
    onCancelDelete,
    onWorktreeCleanupKeep,
    onWorktreeCleanupRemove,
    onWorktreeCleanupCancel
  } = props

  return (
    <div
      style={style}
      className={`shrink-0 h-full flex flex-col select-none ${platform === 'darwin' ? 'bg-bg-secondary/60' : 'bg-bg-secondary/85'}`}
    >
      {/* Traffic light clearance + collapse toggle */}
      <div className="h-12 shrink-0 [-webkit-app-region:drag] relative">
        <button
          onClick={onToggleCollapse}
          style={{
            position: 'absolute',
            left: platform === 'darwin' ? 82 / uiFontScale : 8,
            top: 22 / uiFontScale,
            transform: 'translateY(-50%)'
          }}
          className="[-webkit-app-region:no-drag] w-[26px] h-[26px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          title="Collapse sidebar"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
            <path d="M16 15l-3-3 3-3" />
          </svg>
        </button>
      </div>

      {/* Top nav */}
      <nav style={{ margin: '0 8px' }} className="flex flex-col gap-px">
        <NavItem
          label="New session"
          onClick={onNewSession}
          onDoubleClick={onNewSessionDblClick}
          icon={
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
            </svg>
          }
          rightSlot={
            <div
              className="shrink-0"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <ProviderToggle compact />
            </div>
          }
        />
        <NavItem
          label="Automations"
          active={activeView.type === 'automations'}
          onClick={() => {
            onSetActiveView(
              activeView.type === 'automations' ? { type: 'chat' } : { type: 'automations' }
            )
          }}
          badge={automationBadge}
          icon={
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          }
        />
        {pluginViews.map((view) => (
          <NavItem
            key={`plugin:${view.pluginId}:${view.id}`}
            label={view.label}
            active={activeView.type === 'plugin' && activeView.pluginId === view.pluginId}
            onClick={() => {
              if (activeView.type === 'plugin' && activeView.pluginId === view.pluginId) {
                onSetActiveView({ type: 'chat' })
              } else {
                onSetActiveView({ type: 'plugin', pluginId: view.pluginId })
              }
            }}
            icon={
              view.icon ? (
                <SafeSvgIcon svg={view.icon} />
              ) : (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              )
            }
          />
        ))}
      </nav>

      {/* Scrollable sidebar content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Pinned sessions */}
        {pinnedSessions.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div style={{ paddingLeft: 5, marginBottom: 3 }}>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">
                Pinned
              </span>
            </div>
            <PinnedSessionList
              pinnedSessions={pinnedSessions}
              activeSessionId={activeSessionId}
              onClickSession={onClickSession}
              onToggleWatch={onToggleWatch}
              onUnpin={onUnpin}
              onReorder={onReorderPinned}
              renamingKey={renamingKey}
              renamePrefix="pinned"
              onStartRename={(key) => onSetRenamingKey(key)}
              onFinishRename={onFinishRename}
              onAutoRename={onAutoRename}
              onCancelRename={() => onSetRenamingKey(null)}
              hiddenSessionIds={hiddenSessionSet}
              onHideSession={onHideSession}
              onUnhideSession={onUnhideSession}
              onDeleteSession={onDeleteSession}
            />
          </div>
        )}

        {/* Watching sessions */}
        {watchingSessions.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div style={{ paddingLeft: 5, marginBottom: 3 }}>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">
                Watching
              </span>
            </div>
            <nav className="flex flex-col gap-px">
              {watchingSessions.map((info) => {
                const sessionHidden = hiddenSessionSet.has(info.sessionId)
                return (
                  <SessionItem
                    key={info.sessionId}
                    info={info}
                    active={info.sessionId === activeSessionId}
                    onClick={() => onClickSession(info)}
                    onToggleWatch={() => onToggleWatch(info)}
                    isRenaming={renamingKey === `watching:${info.sessionId}`}
                    onStartRename={() => onSetRenamingKey(`watching:${info.sessionId}`)}
                    onFinishRename={(title) => onFinishRename(info.sessionId, title)}
                    onAutoRename={() => onAutoRename(info.sessionId)}
                    onCancelRename={() => onSetRenamingKey(null)}
                    hidden={sessionHidden}
                    onHide={!sessionHidden ? () => onHideSession(info) : undefined}
                    onUnhide={sessionHidden ? () => onUnhideSession(info) : undefined}
                    onDelete={info.projectKey ? () => onDeleteSession(info) : undefined}
                  />
                )
              })}
            </nav>
          </div>
        )}

        {/* Recent sessions */}
        {recentSessions.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div style={{ paddingLeft: 5, marginBottom: 3 }}>
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">
                Recent
              </span>
            </div>
            <nav className="flex flex-col gap-px">
              {recentSessions.map((info) => {
                const sessionHidden = hiddenSessionSet.has(info.sessionId)
                return (
                  <SessionItem
                    key={info.sessionId}
                    info={info}
                    active={info.sessionId === activeSessionId}
                    onClick={() => onClickSession(info)}
                    onToggleWatch={info.projectKey ? () => onToggleWatch(info) : undefined}
                    onPin={() => onPin(info.sessionId)}
                    onRemove={() => onRemoveRecent(info)}
                    isRenaming={renamingKey === `recent:${info.sessionId}`}
                    onStartRename={() => onSetRenamingKey(`recent:${info.sessionId}`)}
                    onFinishRename={(title) => onFinishRename(info.sessionId, title)}
                    onAutoRename={() => onAutoRename(info.sessionId)}
                    onCancelRename={() => onSetRenamingKey(null)}
                    hidden={sessionHidden}
                    onHide={!sessionHidden ? () => onHideSession(info) : undefined}
                    onUnhide={sessionHidden ? () => onUnhideSession(info) : undefined}
                    onDelete={info.projectKey ? () => onDeleteSession(info) : undefined}
                  />
                )
              })}
            </nav>
          </div>
        )}

        {/* Projects accordion */}
        {augmentedDirs.length > 0 && (
          <div style={{ margin: '20px 8px 0' }}>
            <div
              style={{ paddingLeft: 5, marginBottom: 3 }}
              className="flex items-center justify-between pr-1"
            >
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.08em]">
                Projects
              </span>
              {hasAnyHidden && (
                <button
                  onClick={onShowHiddenToggle}
                  className="text-[10px] text-text-muted hover:text-text-primary transition-colors cursor-default"
                  title={showHidden ? 'Hide dimmed items' : 'Show hidden items'}
                >
                  {showHidden ? 'Hide hidden' : 'Show hidden'}
                </button>
              )}
            </div>
            <nav className="flex flex-col gap-px">
              {augmentedDirs
                .filter((group) => showHidden || !hiddenProjectSet.has(group.projectKey))
                .map((group) => {
                  const projectHidden = !!group.projectKey && hiddenProjectSet.has(group.projectKey)
                  return (
                    <DirectoryItem
                      key={group.projectKey || group.cwd}
                      group={group}
                      expanded={expandedDir === (group.projectKey || group.cwd)}
                      activeSessionId={activeSessionId}
                      onClick={() => onDirClick(group.projectKey || group.cwd)}
                      onDoubleClick={() => onDirDoubleClick(group)}
                      onSessionClick={onClickSession}
                      onSessionDoubleClick={(info) => {
                        if (!pinnedSessionIds.includes(info.sessionId)) onSessionDoubleClick(info)
                      }}
                      onToggleWatch={onToggleWatch}
                      onViewWorktrees={() => onViewWorktrees(group.cwd)}
                      renamingKey={renamingKey}
                      renamePrefix={`project:${group.projectKey || group.cwd}`}
                      onStartRename={(key) => onSetRenamingKey(key)}
                      onFinishRename={onFinishRename}
                      onAutoRename={onAutoRename}
                      onCancelRename={() => onSetRenamingKey(null)}
                      hidden={projectHidden}
                      onHide={
                        group.projectKey && !projectHidden
                          ? () => onHideProject(group.projectKey)
                          : undefined
                      }
                      onUnhide={
                        group.projectKey && projectHidden
                          ? () => onUnhideProject(group.projectKey)
                          : undefined
                      }
                      onDelete={group.projectKey ? () => onDeleteProject(group) : undefined}
                      hiddenSessionIds={hiddenSessionSet}
                      showHidden={showHidden}
                      onHideSession={onHideSession}
                      onUnhideSession={onUnhideSession}
                      onDeleteSession={onDeleteSession}
                    />
                  )
                })}
            </nav>
          </div>
        )}
      </div>

      {/* Settings panel + Footer */}
      <SettingsPanel />

      {/* Worktrees management modal */}
      {worktreesModalCwd && (
        <WorktreesModal cwd={worktreesModalCwd} onClose={onCloseWorktreesModal} />
      )}

      {/* Delete confirmation modal (session or project) */}
      {deleteTarget && (
        <DeleteConfirmModal
          kind={deleteTarget.kind}
          name={deleteTarget.kind === 'session' ? deleteTarget.title : deleteTarget.folderName}
          path={
            deleteTarget.kind === 'session'
              ? `~/.claude/projects/${deleteTarget.projectKey}/${deleteTarget.sessionId}.jsonl`
              : `~/.claude/projects/${deleteTarget.projectKey}/`
          }
          sessionCount={deleteTarget.kind === 'project' ? deleteTarget.sessionCount : undefined}
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        />
      )}

      {/* Worktree cleanup modal (on session removal) */}
      {cleanupWorktree && (
        <WorktreeCleanupModal
          worktreeInfo={cleanupWorktree.worktreeInfo}
          onKeep={onWorktreeCleanupKeep}
          onRemove={onWorktreeCleanupRemove}
          onCancel={onWorktreeCleanupCancel}
        />
      )}
    </div>
  )
}
