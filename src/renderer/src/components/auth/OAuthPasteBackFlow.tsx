/**
 * The ONE remote sign-in surface — ADR-057's paste-back flow (series S4-UI).
 *
 * The host never opens a browser for a REMOTE-initiated OAuth sign-in (that
 * browser would be on the wrong machine), so a remote client drives the flow in
 * two steps of its own:
 *
 *   1. open the authorize URL on THE CLIENT'S device (a real user gesture —
 *      `window.open` from the button below, never a host-side `openExternal`);
 *   2. paste back whatever the vendor handed over — the whole failed-redirect
 *      URL, a `?code=…&state=…` fragment, or a bare code.
 *
 * The pasted string is posted VERBATIM (trimmed only): the BACKEND owns the
 * URL-vs-code decision and the shape-dependent CSRF rule
 * (`parsePastedCallback` / `completeFromPastedInput` in
 * `core/auth/vault/codex-oauth.ts`). Pre-parsing here would fork that rule.
 *
 * Two variants, because two vendors return the code differently:
 *  - `url`  — Codex/opencode: the redirect lands on a dead `localhost:1455`
 *             page whose ADDRESS BAR holds the code (mockup state 2);
 *  - `code` — Claude: claude.ai displays the code on the page (mockup state 3).
 *
 * DESKTOP NEVER MOUNTS THIS. Every surface branches on
 * `window.api.platform === 'web'` and keeps its legacy auto-flow untouched —
 * the desktop opens the host browser and waits on the host loopback exactly as
 * before, which is why this component has no "waiting" state at all.
 *
 * Copy is the owner-approved mockup's, verbatim, with one deliberate change:
 * the mockup's "Opens on this phone" reads "Opens on this device" because the
 * web client is also served to laptops.
 */
import { useState } from 'react'

/** Which of the two paste shapes a vendor hands the user (see the module header). */
export type OAuthPasteBackVariant = 'url' | 'code'

/**
 * The outcome classes the mockup gives distinct copy to. `error` is the honest
 * fallback: an unrecognized backend message renders VERBATIM rather than being
 * flattened into a friendly lie.
 */
export type OAuthOutcomeKind = 'success' | 'state-mismatch' | 'desktop-only' | 'error'

/** Mockup state 4, state-mismatch row. */
export const STATE_MISMATCH_COPY =
  "That didn't match this sign-in attempt (state mismatch). Start again from step 1."
/** Mockup state 4, desktop-only row. */
export const DESKTOP_ONLY_COPY =
  "This provider's automatic flow only works on the desktop app. Use the desktop, or a vendor with a code method."

/**
 * Map a backend error message onto a mockup outcome.
 *
 * Both patterns are keyed to literals the backend actually throws, and
 * `OAuthPasteBackFlow.unit.test.tsx` pins them against those source files so a
 * reworded backend message fails a test instead of silently degrading to the
 * verbatim branch:
 *
 *  - state mismatch — `codex-oauth.ts`'s `'Invalid state - potential CSRF
 *    attack'` (both the loopback and the paste path throw it), plus cli.js's
 *    own wording for the Claude flow, which we have not pinned and match
 *    loosely;
 *  - desktop-only — `core/ipc/auth-commands.ts`'s refusal of opencode's `auto`
 *    method for a remote caller ("…only completes on the host machine…").
 *
 * Anything else is `error`, and the caller shows the message unchanged.
 */
export function classifyOAuthError(message: string): OAuthOutcomeKind {
  const text = message.toLowerCase()
  if (text.includes('invalid state') || text.includes('state mismatch') || text.includes('csrf')) {
    return 'state-mismatch'
  }
  if (text.includes('only completes on the host machine')) return 'desktop-only'
  return 'error'
}

/** Copy for a classified outcome; `error` keeps the backend's own words. */
export function oauthOutcomeCopy(kind: OAuthOutcomeKind, message: string): string {
  if (kind === 'state-mismatch') return STATE_MISMATCH_COPY
  if (kind === 'desktop-only') return DESKTOP_ONLY_COPY
  return message
}

/**
 * Mockup state 4 — one outcome row. Rendered inside the flow when a submit
 * fails, and STANDALONE by surfaces whose failure happens before any flow
 * exists (opencode's remote-`auto` refusal is thrown by `oauth-authorize`, so
 * there is no paste field to attach it to).
 */
export function OAuthOutcomeNotice({
  kind,
  message,
  id
}: {
  kind: OAuthOutcomeKind
  /** Raw backend text for `error`; ignored for the two classified kinds. */
  message?: string
  id?: string
}): React.JSX.Element {
  const tone =
    kind === 'success'
      ? 'border-success/25 bg-success/5 text-success'
      : kind === 'state-mismatch' || kind === 'error'
        ? 'border-danger/25 bg-danger/5 text-danger'
        : 'border-border bg-bg-tertiary/40 text-text-muted'
  return (
    <div
      data-testid="OAuthOutcomeNotice"
      data-kind={kind}
      {...(id ? { 'data-id': id } : {})}
      className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${tone}`}
    >
      {oauthOutcomeCopy(kind, message ?? '')}
    </div>
  )
}

export interface OAuthPasteBackFlowProps {
  variant: OAuthPasteBackVariant
  /**
   * Authorize URL for step 1. Absent means the host started a flow but handed
   * back no URL — step 1 says so rather than opening `about:blank`.
   */
  url?: string
  /** Discriminator when several instances can be on screen (ADR-027 `data-id`). */
  id?: string
  /** Backend error from the LAST submit (verbatim); drives the outcome row. */
  error?: string | null
  /** A submit is in flight — the field and both buttons lock. */
  busy?: boolean
  /** Receives the pasted string TRIMMED and otherwise verbatim. */
  onSubmit: (pasted: string) => void
  /** Omitted → no Cancel affordance (a surface that owns its own dismiss). */
  onCancel?: () => void
}

/**
 * Mockup states 2/3 (+ the state-4 row on failure). Stateless about the flow
 * itself: the store owns `authState` / `vendorOAuth`, this owns only the text
 * the user is currently typing.
 */
export function OAuthPasteBackFlow({
  variant,
  url,
  id,
  error,
  busy = false,
  onSubmit,
  onCancel
}: OAuthPasteBackFlowProps): React.JSX.Element {
  const [pasted, setPasted] = useState('')
  const trimmed = pasted.trim()
  // Claude's flow is the app's amber "you are signed out" area; the vendor
  // flows are the ordinary accent. Matches the mockup's sky/amber split.
  const tone = variant === 'code' ? 'warning' : 'accent'
  const badge = tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-accent/15 text-accent'
  const submitClass =
    tone === 'warning'
      ? 'bg-warning/80 hover:bg-warning text-bg-primary'
      : 'bg-accent/80 hover:bg-accent text-bg-primary'

  const submit = (): void => {
    if (!trimmed || busy) return
    onSubmit(trimmed)
  }

  return (
    <div
      data-testid="OAuthPasteBackFlow"
      data-variant={variant}
      {...(id ? { 'data-id': id } : {})}
      className="space-y-3"
    >
      <div className="flex items-start gap-2.5">
        <div
          className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${badge}`}
          aria-hidden="true"
        >
          1
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium text-text-primary">Sign in with your browser</div>
          <div className="text-[11px] text-text-muted mt-0.5 leading-relaxed">
            Opens on this device. Finish the sign-in there, then come back.
          </div>
          <button
            data-testid="OAuthPasteBackFlow.open"
            {...(id ? { 'data-id': id } : {})}
            disabled={!url || busy}
            // A CLIENT-side open, from a real user gesture — the host must never
            // openExternal for a remote caller (ADR-057). `noopener` because the
            // vendor page has no business holding a handle on this one.
            onClick={() => {
              if (url) window.open(url, '_blank', 'noopener,noreferrer')
            }}
            className="mt-1.5 text-[11px] px-2.5 py-1 rounded-md bg-bg-tertiary hover:bg-bg-hover text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Open sign-in page ↗
          </button>
          {!url && (
            <div className="mt-1 text-[10px] text-text-muted/70">
              The host did not return a sign-in link. Start again.
            </div>
          )}
        </div>
      </div>

      <div className="flex items-start gap-2.5">
        <div
          className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${badge}`}
          aria-hidden="true"
        >
          2
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium text-text-primary">
            {variant === 'code' ? 'Paste the code claude.ai shows you' : 'Paste what you got back'}
          </div>
          {variant === 'url' && (
            <div className="text-[11px] text-text-muted mt-0.5 leading-relaxed">
              After sign-in you&rsquo;ll land on a page that{' '}
              <span className="text-text-secondary">fails to load</span> — that&rsquo;s expected.
              Copy its <span className="text-text-secondary">address</span> from the address bar and
              paste it here. A code works too.
            </div>
          )}
          <div className="mt-1.5 flex gap-1.5">
            <input
              data-testid="OAuthPasteBackFlow.input"
              {...(id ? { 'data-id': id } : {})}
              type="text"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder={
                variant === 'code'
                  ? 'Paste authorization code'
                  : 'http://localhost:1455/auth/callback?code=… or the code'
              }
              className="flex-1 min-w-0 px-2 py-1.5 text-[11px] font-mono rounded-md bg-bg-input border border-border/40 text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent/60 disabled:opacity-50"
            />
            <button
              data-testid="OAuthPasteBackFlow.submit"
              {...(id ? { 'data-id': id } : {})}
              onClick={submit}
              disabled={!trimmed || busy}
              className={`shrink-0 text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${submitClass}`}
            >
              {busy ? 'Finishing…' : 'Finish'}
            </button>
          </div>
        </div>
      </div>

      {error && <OAuthOutcomeNotice kind={classifyOAuthError(error)} message={error} id={id} />}

      {onCancel && (
        <button
          data-testid="OAuthPasteBackFlow.cancel"
          {...(id ? { 'data-id': id } : {})}
          onClick={onCancel}
          className="text-[11px] text-text-muted hover:text-text-secondary underline underline-offset-2"
        >
          Cancel
        </button>
      )}
    </div>
  )
}
