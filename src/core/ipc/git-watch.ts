/**
 * `git:watch` — the git poller's per-connection interest verb (SyncCore phase 5 S2).
 *
 * ONE declaration, spread by both transport registrars (`session.ipc.ts` for the
 * desktop, `remote-handlers.ts` for the WebSocket), so the two surfaces cannot
 * drift about its capability, kind or shape — the same pattern `stream:watch`
 * uses, and for the same reason.
 *
 * **It replaces `git:start-watching` / `git:stop-watching`.** Those were a
 * refcounted pair against a COLLECTIVE owner id (`'desktop'` / `'remote'`),
 * because the pre-registry dispatcher gave handlers no client identity. A replace
 * set keyed by the real connection is strictly better: it is idempotent, it cannot
 * leak a count when a tab closes without running its cleanup, and it dies with the
 * socket like every other authority a connection holds. ADR-052 named this
 * workaround as the thing per-client subscriptions retire.
 *
 * **`git`, `query` — unchanged from what git reads already require.** Both retired
 * channels declared exactly this, and `git:status-update` itself is a `replicated`
 * event every authenticated connection already receives. Nothing about the
 * authority to read a working tree changed, so security.md needs no amendment.
 *
 * The wire event is deliberately untouched: `git:status-update` stays a ringed,
 * replicated broadcast. It is small and infrequent — it was never the ring poison
 * — and narrowing it would buy nothing while costing every client its catchup.
 */

import { gitWatchRegistry, MAX_GIT_WATCH } from '../services/git-watch-registry'
import type { CommandConnection, CommandRegistration } from './command-registry'

/**
 * Replace this connection's set of watched cwds.
 *
 * REPLACE, never additive: the client sends the set it wants and never has to
 * remember what it asked for last. Re-sending an unchanged set is not a no-op at
 * the registry — it re-delivers the cached status, which is what keeps a reloaded
 * renderer (same connection id, empty store) from waiting for the next working-tree
 * change before its git pill renders.
 */
export function handleGitWatch(
  connection: CommandConnection,
  payload: { cwds?: unknown } | undefined
): void {
  const raw = payload?.cwds
  if (!Array.isArray(raw)) {
    throw new Error('git:watch: cwds must be an array')
  }
  // Bounded for the same reason `stream:watch` is, with an extra cost per entry:
  // every watched cwd is a `git status` every 5 seconds on the main process.
  // REFUSED rather than truncated — a silently-clipped set would leave the client
  // believing it is watching directories it is not.
  if (raw.length > MAX_GIT_WATCH) {
    throw new Error(`git:watch: at most ${MAX_GIT_WATCH} directories may be watched at once`)
  }
  const cwds = raw.filter((cwd): cwd is string => typeof cwd === 'string' && cwd !== '')
  if (cwds.length !== raw.length) {
    throw new Error('git:watch: cwds must be non-empty strings')
  }
  gitWatchRegistry.setWatch(connection.connectionId, cwds)
}

/** The transport-agnostic half of the registration. */
export const GIT_WATCH_COMMAND: Omit<CommandRegistration, 'transport'> = {
  channel: 'git:watch',
  capability: 'git',
  kind: 'query',
  withConnection: true,
  handler: handleGitWatch
}
