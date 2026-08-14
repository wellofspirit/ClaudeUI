/**
 * SyncCore phase 0 — the snapshot watermark race
 * (docs/architecture/remote.md defect 3).
 *
 * `getFullState()` pulls the state from the renderer over an ASYNC
 * `executeJavaScript` round-trip while the event ring keeps accepting appends.
 * Stamping the snapshot with the seq read AFTER that round-trip claims coverage
 * the snapshot does not have: the client starts its cursor at that seq and
 * never asks for the mid-flight events again.
 *
 * Phase 4a moved the ring out of this class (`main/sync/event-ring.ts`) so the
 * emission funnel can be its only writer. The behavior pinned here is unchanged
 * — only the wiring is: the ring is now injected instead of owned.
 */

import { describe, it, expect } from 'vitest'
import { EventLog } from '../event-log'
import { EventRing } from '../../sync/event-ring'
import type { BrowserWindow } from 'electron'

/** A renderer stub whose round-trip runs `duringRoundTrip` before it resolves. */
function fakeWindow(
  state: Record<string, unknown> | null,
  duringRoundTrip?: () => void
): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async () => {
        duringRoundTrip?.()
        return state
      }
    }
  } as unknown as BrowserWindow
}

const RENDERER_STATE = {
  sessions: {},
  directories: [],
  activeSessionId: null,
  settings: {},
  recentSessionIds: [],
  pinnedSessionIds: [],
  customTitles: {},
  worktreeInfoMap: {}
}

describe('EventLog.getFullState — watermark', () => {
  it('stamps the seq captured at call start, not after the round-trip (GUARD)', async () => {
    const ring = new EventRing()
    const log = new EventLog(ring)
    ring.append('before', []) // seq 1 — in the snapshot

    // seq 2 is appended while executeJavaScript is in flight, so it is NOT in
    // the state we get back.
    log.setWindow(fakeWindow(RENDERER_STATE, () => ring.append('mid-flight', [])))

    const state = await log.getFullState()

    expect(state.seq).toBe(1)
    // The point of the under-claim: a catchup from the advertised watermark
    // still carries the mid-flight event. Stamping seq 2 would have skipped it
    // permanently.
    expect(ring.getAfter(state.seq)?.map((e) => e.channel)).toEqual(['mid-flight'])
  })

  it('stamps the current seq when nothing lands mid-flight (non-vacuity)', async () => {
    const ring = new EventRing()
    const log = new EventLog(ring)
    ring.append('a', [])
    ring.append('b', [])
    log.setWindow(fakeWindow(RENDERER_STATE))

    const state = await log.getFullState()

    expect(state.seq).toBe(2)
    expect(ring.getAfter(state.seq)).toEqual([])
  })

  it('under-claims on the empty-snapshot paths too (no renderer / null state)', async () => {
    const noWindowRing = new EventRing()
    const noWindow = new EventLog(noWindowRing)
    noWindowRing.append('a', [])
    expect((await noWindow.getFullState()).seq).toBe(1)

    const nullRing = new EventRing()
    const nullState = new EventLog(nullRing)
    nullRing.append('a', [])
    nullState.setWindow(fakeWindow(null, () => nullRing.append('mid-flight', [])))
    const state = await nullState.getFullState()
    expect(state.seq).toBe(1)
    expect(state.sessions).toEqual({})
    expect(nullRing.getAfter(state.seq)?.map((e) => e.channel)).toEqual(['mid-flight'])
  })
})
