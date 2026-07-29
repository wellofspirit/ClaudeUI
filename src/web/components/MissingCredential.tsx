interface MissingCredentialProps {
  /** Optional detail (e.g. a failed discovery fetch) shown under the guidance. */
  detail?: string
}

/**
 * Dead-end state for a `/remote` visitor with no URL fragment on a server that
 * offers no password credential — the only way in is the QR code / copied link.
 *
 * (Was raw `document.body.innerHTML` before Phase 2; it lives in the React tree
 * now so the password flow can render alongside it.)
 */
export function MissingCredential({ detail }: MissingCredentialProps): React.JSX.Element {
  return (
    <div
      data-testid="MissingCredential"
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(13,17,23,0.95)' }}
    >
      <div className="flex flex-col items-center gap-2 text-center px-6">
        <div className="text-text-primary text-lg font-medium">Missing Token</div>
        <div className="text-text-secondary text-sm">
          Scan the QR code from the desktop app to connect.
        </div>
        {detail && (
          <div data-testid="MissingCredential.detail" className="text-text-muted text-xs">
            {detail}
          </div>
        )}
      </div>
    </div>
  )
}
