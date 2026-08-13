/**
 * SyncCore phase 0 — the snapshot watermark race
 * (docs/architecture/remote.md defect 3).
 *
 * `getFullState()` pulls the state from the renderer over an ASYNC
 * `executeJavaScript` round-trip while the event log keeps accepting appends.
 * Stamping the snapshot with the seq read AFTER that round-trip claims coverage
 * the snapshot does not have: the client starts its cursor at that seq and
 * never asks for the mid-flight events again.
 */

import { describe, it, expect } from 'vitest'
import { EventLog } from '../event-log'
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
    const log = new EventLog()
    log.append('before', []) // seq 1 — in the snapshot

    // seq 2 is appended while executeJavaScript is in flight, so it is NOT in
    // the state we get back.
    log.setWindow(fakeWindow(RENDERER_STATE, () => log.append('mid-flight', [])))

    const state = await log.getFullState()

    expect(state.seq).toBe(1)
    // The point of the under-claim: a catchup from the advertised watermark
    // still carries the mid-flight event. Stamping seq 2 would have skipped it
    // permanently.
    expect(log.getAfter(state.seq)?.map((e) => e.channel)).toEqual(['mid-flight'])
  })

  it('stamps the current seq when nothing lands mid-flight (non-vacuity)', async () => {
    const log = new EventLog()
    log.append('a', [])
    log.append('b', [])
    log.setWindow(fakeWindow(RENDERER_STATE))

    const state = await log.getFullState()

    expect(state.seq).toBe(2)
    expect(log.getAfter(state.seq)).toEqual([])
  })

  it('under-claims on the empty-snapshot paths too (no renderer / null state)', async () => {
    const noWindow = new EventLog()
    noWindow.append('a', [])
    expect((await noWindow.getFullState()).seq).toBe(1)

    const nullState = new EventLog()
    nullState.append('a', [])
    nullState.setWindow(fakeWindow(null, () => nullState.append('mid-flight', [])))
    const state = await nullState.getFullState()
    expect(state.seq).toBe(1)
    expect(state.sessions).toEqual({})
    expect(nullState.getAfter(state.seq)?.map((e) => e.channel)).toEqual(['mid-flight'])
  })
})
