// ── View props ──────────────────────────────────────────────────────

export interface GitCommitBoxViewProps {
  gitCommitMessage: string
  commitBoxHeight: number
  stagedCount: number
  totalChanges: number
  allStaged: boolean
  commitDisabled: boolean
  isPushMode: boolean
  loading: boolean
  generating: boolean
  toast: { message: string; type: 'success' | 'error' } | null
  toastExiting: boolean
  upstreamPrompt: { branch: string; afterCommitHash?: string } | null
  dropdownOpen: boolean
  dropdownRef: React.RefObject<HTMLDivElement | null>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onCommitMessageChange: (value: string) => void
  onPrimaryCommit: () => void
  onSecondaryCommit: () => void
  onPush: () => void
  onToggleStageAll: () => void
  onGenerateMessage: () => void
  onResizeMouseDown: (e: React.MouseEvent) => void
  onToggleDropdown: () => void
  onDismissUpstream: () => void
  onPushWithUpstream: () => void
}

export function GitCommitBoxView({
  gitCommitMessage,
  commitBoxHeight,
  stagedCount,
  totalChanges,
  allStaged,
  commitDisabled,
  isPushMode,
  loading,
  generating,
  toast,
  toastExiting,
  upstreamPrompt,
  dropdownOpen,
  dropdownRef,
  textareaRef,
  onCommitMessageChange,
  onPrimaryCommit,
  onSecondaryCommit,
  onPush,
  onToggleStageAll,
  onGenerateMessage,
  onResizeMouseDown,
  onToggleDropdown,
  onDismissUpstream,
  onPushWithUpstream
}: GitCommitBoxViewProps): React.JSX.Element {
  return (
    <div
      className="shrink-0 border-t border-border relative flex flex-col"
      style={{ height: commitBoxHeight, maxHeight: '50%' }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={onResizeMouseDown}
        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize z-10 hover:bg-accent/30 transition-colors"
      />
      {/* Commit message */}
      <div className="relative flex-1 min-h-0 p-2 pb-0">
        <textarea
          ref={textareaRef}
          value={gitCommitMessage}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              onPrimaryCommit()
            }
          }}
          placeholder="Commit message..."
          className="w-full h-full bg-bg-tertiary text-text-primary text-[12px] px-2.5 py-2 pr-8 rounded-md outline-none placeholder:text-text-muted resize-none font-mono"
        />
        <button
          onClick={onGenerateMessage}
          disabled={generating || stagedCount === 0}
          className="absolute top-3.5 right-3.5 w-6 h-6 flex items-center justify-center rounded text-text-muted/50 hover:text-accent hover:bg-bg-hover transition-colors cursor-default disabled:opacity-30 disabled:hover:text-text-muted/50 disabled:hover:bg-transparent"
          title="Auto-generate commit message"
        >
          {generating ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="animate-spin-slow text-accent"
            >
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" />
            </svg>
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9.5 2l1.2 3.6L14.3 7l-3.6 1.2L9.5 12l-1.2-3.6L4.7 7l3.6-1.2z" />
              <path d="M18 12l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7L14.4 15.6l2.7-.9z" />
              <path d="M9 17l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8L6.6 19.4l1.8-.6z" />
            </svg>
          )}
        </button>
      </div>

      {/* Bottom section: buttons */}
      <div className="shrink-0 px-2 pb-2 pt-1.5 space-y-1.5">
        {/* Floating toast */}
        {toast && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 z-50 pointer-events-none">
            <div
              className={`px-4 py-2 rounded-lg shadow-lg text-[12px] font-mono whitespace-nowrap ${toast.type === 'error' ? 'bg-red-950 border border-red-800 text-red-300' : 'bg-bg-tertiary border border-border text-green-400'} ${toastExiting ? 'animate-toast-out' : 'animate-toast-in'}`}
            >
              {toast.message}
            </div>
          </div>
        )}

        {/* Upstream prompt */}
        {upstreamPrompt && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 z-50 w-72">
            <div className="px-4 py-3 rounded-lg bg-bg-primary border border-border shadow-lg text-[12px] animate-toast-in">
              <p className="text-text-primary mb-2">
                No upstream branch for{' '}
                <span className="font-mono text-accent">{upstreamPrompt.branch}</span>. Set up
                tracking on remote?
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={onDismissUpstream}
                  className="px-2.5 py-1 text-[11px] rounded-md border border-border text-text-secondary hover:bg-bg-hover transition-colors cursor-default"
                >
                  Cancel
                </button>
                <button
                  onClick={onPushWithUpstream}
                  disabled={loading}
                  className="px-2.5 py-1 text-[11px] rounded-md bg-accent text-white hover:bg-accent-hover transition-colors cursor-default disabled:opacity-50"
                >
                  Push with -u
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onToggleStageAll}
            disabled={loading || totalChanges === 0}
            className="px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-border text-text-secondary hover:bg-bg-hover transition-colors cursor-default disabled:opacity-50"
          >
            {allStaged ? 'Unstage All' : 'Stage All'}
          </button>

          {/* Commit split button */}
          <div className="flex-1 flex relative" ref={dropdownRef}>
            <button
              onClick={onPrimaryCommit}
              disabled={commitDisabled}
              className="flex-1 px-2.5 py-1.5 text-[11px] font-medium rounded-l-md bg-accent text-white hover:bg-accent-hover transition-colors cursor-default disabled:opacity-50"
              title={`Ctrl+Enter to ${isPushMode ? 'commit & push' : 'commit'}`}
            >
              {isPushMode ? 'Commit & Push' : 'Commit'}
              {stagedCount > 0 ? ` (${stagedCount})` : ''}
            </button>
            <button
              onClick={onToggleDropdown}
              disabled={loading}
              className="px-1.5 py-1.5 rounded-r-md bg-accent text-white hover:bg-accent-hover transition-colors cursor-default disabled:opacity-50 border-l border-white/20"
            >
              <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
                <path d="M3 4.5l3 3 3-3" />
              </svg>
            </button>

            {/* Dropdown menu */}
            {dropdownOpen && (
              <div className="absolute bottom-full left-0 right-0 mb-1 bg-bg-primary border border-border rounded-md shadow-lg overflow-hidden z-50">
                <button
                  onClick={onSecondaryCommit}
                  disabled={commitDisabled}
                  className="w-full text-left px-3 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors cursor-default disabled:opacity-50"
                >
                  {isPushMode ? 'Commit' : 'Commit & Push'}
                </button>
                <button
                  onClick={onPush}
                  disabled={loading}
                  className="w-full text-left px-3 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors cursor-default disabled:opacity-50 border-t border-border"
                >
                  Push
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
