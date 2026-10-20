/**
 * What an X-Agent's end says to its parent (ADR-105 §3, slice B-3b): the text of the one
 * `dispatch-result` item a background run delivers into the parent's conversation.
 *
 * Pure. The dispatcher decides WHICH end it was and hands the pieces over; this builds the
 * words, and keeps a long report under the delivery cap with its pointer intact.
 *
 * A report is framed by `src/shared/handback-frame.ts` (the sanitiser: untrusted, indented,
 * defused); everything else here is ClaudeUI's own sentence about the run, so it is never
 * indented or marked like the report.
 */

/**
 * The longest report body put into a delivery before framing. `deliver()` cuts the FRAMED
 * text at 20 000 characters (`ITEM_BODY_MAX`, session-delivery.ts) and a cut there would take
 * a trailing pointer first, so the body is cut well under it here.
 */
export const RESULT_REPORT_MAX = 16_000

/**
 * What the whole delivered text may total, framing and pointer included: under the 20 000
 * `ITEM_BODY_MAX` of `session-delivery.ts` (pinned by a test), so the host never cuts it.
 */
export const RESULT_TEXT_MAX = 19_000

/** A report body is never cut below this, however much its frame adds (many short lines). */
const RESULT_REPORT_FLOOR = 2_000

/** A name as it stands in one of our own sentences: one line, bounded. */
export function sentenceLabel(name: string, limit = 80): string {
  const clean = name.replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}

/** The line that says a report was cut and where the whole one is. */
export function truncationPointer(name: string): string {
  return `(report truncated — the full report is on X-Agent ${sentenceLabel(name)}'s card)`
}

/** `1.2k` / `34k` / `812` */
function compactCount(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

/** The status/cost line above a report. Cost is what the X-Agent has spent in all its runs; absent when it is not known. */
export function statusLine(opts: {
  name: string
  usage: { totalTokens: number; toolUses: number; durationMs: number }
  costUsd?: number | null
  unpricedTurns?: number
}): string {
  const { usage } = opts
  const parts = [
    `${usage.toolUses} tool use${usage.toolUses === 1 ? '' : 's'}`,
    `${compactCount(usage.totalTokens)} tokens`,
    clock(usage.durationMs)
  ]
  if (opts.costUsd !== undefined && opts.costUsd !== null) {
    const unpriced = opts.unpricedTurns ?? 0
    parts.push(
      `cost so far $${opts.costUsd.toFixed(4)}${unpriced > 0 ? ` (${unpriced} unpriced turn${unpriced === 1 ? '' : 's'} not counted)` : ''}`
    )
  }
  return `X-Agent ${sentenceLabel(opts.name)} finished: ${parts.join(' · ')}.`
}

/**
 * The delivery for a finished report: the status line, the framed report and, when the
 * report had to be cut, the pointer after the frame. The body is cut at
 * {@link RESULT_REPORT_MAX} and, when the frame's indent and header still push the whole
 * past {@link RESULT_TEXT_MAX}, cut further until it fits — the pointer must survive.
 */
export function reportResultText(opts: {
  name: string
  report: string
  status: string
  /** Frames a (possibly cut) report body. */
  frame: (report: string) => string
}): string {
  let limit = RESULT_REPORT_MAX
  for (;;) {
    const cut = opts.report.length > limit
    const body = cut ? opts.report.slice(0, limit) : opts.report
    const text = [
      opts.status,
      opts.frame(body),
      ...(cut ? [truncationPointer(opts.name)] : [])
    ].join('\n')
    if (text.length <= RESULT_TEXT_MAX || limit <= RESULT_REPORT_FLOOR) return text
    limit = Math.max(RESULT_REPORT_FLOOR, Math.floor(limit * 0.6))
  }
}

/** The failure line: the first line of the reason, bounded. */
export function failedResultText(name: string, reason: string | null): string {
  const first = (reason ?? '')
    .split(/\r?\n/, 1)[0]
    .trim()
    .replace(/[.\s]+$/, '')
  const short = first.length > 200 ? `${first.slice(0, 199)}…` : first
  return `X-Agent ${sentenceLabel(name)} failed${short ? `: ${short}` : ''}.`
}

export function stoppedResultText(name: string): string {
  return `X-Agent ${sentenceLabel(name)} was stopped by the user.`
}

/**
 * The notice the next start leaves for an X-Agent that was running when ClaudeUI quit: `ref` is
 * its ledger ref (what `session_message` takes), alongside the name when it has one.
 */
export function interruptedResultText(name: string, ref: string): string {
  const label = sentenceLabel(name)
  const addressed = label === ref ? `"${ref}"` : `"${label}" or "${ref}"`
  return (
    `X-Agent ${label} was interrupted when ClaudeUI quit; continue it by messaging it with ` +
    `session_message (session: ${addressed}).`
  )
}
