import { useState } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { useShallow } from 'zustand/react/shallow'
import type { EngineId } from '../../../../shared/types'
import {
  OAuthOutcomeNotice,
  OAuthPasteBackFlow,
  classifyOAuthError
} from '../auth/OAuthPasteBackFlow'

/**
 * Interactive re-login card for opencode vendor auth failures (401 mid-turn).
 * Shown when the active session has `vendorAuthRequired` (set by the
 * `session:vendor-auth-required` event the OpencodeSession emits for a
 * ProviderAuthError carrying a providerID). opencode-only: Claude never emits
 * this event (its auth path is AuthBanner / AuthErrorBlock, ADR-014).
 *
 * Re-authenticate runs the shared `authorizeVendorOAuth` action (native browser
 * `auto` drive). On success the card stays mounted (local `success` state) and
 * offers Retry (re-send the session's last user prompt via the respawn-aware
 * `retrySend`) + Dismiss. We do NOT clear `vendorAuthRequired` on success —
 * clearing would unmount the card before the Retry button could render; it's
 * cleared only on Dismiss and on Retry.
 *
 * REMOTE (ADR-057 / S4-UI): there is no host browser to drive, so the same
 * action parks the flow at `vendorOAuth.stage === 'paste'` and this card expands
 * into the shared two-step paste-back flow (variant `url` — the vendor redirect
 * dies on a `localhost` page whose ADDRESS is the payload). When the backend
 * refuses the vendor's method outright — opencode's `auto` can only complete on
 * the host — the flow lands on `stage: 'error'` and the card renders the
 * desktop-only outcome instead. Desktop mounts none of this.
 */
export function VendorAuthRequiredCard(): React.JSX.Element | null {
  const vendorAuthRequired = useActiveSession((s) => s.vendorAuthRequired)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const engineId = useActiveSession((s) => s.status.engineId)
  const {
    authorizeVendorOAuth,
    clearVendorAuthRequired,
    cancelVendorOAuth,
    submitVendorOAuthCode,
    vendorOAuth
  } = useSessionStore(
    useShallow((s) => ({
      authorizeVendorOAuth: s.authorizeVendorOAuth,
      clearVendorAuthRequired: s.clearVendorAuthRequired,
      cancelVendorOAuth: s.cancelVendorOAuth,
      submitVendorOAuthCode: s.submitVendorOAuthCode,
      vendorOAuth: s.vendorOAuth
    }))
  )
  const [success, setSuccess] = useState(false)
  const [retryPrompt, setRetryPrompt] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  /** Last user prompt, captured at Re-authenticate for the post-success Retry. */
  const [pendingRetryPrompt, setPendingRetryPrompt] = useState<string | null>(null)

  // Keep the card mounted through the post-success state (Retry/Dismiss). The
  // success view doesn't depend on `vendorAuthRequired` (we snapshot vendorId
  // below), so guarding only on it would unmount before Retry can render.
  if ((!vendorAuthRequired && !success) || !activeSessionId) return null

  const vendorId = vendorAuthRequired?.vendorId ?? ''
  const message = vendorAuthRequired?.message ?? ''
  const mine = vendorOAuth?.vendorId === vendorId
  const isWaiting = mine && vendorOAuth?.stage === 'waiting'
  const isError = mine && vendorOAuth?.stage === 'error'
  // Only ever set on web (the store never parks a desktop flow here), so this
  // doubles as the platform branch — the flow component cannot reach the desktop.
  const isPasting = mine && vendorOAuth?.stage === 'paste'

  const handleReauthenticate = async (): Promise<void> => {
    // Capture the session's last user prompt now (for the post-success Retry).
    const store = useSessionStore.getState()
    const session = store.sessions[activeSessionId]
    const msgs = session?.messages ?? []
    let lastPrompt: string | null = null
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        const textBlock = msgs[i].content.find((b) => b.type === 'text')
        if (textBlock && textBlock.type === 'text') lastPrompt = textBlock.text
        break
      }
    }
    // Remembered for the paste-back path, whose success lands in a later tick.
    setPendingRetryPrompt(lastPrompt)
    const result = await authorizeVendorOAuth(engineId as EngineId, vendorId)
    if (result.ok) {
      // Keep vendorAuthRequired set so the card stays mounted; flip to the
      // success/Retry view via local state. Cleared on Dismiss / Retry.
      setSuccess(true)
      setRetryPrompt(lastPrompt)
    }
    // On web: vendorOAuth parks at stage 'paste' (or 'error' when the backend
    // refuses the method) and the flow below takes over.
    // On desktop, needsPaste → user must use Settings › Vendors (rare for
    // subscription vendors); error → vendorOAuth.stage drives the failure message.
  }

  const handlePasteSubmit = (pasted: string): void => {
    setSubmitting(true)
    void submitVendorOAuthCode(pasted)
      .then((result) => {
        if (result.ok) {
          setSuccess(true)
          setRetryPrompt(pendingRetryPrompt)
        }
        // Failure: the store dropped the flow to stage 'error' with the backend's
        // verbatim message, which the outcome row below classifies.
      })
      .finally(() => setSubmitting(false))
  }

  const handleRetry = (): void => {
    if (!retryPrompt) return
    useSessionStore.getState().retrySend(activeSessionId, retryPrompt)
    clearVendorAuthRequired(activeSessionId)
    setSuccess(false)
    setRetryPrompt(null)
  }

  const handleDismiss = (): void => {
    clearVendorAuthRequired(activeSessionId)
    setSuccess(false)
    setRetryPrompt(null)
  }

  return (
    <div
      data-testid="VendorAuthRequiredCard"
      className="absolute top-12 left-0 right-0 z-20 pointer-events-none"
    >
      <div className="pointer-events-auto px-4 pt-2">
        <div className="max-w-[740px] mx-auto">
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2.5 text-[13px]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-yellow-400 text-[12px] mb-0.5">
                  Authentication required — <span className="font-mono">{vendorId}</span>
                </div>
                {message && (
                  <div className="text-text-secondary text-[11px] leading-relaxed">{message}</div>
                )}
              </div>
              <button
                onClick={handleDismiss}
                className="shrink-0 text-[11px] text-text-muted/60 hover:text-text-muted transition-colors"
              >
                ✕
              </button>
            </div>

            {success ? (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[11px] text-green-400">Re-authenticated.</span>
                {retryPrompt && (
                  <button
                    onClick={handleRetry}
                    className="px-2 py-0.5 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
                  >
                    Retry
                  </button>
                )}
                <button
                  onClick={handleDismiss}
                  className="px-2 py-0.5 text-[11px] rounded hover:bg-bg-hover text-text-muted/70 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            ) : isPasting ? (
              <div className="mt-2.5">
                <OAuthPasteBackFlow
                  variant="url"
                  id={vendorId}
                  url={vendorOAuth?.url}
                  busy={submitting}
                  onSubmit={handlePasteSubmit}
                  onCancel={cancelVendorOAuth}
                />
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                {isWaiting ? (
                  <>
                    <span className="text-[11px] text-text-muted/80">
                      Waiting for browser authorization…
                    </span>
                    <button
                      onClick={() => cancelVendorOAuth()}
                      className="px-2 py-0.5 text-[11px] rounded hover:bg-bg-hover text-text-muted/70 transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => void handleReauthenticate()}
                      className="px-2 py-0.5 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
                    >
                      Re-authenticate
                    </button>
                    {/* An S4-UI failure carries the backend's own words, so it
                        gets the classified outcome (desktop-only / state
                        mismatch / verbatim). The legacy desktop `auto` failure
                        carries none and keeps its generic line. */}
                    {isError &&
                      (vendorOAuth?.error ? (
                        <OAuthOutcomeNotice
                          kind={classifyOAuthError(vendorOAuth.error)}
                          message={vendorOAuth.error}
                          id={vendorId}
                        />
                      ) : (
                        <span className="text-[11px] text-red-400">
                          Authentication failed. Try again.
                        </span>
                      ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
