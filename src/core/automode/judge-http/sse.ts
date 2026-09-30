/**
 * Incremental Server-Sent Events frame reader for the HTTP judge (ADR-081 §4).
 *
 * One reader serves both wires: chat completions (`data:` lines only) and the
 * Responses API (`event:` + `data:`). It follows the SSE line grammar closely
 * enough for what providers actually send:
 *
 * - lines end in LF, CRLF or a bare CR, and a CRLF split across two chunks is
 *   still one line break (a trailing CR waits for the next chunk);
 * - a blank line dispatches the frame; several `data:` lines join with `\n`;
 * - lines starting with `:` are comments (OpenRouter's `: OPENROUTER PROCESSING`
 *   keep-alives) and are dropped; `id:` / `retry:` are ignored;
 * - one leading space after the field colon is stripped.
 *
 * Deviation from the spec, on purpose: a frame still pending when the stream
 * ends is dispatched rather than discarded. A provider that closes without the
 * final blank line would otherwise lose its terminal event (and its usage).
 *
 * Returning early from the iterator (a reader that has what it needs, or
 * throws) cancels the underlying body, so the connection is released.
 */

export interface SseFrame {
  /** The `event:` field, when the frame had one. */
  event?: string
  /** The joined `data:` lines. */
  data: string
}

export async function* readSseFrames(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []
  let finished = false

  /** Feed one complete line; returns a frame when the line dispatches one. */
  const onLine = (line: string): SseFrame | null => {
    if (line === '') {
      if (data.length === 0) {
        event = undefined
        return null
      }
      const frame: SseFrame =
        event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') }
      event = undefined
      data = []
      return frame
    }
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    return null
  }

  /**
   * Split every complete line off the front of `buffer`. At EOF a trailing CR
   * is a line break on its own; before EOF it might be the first half of a
   * CRLF, so it waits.
   */
  function* drain(eof: boolean): Generator<SseFrame> {
    for (;;) {
      const lf = buffer.indexOf('\n')
      const cr = buffer.indexOf('\r')
      let end: number
      let next: number
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        if (cr === buffer.length - 1 && !eof) return
        end = cr
        next = buffer[cr + 1] === '\n' ? cr + 2 : cr + 1
      } else if (lf !== -1) {
        end = lf
        next = lf + 1
      } else {
        return
      }
      const line = buffer.slice(0, end)
      buffer = buffer.slice(next)
      const frame = onLine(line)
      if (frame) yield frame
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      yield* drain(false)
    }
    finished = true
    buffer += decoder.decode()
    yield* drain(true)
    // A last line with no terminator, then an implicit blank line to flush.
    if (buffer !== '') {
      const frame = onLine(buffer)
      buffer = ''
      if (frame) yield frame
    }
    const tail = onLine('')
    if (tail) yield tail
  } finally {
    if (!finished) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
