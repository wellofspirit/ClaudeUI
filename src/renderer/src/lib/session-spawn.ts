/**
 * The one place the renderer spawns an engine for a session: every "lazy create" (first send,
 * voice, review comments, retry after sign-in, restart after an effort change, plan accepted)
 * goes through {@link spawnSession}, so the steps cannot drift between them. A guard spec fails
 * on any other `window.api.createSession` call under `src/renderer/src`.
 */
import { catalogFor, sessionSpawnEffort, spawnAnnouncement } from './session-effort'
import { awaitReloadBeforeSpawn } from './session-history-load'
import { createPendingWorktree, WorktreeCreateError } from './worktree-start'
import { resolveRekeyed } from '../stores/replica'
import {
  hasResumableTranscript,
  useSessionStore,
  type PerSessionState
} from '../stores/session-store'
import {
  modelDefaultThinkingMode,
  modelResolveThinkingMode,
  type ThinkingMode
} from '../../../shared/model-capabilities'
import type { SessionConfig, SessionSpawnRequest } from '../../../shared/types/session-config'

export interface SpawnSessionOptions {
  /**
   * What the new process continues. `'auto'` (default): the fork's source while the session's
   * fork has not materialised; else its own id when it holds a resumable transcript or its
   * engine resumes by id without one; else a new session. `'self'`: always its own id (restart).
   * `'none'`: a new session (plan accepted).
   */
  resume?: 'auto' | 'self' | 'none'
  /** Overrides the session's permission mode. */
  permissionMode?: string
  /**
   * The session as it was before something blanked its picks (the plan card clears the
   * conversation first): the config, cwd and engine resolve from it, not from the store.
   */
  from?: PerSessionState
}

/**
 * Engines that resume a session by id with no local transcript: opencode replays history from
 * its server, and verifies the id (falling back to a new session) when it spawns.
 */
function resumesWithoutTranscript(engineId: string | undefined): boolean {
  return engineId === 'opencode'
}

/**
 * Refuse to spawn with an EMPTY model.
 *
 * An empty `selectedModel` only happens when the user's configured default
 * named a model that is gone (the store seeds `''` and banners it rather than
 * substituting). Passing that through would hand the spawn resolver
 * `undefined`, which for pi means "use pi's own default" — the silent
 * substitute this whole path exists to prevent. An unconfigured Claude seeds
 * its `'default'` alias, a real value, and never trips this.
 */
function assertModelResolved(session: PerSessionState | undefined): void {
  const engineId = session?.selectedEngineId ?? 'claude'
  if (session?.selectedModel) return
  // Claude's `'default'` alias is always a real value — EXCEPT when the user
  // configured a Claude default the account no longer offers, which seeds ''
  // (ADR-074 §8). Spawning that would let cli.js pick its own model: the
  // silent substitute ADR-059 forbids. Unconfigured, Claude passes as before.
  if (engineId === 'claude' && !useSessionStore.getState().claudeDefaultModelConfigured) return
  throw new Error(
    `No model selected for this ${engineId} session — the configured default model is no longer available. Pick one in the model picker.`
  )
}

/**
 * The effort + thinking values to send for a session. Falls back to the model's default when
 * the user hasn't explicitly picked a value (store value is `null`), and coerces any
 * unsupported user choice against the current model's capabilities. Effort precedence
 * (explicit pick > Claude's per-model starting effort > cli.js heuristic, clamped to the
 * model): `sessionSpawnEffort`, the SAME function the pill reads.
 */
export function resolveSessionSdkOptions(session: PerSessionState | undefined): {
  effort?: string
  thinkingMode?: ThinkingMode
  model?: string
} {
  const state = useSessionStore.getState()
  const { modelInfo } = catalogFor(state, {
    selectedModel: session?.selectedModel ?? '',
    selectedEngineId: session?.selectedEngineId ?? 'claude'
  })
  const desiredThinking: ThinkingMode = session?.thinkingMode ?? modelDefaultThinkingMode(modelInfo)
  return {
    model: session?.selectedModel,
    effort: session ? sessionSpawnEffort(state, session) : undefined,
    thinkingMode: modelResolveThinkingMode(modelInfo, desiredThinking)
  }
}

function resumeOf(
  session: PerSessionState | undefined,
  routingId: string,
  mode: 'auto' | 'self' | 'none'
): SessionSpawnRequest['resume'] {
  if (mode === 'none') return undefined
  if (mode === 'self') return { sessionId: routingId }
  // A fork whose first spawn has not reported its own id: branch from the source.
  const fork = session?.forkOrigin
  if (fork) return { sessionId: fork.sourceSessionId, at: fork.anchorUuid, fork: true }
  // opencode: pass the routing id even when messages are empty (history is replayed from the
  // server, not preloaded); OpencodeSession.run() falls back to a new session if it is unknown.
  if (
    (session && hasResumableTranscript(session)) ||
    resumesWithoutTranscript(session?.selectedEngineId)
  ) {
    return { sessionId: routingId }
  }
  return undefined
}

/**
 * Spawn the engine for `routingId` and mark the session active once it is up. Throws what its
 * steps throw (a `WorktreeCreateError`, the unresolved-model error, the create's own rejection);
 * nothing is marked active then.
 */
export async function spawnSession(
  routingId: string,
  opts: SpawnSessionOptions = {}
): Promise<void> {
  // The host seeds its own transcript the moment the engine spawns; a client read still in
  // flight would then lose the race and show only this turn.
  await awaitReloadBeforeSpawn(routingId)
  const asSent = opts.from ?? useSessionStore.getState().sessions[routingId]
  assertModelResolved(asSent)
  // Everything but the cwd comes from the session AS SENT, before the worktree step: that step
  // moves the session's cwd, and the composer empties the model catalogue on a cwd change until
  // its refetch lands. Resolved after it, a first message in a new worktree found no row for its
  // model and spawned on the fallback effort and thinking mode, announcing no effort. One
  // moment for the engine, the model and the picks also keeps them a matching set.
  const resolved = resolveSessionSdkOptions(asSent)
  const announce = spawnAnnouncement(useSessionStore.getState(), asSent, resolved.effort)
  const config: SessionConfig = {
    effort: resolved.effort,
    permissionMode: opts.permissionMode ?? asSent?.permissionMode,
    model: resolved.model,
    thinkingMode: resolved.thinkingMode,
    // The stored pick, so a respawn (or a pick made before the first spawn) keeps it.
    ...(asSent?.reasoningVariant ? { reasoningVariant: asSent.reasoningVariant } : {})
  }
  const resume = resumeOf(asSent, routingId, opts.resume ?? 'auto')
  await createPendingWorktree(routingId)
  // Read again only for the cwd: the worktree step moved it.
  const cwd = (opts.from ?? useSessionStore.getState().sessions[routingId])?.cwd || ''
  await window.api.createSession(routingId, {
    cwd,
    engineId: asSent?.selectedEngineId,
    config,
    ...(resume ? { resume } : {}),
    announce
  })
  useSessionStore.getState().markSdkActive(routingId)
}

/**
 * Show a refused or failed spawn on the session, for a caller with no UI of its own for it. A
 * `WorktreeCreateError` is quiet: the welcome screen already shows why, with its own buttons.
 */
export function reportSpawnFailure(routingId: string, what: string, err: unknown): void {
  if (err instanceof WorktreeCreateError) return
  useSessionStore.getState().addError(resolveRekeyed(routingId), `${what}: ${err}`)
}

/**
 * Respawn the session's engine (so it re-reads freshly-stored credentials) and resend a prompt.
 * Used by the post-login Retry.
 */
export async function retrySend(routingId: string, prompt: string): Promise<void> {
  const session = useSessionStore.getState().sessions[routingId]
  if (!session) return
  // Both engines cache vendor credentials for their process's lifetime, so a
  // post-login retry MUST respawn (createSession → session-manager cancels the
  // old session and spawns a fresh backend that re-reads the new credential):
  //   - Claude: the persistent cli.js process caches the OAuth token.
  //   - opencode: the `opencode serve` process caches the instantiated AI-SDK
  //     provider (auth baked in) for its lifetime — verified in opencode-src
  //     provider/provider.ts (InstanceState reads auth.all() once at init; the
  //     /oauth/callback + PUT /auth handlers persist to disk but never
  //     invalidate that cache). cancel() releases the server ref; when it's the
  //     last ref the process is killed, so the recreate spawns a fresh server
  //     that re-reads auth.json. Plain sendPrompt would re-hit the stale,
  //     still-401ing backend.
  try {
    await spawnSession(routingId)
    await window.api.sendPrompt(routingId, prompt)
  } catch (err) {
    reportSpawnFailure(routingId, 'Failed to retry', err)
  }
}
