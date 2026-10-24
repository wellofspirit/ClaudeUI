/**
 * The pieces both wire readers share: the completion-text accumulator (with
 * the client-side stop cut and the character budget), frame JSON parsing, and
 * the numeric coercion for usage fields.
 */

import {
  JUDGE_OFF_FORMAT_CODE,
  JUDGE_OVER_BUDGET_CODE,
  JudgeWireError,
  type JudgeStreamOptions,
  type JudgeStreamResult,
  type JudgeUsageSample
} from './types'

/** Thrown message for a reply that spent its whole budget and said nothing. */
export const JUDGE_BUDGET_EXHAUSTED_MESSAGE =
  'the model used its whole budget without answering — pick a judge with reasoning off or a larger budget'
export const JUDGE_EMPTY_REPLY_MESSAGE = 'empty judge reply'
export const JUDGE_OVER_BUDGET_MESSAGE = 'judge output exceeded its budget'
/** Thrown when a reply opens with something other than the request's `allowedPrefixes`. */
export const JUDGE_OFF_FORMAT_MESSAGE = 'judge reply did not open with the required format'
/** Thrown when a stream ends without the wire's terminal marker: the reply may be cut short. */
export const JUDGE_STREAM_TRUNCATED_MESSAGE = 'stream ended before the response completed'

/**
 * Accumulates text deltas and enforces, client-side, what the endpoint may not:
 *
 * - **Stop sequences.** After each delta the WHOLE text is searched (a stop
 *   string can straddle two deltas), and it is cut at the earliest occurrence of
 *   any of them, exclusive. From then on deltas are counted but not appended, so
 *   the reader can keep going for the usage that arrives at the end.
 * - **The character budget.** Text past `maxChars` aborts the call. Once the
 *   stop cut has happened, deltas past the budget no longer throw — the verdict
 *   is already in hand — they end the drain instead (see {@link push}).
 * - **The opening format.** When the request names `allowedPrefixes`, the kept
 *   text must begin with one of them. The check stops as soon as the text can
 *   no longer become any of them, so a prose reply is abandoned on its first
 *   delta instead of being read to the budget. A prefix split across deltas is
 *   fine: a text that is still a strict prefix of one of them keeps passing.
 */
export class JudgeTextAccumulator {
  private text = ''
  private stopped = false
  private drained = 0
  private readonly stops: string[]
  private readonly maxChars: number
  private readonly onDelta: ((text: string) => void) | undefined
  private readonly prefixes: string[]
  /** The text opened with one of `prefixes` (or there are none); no further checks. */
  private prefixed: boolean

  constructor(
    opts: Pick<JudgeStreamOptions, 'stopSequences' | 'maxChars' | 'onDelta' | 'allowedPrefixes'>
  ) {
    this.stops = (opts.stopSequences ?? []).filter((s) => s.length > 0)
    this.maxChars = opts.maxChars
    this.onDelta = opts.onDelta
    this.prefixes = (opts.allowedPrefixes ?? []).map((p) => p.toLowerCase())
    this.prefixed = this.prefixes.length === 0
  }

  /**
   * Feed one delta. Returns false when the reader should stop reading: the
   * stop cut already happened and the model has since produced more than a
   * whole budget's worth of text we are discarding anyway. Draining that for
   * the sake of a usage count would only run the call into its stage timeout
   * and lose the verdict.
   *
   * @throws JudgeWireError when the kept text opens off-format, or exceeds the budget.
   */
  push(delta: string): boolean {
    // The capture tap sees EVERY delta, ahead of the stop and budget logic below.
    this.onDelta?.(delta)
    if (this.stopped) {
      this.drained += delta.length
      return this.drained <= this.maxChars
    }
    this.text += delta
    let cut = -1
    for (const stop of this.stops) {
      const at = this.text.indexOf(stop)
      if (at !== -1 && (cut === -1 || at < cut)) cut = at
    }
    if (cut !== -1) {
      this.text = this.text.slice(0, cut)
      this.stopped = true
    }
    this.checkPrefixes()
    if (this.text.length > this.maxChars) {
      throw new JudgeWireError(JUDGE_OVER_BUDGET_MESSAGE, { code: JUDGE_OVER_BUDGET_CODE })
    }
    return true
  }

  /**
   * The opening-format rule on the KEPT text: throw as soon as it can no longer become any allowed
   * prefix, and stop checking once it opens with one. Whitespace-only text is skipped — the
   * model may lead with a newline.
   */
  private checkPrefixes(): void {
    if (this.prefixed) return
    const t = this.text.trimStart().toLowerCase()
    if (t === '') return
    if (this.prefixes.some((p) => t.startsWith(p))) {
      this.prefixed = true
      return
    }
    if (!this.prefixes.some((p) => p.startsWith(t))) {
      throw new JudgeWireError(JUDGE_OFF_FORMAT_MESSAGE, { code: JUDGE_OFF_FORMAT_CODE })
    }
  }

  /**
   * The reader's result. A reply with no visible text is a transport error, not
   * an empty verdict (`classify()` would read one as an unparseable BLOCK):
   * `length` gets the reasoning-ate-the-budget copy, anything else the generic
   * one. A stop cut always reports `stop`, whatever the provider said after it.
   */
  finish(finish: 'stop' | 'length', usage: JudgeUsageSample | null): JudgeStreamResult {
    if (this.text.trim() === '') {
      throw new JudgeWireError(
        finish === 'length' && !this.stopped
          ? JUDGE_BUDGET_EXHAUSTED_MESSAGE
          : JUDGE_EMPTY_REPLY_MESSAGE
      )
    }
    return { text: this.text, usage, finish: this.stopped ? 'stop' : finish }
  }
}

/** Parse one frame's data as a JSON object; anything else is a malformed stream. */
export function parseFrameObject(data: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    throw new JudgeWireError('malformed judge stream frame')
  }
  if (!isRecord(parsed)) throw new JudgeWireError('malformed judge stream frame')
  return parsed
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A usage count, or 0 when the provider left it out or sent nonsense. */
export function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/**
 * Build the error for a provider error object (`{message, code?, type?}`),
 * from either wire. `code` falls back to `type`, and a numeric code (OpenRouter
 * sends HTTP-style numbers) is stringified.
 */
export function providerError(prefix: string, err: Record<string, unknown>): JudgeWireError {
  const message = typeof err.message === 'string' && err.message ? err.message : 'unknown error'
  const rawCode = err.code ?? err.type
  const code =
    typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined
  return new JudgeWireError(`${prefix}${code ? ` (${code})` : ''}: ${message}`, {
    ...(code ? { code } : {})
  })
}
