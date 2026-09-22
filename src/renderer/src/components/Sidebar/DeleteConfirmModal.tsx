import { ConfirmModal } from '../shared/ConfirmModal'
import type { CodexDeleteNode } from '../../../../shared/codex-types'

/**
 * Session/project delete confirmation. A thin wrapper over the shared
 * ConfirmModal that owns only its own copy — the dialog mechanics (busy state,
 * inline error + retry, backdrop, testids) live in the primitive so every
 * destructive action in the app behaves identically.
 */
export function DeleteConfirmModal({
  kind,
  name,
  path,
  sessionCount,
  branches,
  onConfirm,
  onCancel
}: {
  kind: 'session' | 'project'
  /** User-facing name of the target (session title or project folder name) */
  name: string
  /** Disk path shown in a monospace hint, e.g. ~/.claude/projects/... */
  path: string
  /** For project deletes, number of sessions that will also be removed */
  sessionCount?: number
  /**
   * Codex only: the branches cut from this session, which the delete has to
   * take with it. Codex refuses to delete a thread while a fork still
   * references its history, so this is a statement of fact, not an option.
   * `undefined` for every other engine; empty for an unbranched Codex session.
   */
  branches?: CodexDeleteNode[]
  /** Async — may reject; the modal surfaces the error inline */
  onConfirm: () => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const confirmLabel =
    kind === 'project' && sessionCount && sessionCount > 0
      ? `Delete all ${sessionCount} session${sessionCount === 1 ? '' : 's'}`
      : branches?.length
        ? `Delete all ${branches.length + 1}`
        : 'Delete'

  return (
    <ConfirmModal
      testId="DeleteConfirmModal"
      title={kind === 'session' ? 'Delete session?' : 'Delete project?'}
      confirmLabel={confirmLabel}
      busyLabel="Deleting..."
      errorTitle="Could not delete"
      detail={path}
      onConfirm={onConfirm}
      onCancel={onCancel}
      body={
        kind === 'session' ? (
          <>
            This will permanently delete{' '}
            <span className="font-medium text-text-primary">&quot;{name}&quot;</span> and its
            subagent data from disk. This cannot be undone.
            {branches?.length ? (
              <span data-testid="DeleteConfirmModal.branches" className="mt-2 block">
                Also deletes {branches.length} branch
                {branches.length === 1 ? '' : 'es'} cut from it — Codex will not delete a session
                while a branch still references it:
                <span className="mt-1 block">
                  {branches.map((branch) => (
                    <span
                      key={branch.threadId}
                      data-testid="DeleteConfirmModal.branch"
                      className="block truncate text-text-primary"
                    >
                      {branch.title ?? branch.threadId}
                      {branch.live ? (
                        <span className="text-text-muted"> — running, will be stopped</span>
                      ) : null}
                    </span>
                  ))}
                </span>
              </span>
            ) : null}
          </>
        ) : (
          <>
            This will permanently delete{' '}
            <span className="font-medium text-text-primary">{name}</span>
            {sessionCount ? (
              <>
                {' '}
                and all{' '}
                <span className="font-medium text-text-primary">
                  {sessionCount} session{sessionCount === 1 ? '' : 's'}
                </span>{' '}
                inside it
              </>
            ) : (
              ''
            )}
            . This cannot be undone.
          </>
        )
      }
    />
  )
}
