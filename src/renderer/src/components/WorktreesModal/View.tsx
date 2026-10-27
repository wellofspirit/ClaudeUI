import { useId } from 'react'
import type {
  WorktreeInspection,
  WorktreeInventoryEntry,
  WorktreeRemoveResult,
  WorktreeSize
} from '../../../../shared/types'
import type { InvokeProgress } from '../../../../shared/remote-protocol'
import {
  describeResult,
  formatBytes,
  holderChip,
  plural,
  sizeText,
  statusText,
  type ConfirmItem,
  type Loaded
} from '../../lib/worktree-view'
import { ConfirmModal } from '../shared/ConfirmModal'

export interface WorktreeRowModel {
  entry: WorktreeInventoryEntry
  inspection: Loaded<WorktreeInspection>
  size: Loaded<WorktreeSize>
  selected: boolean
  /** Why the checkbox is disabled; null = selectable. */
  disabledReason: string | null
  /** Minutes since the newest modification when that is within the last 10 minutes. */
  recentMinutes: number | null
  /** The last run's result for this row. */
  result: WorktreeRemoveResult | null
  /** Removed by the last run: the row stays as a record of it until the next refresh. */
  gone: boolean
}

export interface WorktreesModalViewProps {
  /** The repo root for display; null before the inventory arrives. */
  repoRoot: string | null
  loading: boolean
  error: string | null
  rows: WorktreeRowModel[]
  total: { bytes: number; atLeast: boolean }
  /** Rows still being inspected or measured; null when the scan is complete. */
  scan: { done: number; total: number } | null
  /** The re-inventory after a run failed: the rows are the last known list. */
  staleError: string | null
  selectedCount: number
  selectedSize: { bytes: number; atLeast: boolean }
  phase: 'idle' | 'confirm' | 'removing'
  progress: InvokeProgress | null
  confirmItems: ConfirmItem[]
  onToggle: (id: string) => void
  onSelectSafe: () => void
  onRemoveSelected: () => void
  onConfirm: () => Promise<void>
  onCancelConfirm: () => void
  onRefresh: () => void
  onClose: () => void
}

const sizeLabel = (s: { bytes: number; atLeast: boolean }): string =>
  `${s.atLeast ? '≥ ' : ''}${formatBytes(s.bytes)}`

function ConfirmBody({ items }: { items: ConfirmItem[] }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div>
        This permanently deletes the folders below. Branches with commits found nowhere else are
        kept.
      </div>
      <ul
        className="space-y-1.5 max-h-64 overflow-y-auto"
        data-testid="WorktreesModal.confirm.list"
      >
        {items.map((item) => (
          <li
            key={item.id}
            data-testid="WorktreesModal.confirm.item"
            data-id={item.id}
            className="px-2.5 py-1.5 rounded-lg bg-bg-tertiary border border-border text-[12px]"
          >
            <div className="font-mono text-text-primary break-all">{item.name}</div>
            {item.clean ? (
              <div className="text-text-muted">Nothing uncommitted, no unique commits.</div>
            ) : (
              <ul className="mt-0.5 space-y-0.5 text-text-secondary">
                {item.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {item.samples.length > 0 && (
              <ul className="mt-0.5 font-mono text-[11px] text-text-muted break-all">
                {item.samples.map((sample) => (
                  <li key={sample}>{sample}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Badge({
  kind,
  children,
  tone = 'muted'
}: {
  kind: string
  children: React.ReactNode
  tone?: 'muted' | 'danger' | 'warn'
}): React.JSX.Element {
  const cls =
    tone === 'danger'
      ? 'text-red-400 bg-red-400/10'
      : tone === 'warn'
        ? 'text-warning bg-warning/10'
        : 'text-text-muted bg-bg-hover'
  return (
    <span
      data-testid="WorktreesModal.kindBadge"
      data-kind={kind}
      className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${cls}`}
    >
      {children}
    </span>
  )
}

function WorktreeRow({
  row,
  busy,
  onToggle
}: {
  row: WorktreeRowModel
  busy: boolean
  onToggle: (id: string) => void
}): React.JSX.Element {
  const { entry, inspection, size, disabledReason, result, gone } = row
  const reasonId = useId()
  const view = result ? describeResult(result) : null
  const toneCls =
    view?.tone === 'ok'
      ? 'text-text-secondary'
      : view?.tone === 'warn'
        ? 'text-warning'
        : 'text-red-400'
  return (
    <div
      data-testid="WorktreesModal.worktreeRow"
      data-id={entry.id}
      data-kind={entry.kind}
      data-gone={gone ? 'true' : undefined}
      className={`flex items-start gap-3 px-3 py-2 rounded-lg bg-bg-tertiary border border-border ${gone ? 'opacity-70' : ''}`}
    >
      {gone ? (
        <span className="w-[14px] shrink-0" />
      ) : (
        <input
          type="checkbox"
          data-testid="WorktreesModal.select"
          data-id={entry.id}
          checked={row.selected}
          disabled={busy || disabledReason !== null}
          onChange={() => onToggle(entry.id)}
          aria-label={`Select ${entry.name}`}
          aria-describedby={disabledReason ? reasonId : undefined}
          className="mt-1 shrink-0 accent-[var(--color-accent)]"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            data-testid="WorktreesModal.name"
            title={entry.path}
            className="text-[13px] text-text-primary font-mono break-all"
          >
            {entry.name}
          </span>
          {entry.location !== 'managed' && <Badge kind={entry.location}>{entry.location}</Badge>}
          {entry.kind !== 'worktree' && (
            <Badge kind={entry.kind} tone={entry.kind === 'missing' ? 'danger' : 'muted'}>
              {entry.kind}
            </Badge>
          )}
          {entry.locked && (
            <Badge kind="locked" tone="warn">
              locked
            </Badge>
          )}
          {entry.invalidReason && (
            <Badge kind="invalid" tone="danger">
              invalid
            </Badge>
          )}
          {!gone && (
            <span
              data-testid="WorktreesModal.size"
              className="ml-auto text-[11px] text-text-muted tabular-nums"
            >
              {sizeText(entry, size)}
            </span>
          )}
        </div>
        {!gone && (
          <>
            <div className="text-[11px] text-text-muted mt-0.5 break-words">
              {/* An orphan is a folder git doesn't list: it has no branch or HEAD to show. */}
              {entry.kind !== 'orphan' && (
                <>
                  <span data-testid="WorktreesModal.branch">{entry.branch ?? 'detached'}</span>
                  <span className="mx-1">·</span>
                </>
              )}
              <span data-testid="WorktreesModal.status">{statusText(entry, inspection)}</span>
              {row.recentMinutes !== null && (
                <span data-testid="WorktreesModal.recent" className="ml-1 text-warning">
                  · modified {row.recentMinutes < 1 ? '<1' : row.recentMinutes} min ago
                </span>
              )}
            </div>
            {entry.holders.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {entry.holders.map((h) => {
                  const chip = holderChip(h)
                  return (
                    <span
                      key={`${h.kind}:${h.id}`}
                      data-testid="WorktreesModal.holder"
                      title={chip.text}
                      data-live={chip.live ? 'true' : 'false'}
                      className={`text-[10px] px-1.5 py-0.5 rounded max-w-full truncate ${chip.live ? 'text-warning bg-warning/10' : 'text-text-muted bg-bg-hover'}`}
                    >
                      {chip.text}
                    </span>
                  )
                })}
              </div>
            )}
            {disabledReason && (
              <div
                id={reasonId}
                data-testid="WorktreesModal.disabledReason"
                className="text-[11px] text-text-muted mt-1 break-words"
              >
                Cannot be removed: {disabledReason}
              </div>
            )}
          </>
        )}
        {view && result && (
          <div
            data-testid="WorktreesModal.result"
            data-outcome={result.outcome}
            data-branch-action={result.branch?.action}
            className={`text-[11px] mt-1 break-words ${toneCls}`}
          >
            {view.text}
            {view.paths.length > 0 && (
              <ul className="font-mono text-[10px] text-text-muted break-all">
                {view.paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function WorktreesModalView({
  repoRoot,
  loading,
  error,
  rows,
  total,
  scan,
  staleError,
  selectedCount,
  selectedSize,
  phase,
  progress,
  confirmItems,
  onToggle,
  onSelectSafe,
  onRemoveSelected,
  onConfirm,
  onCancelConfirm,
  onRefresh,
  onClose
}: WorktreesModalViewProps): React.JSX.Element {
  const removing = phase === 'removing'
  return (
    <div
      data-testid="WorktreesModal"
      className="fixed inset-0 z-[100] flex items-center justify-center max-md:items-end"
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={removing ? undefined : onClose}
      />
      <div className="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-[640px] max-w-full max-h-[80%] max-md:w-full max-md:max-h-[92%] max-md:rounded-b-none flex flex-col animate-fade-in">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <h3 className="text-[15px] font-medium text-text-primary">Worktrees</h3>
            {repoRoot && (
              <div
                data-testid="WorktreesModal.repoRoot"
                title={repoRoot}
                className="text-[11px] text-text-muted font-mono truncate"
              >
                {repoRoot}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!loading && !error && (
              <span
                data-testid="WorktreesModal.totalSize"
                className="text-[11px] text-text-muted tabular-nums"
              >
                {sizeLabel(total)}
              </span>
            )}
            <button
              data-testid="WorktreesModal.refresh"
              onClick={onRefresh}
              disabled={loading || removing}
              className="px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors cursor-default"
            >
              Refresh
            </button>
            <button
              data-testid="WorktreesModal.close"
              onClick={onClose}
              disabled={removing}
              aria-label="Close"
              className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors cursor-default"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {!loading && !error && rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-5 py-2 border-b border-border">
            <button
              data-testid="WorktreesModal.selectSafe"
              onClick={onSelectSafe}
              disabled={removing}
              className="px-2.5 py-1 rounded-md text-[11px] text-text-secondary bg-bg-tertiary hover:bg-bg-hover border border-border disabled:opacity-50 transition-colors cursor-default"
            >
              Select safe
            </button>
            <button
              data-testid="WorktreesModal.removeSelected"
              onClick={onRemoveSelected}
              disabled={removing || selectedCount === 0}
              className="px-2.5 py-1 rounded-md text-[11px] text-red-400 hover:text-red-300 hover:bg-red-400/10 border border-red-400/30 disabled:opacity-50 transition-colors cursor-default"
            >
              Remove {selectedCount} ({sizeLabel(selectedSize)})
            </button>
            {scan && (
              <span data-testid="WorktreesModal.scan" className="text-[11px] text-text-muted">
                Scanning {scan.done}/{scan.total}…
              </span>
            )}
          </div>
        )}

        {removing && (
          <div
            data-testid="WorktreesModal.progress"
            className="px-5 py-2 border-b border-border text-[11px] text-text-secondary break-words"
          >
            Removing{' '}
            {progress ? Math.min(progress.done + 1, progress.total ?? progress.done + 1) : 1}
            {progress?.total ? ` of ${progress.total}` : ''}
            {progress?.phase ? ` — ${progress.phase}` : '…'}
          </div>
        )}

        {staleError && (
          <div
            data-testid="WorktreesModal.staleError"
            className="px-5 py-2 border-b border-border text-[11px] text-warning break-words"
          >
            Could not re-read the worktrees ({staleError}); this is the last known list. Refresh to
            retry.
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div
              data-testid="WorktreesModal.loading"
              className="text-[12px] text-text-muted text-center py-4"
            >
              Loading...
            </div>
          ) : error ? (
            <div
              data-testid="WorktreesModal.error"
              className="text-[12px] text-red-400 text-center py-4 break-words"
            >
              Could not read the worktrees: {error}
            </div>
          ) : rows.length === 0 ? (
            <div
              data-testid="WorktreesModal.empty"
              className="text-[12px] text-text-muted text-center py-4"
            >
              No worktrees found for this repository
            </div>
          ) : (
            <div className="space-y-2">
              {rows.map((row) => (
                <WorktreeRow key={row.entry.id} row={row} busy={removing} onToggle={onToggle} />
              ))}
            </div>
          )}
        </div>
      </div>

      {phase === 'confirm' && (
        <ConfirmModal
          testId="WorktreesModal.confirm"
          stackedAbove
          title={`Remove ${plural(confirmItems.length, 'worktree')}?`}
          body={<ConfirmBody items={confirmItems} />}
          confirmLabel={`Remove ${plural(confirmItems.length, 'worktree')}`}
          busyLabel="Removing…"
          errorTitle="Could not remove"
          onConfirm={onConfirm}
          onCancel={onCancelConfirm}
        />
      )}
    </div>
  )
}
