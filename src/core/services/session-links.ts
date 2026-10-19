/**
 * Session refs and links (session tools, slice 1b, spec §4/§5; flat groups in slice 5).
 *
 * A ref (`s-` + 6 characters) is the short handle a session keeps across the
 * routing-id rekey and restarts; a link records that one session started, or
 * was handed off to, another — its ORIGIN — and whether the pair is `grouped` (shown
 * as one piece of work). The lineage is always kept; grouping is the user's view and
 * can be changed afterwards. This module is the RULE and the bridge to the
 * replicated state: SQLite (`session_ref`, `session_link`, via `db.ts`) is the
 * record, and every change re-emits `session:link-changed` carrying the whole
 * (small) link table, so a client that joins late reads it from the snapshot and
 * an applied event is a plain replace.
 *
 * State of a link follows its child's session:
 *  - `starting` until the child's first status reaches canonical (`live`), or
 *    its first status is a disconnect (`failed`);
 *  - a session deleted while `starting` → `failed`, otherwise → `ended`; deleting
 *    an ORIGIN leaves the sessions it started in place with their links `ended`.
 *
 * The session tools (`session-tools.ts`) create links with {@link linkChild} after
 * they spawn the new session.
 */
import type { ChatMessage, EngineId } from '../../shared/types'
import {
  groupHeadRef,
  RESERVED_SESSION_WORDS,
  isRef,
  isRefShaped,
  type SessionLinkCreator,
  type SessionLinkInfo,
  type SessionLinkKind,
  type SessionLinkState,
  type SessionLinksPayload
} from '../../shared/session-links'
import {
  allSessionLinks,
  allSessionRefs,
  clearSessionRefIds,
  findSessionRef,
  getSessionLink,
  getSessionMeta,
  getSessionRef,
  insertSessionRef,
  markSessionLinkClientPrompted,
  moveSessionRef,
  sessionLinksByParent,
  sessionProposalStartedRef,
  setSessionLinkGrouped,
  setSessionLinkState,
  setSessionRefIds,
  upsertSessionLink,
  type SessionLinkRow,
  type SessionRefRow
} from './db'
import { mintRef } from './session-ref-mint'
import { setClientPromptObserver } from '../providers/client-prompt-observer'
import { logger } from './logger'
import { addHostObserver, emitEvent, syncCore } from './sync-host'

const LOG = 'SessionLinks'

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

interface RefIds {
  engine: EngineId
  sessionId?: string | null
  routingId?: string | null
}

/**
 * The ref of the session known by these ids, assigned on first use. An existing
 * row found by either id learns the other, so a ref assigned to a routing id
 * keeps working once the engine's session id is known.
 */
function ensureRef(ids: RefIds): SessionRefRow {
  const found =
    (ids.routingId ? findSessionRef(ids.routingId) : undefined) ??
    (ids.sessionId ? findSessionRef(ids.sessionId) : undefined)
  if (found) {
    const learn: { sessionId?: string; routingId?: string } = {}
    if (ids.sessionId && !found.sessionId) learn.sessionId = ids.sessionId
    if (ids.routingId && !found.routingId) learn.routingId = ids.routingId
    if (learn.sessionId !== undefined || learn.routingId !== undefined) {
      setSessionRefIds(found.ref, learn)
      return { ...found, ...learn }
    }
    return found
  }
  // Collisions on 30 bits are rare; a handful of retries makes a failure not worth modelling.
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = {
      ref: mintRef(),
      engine: ids.engine,
      sessionId: ids.sessionId ?? null,
      routingId: ids.routingId ?? null
    }
    if (insertSessionRef(row)) return { ...row, createdAt: Date.now() }
  }
  throw new Error('Could not assign a session ref')
}

/** A session canonical holds but whose engine has not yet reported its own id. */
function isPendingRouting(id: string): boolean {
  const session = syncCore.getCanonicalState().sessions[id]
  return !!session && !session.status.sessionId
}

/**
 * The ref of the session with this live routing id or durable session id,
 * assigned the first time it is asked for. A routing id the engine has not yet
 * replaced (a session still starting) is recorded as a routing id only, so the
 * rekey can later bind it to the real one.
 */
export function refFor(engine: EngineId, id: string): string {
  const pending = isPendingRouting(id)
  return ensureRef({ engine, routingId: id, sessionId: pending ? null : id }).ref
}

/** The id the sidebar keys a session's row by: the live routing id, else the durable id. */
function sidebarIdOf(row: SessionRefRow): string | null {
  return row.routingId ?? row.sessionId
}

export interface ResolvedSession {
  ref: string
  engine: EngineId
  /** The id the sidebar and the engines address the session by. */
  id: string
  sessionId: string | null
  routingId: string | null
}

export type ResolveResult =
  | ({ ok: true } & ResolvedSession)
  | { ok: false; reason: 'not-found' }
  /** `self` and `origin` (or `parent`) are the caller's to resolve; they are not titles. */
  | { ok: false; reason: 'reserved' }
  | {
      ok: false
      reason: 'ambiguous'
      candidates: { ref: string; title: string; engine: EngineId }[]
    }

function resolved(row: SessionRefRow): ResolveResult {
  const id = sidebarIdOf(row)
  if (!id) return { ok: false, reason: 'not-found' }
  return {
    ok: true,
    ref: row.ref,
    engine: row.engine,
    id,
    sessionId: row.sessionId,
    routingId: row.routingId
  }
}

/** The title the sidebar shows for a session canonical knows, by sidebar id. */
export function titleOf(id: string): string {
  const state = syncCore.getCanonicalState()
  const custom = state.customTitles[id]
  if (custom) return custom
  for (const group of state.directories) {
    const info = group.sessions.find((s) => s.sessionId === id)
    if (info) return info.title
  }
  const first = state.sessions[id]?.messages.find((m) => m.role === 'user')
  const text = first?.content.find((b) => b.type === 'text')
  return text && text.type === 'text' ? text.text.slice(0, 80).replace(/\n/g, ' ').trim() : ''
}

export function engineOfId(id: string): EngineId {
  const state = syncCore.getCanonicalState()
  const live = state.sessions[id]
  // Canonical's status names the engine only once the session has reported one
  // (`DEFAULT_STATUS` says claude): a session that has not — Codex starts lazily —
  // still has the engine it was born with, from `session:created`.
  if (live) return live.status.sessionId ? live.status.engineId : live.selectedEngineId
  for (const group of state.directories) {
    const info = group.sessions.find((s) => s.sessionId === id)
    if (info) return info.engineId ?? 'claude'
  }
  return getSessionMeta(id)?.engineId ?? state.sessionEngines[id]?.engineId ?? 'claude'
}

/** Every session id canonical knows: the live ones and the listed ones. */
export function knownSessionIds(): string[] {
  const state = syncCore.getCanonicalState()
  const ids = new Set<string>(Object.keys(state.sessions))
  for (const group of state.directories) for (const s of group.sessions) ids.add(s.sessionId)
  return [...ids]
}

/**
 * What a tool's `session` argument names. In order: one of our refs; a live
 * routing id or a durable session id (a ref is assigned if it has none yet); an
 * exact, unique title. `self`, `origin` and `parent` are refused as titles because the
 * caller resolves them; so is anything shaped like a ref that is not one — an
 * unknown `s-…` is "not found", never a title lookup. Two sessions sharing a
 * title are ambiguous and come back as candidates.
 */
export function resolveRef(input: string): ResolveResult {
  const text = input.trim()
  if (!text) return { ok: false, reason: 'not-found' }
  if (isRef(text)) {
    const row = getSessionRef(text)
    return row ? resolved(row) : { ok: false, reason: 'not-found' }
  }
  if (isRefShaped(text)) return { ok: false, reason: 'not-found' }

  const byId = findSessionRef(text)
  if (byId) return resolved(byId)
  const state = syncCore.getCanonicalState()
  const listed = state.sessions[text] !== undefined || knownSessionIds().includes(text)
  if (listed) {
    const engine = engineOfId(text)
    return resolved(
      ensureRef({ engine, routingId: text, sessionId: isPendingRouting(text) ? null : text })
    )
  }

  if (RESERVED_SESSION_WORDS.has(text.toLowerCase())) return { ok: false, reason: 'reserved' }
  const matches = knownSessionIds().filter((id) => titleOf(id) === text)
  if (matches.length === 0) return { ok: false, reason: 'not-found' }
  if (matches.length === 1) {
    const id = matches[0]
    return resolved(
      ensureRef({
        engine: engineOfId(id),
        routingId: id,
        sessionId: isPendingRouting(id) ? null : id
      })
    )
  }
  return {
    ok: false,
    reason: 'ambiguous',
    candidates: matches.slice(0, 10).map((id) => {
      const engine = engineOfId(id)
      return {
        ref: ensureRef({ engine, routingId: id, sessionId: isPendingRouting(id) ? null : id }).ref,
        title: titleOf(id),
        engine
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** child routing id → child ref, for links still `starting` (so a status needs no DB read). */
const startingByRouting = new Map<string, string>()

function infoOf(row: SessionLinkRow): SessionLinkInfo {
  return {
    originRef: row.parentRef,
    kind: row.kind,
    state: row.state,
    createdBy: row.createdBy,
    grouped: row.grouped,
    createdAt: row.createdAt
  }
}

/** The replicated link state, built from the tables. */
export function linkPayload(): SessionLinksPayload {
  const links: Record<string, SessionLinkInfo> = {}
  const named = new Set<string>()
  for (const row of allSessionLinks()) {
    links[row.childRef] = infoOf(row)
    named.add(row.childRef)
    named.add(row.parentRef)
  }
  const refs: Record<string, string> = {}
  for (const row of allSessionRefs()) {
    if (!named.has(row.ref)) continue
    const id = sidebarIdOf(row)
    if (id) refs[id] = row.ref
  }
  return { links, refs }
}

function emitLinks(): void {
  emitEvent('session:link-changed', [linkPayload()])
}

/** Seed canonical with the stored links at boot (the snapshot a first client reads). */
export function seedLinkState(): void {
  reconcileOnBoot()
  const { links, refs } = linkPayload()
  syncCore.setAppState({ sessionLinks: links, sessionRefs: refs })
}

/**
 * Links still `starting` after a restart have no spawn to wait for: a child with
 * a durable id reached its first status (`live`), one without never did (`failed`).
 */
function reconcileOnBoot(): void {
  // A child this process is waiting for is not a leftover: the seed is async, so a
  // link can legitimately start while it runs.
  const waitingFor = new Set(startingByRouting.values())
  for (const row of allSessionLinks()) {
    if (row.state !== 'starting' || waitingFor.has(row.childRef)) continue
    const child = getSessionRef(row.childRef)
    setSessionLinkState(row.childRef, child?.sessionId ? 'live' : 'failed')
  }
}

function ancestorsInclude(startRef: string, needle: string): boolean {
  const seen = new Set<string>()
  let cur: string | undefined = startRef
  while (cur && !seen.has(cur)) {
    if (cur === needle) return true
    seen.add(cur)
    cur = getSessionLink(cur)?.parentRef
  }
  return false
}

export interface RecordLinkInput {
  childRef: string
  parentRef: string
  kind: SessionLinkKind
  createdBy: SessionLinkCreator
  grouped: boolean
  state?: SessionLinkState
}

/**
 * Record `origin → started session`. A session has at most one origin (a second
 * record replaces the first). Throws for a link that would make a session its own
 * ancestor, which no flow produces and the sidebar could not draw.
 */
export function recordLink(input: RecordLinkInput): void {
  if (input.childRef === input.parentRef || ancestorsInclude(input.parentRef, input.childRef)) {
    throw new Error('A session cannot be linked under itself')
  }
  upsertSessionLink({ ...input, state: input.state ?? 'starting' })
  emitLinks()
}

/** Move a link to `state` and tell the clients; a no-op when it is already there. */
export function setLinkState(childRef: string, state: SessionLinkState): boolean {
  const changed = setSessionLinkState(childRef, state)
  if (!changed) return false
  if (state !== 'starting') {
    for (const [routingId, ref] of startingByRouting) {
      if (ref === childRef) startingByRouting.delete(routingId)
    }
  }
  emitLinks()
  return true
}

/**
 * Client prompts that arrived while the session was still on its temporary routing
 * id. A resumed session's first prompt spawns its engine, and only that engine's
 * first status carries the durable id the link is bound to: until then the prompt
 * cannot be matched to a link, so it is remembered here and recorded at the rekey.
 */
const promptedBeforeRekey = new Set<string>()
const PROMPTED_BEFORE_REKEY_MAX = 1000

/**
 * A client prompt (not the brief a tool sent, not the host's own instruction)
 * reached this session. Records it on the session's link, if it has one, so "no
 * client has typed into this agent-created session yet" survives a restart.
 * Best-effort: the prompt path never fails on bookkeeping.
 */
export function noteClientPrompt(id: string): void {
  try {
    if (markSessionLinkClientPrompted(id) || !isPendingRouting(id)) return
    if (promptedBeforeRekey.size >= PROMPTED_BEFORE_REKEY_MAX) {
      promptedBeforeRekey.delete(promptedBeforeRekey.values().next().value as string)
    }
    promptedBeforeRekey.add(id)
  } catch (err) {
    logger.warn(LOG, `could not record the client prompt for ${id}: ${String(err)}`)
  }
}

/**
 * Was this session started by an agent — or by the user's click on an agent's
 * proposal, whose brief the agent wrote — and not yet prompted by a client? Read from
 * the link (and the proposal that started it), so it holds across a host restart, when
 * the in-memory ledger starts fresh. False for a session with no link or one the user
 * made a link for themselves.
 */
export function awaitingClientPrompt(ref: string): boolean {
  const link = getSessionLink(ref)
  return (
    link !== undefined &&
    link.clientPromptedAt === null &&
    (link.createdBy === 'agent' || sessionProposalStartedRef(ref))
  )
}

/**
 * Group or ungroup a session with the one that started it. The link (the lineage)
 * stays either way.
 */
export function setLinkGrouped(childRef: string, grouped: boolean): boolean {
  const changed = setSessionLinkGrouped(childRef, grouped)
  if (changed) emitLinks()
  return changed
}

/**
 * The body of `session:link:set-grouped`: "Detach from group" (`grouped: false`) and
 * "Add to group" (`true`) on the session named by the id its row is keyed by.
 */
export function setSessionGrouped(
  sessionId: string,
  grouped: boolean
): { success: boolean; error?: string } {
  const ref = findSessionRef(sessionId)
  const link = ref ? getSessionLink(ref.ref) : undefined
  if (!ref || !link) return { success: false, error: 'This session was not started from another' }
  setLinkGrouped(ref.ref, grouped === true)
  return { success: true }
}

/** The group head of `ref`: the topmost session reached through grouped links. */
export function groupHeadOf(ref: string): string {
  return groupHeadRef((r) => {
    const link = getSessionLink(r)
    return link && { originRef: link.parentRef, grouped: link.grouped }
  }, ref)
}

export interface LinkedSessions {
  /** The link to the session that started this one, grouped or not. */
  origin: SessionLinkRow | null
  /** The links of the sessions this one started directly, grouped or not. */
  started: SessionLinkRow[]
  /** This session's group: its head and every session grouped under it (this one included; just itself when alone). */
  group: Set<string>
}

/** The whole link table by started session's ref: read once, then asked as often as needed. */
export type LinkTable = ReadonlyMap<string, SessionLinkRow>

/** One read of the link table. A caller that asks about many sessions reads it once and passes it on. */
export function readLinkTable(): LinkTable {
  return new Map(allSessionLinks().map((l) => [l.childRef, l]))
}

/** A link table seen as `groupHeadRef` reads links. */
const originOf =
  (table: LinkTable) =>
  (ref: string): { originRef: string; grouped: boolean } | undefined => {
    const link = table.get(ref)
    return link && { originRef: link.parentRef, grouped: link.grouped }
  }

/** Every ref in the group `ref` belongs to. */
export function groupOf(ref: string, table: LinkTable = readLinkTable()): Set<string> {
  const head = groupHeadRef(originOf(table), ref)
  const out = new Set<string>([head, ref])
  for (const childRef of table.keys()) {
    if (groupHeadRef(originOf(table), childRef) === head) out.add(childRef)
  }
  return out
}

/** The sessions a ref is tied to: where it came from, what it started, and its group. */
export function linksOf(ref: string, table: LinkTable = readLinkTable()): LinkedSessions {
  return {
    origin: table.get(ref) ?? null,
    started: [...table.values()].filter((l) => l.parentRef === ref),
    group: groupOf(ref, table)
  }
}

export interface LinkChildInput {
  /** The parent's routing id (a live session). */
  parent: string
  /** The routing id the child was created under (not yet rekeyed). */
  childRoutingId: string
  engine: EngineId
  kind: SessionLinkKind
  createdBy: SessionLinkCreator
  /** Shown as part of the origin's group (always for a hand-off). */
  grouped: boolean
  /** The new session's name for its card until the sidebar has a title for it. */
  title?: string
  /**
   * Put a session card in the parent's transcript (default). Off for a session a
   * proposal started: the proposal card (Started, Open) is that session's one card.
   */
  card?: boolean
}

/**
 * Record a freshly created child under its parent (`starting`) and put its
 * session card in the parent's transcript. The slice 1c start flow calls this
 * right after it spawns the child.
 */
export function linkChild(input: LinkChildInput): { parentRef: string; childRef: string } {
  const parentRef = refFor(engineOfId(input.parent), input.parent)
  const child = ensureRef({
    engine: input.engine,
    routingId: input.childRoutingId,
    sessionId: null
  })
  recordLink({
    childRef: child.ref,
    parentRef,
    kind: input.kind,
    createdBy: input.createdBy,
    grouped: input.grouped
  })
  startingByRouting.set(input.childRoutingId, child.ref)
  if (input.card === false) return { parentRef, childRef: child.ref }
  emitEvent('session:message', [
    input.parent,
    sessionCardMessage({
      childRef: child.ref,
      kind: input.kind,
      title: input.title ?? '',
      engineId: input.engine,
      timestamp: Date.now()
    })
  ])
  return { parentRef, childRef: child.ref }
}

// ---------------------------------------------------------------------------
// The session card
// ---------------------------------------------------------------------------

/** Id of the card row a child gets in its parent's transcript (one per child, so a replay replaces). */
export const sessionCardId = (childRef: string): string => `session-card-${childRef}`

export function sessionCardMessage(input: {
  childRef: string
  kind: SessionLinkKind
  title: string
  engineId: EngineId
  timestamp: number
}): ChatMessage {
  return {
    id: sessionCardId(input.childRef),
    role: 'system',
    content: [
      {
        type: 'session_card',
        childRef: input.childRef,
        kind: input.kind,
        title: input.title,
        engineId: input.engineId
      }
    ],
    timestamp: input.timestamp
  }
}

/**
 * A cold-loaded transcript with the parent's session cards put back. cli.js and
 * the other engines write nothing for a card, so the host adds one per child
 * link, placed by when the link was made (before the first message that came
 * after it; at the end if none did). Never throws: a history read must not fail
 * because the link tables could not be read.
 */
export function withSessionCards(sessionId: string, messages: ChatMessage[]): ChatMessage[] {
  try {
    const parent = findSessionRef(sessionId)
    if (!parent) return messages
    // A session a proposal started has the proposal's card, not a session card of its own.
    const links = sessionLinksByParent(parent.ref).filter(
      (l) => !sessionProposalStartedRef(l.childRef)
    )
    if (links.length === 0) return messages
    const out = messages.filter((m) => !links.some((l) => m.id === sessionCardId(l.childRef)))
    for (const link of links) {
      const child = getSessionRef(link.childRef)
      const card = sessionCardMessage({
        childRef: link.childRef,
        kind: link.kind,
        title: '',
        engineId: child?.engine ?? 'claude',
        timestamp: link.createdAt
      })
      const at = out.findIndex((m) => m.timestamp > link.createdAt)
      out.splice(at === -1 ? out.length : at, 0, card)
    }
    return out
  } catch (err) {
    logger.warn(LOG, `could not add session cards to ${sessionId}: ${String(err)}`)
    return messages
  }
}

// ---------------------------------------------------------------------------
// Following the sessions
// ---------------------------------------------------------------------------

/**
 * A rekey means a status carrying the engine's session id reached canonical,
 * which is the child's arrival: the ref follows the id and a `starting` link goes
 * `live`. Registered on core's rekey notifications below (not through
 * `SessionManager`), so the stored row moves with canonical in every rekey.
 */
export function onSessionRekeyed(oldId: string, newId: string): void {
  const childRef = startingByRouting.get(oldId)
  startingByRouting.delete(oldId)
  moveSessionRef(oldId, newId)
  if (promptedBeforeRekey.delete(oldId)) markSessionLinkClientPrompted(newId)
  if (childRef) setLinkState(childRef, 'live')
}

function onSessionStatus(routingId: string, status: { state?: string } | undefined): void {
  const childRef = startingByRouting.get(routingId)
  if (!childRef) return
  startingByRouting.delete(routingId)
  setLinkState(childRef, status?.state === 'disconnected' ? 'failed' : 'live')
}

/** A session was deleted. Its own link ends (or fails, if it never started); its children's end. */
function onSessionRemoved(id: string): void {
  startingByRouting.delete(id)
  promptedBeforeRekey.delete(id)
  const row = findSessionRef(id)
  if (!row) return
  let changed = false
  const own = getSessionLink(row.ref)
  if (own && own.state !== 'ended' && own.state !== 'failed') {
    changed = setSessionLinkState(row.ref, own.state === 'starting' ? 'failed' : 'ended') || changed
  }
  for (const child of sessionLinksByParent(row.ref)) {
    if (child.state === 'live' || child.state === 'starting') {
      changed = setSessionLinkState(child.childRef, 'ended') || changed
    }
  }
  const named = own !== undefined || sessionLinksByParent(row.ref).length > 0
  clearSessionRefIds(id)
  if (changed || named) emitLinks()
}

function observe(channel: string, args: unknown[]): void {
  if (channel === 'session:status' && typeof args[0] === 'string') {
    onSessionStatus(args[0], args[1] as { state?: string } | undefined)
  } else if (channel === 'session:removed' && typeof args[0] === 'string') {
    onSessionRemoved(args[0])
  }
}

// BaseSession reports the queued prompts the engine takes; this module is who records them.
setClientPromptObserver(noteClientPrompt)

syncCore.onRekey((oldId, newId) => {
  try {
    onSessionRekeyed(oldId, newId)
  } catch (err) {
    logger.warn(LOG, `session ref move failed (the ref may stay under the old id): ${String(err)}`)
  }
})

addHostObserver((channel, args) => {
  // The cheap test first: a status for a session with no link in flight reads nothing.
  if (channel === 'session:status' && !startingByRouting.has(args[0] as string)) return
  try {
    observe(channel, args)
  } catch (err) {
    logger.warn(LOG, `link bookkeeping for "${channel}" failed: ${String(err)}`)
  }
})

/** Test seam: forget the in-memory starting set. */
export function resetSessionLinksForTests(): void {
  startingByRouting.clear()
  promptedBeforeRekey.clear()
}
