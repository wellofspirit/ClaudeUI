import type { GitBranchData } from '../../../../../shared/types'

type GitSyncOperation = 'idle' | 'fetching' | 'pulling' | 'pushing'

// ── View props ──────────────────────────────────────────────────────

export interface GitBranchDropdownViewProps {
  dropdownRef: React.RefObject<HTMLDivElement | null>
  inputRef: React.RefObject<HTMLInputElement | null>
  search: string
  onSearchChange: (value: string) => void
  branches: GitBranchData | null
  localFiltered: string[]
  remoteFiltered: string[]
  hasRemote: boolean
  hasTracking: boolean
  ahead: number
  behind: number
  isSyncing: boolean
  syncOp: GitSyncOperation
  syncError: string | null
  localError: string | null
  successMsg: string | null
  upstreamPrompt: { branch: string } | null
  creating: boolean
  newBranchName: string
  loading: boolean
  onNewBranchNameChange: (value: string) => void
  onStartCreating: () => void
  onCancelCreating: () => void
  onCreateBranch: () => void
  onCheckout: (branch: string) => void
  onFetch: () => void
  onPull: () => void
  onPush: () => void
  onPushWithUpstream: () => void
  onDismissUpstream: () => void
}

export function GitBranchDropdownView({
  dropdownRef,
  inputRef,
  search,
  onSearchChange,
  branches,
  localFiltered,
  remoteFiltered,
  hasRemote,
  hasTracking,
  ahead,
  behind,
  isSyncing,
  syncOp,
  syncError,
  localError,
  successMsg,
  upstreamPrompt,
  creating,
  newBranchName,
  loading,
  onNewBranchNameChange,
  onStartCreating,
  onCancelCreating,
  onCreateBranch,
  onCheckout,
  onFetch,
  onPull,
  onPush,
  onPushWithUpstream,
  onDismissUpstream
}: GitBranchDropdownViewProps): React.JSX.Element {
  return (
    <div
      ref={dropdownRef}
      className="absolute top-full right-0 mt-1 w-72 max-h-96 bg-bg-primary border border-border rounded-lg shadow-lg overflow-hidden z-50 flex flex-col"
    >
      {/* Search */}
      <div className="p-2 border-b border-border">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search branches..."
          className="w-full bg-bg-tertiary text-text-primary text-[12px] px-2.5 py-1.5 rounded-md outline-none placeholder:text-text-muted"
        />
      </div>

      {/* Sync section — only when remotes exist */}
      {hasRemote && (
        <div className="px-2 py-2 border-b border-border">
          <div className="text-[10px] text-text-muted uppercase tracking-wider font-medium px-1 mb-1.5">
            Sync
          </div>
          <div className="grid grid-cols-2 gap-1.5 mb-1.5">
            <SyncButton
              icon="↓"
              label="Pull"
              count={hasTracking ? behind : 0}
              disabled={isSyncing || !hasTracking || behind === 0}
              active={syncOp === 'pulling'}
              onClick={onPull}
              title={
                !hasTracking
                  ? 'No upstream branch'
                  : behind === 0
                    ? 'Already up to date'
                    : `Pull ${behind} commit${behind !== 1 ? 's' : ''}`
              }
            />
            <SyncButton
              icon="↑"
              label="Push"
              count={hasTracking ? ahead : 0}
              disabled={isSyncing || (hasTracking && ahead === 0)}
              active={syncOp === 'pushing'}
              onClick={onPush}
              title={
                !hasTracking
                  ? 'Push and set upstream'
                  : ahead === 0
                    ? 'Nothing to push'
                    : `Push ${ahead} commit${ahead !== 1 ? 's' : ''}`
              }
            />
          </div>
          <SyncButton
            icon="↻"
            label="Fetch"
            disabled={isSyncing}
            active={syncOp === 'fetching'}
            onClick={onFetch}
            title="Fetch from all remotes"
            fullWidth
          />
        </div>
      )}

      {/* Upstream prompt */}
      {upstreamPrompt && (
        <div className="px-3 py-2 border-b border-border bg-bg-tertiary/50">
          <p className="text-[11px] text-text-primary mb-2">
            No upstream for <span className="font-mono text-accent">{upstreamPrompt.branch}</span>.
            Set up tracking?
          </p>
          <div className="flex items-center justify-end gap-1.5">
            <button
              onClick={onDismissUpstream}
              className="px-2 py-1 text-[11px] rounded-md border border-border text-text-secondary hover:bg-bg-hover transition-colors cursor-default"
            >
              Cancel
            </button>
            <button
              onClick={onPushWithUpstream}
              disabled={isSyncing}
              className="px-2 py-1 text-[11px] rounded-md bg-accent text-white hover:bg-accent-hover transition-colors cursor-default disabled:opacity-50"
            >
              Push with -u
            </button>
          </div>
        </div>
      )}

      {/* Success / error feedback */}
      {successMsg && (
        <div className="px-3 py-1.5 text-[11px] text-green-400 border-b border-border bg-green-500/10 flex items-center gap-1.5">
          <span>✓</span>
          <span className="truncate">{successMsg}</span>
        </div>
      )}
      {(syncError || localError) && (
        <div className="px-3 py-1.5 text-[11px] text-red-400 border-b border-border bg-red-500/10 flex items-center gap-1.5">
          <span>✗</span>
          <span className="truncate">{syncError || localError}</span>
        </div>
      )}

      {/* Branch list */}
      <div className="overflow-y-auto flex-1 min-h-0">
        {!branches ? (
          <div className="p-3 text-[12px] text-text-muted text-center">Loading...</div>
        ) : (
          <>
            {localFiltered.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider font-medium">
                  Local
                </div>
                {localFiltered.map((b) => (
                  <button
                    key={b}
                    onClick={() => onCheckout(b)}
                    disabled={loading}
                    className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-bg-hover transition-colors flex items-center justify-between cursor-default disabled:opacity-50"
                  >
                    <span
                      className={`truncate ${b === branches.current ? 'text-accent font-medium' : 'text-text-primary'}`}
                    >
                      {b}
                    </span>
                    {b === branches.current && (
                      <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0 ml-2" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {remoteFiltered.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider font-medium border-t border-border">
                  Remote
                </div>
                {remoteFiltered.map((b) => {
                  const slashIdx = b.indexOf('/')
                  const prefix = slashIdx >= 0 ? b.slice(0, slashIdx + 1) : ''
                  const name = slashIdx >= 0 ? b.slice(slashIdx + 1) : b
                  return (
                    <button
                      key={b}
                      onClick={() => onCheckout(name)}
                      disabled={loading}
                      className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-bg-hover transition-colors truncate cursor-default disabled:opacity-50"
                    >
                      <span className="text-text-muted">{prefix}</span>
                      <span className="text-text-secondary">{name}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Create new branch */}
      <div className="border-t border-border">
        {creating ? (
          <div className="p-2 flex gap-1.5">
            <input
              type="text"
              value={newBranchName}
              onChange={(e) => onNewBranchNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCreateBranch()
                if (e.key === 'Escape') onCancelCreating()
              }}
              placeholder="Branch name"
              className="flex-1 bg-bg-tertiary text-text-primary text-[12px] px-2.5 py-1.5 rounded-md outline-none placeholder:text-text-muted"
              autoFocus
            />
            <button
              onClick={onCreateBranch}
              disabled={!newBranchName.trim() || loading}
              className="px-2.5 py-1.5 text-[12px] bg-accent text-white rounded-md hover:bg-accent-hover transition-colors disabled:opacity-50 cursor-default"
            >
              Create
            </button>
          </div>
        ) : (
          <button
            onClick={onStartCreating}
            className="w-full text-left px-3 py-2 text-[12px] text-accent hover:bg-bg-hover transition-colors cursor-default"
          >
            + Create new branch...
          </button>
        )}
      </div>
    </div>
  )
}

// ── SyncButton (sub-component) ──────────────────────────────────────

function SyncButton({
  icon,
  label,
  count,
  disabled,
  active,
  onClick,
  title,
  fullWidth
}: {
  icon: string
  label: string
  count?: number
  disabled: boolean
  active: boolean
  onClick: () => void
  title: string
  fullWidth?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors cursor-default
        ${fullWidth ? 'col-span-2' : ''}
        ${
          disabled
            ? 'bg-bg-tertiary/50 text-text-muted/50 cursor-default'
            : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary'
        }`}
    >
      {active ? (
        <span className="animate-spin inline-block text-accent">⟳</span>
      ) : (
        <span>{icon}</span>
      )}
      <span>{label}</span>
      {!!count && count > 0 && (
        <span className="text-[10px] text-accent tabular-nums">({count})</span>
      )}
    </button>
  )
}
