/**
 * The app's ONE derived view of "what is wrong with a credential right now"
 * (ADR-070 §4).
 *
 * Before this, six surfaces each asked their own version of the question from
 * their own input — the yellow banner from `vendorAuth.anthropic`, the composer
 * hint from `providerAuth`, the transcript row from `session:auth-required`,
 * `FloatingError` from an engine-authored string — so one rejected credential
 * lit four of them and no two agreed on when to stop. There is one answer here
 * and the pill, the row and (Slice C) the dialog's list all read it.
 *
 * PURE and store-free, like `sign-in-provider.ts`: the caller passes the three
 * inputs in. That keeps it unit-testable without a store and, more importantly,
 * makes the memoisation the caller's problem to state explicitly — the pill
 * lives in the top bar, and a selector that rebuilt this object on every render
 * would re-render the bar on every streamed token.
 *
 * APP-WIDE, not per-session, and that is the point: a credential that died in a
 * background session is exactly the failure the old per-session surfaces never
 * reported.
 */
import type { EngineId } from '../../../shared/types'
import { engineMeta } from '../../../shared/engine-meta'
import type { AuthRequiredState } from '../../../shared/remote-protocol'
import type { ProviderAuthView } from '../utils/sign-in-provider'
import { isDrivableProvider } from '../utils/sign-in-provider'
import type { SignInProviderId } from './session-store'

/** `needed` = will fail (no usable credential); `expired` = has failed (a turn died). */
export type AuthIssueKind = 'needed' | 'expired'

/** A stopped prompt, and the session it has to be re-sent on. */
export interface AuthRetry {
  routingId: string
  prompt: string
}

/**
 * An owed retry as it appears on an APP-WIDE list, which has to say whose
 * credential stopped it.
 *
 * {@link AuthIssue.retry} needs no such field — it is reached through an issue
 * that already names the provider — and neither does `SignInRequest.retry`,
 * whose request names it. {@link AuthSummary.retryable} is the one list that
 * spans providers, and a consumer filtering it by provider (the dialog's done
 * state) cannot do that from `routingId` alone.
 *
 * A separate type rather than an optional field on `AuthRetry`, so "every
 * app-wide retry names its provider" is a compile-time guarantee instead of a
 * convention, and so the request shape the pill and the transcript row build
 * stays byte-identical (`AuthEntryPoints` pins that the two agree).
 */
export interface OwedRetry extends AuthRetry {
  /** `anthropic` | `chatgpt` | `opencode:<vendorId>` | `pi:<vendorId>`. */
  providerId: string
}

export interface AuthIssue {
  /** `anthropic` | `chatgpt` | `opencode:<vendorId>` | `pi:<vendorId>`. */
  providerId: string
  kind: AuthIssueKind
  /** Sessions whose `authRequired` blames this provider and is not yet resolved. */
  routingIds: string[]
  /** Sessions resolved but still owing a retry. */
  retryable: OwedRetry[]
  /**
   * What to hand the dialog as its retry target — the first still-broken session
   * that captured a prompt. Distinct from {@link AuthIssue.retryable}, which is
   * the retries already unblocked by a resolution.
   */
  retry?: AuthRetry
  /** The stored account the event blamed, when it named one. */
  accountId?: string
  /** Whether ClaudeUI can drive this provider's sign-in (anthropic | chatgpt). */
  drivable: boolean
  /** Engine labels this credential blocks, for the hover title. */
  blocks: string[]
}

/** What the pill shows. `'none'` = render nothing. */
export type AuthTone = 'none' | 'needed' | 'expired' | 'authorizing' | 'resolved'

export interface AuthSummary {
  issues: AuthIssue[]
  tone: AuthTone
  /**
   * Every owed retry in the app, whatever provider it belongs to — including one
   * whose provider no longer has an issue at all, which is the whole point of
   * lifetime 2 (the credential is good, the prompt is still un-sent) — and why
   * each entry names its provider.
   */
  retryable: OwedRetry[]
  /** Sessions a resolution has fixed, retry owed or not. */
  resolved: string[]
  /** The provider whose sign-in flow is alive, when one is. */
  authorizing: SignInProviderId | null
}

export interface AuthIssuesInput {
  /** The renderer's one view of "who is signed in" (`providerAuth`). */
  providerAuth: ProviderAuthView
  /** Every session whose `authRequired` is set, keyed by routingId. */
  blamed: Record<string, AuthRequiredState>
  /** A live flow: `authState.status === 'authorizing'` / a non-error `vendorOAuth`. */
  authorizing: { anthropic: boolean; chatgpt: boolean }
}

/** The two providers `providerAuth` can speak about, in the order it declares them. */
const DRIVABLE_PROVIDERS: readonly SignInProviderId[] = ['anthropic', 'chatgpt']

/**
 * Which engines stop working while this credential is refused.
 *
 * `chatgpt` is route-dependent and deliberately so (ADR-030): Codex runs on the
 * vault and nothing else, but pi and opencode only do while their shared-provider
 * route is enabled — with it off those engines are backed by their own auth
 * stores and a ChatGPT sign-in would not touch them. Claiming otherwise in a
 * tooltip is the kind of confident wrong answer that sends a user to the wrong
 * settings page.
 */
function blockedEngines(providerId: string, routes: Partial<Record<EngineId, boolean>>): string[] {
  if (providerId === 'anthropic') return [engineMeta('claude').label]
  if (providerId === 'chatgpt') {
    const blocked = [engineMeta('codex').label]
    for (const engineId of ['pi', 'opencode'] as const)
      if (routes[engineId]) blocked.push(engineMeta(engineId).label)
    return blocked
  }
  if (providerId.startsWith('opencode:')) return [engineMeta('opencode').label]
  if (providerId.startsWith('pi:')) return [engineMeta('pi').label]
  return []
}

interface Draft {
  routingIds: string[]
  retryable: OwedRetry[]
  retry?: AuthRetry
  accountId?: string
  /** A turn actually died on this provider — `expired` rather than `needed`. */
  failed: boolean
}

/**
 * Fold `providerAuth` and every session's `authRequired` into one answer.
 *
 * The rules, and each of them is load-bearing:
 *
 *  - `'unauthenticated'` with no failed session → `needed` (amber, "will fail").
 *  - any session with an unresolved `authRequired` → `expired` (red, "has failed").
 *  - **`'unknown'` contributes NOTHING.** An unprobed host is not a signed-out
 *    one, so a cold boot shows no pill — the old banner's boot-time false alarm
 *    is half of what ADR-070 was written to fix.
 *  - a live flow wins the TONE over both: something is already being done about
 *    it, and the pill is where that stays visible with the dialog closed.
 *  - a resolution with no remaining failure is `resolved`, and the pill makes
 *    that transient itself (it is good news, not a problem).
 *
 * Issue ORDER is drivable-first then providerId, so the pill's label and the
 * dialog's list name the same provider first and snapshots are stable.
 */
export function summarizeAuthIssues(input: AuthIssuesInput): AuthSummary {
  const drafts = new Map<string, Draft>()
  const draftFor = (providerId: string): Draft => {
    const existing = drafts.get(providerId)
    if (existing) return existing
    const fresh: Draft = { routingIds: [], retryable: [], failed: false }
    drafts.set(providerId, fresh)
    return fresh
  }

  // Proactive half: a provider whose credential is known to be missing.
  for (const providerId of DRIVABLE_PROVIDERS)
    if (input.providerAuth[providerId] === 'unauthenticated') draftFor(providerId)

  // Reactive half: every session an auth fact blames. The iteration order is
  // the `blamed` record's own insertion order — DETERMINISTIC, which is all
  // `retry`/`accountId` need to be stable across renders, but deliberately NOT
  // claimed to be age-ordered: the caller builds the record from the sessions
  // map, whose order is its own business.
  const retryable: OwedRetry[] = []
  const resolved: string[] = []
  for (const [routingId, state] of Object.entries(input.blamed)) {
    const draft = draftFor(state.providerId)
    if (state.resolved === true) {
      resolved.push(routingId)
      if (state.retryPrompt) {
        const owed: OwedRetry = {
          routingId,
          prompt: state.retryPrompt,
          providerId: state.providerId
        }
        draft.retryable.push(owed)
        retryable.push(owed)
      }
      continue
    }
    draft.failed = true
    draft.routingIds.push(routingId)
    if (!draft.retry && state.retryPrompt) draft.retry = { routingId, prompt: state.retryPrompt }
    if (!draft.accountId && state.accountId) draft.accountId = state.accountId
  }

  const issues: AuthIssue[] = []
  for (const [providerId, draft] of drafts) {
    const unauthenticated =
      isDrivableProvider(providerId) && input.providerAuth[providerId] === 'unauthenticated'
    // A provider that only appears here because a session of its was RESOLVED is
    // not an issue: its credential is fine and all that is left is the retry,
    // which rides on `retryable`. Counting it would make the pill say "2
    // sign-ins needed" when one of them is already done.
    if (!draft.failed && !unauthenticated) continue
    issues.push({
      providerId,
      kind: draft.failed ? 'expired' : 'needed',
      routingIds: draft.routingIds,
      retryable: draft.retryable,
      ...(draft.retry ? { retry: draft.retry } : {}),
      ...(draft.accountId ? { accountId: draft.accountId } : {}),
      drivable: isDrivableProvider(providerId),
      blocks: blockedEngines(providerId, input.providerAuth.chatgptRoutes)
    })
  }
  issues.sort((a, b) =>
    a.drivable === b.drivable ? a.providerId.localeCompare(b.providerId) : a.drivable ? -1 : 1
  )

  const authorizing = input.authorizing.anthropic
    ? 'anthropic'
    : input.authorizing.chatgpt
      ? 'chatgpt'
      : null

  const tone: AuthTone = authorizing
    ? 'authorizing'
    : issues.some((issue) => issue.kind === 'expired')
      ? 'expired'
      : issues.length > 0
        ? 'needed'
        : resolved.length > 0
          ? 'resolved'
          : 'none'

  return { issues, tone, retryable, resolved, authorizing }
}
