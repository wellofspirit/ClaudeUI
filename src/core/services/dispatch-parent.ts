/**
 * The dispatching session as a run sees it (ADR-105 §1, slice B-2a).
 *
 * A dispatch run outlives the call that launched it, and its parent's session OBJECT can
 * be replaced under it (a respawn after an effort change or an account switch) or be
 * gone altogether (a Disconnect evicts the transcript). So a run never holds the
 * parent's closures from the launching call. It holds a facade that resolves the parent
 * AT THE MOMENT OF EACH READ:
 *
 *  - events go out under the parent's durable id (`emitEvent`'s routing), not through
 *    an object that may be dead — the id follows `syncCore.onRekey`;
 *  - the judge's inputs (mode, transcript, queued turns, blocked calls) and the cost
 *    fold-in come from whatever session object answers to that id now;
 *  - with no object, the mode falls back to the ledger's `launch_mode` and the
 *    transcript to canonical state, then to a cold read of the engine's history.
 *
 * Without a lookup (`DispatcherDeps.parents` unset — a headless test double) the
 * facade is the launching call's own context, as before.
 */
import { stricterMode } from '../../shared/mode-class'
import type { BlockedCallLedger } from '../automode/blocked-calls'
import type { ChatMessage, EngineId } from '../../shared/types'
import type { DispatchContext } from './cross-engine-dispatcher'
import type { DispatchRun, DispatchRunRegistry } from './dispatch-runs'

/** A dispatch call's context as the run engine hands it to a turn body: the parent facade + its run. */
export type RunContext = DispatchContext & { readonly run: DispatchRun }

/** The slice of a session object the run reads live (`ISession` satisfies it structurally). */
export interface LiveParentSession {
  getAutonomyMode?(): string
  getMessages(): ChatMessage[]
  /** Is the engine process (or connection) up? Absent means live; a cancelled object says false. */
  isEngineLive?(): boolean
  queuedUserTurns?(): ChatMessage[]
  readonly blockedCalls?: BlockedCallLedger
  addDispatchedCost?(engineId: EngineId, modelId: string, costUsd: number): void
}

/** How the dispatcher reaches the dispatching session. Wired once, from `core-services.ts`. */
export interface DispatchParentLookup {
  /** The session object that answers to `parentId` now (it may be cancelled), or undefined. */
  session(parentId: string): LiveParentSession | undefined
  /** Emit under the parent's routing (`emitEvent(channel, [parentId, data])`). */
  emit(parentId: string, channel: string, data: unknown): void
  /** The parent's transcript in canonical state (empty once evicted on disconnect). */
  canonicalMessages?(parentId: string): ChatMessage[]
  /** Read the parent's transcript from its engine's history (`readSessionHistory`). */
  readMessages?(parentId: string): Promise<ChatMessage[]>
}

/** How long one cold read of a disconnected parent's transcript is reused. */
export const COLD_TRANSCRIPT_TTL_MS = 10_000

export function makeRunContext(opts: {
  base: DispatchContext
  run: DispatchRun
  registry: DispatchRunRegistry
  parents: DispatchParentLookup | undefined
  /** The mode a parent with no session object runs under: the ledger's `launch_mode`. */
  launchMode: () => string
  now: () => number
}): RunContext {
  const { base, run, registry, parents, launchMode, now } = opts
  if (!parents) return { ...base, run }

  const parentId = (): string => registry.parentOf(base.fromRoutingId)
  const live = (): LiveParentSession | undefined => parents.session(parentId())
  const getMessages = (): ChatMessage[] => {
    const messages = live()?.getMessages()
    if (messages && messages.length > 0) return messages
    return parents.canonicalMessages?.(parentId()) ?? messages ?? []
  }
  // The mode a parent is judged under. A session whose engine is down keeps its last-set
  // mode on the object, which the user may have loosened after the launch with nothing
  // running to mind it: that never loosens the target's launch mode. A live session's
  // mode is the user's current word.
  const mode = (): string => {
    const parent = live()
    const current = parent?.getAutonomyMode?.()
    if (current === undefined) return launchMode()
    return parent?.isEngineLive?.() === false ? stricterMode(current, launchMode()) : current
  }
  // One cold read in flight at a time, reused for a short while.
  let cold: { at: number; messages: Promise<ChatMessage[]> } | undefined

  return {
    fromEngine: base.fromEngine,
    get fromRoutingId(): string {
      return parentId()
    },
    cwd: base.cwd,
    getAutonomyMode: mode,
    getMessages,
    // The judge's transcript: live, then canonical, and only then the engine's own history
    // (a Disconnect evicts canonical's copy), reused briefly so a burst of asks reads once.
    loadMessages: async () => {
      const here = getMessages()
      if (here.length > 0 || !parents.readMessages) return here
      if (!cold || now() - cold.at >= COLD_TRANSCRIPT_TTL_MS) {
        // an unreadable history is an empty one: the judge then has no intent to read
        const reading = parents.readMessages(parentId()).catch((): ChatMessage[] => [])
        cold = { at: now(), messages: reading }
      }
      return cold.messages
    },
    getQueuedUserTurns: () => live()?.queuedUserTurns?.() ?? [],
    get blockedCalls(): BlockedCallLedger | undefined {
      return live()?.blockedCalls
    },
    emit: (channel, data) => parents.emit(parentId(), channel, data),
    addDispatchedCost: (engineId, modelId, costUsd) =>
      live()?.addDispatchedCost?.(engineId, modelId, costUsd),
    ...(base.toolUseId !== undefined ? { toolUseId: base.toolUseId } : {}),
    ...(base.chatgptAccountId !== undefined ? { chatgptAccountId: base.chatgptAccountId } : {}),
    ...(base.callerRestriction ? { callerRestriction: base.callerRestriction } : {}),
    run
  }
}
