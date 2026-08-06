import { ConfirmModal } from '../shared/ConfirmModal'

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
  /** Async — may reject; the modal surfaces the error inline */
  onConfirm: () => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const confirmLabel =
    kind === 'project' && sessionCount && sessionCount > 0
      ? `Delete all ${sessionCount} session${sessionCount === 1 ? '' : 's'}`
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
