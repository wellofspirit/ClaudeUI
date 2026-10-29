import { ConfirmModal } from '../shared/ConfirmModal'
import type { FoldedWorktreeSummary } from '../../../../shared/worktree-fold'

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
  sessionPaths,
  folderKept,
  folderUnlisted,
  worktrees,
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
   * Project deletes: Claude session files removed ONE BY ONE rather than with
   * the project folder (`planClaudeProjectDelete`): members cli.js's
   * `EnterWorktree` moved into a worktree's project folder, and the sessions of
   * the worktrees folded into this project (each under its own folder). Empty
   * in the common case, which renders as before.
   */
  sessionPaths?: string[]
  /**
   * Project deletes: the folder at `path` is NOT removed, because it also holds
   * another project's relocated session; every member in `sessionPaths` goes
   * individually instead.
   */
  folderKept?: boolean
  /**
   * Project deletes: the project is a repository the listing has no group for (it is shown only
   * because its worktrees have sessions). Its folder holds Claude's saved project memory and is
   * never removed.
   */
  folderUnlisted?: boolean
  /** Project deletes: the linked worktrees folded into this project, whose sessions go with it. */
  worktrees?: FoldedWorktreeSummary | null
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
      detail={folderKept ? `${path} — folder kept` : path}
      onConfirm={onConfirm}
      onCancel={onCancel}
      body={
        kind === 'session' ? (
          <>
            This will permanently delete{' '}
            {/* Engine-neutral on purpose: every engine's delete takes the
                session's agents with it (Claude's subagent dir, opencode's child
                sessions, pi's agent sessions), and not every engine keeps them on
                disk. */}
            <span className="font-medium text-text-primary">&quot;{name}&quot;</span> and its
            subagents. This cannot be undone.
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
            {worktrees ? (
              <span data-testid="DeleteConfirmModal.worktrees" className="mt-2 block">
                Includes {worktrees.sessionCount} session{worktrees.sessionCount === 1 ? '' : 's'}{' '}
                in {worktrees.names.length} worktree{worktrees.names.length === 1 ? '' : 's'}:{' '}
                {worktrees.names.join(', ')}. The worktree folders are not deleted.
              </span>
            ) : null}
            {folderUnlisted ? (
              <span data-testid="DeleteConfirmModal.memoryKept" className="mt-2 block">
                Claude&apos;s folder for this repository, with its saved project memory, is not
                touched.
              </span>
            ) : !folderKept ? (
              <span data-testid="DeleteConfirmModal.memory" className="mt-2 block">
                This also removes Claude&apos;s saved project memory for this folder.
              </span>
            ) : null}
            {sessionPaths?.length ? (
              <span data-testid="DeleteConfirmModal.relocated" className="mt-2 block">
                {folderUnlisted
                  ? `Deletes ${sessionPaths.length} Claude session file${sessionPaths.length === 1 ? '' : 's'} one by one:`
                  : folderKept
                    ? `Its session${sessionPaths.length === 1 ? ' is' : 's are'} deleted one by one — the folder also holds another project's session, so it is kept:`
                    : `Also deletes ${sessionPaths.length} session file${sessionPaths.length === 1 ? '' : 's'} stored in other Claude project folders (moved or worktree sessions):`}
                <span className="mt-1 block">
                  {sessionPaths.map((sessionPath) => (
                    <span
                      key={sessionPath}
                      data-testid="DeleteConfirmModal.relocatedPath"
                      title={sessionPath}
                      className="block break-all font-mono text-[11px] text-text-primary"
                    >
                      {sessionPath}
                    </span>
                  ))}
                </span>
              </span>
            ) : null}
          </>
        )
      }
    />
  )
}
