import { useState } from 'react'
import { useSessionStore } from '../../stores/session-store'

/**
 * Proactive sign-in banner (ADR-014). Shown when cli.js reports it has no
 * credentials — `authSource === 'none'` from the session init event. We use the
 * init signal rather than reading the credential store ourselves, which would
 * trigger macOS Keychain `security` trust prompts. Expired-but-refreshable
 * tokens are intentionally not surfaced here (cli.js refreshes lazily); a truly
 * dead session is caught reactively by the inline 401 auth card.
 */
export function AuthBanner(): React.JSX.Element | null {
  const authSource = useSessionStore((s) => s.authSource)
  const authState = useSessionStore((s) => s.authState)
  const signIn = useSessionStore((s) => s.signIn)
  const cancelSignIn = useSessionStore((s) => s.cancelSignIn)
  const [dismissed, setDismissed] = useState(false)

  // Hide once logged in (init said oauth/api_key) or a login just succeeded.
  const loggedOut = authSource === 'none' && authState?.status !== 'success'
  if (dismissed || !loggedOut) return null

  const authorizing = authState?.status === 'authorizing'

  return (
    <div className="mx-3 mt-2 rounded-lg border border-warning/40 bg-bg-secondary animate-fade-in">
      <div className="px-3 py-2 flex items-center gap-2.5">
        {authorizing ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-accent shrink-0 animate-spin"
          >
            <path d="M21 12a9 9 0 1 1-6.22-8.56" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-warning shrink-0"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        )}
        <span className="flex-1 text-[12px] text-text-secondary">
          {authorizing
            ? 'Waiting for browser authorization…'
            : "You're not signed in to a Claude subscription."}
        </span>
        {authorizing ? (
          <button
            onClick={() => void cancelSignIn()}
            className="text-[12px] text-text-secondary hover:text-text-primary cursor-pointer"
          >
            Cancel
          </button>
        ) : (
          <>
            <button
              onClick={() => void signIn()}
              className="text-[12px] font-medium rounded-md px-3 py-1 bg-accent text-bg-primary hover:bg-accent-hover transition-colors cursor-pointer"
            >
              Log in
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="text-[12px] text-text-secondary hover:text-text-primary cursor-pointer"
            >
              Later
            </button>
          </>
        )}
      </div>
    </div>
  )
}
