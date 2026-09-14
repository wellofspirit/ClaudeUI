/**
 * DeviceCodeFlow — the DEFAULT remote ChatGPT sign-in (ADR-068 §3, Slice 7).
 *
 * ADR-057's paste-back (its sibling `OAuthPasteBackFlow`) can complete a ChatGPT
 * sign-in from any browser, but the step it asks for on a phone is the one that
 * hurts: land on a page that fails to load, then copy its address bar. Device
 * code replaces that with "open this link, type this code" — the host polls
 * `deviceauth/token` and finishes on its own, so this panel has no input field
 * and nothing to submit.
 *
 * WHAT CROSSES THE WIRE TO GET HERE. Three fields, all display material: the
 * verification URL, the user code, and the expiry. The `device_auth_id` the host
 * polls with never leaves the host, and neither does any token — see
 * `core/auth/vault/codex-device-code.ts` and
 * `docs/architecture/security.md` § "The vendor-credential surface".
 *
 * DESKTOP NEVER MOUNTS THIS. Like the paste panel, it is gated on
 * `window.api.platform === 'web'` by its one caller (`SignInDialog`); the desktop
 * opens the host browser and waits on the host loopback exactly as before.
 *
 * Paste-back stays reachable — "Paste the callback URL instead" — because device
 * code is the newer of the two endpoints and a server that has it turned off
 * fails the usercode request outright (ADR-030: never leave the user with no
 * working path).
 */
import { useEffect, useState } from 'react'

/** Re-rendered on this cadence so "expires in N min" does not go stale on an open dialog. */
const EXPIRY_TICK_MS = 20_000

/**
 * Whole minutes left, rounded to the nearest minute and floored at 0.
 * `undefined` when the host has not answered yet. Rounded rather than ceiled:
 * a fifteen-minute code read "Expires in 16 min" the moment it arrived, because
 * the browser's clock trails the host's by a few seconds and the ceiling of
 * 15.02 is 16 (seen on the hermetic drive).
 */
export function minutesUntil(expiresAt: number | undefined, now: number): number | undefined {
  if (expiresAt === undefined) return undefined
  return Math.max(0, Math.round((expiresAt - now) / 60_000))
}

export interface DeviceCodeFlowProps {
  /** `{issuer}/codex/device`. Absent while the start request is still in flight. */
  verificationUrl?: string
  /** The short code the user types on that page. Absent until the host answers. */
  userCode?: string
  /** Host wall-clock ms at which the host stops polling. */
  expiresAt?: number
  /** Discriminator when several instances could co-exist (ADR-027 `data-id`). */
  id?: string
  /** The start request is in flight — the affordances lock. */
  busy?: boolean
  onCancel: () => void
  /** Abandon device code and fall back to the ADR-057 paste panel. */
  onPasteInstead: () => void
}

export function DeviceCodeFlow({
  verificationUrl,
  userCode,
  expiresAt,
  id,
  busy = false,
  onCancel,
  onPasteInstead
}: DeviceCodeFlowProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (expiresAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS)
    return () => clearInterval(timer)
  }, [expiresAt])

  const minutes = minutesUntil(expiresAt, now)
  const ready = Boolean(userCode)

  const copy = (): void => {
    if (!userCode) return
    // Guarded: `navigator.clipboard` is undefined on an insecure origin, which a
    // LAN client on plain http is. A failed copy leaves the code on screen to
    // read out, which is the whole point of a short code.
    void navigator.clipboard
      ?.writeText(userCode)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <div
      data-testid="DeviceCodeFlow"
      {...(id ? { 'data-id': id } : {})}
      className="space-y-3"
      data-ready={ready ? 'true' : 'false'}
    >
      <div className="flex items-start gap-2.5">
        <div
          className="h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 bg-accent/15 text-accent"
          aria-hidden="true"
        >
          1
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium text-text-primary">
            Open this link on any device
          </div>
          <div className="text-[11px] text-text-muted mt-0.5 leading-relaxed">
            This phone, a laptop, anything with a browser you can sign in on.
          </div>
          {verificationUrl ? (
            <a
              data-testid="DeviceCodeFlow.url"
              {...(id ? { 'data-id': id } : {})}
              href={verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-block text-[11px] px-2.5 py-1 rounded-md bg-bg-tertiary hover:bg-bg-hover text-text-primary transition-colors break-all"
            >
              {verificationUrl} ↗
            </a>
          ) : (
            <div className="mt-1.5 text-[11px] text-text-muted">Requesting a code…</div>
          )}
        </div>
      </div>

      <div className="flex items-start gap-2.5">
        <div
          className="h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 bg-accent/15 text-accent"
          aria-hidden="true"
        >
          2
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium text-text-primary">Enter this code there</div>
          <div className="mt-1.5 flex items-center gap-2">
            <span
              data-testid="DeviceCodeFlow.code"
              {...(id ? { 'data-id': id } : {})}
              className="px-2.5 py-1.5 rounded-md bg-bg-input border border-border/40 font-mono text-[18px] tracking-[0.18em] text-text-primary select-all"
            >
              {userCode ?? '––––––'}
            </span>
            <button
              type="button"
              data-testid="DeviceCodeFlow.copy"
              {...(id ? { 'data-id': id } : {})}
              disabled={!ready || busy}
              onClick={copy}
              className="shrink-0 text-[11px] px-2.5 py-1 rounded-md bg-bg-tertiary hover:bg-bg-hover text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>

      <div
        data-testid="DeviceCodeFlow.waiting"
        {...(id ? { 'data-id': id } : {})}
        className="text-[11px] text-text-muted leading-relaxed"
      >
        Waiting for you to enter the code…
        {minutes !== undefined && (
          <span className="text-text-secondary"> Expires in {minutes} min.</span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="DeviceCodeFlow.cancel"
          {...(id ? { 'data-id': id } : {})}
          onClick={onCancel}
          className="text-[11px] text-text-muted hover:text-text-secondary underline underline-offset-2"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="DeviceCodeFlow.pasteInstead"
          {...(id ? { 'data-id': id } : {})}
          onClick={onPasteInstead}
          className="text-[11px] text-text-muted hover:text-text-secondary underline underline-offset-2"
        >
          Paste the callback URL instead
        </button>
      </div>
    </div>
  )
}
