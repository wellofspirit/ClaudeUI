/**
 * Live output of a running opencode 2.x shell call (ADR-032 bash streaming,
 * ported by ADR-097 S4).
 *
 * 1.x republished a cumulative output preview on the tool part's metadata.
 * 2.x does not stream shell output on the feed at all: the shell tool reports
 * only its `shellID` (`session.tool.progress {metadata:{shellID}}`,
 * `core/src/tool/plugin/shell.ts`), and the output lives in the shell
 * service's capture file, paged by `GET /api/shell/{id}/output?cursor=`
 * (`schema/src/shell.ts` Output: `cursor` = absolute byte offset after the
 * page, `size` = bytes captured so far). So the live view is a poll, started
 * by the mapper's `shell-started` output and stopped by the call's
 * `tool-result` (or teardown).
 *
 * The callback receives the CUMULATIVE tail (as 1.x's preview was), which is
 * what `BashStreamGate` and `session:bash-output` expect; the gate still
 * throttles and dedups downstream.
 */
export interface ShellOutputSource {
  shellOutput(
    shellID: string,
    page: { cursor?: number; limit?: number }
  ): Promise<{ output: string; cursor: number; size: number; truncated: boolean }>
  /** `GET /api/shell/{id}`: lets a poll end on its own when the shell exits. */
  getShell?(shellID: string): Promise<{ status: string }>
}

export interface ShellOutputPollerOptions {
  /** Called with the output so far (its last `tailChars`) whenever it grew. */
  readonly onOutput: (toolUseId: string, output: string) => void
  /** Pause between reads. Default 250 ms. */
  readonly intervalMs?: number
  /** How much of the output is kept and passed on. Default 30 000 characters (1.x's preview size). */
  readonly tailChars?: number
  /** Bytes asked for per page. Default 64 KiB. */
  readonly pageBytes?: number
  /** Consecutive failed reads before a poll gives up (a gone shell fails at once). Default 5. */
  readonly maxFailures?: number
  /** Test seam. */
  readonly sleep?: (ms: number) => Promise<void>
}

interface Poll {
  stopped: boolean
}

type Page = Awaited<ReturnType<ShellOutputSource['shellOutput']>>

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isNotFound = (error: unknown): boolean =>
  (error as { status?: unknown } | null)?.status === 404

const REPLACEMENT = '\uFFFD'
/** UTF-8 encodes a character in at most 4 bytes, so a cut one leaves at most 3. */
const MAX_CUT_BYTES = 3
const byteLength = (text: string) => new TextEncoder().encode(text).length

export class ShellOutputPoller {
  private readonly polls = new Map<string, Poll>()
  private readonly intervalMs: number
  private readonly tailChars: number
  private readonly pageBytes: number
  private readonly maxFailures: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: ShellOutputPollerOptions) {
    this.intervalMs = options.intervalMs ?? 250
    this.tailChars = options.tailChars ?? 30_000
    this.pageBytes = options.pageBytes ?? 64 * 1024
    this.maxFailures = options.maxFailures ?? 5
    this.sleep = options.sleep ?? defaultSleep
  }

  /** Follow `shellID` for the call `toolUseId` until it exits or `stop(toolUseId)`. A second start is a no-op. */
  start(toolUseId: string, shellID: string, source: ShellOutputSource): void {
    if (this.polls.has(toolUseId)) return
    const poll: Poll = { stopped: false }
    this.polls.set(toolUseId, poll)
    void this.run(toolUseId, shellID, source, poll).finally(() => {
      if (this.polls.get(toolUseId) === poll) this.polls.delete(toolUseId)
    })
  }

  stop(toolUseId: string): void {
    const poll = this.polls.get(toolUseId)
    if (!poll) return
    poll.stopped = true
    this.polls.delete(toolUseId)
  }

  stopAll(): void {
    for (const poll of this.polls.values()) poll.stopped = true
    this.polls.clear()
  }

  /** Calls being followed (for tests and teardown checks). */
  get active(): number {
    return this.polls.size
  }

  /**
   * One poll. Wire facts (`vendor/opencode-src/packages/core/src/shell.ts`
   * `output`): a page is the capture file's bytes `[cursor, cursor+limit)`
   * decoded SERVER-side (`toString("utf8")`); a cursor at or past the end
   * answers at once with `size` and no output. So:
   * - it starts at the TAIL (`size − tail`), never at 0: only the tail is shown;
   * - a multibyte character cut at a page end arrives as U+FFFD — its bytes
   *   are read again with the next page (a client-side streaming decoder
   *   cannot help: the server already decoded), and one cut at the jump's
   *   start is dropped;
   * - it sleeps between every read, and ends when the shell is no longer
   *   running (after one last read) — not only when stopped.
   */
  private async run(
    toolUseId: string,
    shellID: string,
    source: ShellOutputSource,
    poll: Poll
  ): Promise<void> {
    let failures = 0
    const read = async (page: { cursor?: number; limit?: number }): Promise<Page | null> => {
      while (!poll.stopped) {
        try {
          const result = await source.shellOutput(shellID, page)
          failures = 0
          return result
        } catch (error) {
          if (isNotFound(error) || ++failures >= this.maxFailures) return null
          await this.sleep(this.intervalMs * failures)
        }
      }
      return null
    }
    const end = await read({ cursor: Number.MAX_SAFE_INTEGER })
    if (!end || poll.stopped) return
    // Enough bytes for the tail at 4 bytes a character, at worst.
    let cursor = Math.max(0, end.size - this.tailChars * 4)
    let dropLeadingCut = cursor > 0
    let output = ''
    let finalRead = false
    while (!poll.stopped) {
      const page = await read({ cursor, limit: this.pageBytes })
      if (!page || poll.stopped) return
      let text = page.output
      let next = Math.max(cursor, page.cursor)
      if (text.endsWith(REPLACEMENT) && !finalRead) {
        const kept = text.slice(0, -1)
        const cut = page.cursor - cursor - byteLength(kept)
        // Only a genuine cut (1–3 bytes, the rest of the page valid UTF-8) is re-read.
        if (cut >= 1 && cut <= MAX_CUT_BYTES) {
          text = kept
          next = page.cursor - cut
        }
      }
      if (dropLeadingCut) {
        text = text.replace(/^\uFFFD{1,3}/, '')
        dropLeadingCut = false
      }
      if (text) {
        output = (output + text).slice(-this.tailChars)
        this.options.onOutput(toolUseId, output)
      }
      cursor = next
      const caughtUp = page.cursor >= page.size
      if (finalRead && caughtUp) return
      if (caughtUp && source.getShell) {
        const info = await source
          .getShell(shellID)
          .catch((error: unknown) => (isNotFound(error) ? { status: 'gone' } : null))
        if (poll.stopped) return
        // Exited: one more read picks up what it wrote after the last page.
        if (info && info.status !== 'running') finalRead = true
      }
      await this.sleep(this.intervalMs)
    }
  }
}
