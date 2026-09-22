/**
 * The store-bound half of ADR-070 §4's one auth answer — `summarizeAuthIssues`
 * wired to the session store, with the memoisation that selector deliberately
 * left to its caller.
 *
 * It lives HERE rather than in `AuthPill.tsx` (Slice B's original home) because
 * Slice C's provider-list dialog reads the same answer, and `AuthPill` imports
 * `SessionView`'s sidebar context while `SessionView` imports `SignInDialog` —
 * so a dialog that imported the hook from the pill would close an import cycle
 * through three modules. `auth-issues.ts` itself stays PURE and store-free, as
 * its own header requires; this is the one adapter between it and the store.
 */
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AuthRequiredState } from '../../../shared/remote-protocol'
import { engineMeta } from '../../../shared/engine-meta'
import { signInProviderFor } from '../utils/sign-in-provider'
import { useSessionStore, type SessionState } from './session-store'
import { summarizeAuthIssues, type AuthSummary } from './auth-issues'

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

/**
 * Which drivable providers some OPEN session actually routes to, as a SORTED
 * JOINED STRING.
 *
 * The scope of the proactive half (`AuthIssuesInput.inUse`): the vault answers
 * `'unauthenticated'` for an empty store, so without it a Claude-only install
 * carried a permanent amber "Blocks Codex" pill. The rule is
 * {@link signInProviderFor} — the SAME one that scoped the deleted composer
 * hint to the engine it was about to spawn — applied to every session rather
 * than to the active one, because the pill is app-wide.
 *
 * A string, not a Set, for the reason `blamedSessions` above is a record: the
 * selector runs on every store update and `Object.is` on a freshly-built Set
 * is always false, so returning one would re-render the top bar on every
 * streamed token. The Set is memoised from this key by the hook.
 *
 * Vendor from the engine's REPORTED model when it has one, else decoded from
 * the picker value; an empty value leaves it `undefined`, which
 * `signInProviderFor` resolves to the engine's `defaultVendorId` — the same
 * fallback a model list with no vendor tracking already takes.
 */
function inUseKey(state: SessionState): string {
  const providers = new Set<string>()
  for (const session of Object.values(state.sessions)) {
    const engineId = session.selectedEngineId
    const vendorId =
      session.status.model?.vendorId ??
      (session.selectedModel
        ? engineMeta(engineId).decodeModelValue(session.selectedModel).vendorId
        : undefined)
    const resolved = signInProviderFor(engineId, vendorId, state.providerAuth)
    if (resolved) providers.add(resolved.providerId)
  }
  return [...providers].sort().join(',')
}

/** The app-wide auth answer, memoised on inputs that are stable between facts. */
export function useAuthSummary(): AuthSummary {
  const providerAuth = useSessionStore((s) => s.providerAuth)
  const blamed = useSessionStore(useShallow(blamedSessions))
  const inUseProviders = useSessionStore(inUseKey)
  const inUse = useMemo(
    () => new Set(inUseProviders ? inUseProviders.split(',') : []),
    [inUseProviders]
  )
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
        inUse,
        authorizing: { anthropic: anthropicAuthorizing, chatgpt: chatgptAuthorizing }
      }),
    [providerAuth, blamed, inUse, anthropicAuthorizing, chatgptAuthorizing]
  )
}
