import { useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import {
  OAuthOutcomeNotice,
  OAuthPasteBackFlow,
  classifyOAuthError
} from '../auth/OAuthPasteBackFlow'

/**
 * Proactive sign-in banner (ADR-014 / Phase 4). Shown when the engine auth
 * probe reports `unauthenticated` for the `anthropic` vendor. The probe itself
 * derives from the same cli.js init signal (`session:auth-source`) — no
 * credential-file reads (preserves Keychain-prompt avoidance). Expired-but-
 * refreshable tokens are intentionally not surfaced here (cli.js refreshes
 * lazily); a truly dead session is caught reactively by the inline 401 auth card.
 *
 * TWO shapes, one store field. `authState` is the single source either way:
 *  - DESKTOP — unchanged: `signIn()` opens the host browser, the banner says
 *    "Waiting for browser authorization…" until the loopback completes;
 *  - WEB (ADR-057 / S4-UI) — the host opens no browser, so `signIn()` comes back
 *    with `manualUrl` and the banner expands into the paste-back flow (variant
 *    `code`: claude.ai displays the code on its page). The pasted string goes to
 *    the store's EXISTING `submitOAuthCode` — no second flow state.
 */
export function AuthBanner(): React.JSX.Element | null {
  const vendorAuth = useSessionStore((s) => s.vendorAuth)
  const authState = useSessionStore((s) => s.authState)
  const signIn = useSessionStore((s) => s.signIn)
  const submitOAuthCode = useSessionStore((s) => s.submitOAuthCode)
  const cancelSignIn = useSessionStore((s) => s.cancelSignIn)
  const [dismissed, setDismissed] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Hide once logged in (probe says authenticated) or a login just succeeded.
  // vendorAuth null = not yet probed → don't show the banner yet.
  const probeState = vendorAuth?.anthropic?.authState
  const loggedOut = probeState === 'unauthenticated' && authState?.status !== 'success'
  if (dismissed || !loggedOut) return null

  const isWeb = window.api.platform === 'web'
  const authorizing = authState?.status === 'authorizing'
  // A web flow is "live" only while the host says `authorizing`. On failure the
  // host has already torn the flow down (AuthManager.fail clears `pendingState`),
  // so the paste field comes DOWN and the outcome + the "Log in" button come back
  // — which is exactly the mockup's "Start again from step 1". `manualUrl` may be
  // absent even here; the flow component says so rather than opening about:blank.
  const pasteBack = isWeb && authorizing

  const handleSubmit = (pasted: string): void => {
    setSubmitting(true)
    void submitOAuthCode(pasted).finally(() => setSubmitting(false))
  }

  return (
    <div
      data-testid="AuthBanner"
      className="mx-3 mt-2 rounded-lg border border-warning/40 bg-bg-secondary animate-fade-in"
    >
      <div className="px-3 py-2 flex items-center gap-2.5">
        {authorizing ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`text-accent shrink-0 ${pasteBack ? '' : 'animate-spin'}`}
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
          {pasteBack
            ? 'Sign in to your Claude subscription'
            : authorizing
              ? 'Waiting for browser authorization…'
              : "You're not signed in to a Claude subscription."}
        </span>
        {authorizing ? (
          <button
            data-testid="AuthBanner.cancel"
            onClick={() => void cancelSignIn()}
            className="text-[12px] text-text-secondary hover:text-text-primary cursor-pointer"
          >
            Cancel
          </button>
        ) : (
          <>
            <button
              data-testid="AuthBanner.login"
              onClick={() => void signIn()}
              className="text-[12px] font-medium rounded-md px-3 py-1 bg-accent text-bg-primary hover:bg-accent-hover transition-colors cursor-pointer"
            >
              Log in
            </button>
            <button
              data-testid="AuthBanner.dismiss"
              onClick={() => setDismissed(true)}
              className="text-[12px] text-text-secondary hover:text-text-primary cursor-pointer"
            >
              Later
            </button>
          </>
        )}
      </div>
      {pasteBack && (
        <div className="px-3 pb-3 pt-0.5 border-t border-border/30">
          <div className="pt-2.5">
            <OAuthPasteBackFlow
              variant="code"
              url={authState?.manualUrl}
              busy={submitting}
              onSubmit={handleSubmit}
            />
          </div>
        </div>
      )}
      {/* Web only, deliberately: the desktop banner has never surfaced a login
          error and this series does not change what the desktop renders. The
          remote flow needs it — a state mismatch is otherwise indistinguishable
          from "nothing happened". */}
      {isWeb && authState?.status === 'error' && authState.error && (
        <div className="px-3 pb-2.5">
          <OAuthOutcomeNotice
            kind={classifyOAuthError(authState.error)}
            message={authState.error}
          />
        </div>
      )}
    </div>
  )
}
