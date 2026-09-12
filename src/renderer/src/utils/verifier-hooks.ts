/**
 * `window.__claudeuiVerifier` — the real-app harness's read handle on renderer
 * state (see `src/shared/verifier-hooks.ts` for the opt-in and why it is off by
 * default).
 *
 * ADR-027 made the DOM structurally assertable; `scripts/app-shot.mjs` can dump
 * the `data-testid` inventory and click through it. What it could not do is tell
 * apart "the store never got the message" from "the store has it and the view
 * didn't render it" — the two halves of a dropped-assistant-turn bug look
 * identical from outside. The handle exposes both sides: the Zustand store the
 * components read, and the replica's canonical state the store is a projection
 * of. When they disagree, the projection is the suspect; when they agree and the
 * DOM does not, the component is.
 *
 * Read-only by intent. It hands out the live store/canonical objects (a
 * defensive deep clone would hide exactly the identity-sharing the replica's
 * diffing depends on), so `page.evaluate` can read anything — but nothing here
 * offers a mutator, and the flag that installs it is opt-in per launch.
 */

import { useSessionStore } from '../stores/session-store'
import { getReplicaState } from '../stores/replica'

/** One session's line in {@link VerifierSnapshot} — store side. */
export interface VerifierSessionSummary {
  id: string
  /** `messages.length` — what the transcript view should be rendering. Named a
   *  count, not `messages`, because it is one: this is a summary, and the sealed
   *  -field lint brand rightly objects to a `sessions[].messages` that isn't. */
  messageCount: number
  /** Message counts by role, so a missing assistant turn is visible at a glance. */
  roles: Record<string, number>
  /** `status.state`: idle | running | error | disconnected. */
  state: string
}

/** The JSON-safe summary `--state` prints. Deliberately small: a full store dump
 *  is megabytes of transcript and unreadable in a harness log. */
export interface VerifierSnapshot {
  activeSessionId: string | null
  sessions: VerifierSessionSummary[]
  /** The replica's canonical copy — the authority the store projects from. A
   *  message count that differs from the store line above IS the bug. */
  canonical: {
    /**
     * NOT a bug when it differs from the store's: selection is resolved
     * client-locally (ADR-041, `replica.ts`'s `resolveActiveSessionId`), so canonical
     * carries what the last hydration decided, not what the user just clicked.
     * Only the message counts are meant to match.
     */
    activeSessionId: string | null
    sessions: Array<{ id: string; messageCount: number }>
  }
}

export interface VerifierHandle {
  /** The live Zustand store: `.getState()`, `.subscribe()`. */
  sessionStore: typeof useSessionStore
  /** The replica's current `CanonicalState`. */
  canonical: typeof getReplicaState
  snapshot: () => VerifierSnapshot
}

function countRoles(messages: ReadonlyArray<{ role: string }>): Record<string, number> {
  const roles: Record<string, number> = {}
  for (const m of messages) roles[m.role] = (roles[m.role] ?? 0) + 1
  return roles
}

/** Build the summary. Exported for tests; production calls it through the handle. */
export function buildVerifierSnapshot(): VerifierSnapshot {
  const store = useSessionStore.getState()
  const canonical = getReplicaState()
  return {
    activeSessionId: store.activeSessionId,
    sessions: Object.entries(store.sessions).map(([id, s]) => ({
      id,
      messageCount: s.messages.length,
      roles: countRoles(s.messages),
      state: s.status.state
    })),
    canonical: {
      activeSessionId: canonical.activeSessionId,
      sessions: Object.entries(canonical.sessions).map(([id, s]) => ({
        id,
        messageCount: s.messages.length
      }))
    }
  }
}

/**
 * Install the handle IF this launch opted in, and report whether it did.
 *
 * The gate is read from `window.api` rather than from `process.env`: the renderer
 * has no env, and the preload is the one process that has already resolved both
 * the env var and the forwarded CLI switch. `=== true` and not a truthiness test
 * — the web adapter returns a literal `false`, and a stale cached bundle whose
 * `api` predates the field must read as "off", not as "undefined is falsy, close
 * enough".
 */
export function installVerifierHooks(target: Window = window): boolean {
  if (target.api?.verifierHooks !== true) return false
  target.__claudeuiVerifier = {
    sessionStore: useSessionStore,
    canonical: getReplicaState,
    snapshot: buildVerifierSnapshot
  }
  return true
}
