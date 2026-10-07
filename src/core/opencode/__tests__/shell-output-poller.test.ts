/**
 * Live shell output for opencode 2.x (ADR-097 S4): 2.x pushes no shell output
 * on the feed, so a running call is followed by paging
 * `GET /api/shell/{id}/output` from a byte cursor. The fake below answers as
 * `core/src/shell.ts` `output` does at 2.0.24: the bytes `[cursor,
 * cursor+limit)` decoded server-side, `cursor` past the end → `size`, no output.
 */
import { describe, expect, it, vi } from 'vitest'
import { ShellOutputPoller, type ShellOutputSource } from '../shell-output-poller'

/** A shell whose capture grows by one chunk per read until `chunks` run out, then exits. */
function fakeShell(chunks: (string | Uint8Array)[], options: { exitAfter?: number } = {}) {
  let capture = new Uint8Array(0)
  let reads = 0
  const cursors: number[] = []
  const source = {
    shellOutput: vi.fn(async (_id: string, page: { cursor?: number; limit?: number }) => {
      const next = chunks[reads++]
      if (next !== undefined) {
        const bytes = typeof next === 'string' ? new TextEncoder().encode(next) : next
        const grown = new Uint8Array(capture.length + bytes.length)
        grown.set(capture)
        grown.set(bytes, capture.length)
        capture = grown
      }
      const cursor = page.cursor ?? 0
      cursors.push(cursor)
      if (cursor >= capture.length)
        return { output: '', cursor: capture.length, size: capture.length, truncated: false }
      const slice = capture.subarray(
        cursor,
        Math.min(capture.length, cursor + (page.limit ?? 65536))
      )
      return {
        output: Buffer.from(slice).toString('utf8'),
        cursor: cursor + slice.length,
        size: capture.length,
        truncated: false
      }
    }),
    getShell: vi.fn(async () => ({
      status: reads > (options.exitAfter ?? chunks.length) ? 'exited' : 'running'
    }))
  } satisfies ShellOutputSource
  return { source, cursors }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const settle = async (poller: ShellOutputPoller, max = 200) => {
  for (let i = 0; i < max && poller.active > 0; i++) await tick()
}

describe('ShellOutputPoller', () => {
  it('passes on the cumulative output as it grows and stops by itself once the shell exits', async () => {
    const seen: string[] = []
    const poller = new ShellOutputPoller({ onOutput: (_id, out) => seen.push(out), sleep: tick })
    const { source } = fakeShell(['', 'a\n', 'b\n', 'c\n'])
    poller.start('call_1', 'sh_1', source)
    await settle(poller)
    expect(poller.active).toBe(0)
    expect(seen.at(-1)).toBe('a\nb\nc\n')
    expect(source.getShell).toHaveBeenCalled()
  })

  it('starts at the TAIL of a long capture, never at 0', async () => {
    const seen: string[] = []
    const poller = new ShellOutputPoller({
      onOutput: (_id, out) => seen.push(out),
      sleep: tick,
      tailChars: 10
    })
    const { source, cursors } = fakeShell(['x'.repeat(1_000) + 'END'])
    poller.start('c', 'sh', source)
    await settle(poller)
    // the probe read, then from size − 4 × tail
    expect(cursors[0]).toBe(Number.MAX_SAFE_INTEGER)
    expect(cursors[1]).toBe(1_003 - 40)
    expect(seen.at(-1)).toBe('xxxxxxxEND')
  })

  it('sleeps between every read, full pages included', async () => {
    const trace: string[] = []
    const poller = new ShellOutputPoller({
      onOutput: () => {},
      sleep: async () => {
        trace.push('sleep')
        await tick()
      },
      pageBytes: 4,
      tailChars: 100
    })
    const { source } = fakeShell(['0123456789abcdef'])
    const shellOutput = source.shellOutput.getMockImplementation()!
    source.shellOutput.mockImplementation(async (id, page) => {
      trace.push('read')
      return shellOutput(id, page)
    })
    poller.start('c', 'sh', source)
    await settle(poller)
    // probe, then pages: every page after the first follows a sleep
    expect(trace.filter((t) => t === 'read').length).toBeGreaterThan(4)
    expect(trace.slice(2).join(',')).not.toContain('read,read')
  })

  it('never splits a multibyte character across pages', async () => {
    const seen: string[] = []
    const poller = new ShellOutputPoller({
      onOutput: (_id, out) => seen.push(out),
      sleep: tick,
      pageBytes: 5
    })
    // 'é' and '世' are 2 and 3 bytes: page boundaries fall inside them.
    const text = 'aé世界é bé世'
    const { source } = fakeShell([text])
    poller.start('c', 'sh', source)
    await settle(poller)
    expect(seen.at(-1)).toBe(text)
    expect(seen.join('')).not.toContain('�')
  })

  it('a character cut by growth (its bytes arrive across two writes) is shown whole', async () => {
    const seen: string[] = []
    const poller = new ShellOutputPoller({ onOutput: (_id, out) => seen.push(out), sleep: tick })
    const bytes = new TextEncoder().encode('ok 世')
    const { source } = fakeShell(['', bytes.subarray(0, 4), bytes.subarray(4)])
    poller.start('c', 'sh', source)
    await settle(poller)
    expect(seen.at(-1)).toBe('ok 世')
    expect(seen.some((out) => out.includes('�'))).toBe(false)
  })

  it('keeps only the tail (bounded memory)', async () => {
    const seen: string[] = []
    const poller = new ShellOutputPoller({
      onOutput: (_id, out) => seen.push(out),
      sleep: tick,
      tailChars: 4
    })
    poller.start('c', 'sh', fakeShell(['', 'abc', 'def']).source)
    await settle(poller)
    expect(seen.at(-1)).toBe('cdef')
    expect(Math.max(...seen.map((out) => out.length))).toBeLessThanOrEqual(4)
  })

  it('stops reading once stopped (the call’s result arrived)', async () => {
    const poller = new ShellOutputPoller({ onOutput: () => {}, sleep: tick })
    const { source } = fakeShell(['x'], { exitAfter: Infinity })
    poller.start('c', 'sh', source)
    await tick()
    poller.stop('c')
    const reads = source.shellOutput.mock.calls.length
    for (let i = 0; i < 5; i++) await tick()
    expect(source.shellOutput.mock.calls.length).toBe(reads)
  })

  it('gives up at once on a gone shell (404), after retries on other failures', async () => {
    const poller = new ShellOutputPoller({ onOutput: () => {}, sleep: tick, maxFailures: 3 })
    const gone: ShellOutputSource = {
      shellOutput: vi.fn(async () => {
        throw Object.assign(new Error('not found'), { status: 404 })
      })
    }
    poller.start('a', 'sh', gone)
    const flaky: ShellOutputSource = {
      shellOutput: vi.fn(async () => {
        throw new Error('reset')
      })
    }
    poller.start('b', 'sh', flaky)
    await settle(poller)
    expect(gone.shellOutput).toHaveBeenCalledTimes(1)
    expect(flaky.shellOutput).toHaveBeenCalledTimes(3)
    expect(poller.active).toBe(0)
  })

  it('a second start for the same call is a no-op; stopAll ends every poll', async () => {
    const poller = new ShellOutputPoller({ onOutput: () => {}, sleep: tick })
    const { source } = fakeShell([], { exitAfter: Infinity })
    poller.start('c', 'sh', source)
    poller.start('c', 'sh', source)
    poller.start('d', 'sh', source)
    expect(poller.active).toBe(2)
    poller.stopAll()
    expect(poller.active).toBe(0)
  })
})
