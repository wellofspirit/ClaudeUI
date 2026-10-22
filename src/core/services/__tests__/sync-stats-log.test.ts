/**
 * @vitest-environment node
 *
 * The host-side `SyncStats` lines — the thresholds and the cost gate, in
 * isolation. The transports' own tests (remote-server.test.ts, sync-port.unit.test.ts)
 * prove each emits the line; this pins the rules the line follows.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), isEnabled: vi.fn() }
}))

import { logger } from '../logger'
import {
  LARGE_SYNC_FULL_BYTES,
  logFullSyncBreakdown,
  logWsFullSync,
  type FrameSent
} from '../sync-stats-log'
import { emptyCanonicalState, emptySession, toSnapshot } from '../../shared/sync/state'
import type { SyncDecision } from '../../shared/sync/sync-decision'

type FullDecision = Extract<SyncDecision, { kind: 'full' }>

function decision(): FullDecision {
  const state = emptyCanonicalState()
  state.sessions = { s1: emptySession('s1', '/private/cwd') }
  return { kind: 'full', state: toSnapshot(state, 9), epoch: 'epoch-A', reason: 'ring-miss' }
}

const ring = { oldestSeq: () => 4 }

function frame(bytes: number): FrameSent {
  return { bytes, encodeMs: 1.25, e2e: false, bufferedAmount: 0 }
}

beforeEach(() => {
  vi.mocked(logger.info).mockClear()
  vi.mocked(logger.warn).mockClear()
  vi.mocked(logger.isEnabled).mockReset()
})

describe('logWsFullSync', () => {
  it('is info below 5 MB and warn at exactly 5 MB', () => {
    logWsFullSync(
      decision(),
      { lastSeq: 3, epoch: 'epoch-A' },
      ring,
      frame(LARGE_SYNC_FULL_BYTES - 1)
    )
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()

    logWsFullSync(decision(), { lastSeq: 3, epoch: 'epoch-A' }, ring, frame(LARGE_SYNC_FULL_BYTES))
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.warn).mock.calls[0][1]).toMatch(/^large sync-full sent: /)
  })

  it('carries the decision: reason, both seqs, ring floor, epoch match', () => {
    logWsFullSync(decision(), { lastSeq: 3, epoch: 'epoch-A' }, ring, frame(1000))
    const [source, message] = vi.mocked(logger.info).mock.calls[0]
    expect(source).toBe('SyncStats')
    expect(message).toBe(
      'sync-full sent: transport=ws reason=ring-miss lastSeq=3 seq=9 ringOldest=4 epochMatch=true' +
        ' e2e=false frameBytes=1000 encodeMs=1.3 bufferedAmount=0'
    )
  })

  it('never prints the cwd, however the state names it', () => {
    logWsFullSync(decision(), { lastSeq: 3 }, ring, frame(1000))
    expect(String(vi.mocked(logger.info).mock.calls[0][1])).not.toContain('/private/cwd')
  })

  it('appends chunks=N only for a chunked transfer, with the transfer totals', () => {
    // A chunked answer is one line for the whole transfer (ADR-102 amendment), so
    // the counts are the transfer's, not per frame, and `large` is the total.
    logWsFullSync(decision(), { lastSeq: 3, epoch: 'epoch-A' }, ring, {
      ...frame(1000),
      chunks: 4
    })
    expect(vi.mocked(logger.info).mock.calls[0][1]).toMatch(
      / frameBytes=1000 encodeMs=1\.3 bufferedAmount=0 chunks=4$/
    )

    logWsFullSync(decision(), { lastSeq: 3, epoch: 'epoch-A' }, ring, {
      ...frame(LARGE_SYNC_FULL_BYTES),
      chunks: 25
    })
    expect(vi.mocked(logger.warn).mock.calls[0][1]).toMatch(/^large sync-full sent: /)
    expect(vi.mocked(logger.warn).mock.calls[0][1]).toMatch(/ chunks=25$/)
  })
})

describe('logFullSyncBreakdown', () => {
  it('does no work while the source is disabled', () => {
    vi.mocked(logger.isEnabled).mockReturnValue(false)
    const d = decision()
    // A getter that throws proves the snapshot is never even touched.
    Object.defineProperty(d, 'state', {
      get: () => {
        throw new Error('breakdown read the snapshot while disabled')
      }
    })
    expect(() => logFullSyncBreakdown(d)).not.toThrow()
    expect(logger.isEnabled).toHaveBeenCalledWith('SyncStats', 'info')
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('logs one info line while enabled', () => {
    vi.mocked(logger.isEnabled).mockReturnValue(true)
    logFullSyncBreakdown(decision())
    expect(logger.info).toHaveBeenCalledTimes(1)
    const [source, message] = vi.mocked(logger.info).mock.calls[0]
    expect(source).toBe('SyncStats')
    expect(message).toMatch(/^snapshot breakdown: totalBytes=\d+ /)
    expect(String(message)).not.toContain('/private/cwd')
  })
})
