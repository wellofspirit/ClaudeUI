/**
 * The re-read half of the 2.x reconnect contract (ADR-093 §7, S4): on
 * `connected {reconnected:true}` the consumer awaits this BEFORE applying the
 * next feed event (the `for await` pause is what keeps the read and the live
 * events from interleaving), and dispatches what it returns.
 *
 * Read order matters: `GET /api/session/active` first. opencode writes a
 * turn's idle row inside the terminal publish, before the execution leaves
 * the active set (`core/src/session/run-coordinator.ts`: the `settled` hook
 * runs before `settle`), so a session read as idle already has its idle row
 * in the message list read after it.
 */
import type {
  Form_Info,
  Permission_Request,
  SessionActive,
  Session_Inbox_Info,
  Session_Message_Info
} from './protocol-v2/openapi'
import type {
  OpencodeEventMapper,
  OpencodeMapperOutput,
  OpencodeReconnectSnapshot
} from './v2-event-mapper'

/** The `OpencodeClient` reads a reconnect needs (structural, for tests). */
export interface OpencodeStateReader {
  activeSessions(): Promise<Readonly<Record<string, SessionActive>>>
  listMessages(sessionID: string): Promise<Session_Message_Info[]>
  listPermissionRequests(sessionID: string): Promise<readonly Permission_Request[]>
  listForms(sessionID: string): Promise<readonly Form_Info[]>
  listInbox(sessionID: string): Promise<readonly Session_Inbox_Info[]>
}

/**
 * Reads the state of `sessionIDs`; the inbox only for `ownID` (a child's is
 * its subagent prompt, which ClaudeUI never shows). `active` defaults to a
 * fresh read, taken before anything else.
 */
export async function readReconnectSnapshot(
  reader: OpencodeStateReader,
  sessionIDs: readonly string[],
  options: { ownID?: string; active?: Readonly<Record<string, SessionActive>> } = {}
): Promise<OpencodeReconnectSnapshot> {
  const activeNow = options.active ?? (await reader.activeSessions())
  const sessions: Record<string, OpencodeReconnectSnapshot['sessions'][string]> = {}
  await Promise.all(
    sessionIDs.map(async (sessionID) => {
      const own = sessionID === options.ownID
      const read = Promise.all([
        reader.listMessages(sessionID),
        reader.listPermissionRequests(sessionID),
        reader.listForms(sessionID),
        own ? reader.listInbox(sessionID) : Promise.resolve(undefined)
      ])
      // A child that cannot be read (deleted meanwhile) is left out, not fatal.
      const result = own ? await read : await read.catch(() => null)
      if (!result) return
      const [messages, permissions, forms, inbox] = result
      sessions[sessionID] = { messages, permissions, forms, ...(inbox ? { inbox } : {}) }
    })
  )
  return { sessions, active: activeNow }
}

/** Rounds of "a re-read linked a child we have not read yet" (nesting depth, in practice). */
const MAX_ROUNDS = 4

/**
 * Re-read every session the mapper follows and reconcile it. A child the read
 * itself links (a subagent call started during the gap) is read in a further
 * round, so its transcript so far is not lost either.
 */
export async function reconcileAfterReconnect(
  reader: OpencodeStateReader,
  mapper: OpencodeEventMapper
): Promise<OpencodeMapperOutput[]> {
  const out: OpencodeMapperOutput[] = []
  const active = await reader.activeSessions()
  const read = new Set<string>()
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const followed = mapper.followedSessions()
    const todo = followed.filter((id) => !read.has(id))
    if (todo.length === 0) break
    const snapshot = await readReconnectSnapshot(reader, todo, {
      ownID: mapper.sessionID,
      active
    })
    for (const id of todo) read.add(id)
    out.push(...mapper.reconcile(snapshot))
  }
  return out
}
