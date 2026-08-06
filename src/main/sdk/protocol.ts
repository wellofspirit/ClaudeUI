/**
 * Newline-delimited JSON transport between SDK (host) and cli.js (child).
 *
 * Line reader tolerates:
 *   - trailing/leading whitespace
 *   - empty lines (skipped)
 *   - lines that straddle chunk boundaries (buffered)
 */
import type { Writable, Readable } from 'node:stream'

export type JsonLine = Record<string, unknown>

export class NdjsonReader {
  private buf = ''
  constructor(
    stream: Readable,
    private readonly onLine: (obj: JsonLine) => void,
    private readonly onError?: (err: Error) => void
  ) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => this.ingest(chunk))
    stream.on('end', () => this.flush())
  }

  private ingest(chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      this.parse(line)
    }
  }

  private flush(): void {
    if (this.buf.trim()) this.parse(this.buf)
    this.buf = ''
  }

  private parse(line: string): void {
    const t = line.trim()
    if (!t) return
    try {
      const obj = JSON.parse(t) as JsonLine
      this.onLine(obj)
    } catch (err) {
      this.onError?.(err as Error)
    }
  }
}

export class NdjsonWriter {
  constructor(private readonly stream: Writable) {}

  /**
   * Serialize + write one ndjson line. Returns `true` if the line was handed
   * to the stream, `false` if the stream was unwritable (child gone / stdin
   * ended) or the write threw synchronously.
   *
   * The boolean matters for the control channel: a silent no-op here used to
   * leave the caller's request registered as pending, so a request issued on a
   * dead handle waited the full timeout — or, for `timeoutMs: 0` subtypes
   * (oauth / mcp_authenticate), forever (M-CL2). Callers reject the pending
   * request when we report the write didn't land.
   */
  write(obj: JsonLine): boolean {
    if (!this.stream.writable) return false
    try {
      this.stream.write(JSON.stringify(obj) + '\n')
      return true
    } catch {
      // A half-open pipe can throw synchronously (e.g. EPIPE on Windows).
      // Treat it as an unwritable stream rather than crashing the caller.
      return false
    }
  }

  end(): void {
    try {
      this.stream.end()
    } catch {
      /* ignore */
    }
  }
}
