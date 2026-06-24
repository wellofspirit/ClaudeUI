import { useState } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { useShallow } from 'zustand/react/shallow'
import type { EngineId } from '../../../../shared/types'

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
 */
export function VendorAuthRequiredCard(): React.JSX.Element | null {
  const vendorAuthRequired = useActiveSession((s) => s.vendorAuthRequired)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const engineId = useActiveSession((s) => s.status.engineId)
  const { authorizeVendorOAuth, clearVendorAuthRequired, cancelVendorOAuth, vendorOAuth } =
    useSessionStore(
      useShallow((s) => ({
        authorizeVendorOAuth: s.authorizeVendorOAuth,
        clearVendorAuthRequired: s.clearVendorAuthRequired,
        cancelVendorOAuth: s.cancelVendorOAuth,
        vendorOAuth: s.vendorOAuth
      }))
    )
  const [success, setSuccess] = useState(false)
  const [retryPrompt, setRetryPrompt] = useState<string | null>(null)

  // Keep the card mounted through the post-success state (Retry/Dismiss). The
  // success view doesn't depend on `vendorAuthRequired` (we snapshot vendorId
  // below), so guarding only on it would unmount before Retry can render.
  if ((!vendorAuthRequired && !success) || !activeSessionId) return null

  const vendorId = vendorAuthRequired?.vendorId ?? ''
  const message = vendorAuthRequired?.message ?? ''
  const isWaiting = vendorOAuth?.stage === 'waiting' && vendorOAuth.vendorId === vendorId
  const isError = vendorOAuth?.stage === 'error' && vendorOAuth.vendorId === vendorId

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
    const result = await authorizeVendorOAuth(engineId as EngineId, vendorId)
    if (result.ok) {
      // Keep vendorAuthRequired set so the card stays mounted; flip to the
      // success/Retry view via local state. Cleared on Dismiss / Retry.
      setSuccess(true)
      setRetryPrompt(lastPrompt)
    }
    // needsPaste → user must use Settings › Vendors (rare for subscription vendors).
    // error → vendorOAuth.stage drives the inline failure message.
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
    <div className="absolute top-12 left-0 right-0 z-20 pointer-events-none">
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
            ) : (
              <div className="mt-2 flex items-center gap-2">
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
                    {isError && (
                      <span className="text-[11px] text-red-400">
                        Authentication failed. Try again.
                      </span>
                    )}
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
