import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ConfirmModal } from '../../shared/ConfirmModal'
import {
  CREATE_KEY,
  formatAge,
  type BranchListModel,
  type BranchRow,
  type PullChoice
} from './branch-model'

type GitSyncOperation = 'idle' | 'fetching' | 'pulling' | 'pushing'

// ── View props ──────────────────────────────────────────────────────

export interface WorktreeContext {
  name: string
  /** basename of the repository the worktree hangs off. */
  parentRepo: string
  path: string
}

export interface PullPrompt {
  ahead: number
  behind: number
  choice: PullChoice
}

export interface StashPrompt {
  /** The branch the click was heading for. */
  branch: string
  files: number
}

export interface GitBranchDropdownViewProps {
  dropdownRef: React.RefObject<HTMLDivElement | null>
  inputRef: React.RefObject<HTMLInputElement | null>

  // Header: where you are
  /** Current branch, or the short sha on a detached HEAD. */
  current: string
  detached: boolean
  /** Short upstream name when one is configured. */
  upstream: string | null
  /** The upstream branch was deleted on the remote. */
  upstreamGone: boolean
  hasRemote: boolean
  ahead: number
  behind: number
  /** Commits no remote has yet (branch without an upstream). */
  unpublished: number
  fetchedLabel: string | null
  worktree: WorktreeContext | null
  /** ClaudeUI autostashes made from the current branch. */
  autostashCount: number
  isSyncing: boolean
  syncOp: GitSyncOperation

  // Search + list
  search: string
  onSearchChange: (value: string) => void
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  loaded: boolean
  list: BranchListModel
  /** The row an Enter would activate. */
  highlightKey: string | null
  /** SessionView renders under `zoom: uiFontScale`; viewport lengths are divided by it. */
  uiFontScale: number
  /** Wall-clock ms, for the age column. */
  now: number
  onToggleRemote: () => void
  createBase: string
  baseOptions: string[]
  baseMenuOpen: boolean
  onToggleBaseMenu: () => void
  onPickBase: (name: string) => void
  loading: boolean

  // Feedback
  error: { title: string; message: string } | null
  successMsg: string | null
  onDismissError: () => void

  // Popups
  pullPrompt: PullPrompt | null
  stashPrompt: StashPrompt | null

  // Actions
  onCheckout: (branch: string) => void
  onCreate: () => void
  onNewBranch: () => void
  onFetch: () => void
  onPull: () => void
  onPush: () => void
  onPublish: () => void
  onRestore: () => void
  onCopyWorktreePath: () => void
  onPullConfirm: (mode: 'merge' | 'rebase') => Promise<void>
  onPullCancel: () => void
  onStashAndSwitch: () => Promise<void>
  onSwitchAnyway: () => Promise<void>
  onStashCancel: () => void
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Last path segment, whichever separator the host uses. */
function baseName(p: string): string {
  return (
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || p
  )
}

export function GitBranchDropdownView(props: GitBranchDropdownViewProps): React.JSX.Element {
  const {
    dropdownRef,
    inputRef,
    current,
    detached,
    upstream,
    upstreamGone,
    hasRemote,
    ahead,
    behind,
    unpublished,
    fetchedLabel,
    worktree,
    autostashCount,
    isSyncing,
    syncOp,
    search,
    onSearchChange,
    onSearchKeyDown,
    loaded,
    list,
    highlightKey,
    now,
    uiFontScale,
    onToggleRemote,
    createBase,
    baseOptions,
    baseMenuOpen,
    onToggleBaseMenu,
    onPickBase,
    loading,
    error,
    successMsg,
    onDismissError,
    pullPrompt,
    stashPrompt,
    onCheckout,
    onCreate,
    onNewBranch,
    onFetch,
    onPull,
    onPush,
    onPublish,
    onRestore,
    onCopyWorktreePath
  } = props

  const listRef = useRef<HTMLDivElement>(null)
  // Keep the keyboard highlight on screen (the slash menu does the same).
  useEffect(() => {
    listRef.current?.querySelector('[data-kb="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightKey])

  // Publish stands in for push while the branch has no upstream to push to.
  const needsPublish = hasRemote && !detached && (!upstream || upstreamGone)
  const searching = search.trim() !== ''
  const noRows =
    loaded && list.local.length === 0 && list.remoteOnly.length === 0 && !list.createName

  // Fits a phone and a short window: capped at the viewport, in the zoomed px the
  // box lays out in (ADR-093).
  // eslint-disable-next-line no-restricted-syntax -- divides by uiFontScale
  const maxWidth = `calc((100vw - 16px) / ${uiFontScale})`
  // eslint-disable-next-line no-restricted-syntax -- divides by uiFontScale
  const maxHeight = `calc((100dvh - 96px) / ${uiFontScale})`

  return (
    <div
      ref={dropdownRef}
      data-testid="GitBranchDropdown"
      style={{ maxWidth, maxHeight }}
      className="absolute top-full right-0 mt-1 w-[340px] bg-bg-primary border border-border rounded-xl shadow-lg overflow-hidden z-50 flex flex-col"
    >
      {/* Header — where you are */}
      <div className="px-3.5 pt-3 pb-2.5 shrink-0">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div
              data-testid="GitBranchDropdown.current"
              className="font-mono text-[13px] font-semibold text-text-primary truncate"
              title={current}
            >
              {detached ? `${current} (detached HEAD)` : current}
            </div>
            <div
              data-testid="GitBranchDropdown.upstream"
              className="text-[11px] text-text-secondary mt-0.5 flex items-center gap-1.5 flex-wrap"
            >
              {!hasRemote ? (
                <span className="text-text-muted">No remote configured</span>
              ) : detached ? (
                <span className="text-text-muted">Not on a branch</span>
              ) : upstream && !upstreamGone ? (
                <>
                  <span className="font-mono truncate">{upstream}</span>
                  {ahead > 0 && (
                    <>
                      <span className="text-text-muted">·</span>
                      <span className="text-accent">{ahead} to push</span>
                    </>
                  )}
                  {behind > 0 && (
                    <>
                      <span className="text-text-muted">·</span>
                      <span className="text-green-400">{behind} to pull</span>
                    </>
                  )}
                  {ahead === 0 && behind === 0 && (
                    <>
                      <span className="text-text-muted">·</span>
                      <span className="text-text-muted">up to date</span>
                    </>
                  )}
                </>
              ) : upstreamGone ? (
                <span className="text-yellow-400">
                  <span className="font-mono">{upstream}</span> was deleted on the remote
                </span>
              ) : (
                <span className="text-text-muted">
                  Not on the remote yet
                  {unpublished > 0 ? ` · ${plural(unpublished, 'commit')}` : ''}
                </span>
              )}
            </div>
          </div>

          {hasRemote && (
            <div
              data-testid="GitBranchDropdown.sync"
              className="shrink-0 flex overflow-hidden rounded-lg border border-border bg-bg-tertiary text-[12px]"
            >
              <SyncButton
                testId="GitBranchDropdown.fetch"
                label={syncOp === 'fetching' ? '⟳' : '↻'}
                spinning={syncOp === 'fetching'}
                title="Fetch from all remotes"
                disabled={isSyncing}
                onClick={onFetch}
              />
              <SyncButton
                testId="GitBranchDropdown.pull"
                label={`↓${behind > 0 ? behind : ''}`}
                spinning={syncOp === 'pulling'}
                title={
                  !upstream || upstreamGone
                    ? 'No upstream branch'
                    : behind === 0
                      ? 'Up to date'
                      : `Pull ${plural(behind, 'commit')}`
                }
                disabled={isSyncing || !upstream || upstreamGone || behind === 0}
                primary={behind > 0}
                onClick={onPull}
                bordered
              />
              {needsPublish ? (
                <SyncButton
                  testId="GitBranchDropdown.publish"
                  label={syncOp === 'pushing' ? 'Publishing…' : 'Publish'}
                  spinning={false}
                  title={`git push -u origin ${current}`}
                  disabled={isSyncing}
                  primary
                  onClick={onPublish}
                  bordered
                />
              ) : (
                <SyncButton
                  testId="GitBranchDropdown.push"
                  label={`↑${ahead > 0 ? ahead : ''}`}
                  spinning={syncOp === 'pushing'}
                  title={ahead === 0 ? 'Nothing to push' : `Push ${plural(ahead, 'commit')}`}
                  disabled={isSyncing || detached || ahead === 0}
                  primary={ahead > 0}
                  onClick={onPush}
                  bordered
                />
              )}
            </div>
          )}
        </div>

        {worktree && (
          <div
            data-testid="GitBranchDropdown.worktree"
            className="mt-2.5 px-2 py-1.5 rounded-md bg-mode-edit/15 text-[11px] flex items-center gap-1.5 min-w-0"
          >
            <span className="text-mode-edit shrink-0">⑂</span>
            <span className="font-mono text-mode-edit truncate" title={worktree.name}>
              {worktree.name}
            </span>
            <span className="text-text-muted shrink-0">· parent repo</span>
            <span className="font-mono text-text-secondary truncate" title={worktree.parentRepo}>
              {worktree.parentRepo}
            </span>
            <button
              data-testid="GitBranchDropdown.copyPath"
              onClick={onCopyWorktreePath}
              title={worktree.path}
              className="ml-auto shrink-0 px-1.5 py-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            >
              Copy path
            </button>
          </div>
        )}

        {autostashCount > 0 && (
          <div
            data-testid="GitBranchDropdown.stashRow"
            className="mt-2 text-[11px] text-text-secondary flex items-center gap-1.5"
          >
            <span>
              {autostashCount} stash{autostashCount === 1 ? '' : 'es'} from this branch
            </span>
            <span className="text-text-muted">·</span>
            <button
              data-testid="GitBranchDropdown.restore"
              onClick={onRestore}
              disabled={loading}
              className="text-accent hover:underline disabled:opacity-50 cursor-default"
            >
              {autostashCount === 1 ? 'Restore' : 'Restore newest'}
            </button>
          </div>
        )}

        {fetchedLabel && (
          <div
            data-testid="GitBranchDropdown.fetched"
            className="text-[10.5px] text-text-muted mt-1.5"
          >
            {fetchedLabel}
          </div>
        )}
      </div>

      {/* Search doubles as create */}
      <div className="px-3 pb-2 shrink-0">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-bg-tertiary border border-border focus-within:border-text-muted">
          <span className="text-text-muted text-[12px]">⌕</span>
          <input
            ref={inputRef}
            data-testid="GitBranchDropdown.search"
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Switch or create branch…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="flex-1 min-w-0 bg-transparent text-text-primary text-[12px] outline-none placeholder:text-text-muted"
          />
        </div>
      </div>

      {/* Feedback */}
      {error && (
        <div
          data-testid="GitBranchDropdown.error"
          className="mx-3 mb-2 px-2.5 py-2 rounded-md bg-red-500/10 text-[11px] shrink-0"
        >
          <div className="flex items-start gap-1.5">
            <span className="text-red-400">✗</span>
            <div className="flex-1 min-w-0">
              <div className="text-red-400 font-medium">{error.title}</div>
              <div className="mt-0.5 font-mono text-[10.5px] leading-snug text-text-secondary whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                {error.message}
              </div>
            </div>
            <button
              data-testid="GitBranchDropdown.errorDismiss"
              onClick={onDismissError}
              title="Dismiss"
              className="text-text-muted hover:text-text-primary cursor-default"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {successMsg && !error && (
        <div
          data-testid="GitBranchDropdown.success"
          className="mx-3 mb-2 px-2.5 py-1.5 rounded-md bg-green-500/10 text-[11px] text-green-400 flex items-center gap-1.5 shrink-0"
        >
          <span>✓</span>
          <span className="truncate">{successMsg}</span>
        </div>
      )}

      {/* Rows */}
      <div ref={listRef} className="border-t border-border overflow-y-auto flex-1 min-h-0 py-1">
        {!loaded ? (
          <div className="p-3 text-[12px] text-text-muted text-center">Loading...</div>
        ) : (
          <>
            {list.createName && (
              <>
                <button
                  data-testid="GitBranchDropdown.createRow"
                  data-kb={highlightKey === CREATE_KEY}
                  onClick={onCreate}
                  disabled={loading}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-[12px] cursor-default disabled:opacity-50 ${
                    highlightKey === CREATE_KEY ? 'bg-bg-hover' : 'hover:bg-bg-hover'
                  }`}
                >
                  <span className="text-accent w-3">+</span>
                  <span className="flex-1 min-w-0 truncate">
                    Create <span className="font-mono">{list.createName}</span>
                  </span>
                  <Kbd>↵</Kbd>
                </button>
                <div className="px-3 pb-1.5 pl-8 text-[11px] text-text-muted flex items-center gap-1">
                  from
                  <button
                    data-testid="GitBranchDropdown.createBase"
                    onClick={onToggleBaseMenu}
                    className="font-mono px-1.5 rounded border border-border text-text-secondary hover:bg-bg-hover truncate max-w-[180px] cursor-default"
                  >
                    {createBase} ▾
                  </button>
                  and switch to it
                </div>
                {baseMenuOpen && (
                  <div
                    data-testid="GitBranchDropdown.baseMenu"
                    className="mx-3 mb-1.5 ml-8 max-h-32 overflow-y-auto rounded-md border border-border bg-bg-tertiary text-[11px]"
                  >
                    {baseOptions.map((b) => (
                      <button
                        key={b}
                        data-testid="GitBranchDropdown.baseOption"
                        data-id={b}
                        onClick={() => onPickBase(b)}
                        className={`w-full text-left px-2 py-1 font-mono truncate hover:bg-bg-hover cursor-default ${
                          b === createBase ? 'text-accent' : 'text-text-primary'
                        }`}
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {list.local.length > 0 && (
              <>
                <SectionLabel>{searching ? 'Matches' : 'Local · by last commit'}</SectionLabel>
                {list.local.map((row) => (
                  <LocalRow
                    key={row.key}
                    row={row}
                    now={now}
                    highlighted={highlightKey === row.key}
                    disabled={loading}
                    onCheckout={onCheckout}
                  />
                ))}
              </>
            )}

            {list.remoteOnly.length > 0 && (
              <div className="mt-1">
                <button
                  data-testid="GitBranchDropdown.remoteToggle"
                  data-open={list.remoteExpanded}
                  onClick={onToggleRemote}
                  className="w-full text-left px-3.5 py-1.5 flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] font-semibold text-text-muted hover:text-text-secondary cursor-default"
                >
                  <span>{list.remoteExpanded ? '▾' : '▸'}</span>
                  <span>Remote only</span>
                  <span className="normal-case tracking-normal font-normal">
                    ({list.remoteOnly.length})
                  </span>
                </button>
                {list.remoteExpanded &&
                  list.remoteOnly.map((row) => (
                    <button
                      key={row.key}
                      data-testid="GitBranchDropdown.remoteRow"
                      data-id={row.detail.name}
                      data-kb={highlightKey === row.key}
                      onClick={() => onCheckout(row.name)}
                      disabled={loading}
                      className={`w-full text-left pl-[10px] pr-3 py-1.5 border-l-2 border-transparent flex items-center gap-2 text-[12px] cursor-default disabled:opacity-50 ${
                        highlightKey === row.key ? 'bg-bg-hover' : 'hover:bg-bg-hover'
                      }`}
                    >
                      <span className="w-3" />
                      <span className="font-mono truncate flex-1">
                        <span className="text-text-muted">{row.prefix}</span>
                        <span className="text-text-secondary">{row.name}</span>
                      </span>
                      <Age row={row} now={now} />
                    </button>
                  ))}
              </div>
            )}

            {noRows && (
              <div className="p-3 text-[12px] text-text-muted text-center">
                No matching branches
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-3 py-2 shrink-0 text-[12px]">
        {searching ? (
          <div
            data-testid="GitBranchDropdown.hints"
            className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-text-muted"
          >
            <span>
              <Kbd>↵</Kbd> {list.createName ? 'switch / create' : 'switch'}
            </span>
            {list.createName && (
              <span>
                <Kbd>⇧↵</Kbd> create
              </span>
            )}
            <span>
              <Kbd>esc</Kbd> clear
            </span>
          </div>
        ) : (
          <div className="flex items-center min-w-0">
            <button
              data-testid="GitBranchDropdown.newBranch"
              onClick={onNewBranch}
              className="text-accent hover:underline shrink-0 cursor-default"
            >
              + New branch
            </button>
            <span className="text-text-muted ml-1.5 text-[11px] truncate">from {current}</span>
          </div>
        )}
      </div>

      {/* Popups — portalled out: the top bar is a layout-contained container, which
          would make `fixed` position against the 48px bar, not the window. A click in
          them is not "outside" because the FC suspends click-outside while one is open. */}
      {pullPrompt &&
        createPortal(
          <PullConfirm
            prompt={pullPrompt}
            onPullConfirm={props.onPullConfirm}
            onPullCancel={props.onPullCancel}
          />,
          document.body
        )}
      {stashPrompt &&
        createPortal(
          <StashConfirm
            prompt={stashPrompt}
            onStashAndSwitch={props.onStashAndSwitch}
            onSwitchAnyway={props.onSwitchAnyway}
            onStashCancel={props.onStashCancel}
          />,
          document.body
        )}
    </div>
  )
}

// ── Popups ──────────────────────────────────────────────────────────

function PullConfirm({
  prompt,
  onPullConfirm,
  onPullCancel
}: { prompt: PullPrompt } & Pick<
  GitBranchDropdownViewProps,
  'onPullConfirm' | 'onPullCancel'
>): React.JSX.Element {
  const { ahead, behind, choice } = prompt
  const local = plural(ahead, 'local commit')
  const incoming = plural(behind, 'incoming commit')
  const decided = choice === 'rebase' || choice === 'merge'
  const body =
    choice === 'rebase' ? (
      <>
        Rebase your {local} onto {behind} incoming
      </>
    ) : choice === 'merge' ? (
      <>Merge {incoming} (creates a merge commit)</>
    ) : choice === 'ff-only' ? (
      <>
        Your branch has {local} and there are {incoming}, but <code>pull.ff</code> is set to{' '}
        <code>only</code>, so a plain pull would fail. Merge or rebase instead.
      </>
    ) : (
      <>
        Your branch has {local} and there are {incoming}. Git needs to know how to combine them.
      </>
    )
  const first: 'merge' | 'rebase' = choice === 'rebase' ? 'rebase' : 'merge'
  return (
    <ConfirmModal
      testId="GitBranchDropdown.pullConfirm"
      tone="primary"
      title={
        decided
          ? choice === 'rebase'
            ? 'Pull with rebase'
            : 'Pull with merge'
          : 'Branch has diverged'
      }
      body={body}
      confirmLabel={first === 'rebase' ? 'Rebase' : 'Merge'}
      busyLabel="Pulling…"
      errorTitle="Pull failed"
      secondary={decided ? undefined : { label: 'Rebase', onClick: () => onPullConfirm('rebase') }}
      onConfirm={() => onPullConfirm(first)}
      onCancel={onPullCancel}
    />
  )
}

function StashConfirm({
  prompt,
  onStashAndSwitch,
  onSwitchAnyway,
  onStashCancel
}: { prompt: StashPrompt } & Pick<
  GitBranchDropdownViewProps,
  'onStashAndSwitch' | 'onSwitchAnyway' | 'onStashCancel'
>): React.JSX.Element {
  return (
    <ConfirmModal
      testId="GitBranchDropdown.stashConfirm"
      tone="primary"
      title={`${plural(prompt.files, 'uncommitted file')}`}
      body={
        <>
          Switching to <span className="font-mono">{prompt.branch}</span> with changes in your
          working tree. Stash them first (untracked files included; you can restore them from this
          branch later), or bring them along.
        </>
      }
      confirmLabel="Stash and switch"
      busyLabel="Switching…"
      errorTitle="Could not switch"
      secondary={{ label: 'Switch and bring them along', onClick: onSwitchAnyway }}
      onConfirm={onStashAndSwitch}
      onCancel={onStashCancel}
    />
  )
}

// ── Pieces ──────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-3.5 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.08em] font-semibold text-text-muted">
      {children}
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="px-1 rounded-[3px] border border-border text-[10px] text-text-muted">
      {children}
    </span>
  )
}

function Age({ row, now }: { row: BranchRow; now: number }): React.JSX.Element {
  return (
    <span className="text-text-muted text-[11px] w-7 text-right shrink-0">
      {formatAge(row.detail.commitTime, now)}
    </span>
  )
}

function LocalRow({
  row,
  now,
  highlighted,
  disabled,
  onCheckout
}: {
  row: BranchRow
  now: number
  highlighted: boolean
  disabled: boolean
  onCheckout: (branch: string) => void
}): React.JSX.Element {
  const { detail } = row
  const base = `w-full text-left pl-[10px] pr-3 py-1.5 flex items-center gap-2 text-[12px] border-l-2 ${
    detail.current ? 'border-accent' : 'border-transparent'
  }`
  const badges = (
    <>
      {detail.ahead > 0 && (
        <span className="font-mono text-[11px] text-accent">↑{detail.ahead}</span>
      )}
      {detail.behind > 0 && (
        <span className="font-mono text-[11px] text-green-400">↓{detail.behind}</span>
      )}
      {detail.gone && (
        <span
          title="Upstream branch was deleted on the remote"
          className="text-[10px] px-1 rounded border border-border text-text-muted"
        >
          gone
        </span>
      )}
      {row.localOnly && <span className="text-[10px] text-text-muted">local only</span>}
    </>
  )

  if (!row.activatable && detail.worktree) {
    const { main, path } = detail.worktree
    return (
      <div
        data-testid="GitBranchDropdown.branchRow"
        data-id={detail.name}
        data-in-use="true"
        title={
          main
            ? `Checked out in the parent repository (${path}) — git can't check out one branch twice`
            : `Checked out in worktree ‘${baseName(path)}’ — git can't check out one branch twice`
        }
        className={`${base} opacity-80`}
      >
        <span className="w-3" />
        <span className="font-mono truncate flex-1 text-text-secondary">{row.name}</span>
        <span
          data-testid="GitBranchDropdown.inUse"
          className="rounded px-1.5 text-[10px] bg-mode-edit/15 text-mode-edit"
        >
          {main ? '⑂ parent' : '⑂ in use'}
        </span>
        <Age row={row} now={now} />
      </div>
    )
  }

  return (
    <button
      data-testid="GitBranchDropdown.branchRow"
      data-id={detail.name}
      data-current={detail.current}
      data-kb={highlighted}
      onClick={() => onCheckout(row.name)}
      disabled={disabled}
      className={`${base} cursor-default disabled:opacity-50 ${
        highlighted ? 'bg-bg-hover' : 'hover:bg-bg-hover'
      }`}
    >
      <span className="text-accent w-3">{detail.current ? '✓' : ''}</span>
      <span className="font-mono truncate flex-1 text-text-primary">{row.name}</span>
      {badges}
      <Age row={row} now={now} />
    </button>
  )
}

function SyncButton({
  testId,
  label,
  spinning,
  title,
  disabled,
  primary,
  bordered,
  onClick
}: {
  testId: string
  label: string
  spinning: boolean
  title: string
  disabled: boolean
  primary?: boolean
  bordered?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-2 py-1 font-mono transition-colors cursor-default ${bordered ? 'border-l border-border' : ''} ${
        disabled
          ? 'text-text-muted opacity-55'
          : primary
            ? 'bg-accent/15 text-accent hover:bg-accent/25'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <span className={spinning ? 'animate-spin inline-block' : undefined}>{label}</span>
    </button>
  )
}
