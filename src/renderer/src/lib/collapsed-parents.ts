/**
 * Which parent sessions this client has collapsed in the sidebar (slice 1b).
 *
 * Per client, never replicated: whether a phone folds a session's children says
 * nothing about the desktop. Kept in localStorage so the folding survives a
 * reload and the mobile drawer, which unmounts the sidebar every time it closes;
 * storage that is missing or throws just means everything starts expanded.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'sidebar.collapsedParents'

function load(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    )
  } catch {
    return new Set()
  }
}

let collapsed: ReadonlySet<string> = load()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function toggleParentCollapsed(sessionId: string): void {
  const next = new Set(collapsed)
  if (!next.delete(sessionId)) next.add(sessionId)
  collapsed = next
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]))
  } catch {
    /* private window or blocked storage: the folding lasts for this page only */
  }
  for (const listener of listeners) listener()
}

/**
 * Unfold these parents (those that are folded; the rest are left as they are).
 * Opening a session brings its ancestors out of a fold so its row is on screen.
 */
export function expandParents(sessionIds: readonly string[]): void {
  if (!sessionIds.some((id) => collapsed.has(id))) return
  const next = new Set(collapsed)
  for (const id of sessionIds) next.delete(id)
  collapsed = next
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]))
  } catch {
    /* see toggleParentCollapsed */
  }
  for (const listener of listeners) listener()
}

export function useCollapsedParents(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => collapsed)
}

/** Test seam: forget the folding and re-read storage. */
export function resetCollapsedParentsForTests(): void {
  collapsed = load()
  for (const listener of listeners) listener()
}
