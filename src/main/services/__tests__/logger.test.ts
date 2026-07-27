/**
 * @vitest-environment node
 *
 * Two halves: the pure-logic mirrors below (ring buffer / filter parsing /
 * error formatting), and — at the bottom — real-module tests for the M-LG1
 * file-write policy (buffered async appends, retention pruning, per-day size
 * cap), which redirect `os.homedir()` at a temp dir so LOG_DIR never points at
 * the developer's real `~/.claude/ui/logs`.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as realFs from 'node:fs'
import * as nodePath from 'node:path'
import * as nodeOs from 'node:os'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

// We can't import the logger module directly since it has side effects
// (reads process.env, opens files). Instead, extract and test the pure logic.

// ── LogRingBuffer ──

class LogRingBuffer<T> {
  private buf: (T | undefined)[]
  private head = 0
  private full = false

  constructor(private size: number) {
    this.buf = new Array(size)
  }

  push(item: T): void {
    this.buf[this.head] = item
    this.head = (this.head + 1) % this.size
    if (!this.full && this.head === 0) this.full = true
  }

  toArray(): T[] {
    if (!this.full) return this.buf.slice(0, this.head) as T[]
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)] as T[]
  }
}

describe('LogRingBuffer', () => {
  it('returns empty array initially', () => {
    const buf = new LogRingBuffer<number>(5)
    expect(buf.toArray()).toEqual([])
  })

  it('returns items in order when not full', () => {
    const buf = new LogRingBuffer<number>(5)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    expect(buf.toArray()).toEqual([1, 2, 3])
  })

  it('wraps around when full, preserving order', () => {
    const buf = new LogRingBuffer<number>(3)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    buf.push(4) // wraps: overwrites 1
    expect(buf.toArray()).toEqual([2, 3, 4])
  })

  it('handles exact capacity fill', () => {
    const buf = new LogRingBuffer<number>(3)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    expect(buf.toArray()).toEqual([1, 2, 3])
  })

  it('handles multiple wraps', () => {
    const buf = new LogRingBuffer<number>(3)
    for (let i = 1; i <= 10; i++) buf.push(i)
    expect(buf.toArray()).toEqual([8, 9, 10])
  })

  it('handles size 1', () => {
    const buf = new LogRingBuffer<string>(1)
    buf.push('a')
    buf.push('b')
    expect(buf.toArray()).toEqual(['b'])
  })
})

// ── parseFilter ──

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4
}

function parseFilter(raw: string): { global: LogLevel; sources: Map<string, LogLevel> } {
  const defaultLevel: LogLevel = 'warn'
  const sources = new Map<string, LogLevel>()
  if (!raw) return { global: defaultLevel, sources }

  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  let resolvedGlobal: LogLevel = defaultLevel

  for (const part of parts) {
    if (part.includes(':')) {
      const [src, lvl] = part.split(':', 2)
      if (lvl in LEVEL_ORDER) sources.set(src, lvl as LogLevel)
    } else if (part in LEVEL_ORDER) {
      resolvedGlobal = part as LogLevel
    } else {
      sources.set(part, 'debug')
    }
  }

  return { global: resolvedGlobal, sources }
}

function shouldLog(
  source: string,
  msgLevel: LogLevel,
  globalLevel: LogLevel,
  sourceLevels: Map<string, LogLevel>
): boolean {
  const effective = sourceLevels.get(source) ?? globalLevel
  return LEVEL_ORDER[msgLevel] >= LEVEL_ORDER[effective]
}

describe('parseFilter', () => {
  it('returns defaults for empty string', () => {
    const result = parseFilter('')
    expect(result.global).toBe('warn')
    expect(result.sources.size).toBe(0)
  })

  it('parses global level', () => {
    expect(parseFilter('debug').global).toBe('debug')
    expect(parseFilter('info').global).toBe('info')
    expect(parseFilter('error').global).toBe('error')
  })

  it('parses source:level pairs', () => {
    const result = parseFilter('info,BlockUsage:debug,Session:error')
    expect(result.global).toBe('info')
    expect(result.sources.get('BlockUsage')).toBe('debug')
    expect(result.sources.get('Session')).toBe('error')
  })

  it('treats bare words as source:debug', () => {
    const result = parseFilter('BlockUsage')
    expect(result.global).toBe('warn') // unchanged default
    expect(result.sources.get('BlockUsage')).toBe('debug')
  })

  it('handles mixed format', () => {
    const result = parseFilter('debug,UsageFetcher,BlockUsage:info')
    expect(result.global).toBe('debug')
    expect(result.sources.get('UsageFetcher')).toBe('debug')
    expect(result.sources.get('BlockUsage')).toBe('info')
  })

  it('ignores invalid levels in source:level pairs', () => {
    const result = parseFilter('Session:banana')
    expect(result.sources.size).toBe(0)
  })

  it('handles whitespace', () => {
    const result = parseFilter('  info , BlockUsage : debug  ')
    // "BlockUsage : debug" contains space — split on first ':'
    // src="  BlockUsage ", lvl=" debug  " — trimmed by parts but not by split
    // Actually the parts are trimmed, so "BlockUsage : debug" is a single part
    // split on ':' gives ["BlockUsage ", " debug"]
    // " debug" is not in LEVEL_ORDER (has leading space)
    // Let's check: the function trims each comma-separated part
    expect(result.global).toBe('info')
  })
})

describe('shouldLog', () => {
  it('allows messages at or above global level', () => {
    const sources = new Map<string, LogLevel>()
    expect(shouldLog('any', 'warn', 'warn', sources)).toBe(true)
    expect(shouldLog('any', 'error', 'warn', sources)).toBe(true)
    expect(shouldLog('any', 'info', 'warn', sources)).toBe(false)
    expect(shouldLog('any', 'debug', 'warn', sources)).toBe(false)
  })

  it('per-source override takes priority', () => {
    const sources = new Map<string, LogLevel>([['Verbose', 'debug']])
    expect(shouldLog('Verbose', 'debug', 'error', sources)).toBe(true)
    expect(shouldLog('Other', 'debug', 'error', sources)).toBe(false)
  })

  it('silent level suppresses everything', () => {
    const sources = new Map<string, LogLevel>()
    expect(shouldLog('any', 'error', 'silent', sources)).toBe(false)
  })
})

// ── formatError ──

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`
  }
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

describe('formatError', () => {
  it('formats Error with stack', () => {
    const err = new Error('boom')
    expect(formatError(err)).toContain('boom')
    expect(formatError(err)).toContain('Error')
  })

  it('formats string directly', () => {
    expect(formatError('something failed')).toBe('something failed')
  })

  it('JSON-serializes objects', () => {
    expect(formatError({ code: 404 })).toBe('{"code":404}')
  })

  it('handles circular references gracefully', () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    const result = formatError(obj)
    expect(typeof result).toBe('string')
  })

  it('handles null', () => {
    expect(formatError(null)).toBe('null')
  })

  it('handles undefined', () => {
    // JSON.stringify(undefined) returns the JS value undefined (not a string).
    // The function returns that value directly — a minor edge case.
    expect(formatError(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Real-module: file-write policy (M-LG1)
//
// RED-FIRST NOTE: pre-fix `writeToFile` called `appendFileSync` on every log
// call, so "the line is NOT on disk before flushSync()" fails immediately (the
// file exists and already holds the line), there was no `flushSync` /
// `pruneOldLogs` export at all (the prune + size-cap suites cannot even
// compile against the old module), and nothing capped a day's file size.
// ---------------------------------------------------------------------------

type LoggerModule = typeof import('../logger')

function logDir(): string {
  return nodePath.join(TEMP_HOME, '.claude', 'ui', 'logs')
}

function dayKey(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function freshHome(prefix: string): string {
  return realFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix))
}

describe('logger — buffered file writes, subscribers, pruning', () => {
  let mod: LoggerModule
  let home = ''

  beforeAll(async () => {
    home = freshHome('logger-buffered-')
    TEMP_HOME = home
    vi.resetModules()
    mod = await import('../logger')
    mod.logger.globalLevel = 'debug'
  })

  afterAll(() => {
    TEMP_HOME = home
    realFs.rmSync(home, { recursive: true, force: true })
  })

  it('buffers the line in memory and only lands it on disk at flushSync()', () => {
    const file = nodePath.join(logDir(), `${dayKey()}.log`)
    mod.logger.info('BufTest', 'buffered-line-marker')

    // Neither the 64-line threshold nor the 500 ms timer has fired.
    expect(realFs.existsSync(file)).toBe(false)

    mod.flushSync()
    expect(realFs.readFileSync(file, 'utf-8')).toContain('buffered-line-marker')
  })

  it('a level-suppressed line reaches subscribers and the ring but never the file', () => {
    const file = nodePath.join(logDir(), `${dayKey()}.log`)
    const seen: string[] = []
    const unsub = mod.logger.subscribe((entry) => seen.push(entry.message))

    mod.logger.globalLevel = 'error'
    try {
      mod.logger.info('BufTest', 'suppressed-line-marker')
    } finally {
      mod.logger.globalLevel = 'debug'
      unsub()
    }
    mod.flushSync()

    expect(seen).toContain('suppressed-line-marker')
    expect(mod.logRing.toArray().some((e) => e.message === 'suppressed-line-marker')).toBe(true)
    expect(realFs.readFileSync(file, 'utf-8')).not.toContain('suppressed-line-marker')
  })

  it('pruneOldLogs deletes daily files past the retention window and keeps everything else', async () => {
    const dir = logDir()
    realFs.mkdirSync(dir, { recursive: true })
    const stale = nodePath.join(dir, `${dayKey(mod.LOG_RETENTION_DAYS + 3)}.log`)
    const recent = nodePath.join(dir, `${dayKey(3)}.log`)
    const unrelated = nodePath.join(dir, 'notes.txt')
    for (const f of [stale, recent, unrelated]) realFs.writeFileSync(f, 'x')

    await mod.pruneOldLogs()

    expect(realFs.existsSync(stale)).toBe(false)
    expect(realFs.existsSync(recent)).toBe(true)
    expect(realFs.existsSync(unrelated)).toBe(true)
  })
})

describe('logger — per-day size cap', () => {
  let mod: LoggerModule
  let home = ''

  beforeAll(async () => {
    home = freshHome('logger-sizecap-')
    TEMP_HOME = home
    vi.resetModules()
    mod = await import('../logger')
    mod.logger.globalLevel = 'debug'
  })

  afterAll(() => {
    TEMP_HOME = home
    realFs.rmSync(home, { recursive: true, force: true })
  })

  it('stops appending once the day is over budget, after one final cap notice', () => {
    const dir = logDir()
    realFs.mkdirSync(dir, { recursive: true })
    const file = nodePath.join(dir, `${dayKey()}.log`)
    // Extend (not fill) the file so statSync reports a day already at the cap.
    realFs.writeFileSync(file, '')
    realFs.truncateSync(file, mod.LOG_MAX_BYTES_PER_DAY)

    mod.logger.info('CapTest', 'last-line-before-cap')
    mod.flushSync()
    mod.logger.info('CapTest', 'line-after-cap')
    mod.flushSync()

    // Read only the tail we appended — the leading 50 MB is a hole.
    const size = realFs.statSync(file).size
    const tailLen = size - mod.LOG_MAX_BYTES_PER_DAY
    const buf = Buffer.alloc(tailLen)
    const fd = realFs.openSync(file, 'r')
    try {
      realFs.readSync(fd, buf, 0, tailLen, mod.LOG_MAX_BYTES_PER_DAY)
    } finally {
      realFs.closeSync(fd)
    }
    const tail = buf.toString('utf-8')

    expect(tail).toContain('last-line-before-cap')
    expect(tail).toContain('size cap reached')
    expect(tail).not.toContain('line-after-cap')
  })
})
