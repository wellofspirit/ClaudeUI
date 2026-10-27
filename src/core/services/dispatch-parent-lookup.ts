/**
 * How the dispatcher reaches a dispatching session (ADR-105 §1): the production
 * {@link DispatchParentLookup}, built from the session manager, canonical state and the
 * engines' history readers. Lives apart from `cross-engine-dispatcher.ts` because that
 * module cannot import the session manager (the session classes import it), and is wired
 * from `core-services.ts`, which sits above both.
 */
import type { ChatMessage, EngineId } from '../../shared/types'
import { cwdToProjectKey } from '../../shared/project-key'
import { claudeProjectKeyFor } from './claude-transcript-locator'
import { readSessionHistory } from './engine-history'
import type {
  DispatchParentLookup,
  DispatchResultItem,
  DispatchResultOutcome,
  LiveParentSession
} from './dispatch-parent'

export interface DispatchParentLookupDeps {
  /** The session object that answers to a routing id (`SessionManager.get`); it may be cancelled. */
  getSession: (routingId: string) => LiveParentSession | undefined
  /** `emitEvent(channel, [routingId, data])`'s args form. */
  emitEvent: (channel: string, args: unknown[]) => void
  /** The parent's canonical session state, if canonical has one. */
  canonical: (
    routingId: string
  ) => { messages: ChatMessage[]; cwd: string; engineId?: EngineId } | undefined
  /** Read a session's history cold. Defaults to the engines' `readSessionHistory`. */
  readHistory?: (routingId: string, cwd: string, engineId?: EngineId) => Promise<ChatMessage[]>
  /** `deliver(manager, parentId, { origin: 'dispatch-result', wake: true, … })` of `session-delivery`. */
  deliverResult?: (parentId: string, item: DispatchResultItem) => Promise<DispatchResultOutcome>
}

/** Read a parent's transcript the way a resume seeds canonical's: Claude's is located, the others' keyed by cwd. */
async function readParentHistory(
  routingId: string,
  cwd: string,
  engineId?: EngineId
): Promise<ChatMessage[]> {
  const projectKey =
    (engineId ?? 'claude') === 'claude' ? claudeProjectKeyFor(routingId, cwd) : cwdToProjectKey(cwd)
  return (await readSessionHistory(routingId, projectKey, undefined, engineId)).messages
}

export function makeDispatchParentLookup(deps: DispatchParentLookupDeps): DispatchParentLookup {
  const read = deps.readHistory ?? readParentHistory
  const { deliverResult } = deps
  return {
    ...(deliverResult ? { deliver: (parentId, item) => deliverResult(parentId, item) } : {}),
    session: (parentId) => deps.getSession(parentId),
    emit: (parentId, channel, data) => deps.emitEvent(channel, [parentId, data]),
    canonicalMessages: (parentId) => deps.canonical(parentId)?.messages ?? [],
    readMessages: async (parentId) => {
      // Canonical's cwd and engine name the history to read; with neither there is nothing to read.
      const held = deps.canonical(parentId)
      if (!held?.cwd) return []
      return read(parentId, held.cwd, held.engineId)
    }
  }
}
