import { describe, expect, it } from 'vitest'
import {
  isStreamEventFrame,
  MAX_STREAM_WATCH,
  STREAM_BACKPRESSURE_BYTES,
  streamEventScopeOf
} from '../stream'

describe('pass-through stream tails', () => {
  it('validates only the retained stream-ev frame shape', () => {
    expect(
      isStreamEventFrame({ type: 'stream-ev', channel: 'session:bash-output', args: [] })
    ).toBe(true)
    expect(isStreamEventFrame({ type: 'stream-ev', channel: 'x' })).toBe(false)
    expect(isStreamEventFrame({ type: 'stream', streamId: 'a/text' })).toBe(false)
    expect(isStreamEventFrame(null)).toBe(false)
  })

  it('scopes session tails by routing id and automation tails by automation id', () => {
    expect(
      streamEventScopeOf({
        type: 'stream-ev',
        channel: 'session:bash-output',
        args: ['rid', { output: 'x' }]
      })
    ).toEqual({ kind: 'session', id: 'rid' })
    expect(
      streamEventScopeOf({
        type: 'stream-ev',
        channel: 'automation:stream-event',
        args: [{ automationId: 'auto-1', text: 'x' }]
      })
    ).toEqual({ kind: 'automation', id: 'auto-1' })
  })

  it('rejects malformed tail scopes', () => {
    for (const frame of [
      { type: 'stream-ev' as const, channel: 'session:bash-output', args: [] },
      { type: 'stream-ev' as const, channel: 'session:bash-output', args: [42] },
      { type: 'stream-ev' as const, channel: 'automation:stream-event', args: [{}] }
    ]) {
      expect(streamEventScopeOf(frame)).toBeNull()
    }
  })

  it('retains bounded watches and the drop-only volatile budget', () => {
    expect(MAX_STREAM_WATCH).toBe(32)
    expect(STREAM_BACKPRESSURE_BYTES).toBe(1024 * 1024)
  })
})
