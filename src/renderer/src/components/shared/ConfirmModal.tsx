import { useState } from 'react'

/**
 * Generic destructive-action confirmation. Extracted from
 * Sidebar/DeleteConfirmModal (which is now a thin wrapper preserving its own
 * copy) so every irreversible action shares one dialog: the same busy state,
 * the same inline error-with-retry on rejection, and the same testids.
 *
 * `stackedAbove` raises the z-index for a confirm opened from INSIDE another
 * dialog — the settings dialog root is z-50 and nested dialogs sit at z-[100],
 * so a confirm launched from one of those must clear it.
 */
export function ConfirmModal({
  title,
  body,
  detail,
  confirmLabel,
  busyLabel = 'Working…',
  errorTitle = 'Could not complete',
  stackedAbove = false,
  testId = 'ConfirmModal',
  onConfirm,
  onCancel
}: {
  title: string
  /** Main explanation. Say plainly what is destroyed and whether it is reversible. */
  body: React.ReactNode
  /** Optional monospace hint — a path, an id, the thing being acted on. */
  detail?: React.ReactNode
  confirmLabel: string
  busyLabel?: string
  errorTitle?: string
  /** True when rendered above another dialog (z-[110] instead of z-[100]). */
  stackedAbove?: boolean
  testId?: string
  /** May reject; the rejection is surfaced inline and the action can be retried. */
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

  return (
    <div
      data-testid={testId}
      className={`fixed inset-0 ${stackedAbove ? 'z-[110]' : 'z-[100]'} flex items-center justify-center`}
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={busy ? undefined : onCancel}
      />
      <div className="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-[440px] p-5 animate-fade-in">
        <h3 className="text-[15px] font-medium text-text-primary mb-2">{title}</h3>
        <p className="text-[13px] text-text-secondary mb-3 leading-relaxed">{body}</p>
        {detail && (
          <div className="text-[11px] text-text-muted font-mono bg-bg-tertiary/60 border border-border rounded px-2 py-1.5 mb-4 break-all">
            {detail}
          </div>
        )}
        {error && (
          <div className="text-[12px] bg-red-500/10 border border-red-500/30 text-red-400 rounded px-3 py-2 mb-4">
            <div className="font-medium">{errorTitle}</div>
            <div className="opacity-80 text-[11px] font-mono mt-0.5 break-all">{error}</div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            data-testid={`${testId}.cancel`}
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors cursor-default"
          >
            {error ? 'Close' : 'Cancel'}
          </button>
          <button
            data-testid={`${testId}.confirm`}
            onClick={handleConfirm}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors cursor-default"
          >
            {busy ? busyLabel : error ? 'Retry' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
