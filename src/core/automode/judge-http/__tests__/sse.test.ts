/**
 * The SSE frame reader: line grammar, chunk boundaries anywhere (mid-line,
 * mid-CRLF, mid-UTF-8 sequence), comments, multi-line data, EOF flush, and
 * body release on early exit.
 */
import { describe, it, expect, vi } from 'vitest'
import { readSseFrames, type SseFrame } from '../sse'

/** A body that delivers exactly these chunks (strings are UTF-8 encoded). */
function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      const c = chunks[i++]
      controller.enqueue(typeof c === 'string' ? enc.encode(c) : c)
    }
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const out: SseFrame[] = []
  for await (const f of readSseFrames(stream)) out.push(f)
  return out
}

/** Every way to split `text` into two chunks yields the same frames. */
async function everySplit(text: string): Promise<SseFrame[][]> {
  const results: SseFrame[][] = []
  for (let at = 0; at <= text.length; at++) {
    results.push(await collect(streamOf([text.slice(0, at), text.slice(at)])))
  }
  return results
}

describe('readSseFrames', () => {
  it('reads data-only frames (chat completions shape) and keeps [DONE] as data', async () => {
    const frames = await collect(streamOf(['data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n']))
    expect(frames).toEqual([{ data: '{"a":1}' }, { data: '{"a":2}' }, { data: '[DONE]' }])
  })

  it('reads event + data frames (Responses shape)', async () => {
    const frames = await collect(
      streamOf(['event: response.output_text.delta\ndata: {"delta":"x"}\n\n'])
    )
    expect(frames).toEqual([{ event: 'response.output_text.delta', data: '{"delta":"x"}' }])
  })

  it('handles a frame split at EVERY position, LF and CRLF alike', async () => {
    const lf = 'event: e1\ndata: one\n\n: comment\ndata: two\n\n'
    const crlf = lf.replace(/\n/g, '\r\n')
    const want = [{ event: 'e1', data: 'one' }, { data: 'two' }]
    for (const text of [lf, crlf]) {
      for (const frames of await everySplit(text)) expect(frames).toEqual(want)
    }
  })

  it('a CRLF split between two chunks is ONE line break, not a blank line', async () => {
    // A premature dispatch here would split `data: a` / `data: b` into two frames.
    const frames = await collect(streamOf(['data: a\r', '\ndata: b\r\n\r\n']))
    expect(frames).toEqual([{ data: 'a\nb' }])
  })

  it('treats a bare CR as a line break', async () => {
    expect(await collect(streamOf(['data: a\r\rdata: b\r\r']))).toEqual([
      { data: 'a' },
      { data: 'b' }
    ])
  })

  it('joins multi-line data with \\n', async () => {
    expect(await collect(streamOf(['data: {"x":\ndata: 1}\n\n']))).toEqual([{ data: '{"x":\n1}' }])
  })

  it('drops comment lines (OpenRouter keep-alives) and ignores id/retry/unknown fields', async () => {
    const frames = await collect(
      streamOf([': OPENROUTER PROCESSING\n\n', 'id: 7\nretry: 100\nfoo: bar\ndata: x\n\n'])
    )
    expect(frames).toEqual([{ data: 'x' }])
  })

  it('strips exactly ONE leading space after the colon', async () => {
    expect(await collect(streamOf(['data:no-space\n\ndata:  two\n\n']))).toEqual([
      { data: 'no-space' },
      { data: ' two' }
    ])
  })

  it('does not dispatch an event line with no data', async () => {
    expect(await collect(streamOf(['event: ping\n\ndata: x\n\n']))).toEqual([{ data: 'x' }])
  })

  it('decodes a UTF-8 sequence split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: ✓\n\n')
    // Split inside the 3-byte check mark.
    const frames = await collect(streamOf([bytes.slice(0, 7), bytes.slice(7)]))
    expect(frames).toEqual([{ data: '✓' }])
  })

  it('flushes a frame still pending at EOF (no final blank line, no final newline)', async () => {
    expect(await collect(streamOf(['data: a\n\ndata: last']))).toEqual([
      { data: 'a' },
      { data: 'last' }
    ])
    expect(await collect(streamOf(['data: last\r']))).toEqual([{ data: 'last' }])
  })

  it('cancels the body when the consumer stops early', async () => {
    const cancel = vi.fn()
    let n = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${n++}\n\n`))
      },
      cancel
    })
    for await (const f of readSseFrames(stream)) {
      if (f.data === '2') break
    }
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('propagates a body that errors mid-stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: a\n\n'))
        controller.error(new Error('socket hang up'))
      }
    })
    await expect(collect(stream)).rejects.toThrow('socket hang up')
  })
})
