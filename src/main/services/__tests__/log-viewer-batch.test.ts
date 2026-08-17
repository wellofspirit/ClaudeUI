/**
 * @vitest-environment node
 *
 * M-LG1 (c) guard — the log viewer's live stream must be coalesced into
 * `log-viewer:entry-batch` sends instead of one IPC message per entry.
 *
 * There is no component harness for `src/renderer/log-viewer/LogViewer.tsx`
 * (its only existing test, `filtering.test.ts`, is pure-logic), so the batching
 * itself is tested here against `LogEntryBatcher` — the class `LogViewer` feeds
 * from both `logger.subscribe` and the renderer `console-message` hook. The
 * renderer side is a one-line channel swap (`onEntry` → `onEntryBatch`) covered
 * by typecheck.
 *
 * RED-FIRST NOTE: `LogEntryBatcher` did not exist pre-fix — `log-viewer.ts`
 * called `webContents.send('log-viewer:entry', entry)` inline, once per entry,
 * so this file cannot compile, let alone pass, against the old module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
// `@electron-toolkit/utils` reaches into the real `electron` binding at import
// time (the vi.mock above only covers OUR import specifiers), so stub it too.
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import {
  LogEntryBatcher,
  ENTRY_BATCH_INTERVAL_MS,
  ENTRY_BATCH_MAX
} from '../log-viewer'
import type { LogEntry } from '../../../core/services/logger'

function entry(message: string): LogEntry {
  return { timestamp: '00:00:00.000', level: 'debug', source: 'T', message }
}

describe('LogEntryBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a burst into ONE send after the batch interval', () => {
    const send = vi.fn()
    const batcher = new LogEntryBatcher(send)

    batcher.push(entry('a'))
    batcher.push(entry('b'))
    batcher.push(entry('c'))

    // Nothing has gone out yet — pre-fix this would already be 3 IPC sends.
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(ENTRY_BATCH_INTERVAL_MS)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].map((e: LogEntry) => e.message)).toEqual(['a', 'b', 'c'])
  })

  it('arms the timer from the FIRST buffered entry, not the last', () => {
    const send = vi.fn()
    const batcher = new LogEntryBatcher(send)

    batcher.push(entry('a'))
    vi.advanceTimersByTime(ENTRY_BATCH_INTERVAL_MS - 10)
    batcher.push(entry('b'))
    vi.advanceTimersByTime(10)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toHaveLength(2)
  })

  it('flushes immediately once the queue hits the size ceiling', () => {
    const send = vi.fn()
    const batcher = new LogEntryBatcher(send)

    for (let i = 0; i < ENTRY_BATCH_MAX; i++) batcher.push(entry(`e${i}`))

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toHaveLength(ENTRY_BATCH_MAX)

    // The timer was cleared by the size-triggered flush — no empty second send.
    vi.advanceTimersByTime(ENTRY_BATCH_INTERVAL_MS * 2)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh window after a flush', () => {
    const send = vi.fn()
    const batcher = new LogEntryBatcher(send)

    batcher.push(entry('a'))
    vi.advanceTimersByTime(ENTRY_BATCH_INTERVAL_MS)
    batcher.push(entry('b'))
    vi.advanceTimersByTime(ENTRY_BATCH_INTERVAL_MS)

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].map((e: LogEntry) => e.message)).toEqual(['b'])
  })

  it('reset() drops the queue and disarms the timer (ring dump supersedes it / window closed)', () => {
    const send = vi.fn()
    const batcher = new LogEntryBatcher(send)

    batcher.push(entry('a'))
    batcher.reset()
    vi.advanceTimersByTime(ENTRY_BATCH_INTERVAL_MS * 2)

    expect(send).not.toHaveBeenCalled()
  })

  it('flush() on an empty queue never sends an empty batch', () => {
    const send = vi.fn()
    const batcher = new LogEntryBatcher(send)
    batcher.flush()
    expect(send).not.toHaveBeenCalled()
  })
})
