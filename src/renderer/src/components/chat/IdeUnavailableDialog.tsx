import { useEffect } from 'react'
import type { IdeUnavailableReason } from '../../../../shared/remote-protocol'

/**
 * WHY the remote IDE cannot open, in the operator's own terms (ADR-064's
 * "explain, don't stonewall" ruling).
 *
 * Every member of {@link IdeUnavailableReason} is a state no retry clears on its
 * own — a toggle to flip, an origin to change, a CLI to install, a spawn that
 * failed — so a generic "something went wrong" would be strictly worse than
 * silence: it invites the one action (click again) that cannot help. Each reason
 * therefore names the fix and where it lives.
 *
 * Register matches TerminalPanel's "Remote terminal is turned off." wall: short
 * statement of fact, then one sentence of what to do about it.
 */
const COPY: Record<IdeUnavailableReason, { title: string; body: string }> = {
  'toggle-off': {
    title: 'VS Code is turned off',
    body: 'Turn on “Allow VS Code on the web” in Settings › Remote on the desktop app.'
  },
  'origin-not-allowed': {
    title: 'VS Code is not served on this connection',
    body:
      'VS Code is served only on the Tailscale HTTPS address (or on the host itself). ' +
      'Cloudflare-tunnel and plain-LAN connections are excluded by the security model.'
  },
  'cli-not-found': {
    title: 'No VS Code on the host',
    body:
      'No VS Code CLI was found on the host. Install VS Code (or the standalone VS Code CLI) ' +
      'on the host, or set an explicit CLI path in Settings › Remote on the desktop app.'
  },
  'cli-invalid': {
    title: 'That is not a VS Code CLI',
    body:
      'The configured VS Code CLI did not answer `serve-web --help`. Check the CLI path in ' +
      'Settings › Remote on the desktop app.'
  },
  'spawn-failed': {
    title: 'VS Code did not start',
    body: 'VS Code’s serve-web failed to start on the host.'
  }
}

/**
 * The modal itself. Follows the repo's existing overlay shape (ConfirmModal's
 * fixed backdrop + centred panel) rather than introducing a second modal system,
 * but it is NOT a confirm: there is nothing to agree to, so it carries a single
 * Close and no destructive affordance.
 */
export function IdeUnavailableDialog({
  reason,
  detail,
  onClose
}: {
  reason: IdeUnavailableReason
  /**
   * The host's own words about this failure — the CLI probe's `detail` for the
   * two CLI reasons, the service's `lastError` for `spawn-failed`. Never a
   * fabricated string: absent means the host said nothing.
   */
  detail?: string
  onClose: () => void
}): React.JSX.Element {
  // Escape closes, like every other dismissible overlay in the bar.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const copy = COPY[reason]

  return (
    <div
      data-testid="IdeUnavailableDialog"
      data-reason={reason}
      className="fixed inset-0 z-[100] flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-[440px] p-5 animate-fade-in">
        <h3 className="text-[15px] font-medium text-text-primary mb-2">{copy.title}</h3>
        <p
          data-testid="IdeUnavailableDialog.reason"
          className="text-[13px] text-text-secondary leading-relaxed"
        >
          {copy.body}
        </p>
        {detail && (
          <div
            data-testid="IdeUnavailableDialog.detail"
            className="text-[11px] text-text-muted font-mono bg-bg-tertiary/60 border border-border rounded px-2 py-1.5 mt-3 break-all"
          >
            {detail}
          </div>
        )}
        <div className="flex justify-end mt-4">
          <button
            data-testid="IdeUnavailableDialog.close"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
