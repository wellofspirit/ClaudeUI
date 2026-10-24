/**
 * Judge-reply capture: with `SharedAutoModeConfig.captureJudgeReplies` on, every call
 * ClaudeUI's HTTP judge transport makes (opencode and pi sessions, the cross-engine
 * dispatcher's target judge) appends what the judge was asked and what it wrote to
 * `<log dir>/judge/YYYYMMDD.jsonl` (local date, like the app log). Diagnostics only: it
 * changes no request, verdict or error, and a failed write never reaches a verdict.
 *
 * File contract — one JSON object per line, UTF-8, `\n`-terminated, two kinds:
 *
 * ```jsonc
 * { "kind": "system", "ts": "<ISO>", "systemHash": "<judgeCacheKey(system)>", "system": "<full system prompt>" }
 * { "kind": "call", "ts": "<ISO, call start>", "durationMs": 0,
 *   "engine": "opencode|pi|…", "routingId": "…", "sessionId": "…|null",
 *   "route": "<route label>", "model": "<wire model>", "wire": "chat|responses",
 *   "stage": "fast|thinking|null", "maxTokens": 64|null, "maxChars": 1024, "stopSequences": ["</severity>"],
 *   "systemHash": "…", "user": "<full user message>",
 *   "outcome": "ok|error|aborted", "error": "<message, when not ok>", "status": 429,
 *   "finish": "stop|length (ok only)", "usage": "<JudgeUsageSample, when seen>",
 *   "text": "<kept text returned to the classifier, ok only>",
 *   "raw": "<every visible delta in arrival order, post-stop and the overflowing delta included>",
 *   "reasoning": "<plain-text reasoning deltas, when the wire carried any>", "reasoningTruncated": true }
 * ```
 *
 * `stopSequences` is what the request asked for, not what went on the wire: a route that cannot
 * carry a stop (the ChatGPT backend) still lists it, because the cut happens client-side.
 *
 * A `system` record precedes the first `call` that names its `systemHash` in a day file (the
 * prompt is tens of KB; the calls reference it by hash). The writer remembers the hashes per day
 * file in memory, so a restart may write one again — harmless. No account id, key, label,
 * header or credential is ever written; `route` is the route's credential-free label. The files
 * hold the judged transcript excerpts: they stay on this machine and are pruned after
 * {@link LOG_RETENTION_DAYS} days, once per process, on the first write.
 *
 * Writes are asynchronous and serialized through one in-process queue, so two concurrent judge
 * calls can never interleave the bytes of two records. Errors are swallowed with one
 * `logger.warn` per failure kind.
 */

import { appendFile, mkdir, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import type { JudgeCallCapture } from './judge-http/types'
import { getLogDir, LOG_RETENTION_DAYS, logger } from '../services/logger'
import { loadSharedAutoModeConfig } from '../services/ui-config'

/** Who made the call — added by the session wiring, which the transport knows nothing about. */
export interface JudgeCaptureContext {
  engine: string
  routingId: string
  sessionId: string | null
}

export type JudgeCaptureCall = JudgeCallCapture & JudgeCaptureContext

/** `captureJudgeReplies` as the shared auto-mode file says it NOW (read per call; a read failure is off). */
export function judgeCaptureEnabled(): boolean {
  try {
    return loadSharedAutoModeConfig().captureJudgeReplies === true
  } catch {
    return false
  }
}

const DAY_FILE = /^(\d{4})(\d{2})(\d{2})\.jsonl$/

/** Local-date key of a day file, e.g. `20261024`. */
function dayKeyOf(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

export interface JudgeCaptureWriter {
  /** Queue one call's record (and its `system` record when the day file lacks it). Never throws. */
  write(call: JudgeCaptureCall): void
  /** Resolves when everything queued so far has been written (or has failed). For tests. */
  idle(): Promise<void>
}

export function createJudgeCaptureWriter(
  opts: {
    /** The directory the day files live in; read per write. */
    dir?: () => string
    now?: () => Date
  } = {}
): JudgeCaptureWriter {
  const dir = opts.dir ?? (() => join(getLogDir(), 'judge'))
  const now = opts.now ?? (() => new Date())
  /** System hashes already in the day file `seenDay` names. */
  let seenDay = ''
  let seen = new Set<string>()
  let pruned = false
  let tail: Promise<void> = Promise.resolve()
  const warned = new Set<string>()

  const warnOnce = (kind: string, message: string, err: unknown): void => {
    if (warned.has(kind)) return
    warned.add(kind)
    logger.warn('JudgeCapture', message, err)
  }

  async function prune(target: string): Promise<void> {
    const cutoff = now().getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
    let names: string[]
    try {
      names = await readdir(target)
    } catch {
      return
    }
    for (const name of names) {
      const match = DAY_FILE.exec(name)
      if (!match) continue
      const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
      if (!Number.isFinite(day) || day >= cutoff) continue
      try {
        await unlink(join(target, name))
      } catch {
        // Vanished or locked — skip it.
      }
    }
  }

  async function writeOne(call: JudgeCaptureCall): Promise<void> {
    const target = dir()
    try {
      await mkdir(target, { recursive: true })
    } catch (err) {
      warnOnce('mkdir', 'Cannot create the judge capture directory', err)
      return
    }
    if (!pruned) {
      pruned = true
      await prune(target)
    }
    const moment = now()
    const day = dayKeyOf(moment)
    if (day !== seenDay) {
      seenDay = day
      seen = new Set()
    }
    const { system, ...rest } = call
    let chunk = ''
    const needsSystem = !seen.has(call.systemHash)
    try {
      if (needsSystem) {
        chunk += `${JSON.stringify({ kind: 'system', ts: moment.toISOString(), systemHash: call.systemHash, system })}\n`
      }
      chunk += `${JSON.stringify({ kind: 'call', ...rest })}\n`
    } catch (err) {
      warnOnce('serialize', 'Cannot serialize a judge capture record', err)
      return
    }
    try {
      // One append per record group: the system record and its first call land together.
      await appendFile(join(target, `${day}.jsonl`), chunk, 'utf-8')
      if (needsSystem) seen.add(call.systemHash)
    } catch (err) {
      warnOnce('append', 'Cannot write a judge capture record', err)
    }
  }

  return {
    write(call) {
      tail = tail.then(() => writeOne(call)).catch(() => {})
    },
    idle: () => tail
  }
}

let defaultWriter: JudgeCaptureWriter | null = null

/** Queue one call on the process-wide writer (`<log dir>/judge/`). Never throws. */
export function writeJudgeCapture(call: JudgeCaptureCall): void {
  try {
    defaultWriter ??= createJudgeCaptureWriter()
    defaultWriter.write(call)
  } catch {
    // Diagnostics only.
  }
}
