/**
 * @vitest-environment node
 *
 * The per-session field list is the one thing `toSnapshot` and `fromSnapshot` copy by: a field in
 * `CanonicalSessionState` has to survive canonical -> wire -> JSON -> canonical on its own key,
 * without either function naming it.
 */

import { describe, it, expect } from 'vitest'
import {
  SESSION_FIELDS,
  emptyCanonicalState,
  emptySession,
  fromSnapshot,
  toSnapshot,
  type CanonicalSessionState
} from '../state'

/** Fields with their own wire rule, asserted by name below. */
const EXCEPTIONS = new Set<keyof CanonicalSessionState>(['routingId', 'metering', 'seeded'])

function sentinel(key: string): unknown {
  return { sentinel: key }
}

function roundTrip(session: CanonicalSessionState): {
  wire: Record<string, unknown>
  restored: CanonicalSessionState
} {
  const state = { ...emptyCanonicalState(), sessions: { r1: session } }
  const snapshot = JSON.parse(JSON.stringify(toSnapshot(state, 7)))
  return { wire: snapshot.sessions.r1, restored: fromSnapshot(snapshot).sessions.r1 }
}

describe('SESSION_FIELDS', () => {
  it('is every key of an empty session, in its order', () => {
    expect([...SESSION_FIELDS]).toEqual(Object.keys(emptySession('x')))
    expect(SESSION_FIELDS.length).toBeGreaterThan(20)
  })

  it('carries a distinct sentinel on every field through the wire and back', () => {
    const sentinels: Record<string, unknown> = {}
    for (const key of SESSION_FIELDS) if (!EXCEPTIONS.has(key)) sentinels[key] = sentinel(key)
    const entry = { ...emptySession('r1'), ...sentinels, seeded: true } as CanonicalSessionState

    const { wire, restored } = roundTrip(entry)

    for (const key of SESSION_FIELDS) {
      if (EXCEPTIONS.has(key)) continue
      expect(wire[key], `${key} is not on the wire`).toEqual(sentinel(key))
      expect(restored[key], `${key} did not come back on its own key`).toEqual(sentinel(key))
    }
  })

  it('routes routingId through the record key', () => {
    const { wire, restored } = roundTrip({ ...emptySession('stale'), seeded: true })
    expect(wire.routingId).toBe('r1')
    expect(restored.routingId).toBe('r1')
  })

  it('leaves metering absent on the wire when null, and restores null', () => {
    const { wire, restored } = roundTrip({ ...emptySession('r1'), seeded: true, metering: null })
    expect('metering' in wire).toBe(false)
    expect(restored.metering).toBeNull()
  })

  it('carries a metering value', () => {
    const metering = sentinel('metering')
    const { wire, restored } = roundTrip({
      ...emptySession('r1'),
      seeded: true,
      metering: metering as never
    })
    expect(wire.metering).toEqual(metering)
    expect(restored.metering).toEqual(metering)
  })

  it('writes seeded only as false', () => {
    const seeded = roundTrip({ ...emptySession('r1'), seeded: true })
    expect('seeded' in seeded.wire).toBe(false)
    expect(seeded.restored.seeded).toBe(true)

    const unseeded = roundTrip({ ...emptySession('r1'), seeded: false })
    expect(unseeded.wire.seeded).toBe(false)
    expect(unseeded.restored.seeded).toBe(false)
  })

  it('defaults the two item-stream fields on a hand-built entry', () => {
    const entry = { ...emptySession('r1'), seeded: true } as Partial<CanonicalSessionState>
    delete entry.itemStreams
    delete entry.itemStreamRevision
    const { wire } = roundTrip(entry as CanonicalSessionState)
    expect(wire.itemStreams).toEqual({})
    expect(wire.itemStreamRevision).toBe(0)
  })

  it('drops a key that is not a session field, in both directions', () => {
    const entry = { ...emptySession('r1'), seeded: true, stray: 1 } as CanonicalSessionState
    const state = { ...emptyCanonicalState(), sessions: { r1: entry } }
    const snapshot = JSON.parse(JSON.stringify(toSnapshot(state, 1)))
    expect('stray' in snapshot.sessions.r1).toBe(false)

    snapshot.sessions.r1.unknownWireKey = 'x'
    expect('unknownWireKey' in fromSnapshot(snapshot).sessions.r1).toBe(false)
  })

  it('restores the empty value for a field the wire leaves out or nulls', () => {
    const snapshot = JSON.parse(
      JSON.stringify(
        toSnapshot({ ...emptyCanonicalState(), sessions: { r1: emptySession('r1') } }, 1)
      )
    )
    for (const key of ['heldCount', 'sentFiles', 'selectedModel', 'slashCommands']) {
      delete snapshot.sessions.r1[key]
    }
    snapshot.sessions.r1.effort = null
    snapshot.sessions.r1.seeded = undefined
    const restored = fromSnapshot(snapshot).sessions.r1
    expect(restored.heldCount).toBe(0)
    expect(restored.sentFiles).toEqual([])
    expect(restored.selectedModel).toBe('default')
    expect(restored.slashCommands).toEqual([])
    expect(restored.effort).toBeNull()
    expect(restored.seeded).toBe(true)
  })

  it('serializes keys in SESSION_FIELDS order, whatever order the entry was built in', () => {
    const reordered = Object.fromEntries(
      Object.entries({ ...emptySession('r1'), seeded: true }).reverse()
    ) as unknown as CanonicalSessionState
    const { wire } = roundTrip(reordered)
    // `metering` is absent when null and `seeded` when true.
    expect(Object.keys(wire)).toEqual(
      SESSION_FIELDS.filter((key) => key !== 'metering' && key !== 'seeded')
    )
  })
})
