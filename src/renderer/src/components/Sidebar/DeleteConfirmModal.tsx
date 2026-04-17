import { useState } from 'react'

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const title = kind === 'session' ? 'Delete session?' : 'Delete project?'
  const confirmLabel = kind === 'project' && sessionCount && sessionCount > 0
    ? `Delete all ${sessionCount} session${sessionCount === 1 ? '' : 's'}`
    : 'Delete'

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={busy ? undefined : onCancel} />
      <div className="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-[440px] p-5 animate-fade-in">
        <h3 className="text-[15px] font-medium text-text-primary mb-2">{title}</h3>
        <p className="text-[13px] text-text-secondary mb-3 leading-relaxed">
          {kind === 'session' ? (
            <>This will permanently delete <span className="font-medium text-text-primary">"{name}"</span> and its subagent data from disk. This cannot be undone.</>
          ) : (
            <>This will permanently delete <span className="font-medium text-text-primary">{name}</span>{sessionCount ? <> and all <span className="font-medium text-text-primary">{sessionCount} session{sessionCount === 1 ? '' : 's'}</span> inside it</> : ''}. This cannot be undone.</>
          )}
        </p>
        <div className="text-[11px] text-text-muted font-mono bg-bg-tertiary/60 border border-border rounded px-2 py-1.5 mb-4 break-all">
          {path}
        </div>
        {error && (
          <div className="text-[12px] bg-red-500/10 border border-red-500/30 text-red-400 rounded px-3 py-2 mb-4">
            <div className="font-medium">Could not delete</div>
            <div className="opacity-80 text-[11px] font-mono mt-0.5 break-all">{error}</div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors cursor-default"
          >
            {error ? 'Close' : 'Cancel'}
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors cursor-default"
          >
            {busy ? 'Deleting...' : error ? 'Retry' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
