/**
 * The agent types an engine can spawn, with their native colours (ADR-093),
 * for the type tile and its settings page.
 *
 * One read per (engine, cwd), shared by every tile on screen: a roster of twenty
 * rows is one IPC call. A successful answer is kept for the life of the window
 * and published to every mounted hook with that key, so the settings page's
 * `fresh` read recolours the tiles already on screen. There is no polling and no
 * watcher: an agent file edited mid-session shows its new colour after the next
 * read, which the settings page forces and a reload gets anyway.
 *
 * Never throws, and never remembers a failure. A host that cannot answer (a
 * reconnect in flight, a stubbed API, a remote that predates the channel) is an
 * empty catalog for now, so every type falls through to its stable hash colour;
 * nothing is cached, so the next mount (or a `fresh` read) asks again.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { AgentTypeInfo, EngineId } from '../../../shared/types'

const NO_TYPES: AgentTypeInfo[] = []
const settled = new Map<string, AgentTypeInfo[]>()
const inflight = new Map<string, Promise<void>>()
const listeners = new Map<string, Set<() => void>>()

const keyOf = (engine: EngineId, cwd: string | undefined): string => `${engine}\u0000${cwd ?? ''}`

function subscribeKey(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

function publish(key: string, types: AgentTypeInfo[]): void {
  settled.set(key, types)
  listeners.get(key)?.forEach((listener) => listener())
}

/** Ask the host; a failure (or a non-list answer) settles nothing. */
function read(engine: EngineId, cwd: string | undefined, fresh: boolean): Promise<void> {
  const key = keyOf(engine, cwd)
  const pending = inflight.get(key)
  if (pending && !fresh) return pending
  const request: Promise<void> = Promise.resolve()
    .then(() => window.api.listAgentTypes(engine, cwd))
    .then((types) => {
      if (Array.isArray(types)) publish(key, types)
    })
    .catch(() => {})
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key)
    })
  inflight.set(key, request)
  return request
}

/**
 * The catalog for `engine` at `cwd`: what the host last answered for exactly this
 * key, else `NO_TYPES` (never another key's list). `enabled` false (a default
 * type, a dispatch: nothing to colour) skips the read; `fresh` re-reads on mount.
 */
export function useAgentTypeCatalog(
  engine: EngineId | undefined,
  cwd: string | undefined,
  options: { enabled?: boolean; fresh?: boolean } = {}
): AgentTypeInfo[] {
  const { enabled = true, fresh = false } = options
  const id = engine ?? 'claude'
  const key = keyOf(id, cwd)
  const subscribe = useCallback((listener: () => void) => subscribeKey(key, listener), [key])
  const types = useSyncExternalStore(subscribe, () => settled.get(key) ?? NO_TYPES)

  useEffect(() => {
    if (!enabled) return
    if (fresh || !settled.has(key)) void read(id, cwd, fresh)
    // `key` carries (id, cwd); `fresh` re-reads only on mount, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  return enabled ? types : NO_TYPES
}

/** The native colour a catalog names for `type`, if any (exact name first, then case-insensitive). */
export function nativeColorOf(catalog: AgentTypeInfo[], type: string): string | undefined {
  const exact = catalog.find((entry) => entry.type === type)
  const hit = exact ?? catalog.find((entry) => entry.type.toLowerCase() === type.toLowerCase())
  return hit?.nativeColor
}

/** Test seam: forget what was read, so a test sees its own stub's answer. */
export function resetAgentTypeCatalog(): void {
  settled.clear()
  inflight.clear()
}
