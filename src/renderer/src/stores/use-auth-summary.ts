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
