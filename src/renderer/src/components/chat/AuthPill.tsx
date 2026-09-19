import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AuthRequiredState } from '../../../../shared/remote-protocol'
import { useSessionStore, type SessionState } from '../../stores/session-store'
import { summarizeAuthIssues, type AuthSummary, type AuthTone } from '../../stores/auth-issues'
import { isDrivableProvider, providerDisplayName } from '../../utils/sign-in-provider'
import { useSidebarCollapsed } from '../SessionView'

/** The green "Signed in" pill is good news, not a problem — it retires itself. */
const RESOLVED_LINGER_MS = 15_000

/**
 * Every session whose `authRequired` is set, keyed by routingId.
 *
 * Shaped as a RECORD on purpose: `useShallow` compares its values with
 * `Object.is`, and `authRequired` objects are reducer-owned and only re-minted
 * when the fact changes, so the RESULT is stable across every token of every
 * stream and the top bar does not re-render on one. Returning tuples or
 * freshly-built objects here would defeat that and re-render the bar
 * continuously — the mistake this comment exists to prevent.
 *
 * It is the result that is stable, not the work: the walk itself runs on every
 * store update, so it allocates one small record per update. Accepted
 * deliberately — sessions are tens, not thousands, and the allocation is a cost
 * paid off the render path, whereas a re-render of the whole bar is not.
 */
function blamedSessions(state: SessionState): Record<string, AuthRequiredState> {
  const blamed: Record<string, AuthRequiredState> = {}
  for (const [routingId, session] of Object.entries(state.sessions))
    if (session.authRequired) blamed[routingId] = session.authRequired
  return blamed
}

/** The app-wide auth answer, memoised on inputs that are stable between facts. */
export function useAuthSummary(): AuthSummary {
  const providerAuth = useSessionStore((s) => s.providerAuth)
  const blamed = useSessionStore(useShallow(blamedSessions))
  const anthropicAuthorizing = useSessionStore((s) => s.authState?.status === 'authorizing')
  // A `vendorOAuth` parked at `error` is a FAILED flow, not a running one — it
  // lingers until the dialog is reopened or cancelled, and calling that "Signing
  // in…" forever is precisely the stale-state bug this pill replaces.
  const chatgptAuthorizing = useSessionStore(
    (s) => s.vendorOAuth !== null && s.vendorOAuth.stage !== 'error'
  )
  return useMemo(
    () =>
      summarizeAuthIssues({
        providerAuth,
        blamed,
        authorizing: { anthropic: anthropicAuthorizing, chatgpt: chatgptAuthorizing }
      }),
    [providerAuth, blamed, anthropicAuthorizing, chatgptAuthorizing]
  )
}

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
    case 'expired':
      return count > 1 ? `${count} sign-ins needed` : 'Sign-in expired'
    default:
      return count > 1 ? `${count} sign-ins needed` : 'Sign-in needed'
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
    const state = issue.kind === 'expired' ? 'sign-in expired' : 'sign-in needed'
    const parts = [`${providerDisplayName(issue.providerId)} — ${state}`]
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

  const openProviderSettings = (): void => {
    window.dispatchEvent(
      new CustomEvent('open-settings', { detail: { page: 'models', group: 'providers' } })
    )
  }

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
    // TODO(ADR-070 Slice C): with several issues this should open the dialog in
    // provider-LIST mode, which Slice C adds. Until then it opens on the first
    // drivable issue rather than growing a second dialog here.
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

  // Mobile: a bare dot with a count. The bar is genuinely tight at 390px — the
  // title has to keep truncating and the overflow menu has to stay on screen.
  if (isMobileCtx)
    return (
      <button
        {...shared}
        className={`ml-1.5 shrink-0 w-[22px] h-[22px] inline-flex items-center justify-center rounded-full border text-[10px] font-semibold [-webkit-app-region:no-drag] cursor-default ${TONE_CLASS[tone]}`}
      >
        {count > 0 ? count : <span className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[tone]}`} />}
      </button>
    )

  return (
    <button
      {...shared}
      className={`ml-2 shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11px] font-medium [-webkit-app-region:no-drag] cursor-default ${TONE_CLASS[tone]}`}
    >
      {tone === 'resolved' ? (
        <span aria-hidden="true">✓</span>
      ) : (
        <span className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[tone]}`} />
      )}
      {pillLabel(summary)}
    </button>
  )
}
