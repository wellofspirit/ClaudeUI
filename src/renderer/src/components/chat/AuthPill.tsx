import { useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { AUTH_ISSUE_NAME, authIssueLabel } from '../../stores/auth-issues'
import type { AuthSummary, AuthTone } from '../../stores/auth-issues'
import { useAuthSummary } from '../../stores/use-auth-summary'
import { isDrivableProvider, providerDisplayName } from '../../utils/sign-in-provider'
import { useSidebarCollapsed } from '../SessionView'

/** The green "Signed in" pill is good news, not a problem — it retires itself. */
const RESOLVED_LINGER_MS = 15_000

/**
 * Settings › Models & providers, the app-wide deep-link channel (`{ page,
 * group }`). The one answer for a credential ClaudeUI cannot drive a flow for
 * (ADR-030): an engine-native `opencode:*` / `pi:*` token lives in that
 * engine's own store, so a dialog here would have nothing to run.
 *
 * Exported because the dialog's provider-LIST mode offers the same escape for
 * the same rows, and the two must not drift into sending the user to different
 * pages.
 */
export function openProviderSettings(): void {
  window.dispatchEvent(
    new CustomEvent('open-settings', { detail: { page: 'models', group: 'providers' } })
  )
}

/**
 * The pill's SLOT: a shrinkable, clipping box holding nothing but the pill,
 * sitting in `TopBar`'s left group after the title.
 *
 * It is the whole of the geometric fix (see `src/layout/TopBar.layout.test.tsx`
 * for the measurements). `min-w-0` + `overflow-hidden` make "the pill never
 * paints outside its group" a guarantee rather than an arithmetic hope — a
 * `shrink-0` pill in a squeezed group painted over the VS Code button, and the
 * overlapped slice stopped being clickable because the button comes later in
 * DOM order. On desktop the slot also gets `flex-1` (it takes the width the
 * title leaves) and `@container`, so the pill's form below is a question about
 * AVAILABLE width — the answer has to change when the sidebar collapses, which
 * moves the group by ~276px without touching the window size.
 */
const SLOT = 'min-w-0 overflow-hidden flex items-center'

/**
 * The compact form, reached when the slot cannot hold the full label.
 *
 * 140px is the threshold, against a widest label of ~123px measured in
 * Chromium ("2 sign-ins needed"); the headroom covers the other platforms'
 * system fonts. The layout test asserts at every width that the pill is never
 * CUT OFF, so a label that outgrows this number fails there rather than
 * shipping as "Sign-in nee…". Written out literally because Tailwind extracts
 * class names from source text — a composed string would generate no CSS.
 */
const COMPACT =
  '@max-[140px]:gap-0 @max-[140px]:w-[22px] @max-[140px]:h-[22px] @max-[140px]:px-0 @max-[140px]:justify-center @max-[140px]:text-[10px] @max-[140px]:font-semibold ' +
  // Backstop for a bar so narrow that not even the compact form fits: show
  // nothing rather than a dot sliced in half. `TopBar` reserves 34px for the
  // slot, so reaching this means the left group could not even hold the
  // title's own floor — the bar has overflowed its window and everything in it
  // is degenerate. A clipped pill would be the one thing here that is
  // ambiguous rather than merely cramped.
  '@max-[23px]:hidden'

const TONE_CLASS: Record<Exclude<AuthTone, 'none'>, string> = {
  needed: 'border-warning/50 bg-warning/10 text-warning',
  expired: 'border-danger/50 bg-danger/10 text-danger',
  authorizing: 'border-accent/50 bg-accent/10 text-accent',
  resolved: 'border-success/50 bg-success/10 text-success'
}

const DOT_CLASS: Record<Exclude<AuthTone, 'none'>, string> = {
  needed: 'bg-warning',
  expired: 'bg-danger',
  authorizing: 'bg-accent animate-pulse',
  resolved: 'bg-success'
}

/** What the pill says. The count only appears once more than one provider is down. */
function pillLabel(summary: AuthSummary): string {
  const count = summary.issues.length
  switch (summary.tone) {
    case 'authorizing':
      return 'Signing in…'
    case 'resolved':
      return summary.retryable.length > 0 ? 'Signed in · Retry' : 'Signed in'
    // One issue: the state's own name, the same words the hover and the
    // dialog's list use. Several: the aggregate, which is about the count
    // rather than the kinds.
    case 'expired':
      return count > 1 ? `${count} sign-ins needed` : authIssueLabel('expired')
    default:
      return count > 1 ? `${count} sign-ins needed` : authIssueLabel('needed')
  }
}

/** Provider, what it blocks, and how many prompts it stopped (mockup tab 3). */
function pillTitle(summary: AuthSummary): string {
  if (summary.tone === 'authorizing' && summary.authorizing)
    return `${providerDisplayName(summary.authorizing)} — signing in\nClick to reopen the sign-in`
  if (summary.tone === 'resolved') {
    const owed = summary.retryable.length
    return owed > 0
      ? `Signed in · ${owed} stopped ${owed === 1 ? 'prompt' : 'prompts'}\nClick to retry`
      : 'Signed in'
  }
  const lines = summary.issues.map((issue) => {
    const parts = [`${providerDisplayName(issue.providerId)} — ${AUTH_ISSUE_NAME[issue.kind]}`]
    if (issue.blocks.length > 0) parts.push(`Blocks ${issue.blocks.join(', ')}`)
    const stopped = issue.routingIds.length
    if (stopped > 0) parts.push(`${stopped} ${stopped === 1 ? 'prompt' : 'prompts'} stopped`)
    return parts.join(' · ')
  })
  const drivable = summary.issues.some((issue) => issue.drivable)
  lines.push(drivable ? 'Click to sign in' : 'Click to open provider settings')
  return lines.join('\n')
}

/**
 * The app's ONE auth indicator, in `TopBar`'s LEFT group right after
 * `TopBar.info` (ADR-070 §4).
 *
 * It replaces three surfaces — the yellow `AuthBanner`, the floating
 * `AuthRequiredRow` and the composer's `InputBox.signInHint` — with one pill
 * that exists only while something is wrong, so it never permanently costs the
 * title its space. LEFT rather than right because the right cluster is already
 * five icons plus branch plus dirty-state plus window controls, because the pill
 * is a property of *this session's* engine (which is what the title names) and
 * on the right would read as another tool button, and because left-of-centre is
 * in the reading path from the transcript row.
 *
 * APP-WIDE. It deliberately does NOT read the active session: a credential that
 * died in a background session went unreported by every surface it replaces, and
 * that is one of the bugs ADR-070 exists to fix.
 */

export function AuthPill(): React.JSX.Element | null {
  const summary = useAuthSummary()
  const { isMobile: isMobileCtx } = useSidebarCollapsed()
  const openSignIn = useSessionStore((s) => s.openSignIn)
  const retrySend = useSessionStore((s) => s.retrySend)
  const clearAuthRequired = useSessionStore((s) => s.clearAuthRequired)
  const [retired, setRetired] = useState(false)

  // Transient only when nothing is owed: a pill offering a Retry has to wait for
  // the user, so it persists (ADR-070 §4). Keyed on the resolved set so a second
  // resolution shows a second pill rather than inheriting the first's timer.
  const transient = summary.tone === 'resolved' && summary.retryable.length === 0
  const resolvedKey = summary.resolved.join(',')
  useEffect(() => {
    if (!transient) {
      setRetired(false)
      return
    }
    setRetired(false)
    const timer = setTimeout(() => setRetired(true), RESOLVED_LINGER_MS)
    return () => clearTimeout(timer)
  }, [transient, resolvedKey])

  if (summary.tone === 'none' || retired) return null
  const tone = summary.tone

  const act = (): void => {
    if (tone === 'resolved') {
      const owed = summary.retryable[0]
      if (!owed) return setRetired(true)
      void retrySend(owed.routingId, owed.prompt)
      clearAuthRequired(owed.routingId)
      return
    }
    // A running flow's pill reopens the dialog it was started from — the fact
    // today's banner had to stay visible for.
    if (summary.authorizing) {
      openSignIn({ providerId: summary.authorizing, mode: 'reauth' })
      return
    }
    // Several providers are down and the pill aggregates them, so it has no
    // single sign-in to offer: the dialog's provider-LIST mode (ADR-070 §5) is
    // the one that can name them all. It reads the same `useAuthSummary`, so
    // the list cannot disagree with the pill that opened it.
    if (summary.issues.length > 1) {
      openSignIn({ kind: 'list' })
      return
    }
    const target = summary.issues.find((issue) => issue.drivable) ?? summary.issues[0]
    if (!target) return
    if (!isDrivableProvider(target.providerId)) return openProviderSettings()
    openSignIn({
      providerId: target.providerId,
      mode: 'reauth',
      ...(target.accountId ? { accountId: target.accountId } : {}),
      ...(target.retry ? { retry: target.retry } : {})
    })
  }

  const count = summary.issues.length
  const shared = {
    type: 'button' as const,
    'data-testid': 'AuthPill',
    'data-tone': tone,
    ...(count > 1 ? { 'data-count': count } : {}),
    onClick: act,
    title: pillTitle(summary)
  }

  const glyph =
    tone === 'resolved' ? (
      <span aria-hidden="true">✓</span>
    ) : (
      <span className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[tone]}`} />
    )

  // Mobile: a bare dot with a count. The bar is genuinely tight at 390px — the
  // title has to keep truncating and the overflow menu has to stay on screen.
  if (isMobileCtx)
    return (
      <div data-testid="AuthPill.slot" className={`${SLOT} ml-1.5`}>
        <button
          {...shared}
          className={`shrink-0 w-[22px] h-[22px] inline-flex items-center justify-center rounded-full border text-[10px] font-semibold [-webkit-app-region:no-drag] cursor-default ${TONE_CLASS[tone]}`}
        >
          {count > 0 ? count : <span className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[tone]}`} />}
        </button>
      </div>
    )

  return (
    <div data-testid="AuthPill.slot" className={`${SLOT} @container ml-2 flex-1`}>
      <button
        {...shared}
        className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11px] font-medium ${COMPACT} [-webkit-app-region:no-drag] cursor-default ${TONE_CLASS[tone]}`}
      >
        {/* The count REPLACES the dot in the compact form — it is the part that
            has to survive (ADR-070 §4), and it is what the mobile pill shows. */}
        <span className={count > 0 ? '@max-[140px]:hidden' : ''}>{glyph}</span>
        <span data-testid="AuthPill.label" className="@max-[140px]:hidden">
          {pillLabel(summary)}
        </span>
        {count > 0 && (
          <span data-testid="AuthPill.count" className="hidden @max-[140px]:inline">
            {count}
          </span>
        )}
      </button>
    </div>
  )
}
