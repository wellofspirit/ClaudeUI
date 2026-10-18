/**
 * Reading the replicated session links (session tools, slice 1b; flat groups in slice 5).
 *
 * The store holds two replicated maps: `sessionLinks` (a started session's ref →
 * its link to the session that started it) and `sessionRefs` (a session's sidebar id
 * → ref). Everything here is a pure read over them, so the sidebar, the session card
 * and the "continued in/from" bar answer the same question the same way.
 *
 * A link always records the ORIGIN; `grouped` says whether the sidebar shows the pair
 * as one piece of work. A group is flat: its head is the topmost session reached
 * through grouped links, and every grouped session sits one level under it.
 */
import { groupHeadRef, type SessionLinkInfo } from '../../../shared/session-links'
import type { DirectoryGroup } from '../../../shared/types'
import { useSessionStore } from '../stores/session-store'
import {
  findSessionInfo,
  loadSessionIntoStore,
  opensResident,
  replaceOnClick
} from './session-history-load'

/** The slice of the store these reads need. */
export interface LinkState {
  sessionLinks: Record<string, SessionLinkInfo>
  sessionRefs: Record<string, string>
}

/** A session's link to the session that started it, with that session's sidebar id when known. */
export interface OriginLink {
  childRef: string
  link: SessionLinkInfo
  /** The origin's sidebar id; null when no session by that ref is known any more. */
  originId: string | null
}

// The ref → id inverse is rebuilt only when the refs object changes.
const inverseCache = new WeakMap<Record<string, string>, Map<string, string>>()

export function idOfRef(sessionRefs: Record<string, string>, ref: string): string | null {
  let inverse = inverseCache.get(sessionRefs)
  if (!inverse) {
    inverse = new Map(Object.entries(sessionRefs).map(([id, r]) => [r, id]))
    inverseCache.set(sessionRefs, inverse)
  }
  return inverse.get(ref) ?? null
}

/** The link to the session that started `sessionId`, grouped or not. */
export function originLinkOf(state: LinkState, sessionId: string): OriginLink | null {
  const childRef = state.sessionRefs[sessionId]
  const link = childRef ? state.sessionLinks[childRef] : undefined
  if (!childRef || !link) return null
  return { childRef, link, originId: idOfRef(state.sessionRefs, link.originRef) }
}

/** The links of the sessions `sessionId` started directly, grouped or not, oldest first. */
export function startedLinksOf(
  state: LinkState,
  sessionId: string
): { childRef: string; link: SessionLinkInfo; childId: string | null }[] {
  const ref = state.sessionRefs[sessionId]
  if (!ref) return []
  return Object.entries(state.sessionLinks)
    .filter(([, link]) => link.originRef === ref)
    .sort(([, a], [, b]) => a.createdAt - b.createdAt)
    .map(([childRef, link]) => ({ childRef, link, childId: idOfRef(state.sessionRefs, childRef) }))
}

/** The title the sidebar shows for a session: the user's name for it, the listing's, or its first words. */
export function sessionTitleOf(
  state: {
    customTitles: Record<string, string>
    directories: readonly DirectoryGroup[]
    sessions: Record<
      string,
      { messages: { role: string; content: { type: string; text?: string }[] }[] }
    >
  },
  sessionId: string
): string {
  const custom = state.customTitles[sessionId]
  if (custom) return custom
  const listed = findSessionInfo(state.directories, sessionId)?.title
  if (listed) return listed
  const first = state.sessions[sessionId]?.messages.find((m) => m.role === 'user')
  const text = first?.content.find((b) => b.type === 'text')?.text
  return text ? text.slice(0, 80).replace(/\n/g, ' ').trim() : ''
}

/**
 * The sidebar id of the head of `sessionId`'s group, or null when the session is its
 * own head (alone, standalone, or the head of a group) or the head is not known.
 */
export function groupHeadIdOf(state: LinkState, sessionId: string): string | null {
  const ref = state.sessionRefs[sessionId]
  if (!ref) return null
  const head = groupHeadRef((r) => state.sessionLinks[r], ref)
  return head === ref ? null : idOfRef(state.sessionRefs, head)
}

export interface GroupedRow<T> {
  info: T
  /** 0 for a head or a standalone row, 1 for a member of the group above it. */
  depth: 0 | 1
  /** Members placed under this row in the same list (shown or folded). */
  memberCount: number
  collapsed: boolean
}

/**
 * Lay a project's sessions out in flat groups: a session whose group head is in the
 * same list sits under that head, one level in, ordered by when each was started; the
 * head carries the count and the fold. A session with no group head in the list —
 * standalone, alone, or its head in another project, hidden or deleted — stays a
 * top-level row in the order the list had. A folded head hides its members. Cycles
 * (never recorded, but replicated data is not trusted) end the walk, so no row is lost
 * and none repeats.
 */
export function groupSessions<T extends { sessionId: string }>(
  sessions: readonly T[],
  state: LinkState,
  collapsed: ReadonlySet<string>
): GroupedRow<T>[] {
  const ids = new Set(sessions.map((s) => s.sessionId))
  const members = new Map<string, T[]>()
  const memberIds = new Set<string>()
  for (const s of sessions) {
    const head = groupHeadIdOf(state, s.sessionId)
    // A head is its own head; one that is not (a cycle) heads nothing, so no row is lost.
    if (head === null || !ids.has(head) || groupHeadIdOf(state, head) !== null) continue
    const list = members.get(head) ?? []
    list.push(s)
    members.set(head, list)
    memberIds.add(s.sessionId)
  }
  const startedAt = (s: T): number => {
    const ref = state.sessionRefs[s.sessionId]
    return (ref ? state.sessionLinks[ref]?.createdAt : undefined) ?? 0
  }
  const out: GroupedRow<T>[] = []
  for (const s of sessions) {
    if (memberIds.has(s.sessionId)) continue
    const kids = [...(members.get(s.sessionId) ?? [])].sort((a, b) => startedAt(a) - startedAt(b))
    const isCollapsed = kids.length > 0 && collapsed.has(s.sessionId)
    out.push({ info: s, depth: 0, memberCount: kids.length, collapsed: isCollapsed })
    if (isCollapsed) continue
    for (const kid of kids) out.push({ info: kid, depth: 1, memberCount: 0, collapsed: false })
  }
  return out
}

/**
 * Open a session by its sidebar id: as it is when its transcript is resident,
 * otherwise through the same per-engine load a sidebar click runs. A session no
 * listing names cannot be opened.
 */
export async function openSessionById(sessionId: string): Promise<void> {
  const state = useSessionStore.getState()
  const inMemory = state.sessions[sessionId]
  if (opensResident(inMemory)) {
    state.switchSession(sessionId)
    return
  }
  const info = findSessionInfo(state.directories, sessionId)
  if (!info) return
  const result = await loadSessionIntoStore(info, {
    isCurrent: () => true,
    replace: replaceOnClick(inMemory)
  })
  if (result === 'skipped') return
  useSessionStore.getState().switchSession(sessionId)
}
