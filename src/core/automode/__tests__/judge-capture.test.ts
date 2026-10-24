/**
 * @vitest-environment node
 *
 * The judge-capture JSONL writer: file contract (`system` record once per hash per day file,
 * before the first `call` that names it), whole lines under concurrency, retention, and that a
 * failing disk never throws. Real files under a temp dir; the real `~/.claude/ui` is never touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../../services/logger', () => ({
  logger: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  getLogDir: () => join(tmpdir(), 'judge-capture-test-never-written'),
  LOG_RETENTION_DAYS: 14
}))
const shared = vi.hoisted(() => ({ value: {} as Record<string, unknown>, throws: false }))
vi.mock('../../services/ui-config', () => ({
  loadSharedAutoModeConfig: () => {
    if (shared.throws) throw new Error('unreadable')
    return shared.value
  }
}))

import {
  createJudgeCaptureWriter,
  judgeCaptureEnabled,
  type JudgeCaptureCall
} from '../judge-capture'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judge-capture-'))
  warn.mockClear()
  shared.value = {}
  shared.throws = false
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const JUDGE_DIR = (): string => join(dir, 'judge')

function call(over: Partial<JudgeCaptureCall> = {}): JudgeCaptureCall {
  return {
    ts: '2026-10-24T10:00:00.000Z',
    durationMs: 12,
    route: 'chatgpt · gpt-6-luna',
    model: 'gpt-6-luna',
    wire: 'responses',
    stage: 'fast',
    maxTokens: 64,
    maxChars: 1024,
    stopSequences: ['</severity>'],
    systemHash: 'judge-aaaa',
    system: 'SYSTEM PROMPT A',
    user: 'ACTION',
    outcome: 'ok',
    raw: '<severity>1</severity>',
    text: '<severity>1',
    finish: 'stop',
    engine: 'pi',
    routingId: 'r1',
    sessionId: 's1',
    ...over
  }
}

const AT = new Date(2026, 9, 24, 10, 0, 0)

function lines(file: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(JUDGE_DIR(), file), 'utf-8')
  expect(text.endsWith('\n')).toBe(true)
  return text
    .split('\n')
    .slice(0, -1)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('judgeCaptureEnabled', () => {
  it('is on only for an explicit true, read per call', () => {
    expect(judgeCaptureEnabled()).toBe(false)
    shared.value = { captureJudgeReplies: true }
    expect(judgeCaptureEnabled()).toBe(true)
    shared.value = { captureJudgeReplies: 'true' }
    expect(judgeCaptureEnabled()).toBe(false)
    shared.value = {}
    expect(judgeCaptureEnabled()).toBe(false)
  })

  it('an unreadable config is off', () => {
    shared.throws = true
    expect(judgeCaptureEnabled()).toBe(false)
  })
})

describe('createJudgeCaptureWriter', () => {
  it('writes <dir>/YYYYMMDD.jsonl (local date): a system record, then the call that names it', async () => {
    const w = createJudgeCaptureWriter({ dir: JUDGE_DIR, now: () => AT })
    w.write(call())
    await w.idle()

    expect(readdirSync(JUDGE_DIR())).toEqual(['20261024.jsonl'])
    const [system, c] = lines('20261024.jsonl')
    expect(system).toEqual({
      kind: 'system',
      ts: AT.toISOString(),
      systemHash: 'judge-aaaa',
      system: 'SYSTEM PROMPT A'
    })
    expect(c).toMatchObject({
      kind: 'call',
      engine: 'pi',
      routingId: 'r1',
      sessionId: 's1',
      route: 'chatgpt · gpt-6-luna',
      systemHash: 'judge-aaaa',
      user: 'ACTION',
      outcome: 'ok',
      raw: '<severity>1</severity>'
    })
    // The call references the prompt by hash; it does not repeat it.
    expect('system' in c).toBe(false)
  })

  it('writes each system prompt once per day file, before the first call that references it', async () => {
    const w = createJudgeCaptureWriter({ dir: JUDGE_DIR, now: () => AT })
    w.write(call({ user: 'one' }))
    w.write(call({ user: 'two' }))
    w.write(call({ user: 'three', systemHash: 'judge-bbbb', system: 'SYSTEM PROMPT B' }))
    w.write(call({ user: 'four' }))
    await w.idle()

    expect(lines('20261024.jsonl').map((r) => `${r.kind}:${r.user ?? r.systemHash}`)).toEqual([
      'system:judge-aaaa',
      'call:one',
      'call:two',
      'system:judge-bbbb',
      'call:three',
      'call:four'
    ])
  })

  it('a new day file gets its own system record', async () => {
    let now = AT
    const w = createJudgeCaptureWriter({ dir: JUDGE_DIR, now: () => now })
    w.write(call({ user: 'today' }))
    await w.idle()
    now = new Date(2026, 9, 25, 0, 5, 0)
    w.write(call({ user: 'tomorrow' }))
    await w.idle()

    expect(lines('20261024.jsonl').map((r) => r.kind)).toEqual(['system', 'call'])
    expect(lines('20261025.jsonl').map((r) => r.kind)).toEqual(['system', 'call'])
  })

  it('a fresh writer (a restart) may repeat the system record', async () => {
    const a = createJudgeCaptureWriter({ dir: JUDGE_DIR, now: () => AT })
    a.write(call())
    await a.idle()
    const b = createJudgeCaptureWriter({ dir: JUDGE_DIR, now: () => AT })
    b.write(call())
    await b.idle()

    expect(lines('20261024.jsonl').map((r) => r.kind)).toEqual(['system', 'call', 'system', 'call'])
  })

  it('two concurrent calls make whole, parseable lines — big records never interleave', async () => {
    const w = createJudgeCaptureWriter({ dir: JUDGE_DIR, now: () => AT })
    const big = (c: string): string => `${c}\n"quoted"\u2028`.repeat(200_000)
    w.write(call({ user: big('a'), raw: big('A') }))
    w.write(call({ user: big('b'), raw: big('B'), systemHash: 'judge-bbbb', system: big('S') }))
    await w.idle()

    const rows = lines('20261024.jsonl')
    expect(rows.map((r) => r.kind)).toEqual(['system', 'call', 'system', 'call'])
    const calls = rows.filter((r) => r.kind === 'call')
    expect(calls[0].user).toBe(big('a'))
    expect(calls[1].raw).toBe(big('B'))
  })

  it('removes day files older than 14 days (once, on the first write) and keeps newer ones', async () => {
    mkdirSync(JUDGE_DIR(), { recursive: true })
    const old = '20260909.jsonl' // 45 days before AT
    const edge = '20261011.jsonl' // 13 days: kept
    const recent = '20261023.jsonl'
    const stray = 'notes.txt'
    for (const name of [old, edge, recent, stray]) writeFileSync(join(JUDGE_DIR(), name), 'x\n')
    const w = createJudgeCaptureWriter({ dir: JUDGE_DIR, now: () => AT })

    w.write(call())
    await w.idle()

    expect(readdirSync(JUDGE_DIR()).sort()).toEqual([edge, recent, '20261024.jsonl', stray].sort())

    // Once per process: an old file that appears later is not touched by the next write.
    writeFileSync(join(JUDGE_DIR(), old), 'x\n')
    w.write(call())
    await w.idle()
    expect(existsSync(join(JUDGE_DIR(), old))).toBe(true)
  })

  it('never throws and never rejects when the directory cannot be created; warns once', async () => {
    const blocker = join(dir, 'file')
    writeFileSync(blocker, 'not a dir')
    const w = createJudgeCaptureWriter({ dir: () => join(blocker, 'judge'), now: () => AT })

    expect(() => w.write(call())).not.toThrow()
    w.write(call())
    await expect(w.idle()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toBe('JudgeCapture')
  })

  it('a failed write is retried with its system record on the next call', async () => {
    mkdirSync(JUDGE_DIR(), { recursive: true })
    // A directory where today's file should be makes the append fail.
    mkdirSync(join(JUDGE_DIR(), '20261024.jsonl'))
    const w = createJudgeCaptureWriter({ dir: JUDGE_DIR, now: () => AT })
    w.write(call({ user: 'lost' }))
    await w.idle()
    expect(warn).toHaveBeenCalledTimes(1)

    rmSync(join(JUDGE_DIR(), '20261024.jsonl'), { recursive: true })
    w.write(call({ user: 'kept' }))
    await w.idle()
    expect(lines('20261024.jsonl').map((r) => r.kind)).toEqual(['system', 'call'])
  })
})
