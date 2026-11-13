/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { logger } from '../logger'
import { claudeStderrTail } from '../claude-stderr-tail'

beforeEach(() => vi.clearAllMocks())

describe('claudeStderrTail', () => {
  it('keeps the last 12 lines, each cut to 400 characters', () => {
    const log = vi.fn()
    const tail = claudeStderrTail(log)
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    lines[19] = 'x'.repeat(1000)
    tail.note(Buffer.from(lines.join('\n')))

    const kept = tail.failure(new Error('exit')).message.split('\n').slice(2)
    expect(kept).toHaveLength(12)
    expect(kept[0]).toBe('line 9')
    expect(kept[11]).toBe('x'.repeat(400))
    expect(log).toHaveBeenCalledTimes(20)
  })

  it('files Voice lines to the Voice debug log and keeps them out of log and tail', () => {
    const log = vi.fn()
    const tail = claudeStderrTail(log)
    tail.note(Buffer.from('real\n[Voice:Patch] chatter\n\n  \n'))

    expect(logger.debug).toHaveBeenCalledWith('Voice', '[Voice:Patch] chatter')
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('real')
    expect(tail.failure(new Error('exit')).message).toBe('exit\nClaude Code stderr:\nreal')
  })

  it('is usable detached, as the stderr query option', () => {
    const { note, failure } = claudeStderrTail(() => {})
    note(Buffer.from('boom'))
    expect(failure(new Error('exit')).message).toContain('boom')
  })

  it('treats a chunk that splits a line as two lines, as the dispatcher always has', () => {
    const log = vi.fn()
    const tail = claudeStderrTail(log)
    tail.note(Buffer.from('first\nsecond ha'))
    tail.note(Buffer.from('lf\nthird'))
    expect(log.mock.calls.map((c) => c[0])).toEqual(['first', 'second ha', 'lf', 'third'])
  })

  it('returns the same Error object when nothing was kept, and an Error of the text otherwise', () => {
    const tail = claudeStderrTail(() => {})
    const err = new Error('exit')
    expect(tail.failure(err)).toBe(err)
    expect(tail.failure('plain').message).toBe('plain')
    expect(tail.failure('plain')).toBeInstanceOf(Error)

    tail.note(Buffer.from('why'))
    expect(tail.failure('plain').message).toBe('plain\nClaude Code stderr:\nwhy')
  })
})
