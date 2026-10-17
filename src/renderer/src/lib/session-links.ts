/**
 * Reading the replicated parent/child links (session tools, slice 1b).
 *
 * The store holds two replicated maps: `sessionLinks` (child ref → link) and
 * `sessionRefs` (a session's sidebar id → ref). Everything here is a pure read
 * over them, so the sidebar, the session card and the "continued in/from" bar
 * answer the same question the same way.
 */
import { linkNests, type SessionLinkInfo } from '../../../shared/session-links'
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

/** A session's link to its parent, with the parent's sidebar id when the parent is known. */
export interface ParentLink {
  childRef: string
  link: SessionLinkInfo
  /** The parent's sidebar id; null when no session by that ref is known any more. */
  parentId: string | null
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

/** The link that makes `sessionId` a child, unless it was detached. */
export function parentLinkOf(state: LinkState, sessionId: string): ParentLink | null {
  const childRef = state.sessionRefs[sessionId]
  const link = childRef ? state.sessionLinks[childRef] : undefined
  if (!childRef || !link || !linkNests(link)) return null
  return { childRef, link, parentId: idOfRef(state.sessionRefs, link.parentRef) }
}

/** The links under `sessionId`, with each child's sidebar id when it is known. */
export function childLinksOf(
  state: LinkState,
  sessionId: string
): { childRef: string; link: SessionLinkInfo; childId: string | null }[] {
  const ref = state.sessionRefs[sessionId]
  if (!ref) return []
  return Object.entries(state.sessionLinks)
    .filter(([, link]) => link.parentRef === ref && linkNests(link))
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
 * The sidebar ids above `sessionId`, nearest parent first, as far as the links
 * and refs reach. Stops at a cycle.
 */
export function ancestorIdsOf(state: LinkState, sessionId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([sessionId])
  let cur = parentLinkOf(state, sessionId)?.parentId
  while (cur && !seen.has(cur)) {
    out.push(cur)
    seen.add(cur)
    cur = parentLinkOf(state, cur)?.parentId
  }
  return out
}

/** Deepest nesting drawn; a chain longer than this keeps its last indent. */
export const MAX_NEST_DEPTH = 4

export interface NestedRow<T> {
  info: T
  depth: number
  /** Direct children placed under this row in the same list (shown or collapsed). */
  childCount: number
  collapsed: boolean
}

/**
 * Lay a project's sessions out as a forest: a session whose parent is in the
 * same list sits right under it, in the order the list had. A session whose
 * parent is not in the list (another project, hidden, deleted) or whose link was
 * detached stays at the top level. A collapsed parent hides everything below it.
 * A link cycle (never recorded, but replicated data is not trusted) is cut, so
 * no row is lost and none repeats.
 */
export function nestSessions<T extends { sessionId: string }>(
  sessions: readonly T[],
  state: LinkState,
  collapsed: ReadonlySet<string>
): NestedRow<T>[] {
  const ids = new Set(sessions.map((s) => s.sessionId))
  const parentOf = new Map<string, string>()
  for (const s of sessions) {
    const parent = parentLinkOf(state, s.sessionId)?.parentId
    if (parent && parent !== s.sessionId && ids.has(parent)) parentOf.set(s.sessionId, parent)
  }
  // Cut cycles: walking up from a node must reach a root.
  for (const start of [...parentOf.keys()]) {
    const seen = new Set<string>([start])
    let cur = parentOf.get(start)
    while (cur !== undefined) {
      if (seen.has(cur)) {
        parentOf.delete(start)
        break
      }
      seen.add(cur)
      cur = parentOf.get(cur)
    }
  }
  const children = new Map<string, T[]>()
  for (const s of sessions) {
    const parent = parentOf.get(s.sessionId)
    if (parent === undefined) continue
    const list = children.get(parent) ?? []
    list.push(s)
    children.set(parent, list)
  }
  const out: NestedRow<T>[] = []
  const emit = (info: T, depth: number): void => {
    const kids = children.get(info.sessionId) ?? []
    const isCollapsed = kids.length > 0 && collapsed.has(info.sessionId)
    out.push({
      info,
      depth: Math.min(depth, MAX_NEST_DEPTH),
      childCount: kids.length,
      collapsed: isCollapsed
    })
    if (isCollapsed) return
    for (const kid of kids) emit(kid, depth + 1)
  }
  for (const s of sessions) if (!parentOf.has(s.sessionId)) emit(s, 0)
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
