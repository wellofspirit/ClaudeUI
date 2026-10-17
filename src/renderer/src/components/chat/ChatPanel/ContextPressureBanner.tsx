/**
 * The context-pressure banner above the composer (session tools, slice 4, spec §6.6).
 *
 * A session's context crossed a threshold the user set: "Context is at 72 % — continue in a
 * new session?" with Hand off (tell the session to wrap up and call session_hand_off) and
 * Not now. After ClaudeUI asked a session to hand off and it did not, the same banner says
 * so and Hand off tries again. The state is replicated per session, so either answer clears
 * the banner on every client; this component only renders it and sends the answer.
 *
 * Same slot and column as the queued-message card. Wraps, 32px targets, no viewport units
 * (ADR-093), so the one component serves the desktop, the browser and the phone.
 */
import { useState } from 'react'
import {
  contextPressureBannerText,
  handOffBlockedReason,
  type ContextPressureBanner as BannerData
} from '../../../../../shared/context-pressure'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'

export function ContextPressureBannerView({
  banner,
  busy,
  error,
  blockedReason,
  isMobile,
  onHandOff,
  onDismiss
}: {
  banner: BannerData
  busy?: 'handoff' | 'dismiss' | null
  error?: string | null
  /** Why Hand off cannot be used now (plan mode); the button is disabled and the reason shown. */
  blockedReason?: string | null
  isMobile: boolean
  onHandOff: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const failed = banner.kind === 'failed'
  return (
    <div
      data-testid="ContextPressureBanner"
      data-kind={banner.kind}
      style={{ padding: '0 13px 4px' }}
    >
      <div className={`${isMobile ? 'max-w-full' : 'max-w-[740px]'} mx-auto`}>
        <div
          role="status"
          className={`px-2.5 py-1.5 rounded-lg bg-bg-secondary border flex flex-wrap items-center gap-x-3 gap-y-1 ${
            failed ? 'border-warning/40' : 'border-border/60'
          }`}
        >
          <span
            data-testid="ContextPressureBanner.text"
            className={`flex-1 min-w-[200px] text-[12px] leading-4 break-words ${
              failed ? 'text-warning/90' : 'text-text-secondary'
            }`}
          >
            {contextPressureBannerText(banner)}
            {failed && ` Context is at ${banner.percent} %.`}
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              data-testid="ContextPressureBanner.handoff"
              disabled={busy != null || !!blockedReason}
              title={blockedReason ?? undefined}
              onClick={onHandOff}
              className="min-h-8 px-3 rounded-md bg-accent/15 text-accent text-[12px] font-medium hover:bg-accent/25 transition-colors cursor-pointer disabled:opacity-50"
            >
              Hand off
            </button>
            <button
              type="button"
              data-testid="ContextPressureBanner.dismiss"
              disabled={busy != null}
              onClick={onDismiss}
              className="min-h-8 px-3 rounded-md border border-border text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer disabled:opacity-50"
            >
              Not now
            </button>
          </span>
          {blockedReason && (
            <span
              data-testid="ContextPressureBanner.reason"
              className="basis-full text-[11px] leading-4 text-text-muted break-words"
            >
              {blockedReason}
            </span>
          )}
          {error && (
            <span
              data-testid="ContextPressureBanner.error"
              className="basis-full text-[11px] leading-4 text-danger/90 break-words"
            >
              {error}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** The banner for the active session, or nothing. */
export function ContextPressureBanner({
  isMobile
}: {
  isMobile: boolean
}): React.JSX.Element | null {
  const banner = useActiveSession((s) => s.contextPressure)
  const routingId = useSessionStore((s) => s.activeSessionId)
  const blocked = useActiveSession((s) => handOffBlockedReason(s.permissionMode))
  const [busy, setBusy] = useState<'handoff' | 'dismiss' | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!banner || !routingId) return null

  const answer = async (which: 'handoff' | 'dismiss'): Promise<void> => {
    setBusy(which)
    setError(null)
    try {
      const result = await window.api.respondContextPressure(routingId, which)
      if (!result.success) setError(result.error ?? 'That did not work.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <ContextPressureBannerView
      banner={banner}
      busy={busy}
      error={error}
      blockedReason={blocked}
      isMobile={isMobile}
      onHandOff={() => void answer('handoff')}
      onDismiss={() => void answer('dismiss')}
    />
  )
}
