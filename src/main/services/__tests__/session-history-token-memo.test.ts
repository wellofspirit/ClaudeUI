/**
 * @vitest-environment node
 *
 * The token/cost fold memo behind `computeTokenMetrics` (session-history.ts).
 *
 * A reopened session's transcript and its subagent files were folded up to three
 * times before the first prompt (the ADR-102 status pass, the spawn's resume
 * seed, a respawn). The memo makes the repeats free; what these tests pin is that
 * "free" never means "stale": a hit equals a fresh compute for every `model`, and
 * any change to the main file or the subagent set re-folds.
 *
 * A fold is observable without spying on fs: every full read of the fixture logs
 * exactly one `Failed to parse line in computeTokenMetrics` warning (the fixture
 * carries one malformed line), a memo hit logs none.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  clearTokenFoldMemo,
  computeTokenMetrics,
  tokenFoldMemoSize
} from '../../../core/services/session-history'
import { logger } from '../../../core/services/logger'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-token-memo-'))
let seq = 0
const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
/** Full reads of the fixture so far (one malformed line each). */
const folds = (): number =>
  warn.mock.calls.filter((c) => String(c[1]).includes('in computeTokenMetrics')).length

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const ts = (s: number): string => new Date(T0 + s * 1000).toISOString()

/** No model on the main-chain assistant, so the caller's `model` sizes the window. */
const mainTurn = (at: number, input: number): object => ({
  type: 'assistant',
  timestamp: ts(at),
  message: { usage: { input_tokens: input, output_tokens: 50, cache_read_input_tokens: 5000 } }
})
const sidechain = (id: string, model: string, input: number): object => ({
  type: 'assistant',
  isSidechain: true,
  message: { id, model, usage: { input_tokens: input, output_tokens: 0 } }
})
const toJsonl = (lines: Array<object | string>): string =>
  lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'

function writeMain(lines: Array<object | string> = []): string {
  const file = path.join(ROOT, `sess-${seq++}.jsonl`)
  fs.writeFileSync(
    file,
    toJsonl([
      { type: 'user', timestamp: ts(0) },
      mainTurn(5, 100_000),
      sidechain(`m-${seq}`, 'claude-sonnet-4-6', 400_000),
      'NOT JSON — one parse warning per full fold',
      ...lines
    ])
  )
  return file
}
const subDir = (main: string): string =>
  path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents')
function writeSub(main: string, name: string, lines: object[]): string {
  fs.mkdirSync(subDir(main), { recursive: true })
  const file = path.join(subDir(main), name)
  fs.writeFileSync(file, toJsonl(lines))
  return file
}
const subLine = (id: string, input: number): object => sidechain(id, 'claude-opus-4-8', input)

/** What a cold compute says now, without disturbing what the memo holds. */
async function fresh(file: string, model?: string, anchor?: string) {
  clearTokenFoldMemo()
  return computeTokenMetrics(file, model, anchor)
}

beforeEach(() => {
  clearTokenFoldMemo()
  warn.mockClear()
})
afterEach(() => {
  clearTokenFoldMemo()
})
afterAll(() => {
  warn.mockRestore()
  fs.rmSync(ROOT, { recursive: true, force: true })
})

describe('token fold memo — a hit is a fresh compute', () => {
  it('returns deep-equal output for two different `model` values off ONE fold', async () => {
    const main = writeMain()
    writeSub(main, 'agent-a.jsonl', [subLine('s1', 200_000)])

    const first = await computeTokenMetrics(main, 'default')
    expect(folds()).toBe(1)
    const opus = await computeTokenMetrics(main, 'opus')
    const again = await computeTokenMetrics(main, 'default')
    expect(folds()).toBe(1) // both were hits

    // The caller's model really is an input: it sizes the window differently...
    expect(first.contextWindow.size).toBe(200_000)
    expect(opus.contextWindow.size).toBe(1_000_000)
    // ...and each hit equals what a cold compute says for that same model.
    expect(opus).toEqual(await fresh(main, 'opus'))
    expect(again).toEqual(first)
    expect(first).toEqual(await fresh(main, 'default'))
    // The subagent spend rode along: sonnet from the sidechain line, opus from the agent file.
    expect(first.modelCosts?.map((m) => m.modelId).sort()).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-4-6'
    ])
  })

  it('hands every caller its own result (mutating one never reaches the memo)', async () => {
    const main = writeMain()
    const a = await computeTokenMetrics(main)
    a.modelCosts!.push({ engineId: 'claude', modelId: 'x', costUsd: 99 })
    a.totalCostUsd = 12345
    const b = await computeTokenMetrics(main)
    expect(folds()).toBe(1)
    expect(b).toEqual(await fresh(main))
    expect(b.modelCosts!.some((m) => m.modelId === 'x')).toBe(false)
  })

  it('reports the bytes a hit skipped (main + subagents) so a progress bar still lands', async () => {
    const main = writeMain()
    const sub = writeSub(main, 'agent-a.jsonl', [subLine('s1', 1)])
    await computeTokenMetrics(main)
    const deltas: number[] = []
    await computeTokenMetrics(main, undefined, undefined, (d) => deltas.push(d))
    expect(folds()).toBe(1)
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(fs.statSync(main).size + fs.statSync(sub).size)
  })

  it('keys the fork anchor: an anchored read neither reuses nor poisons the whole-file fold', async () => {
    const main = writeMain([
      { type: 'user', uuid: 'anchor', timestamp: ts(10) },
      mainTurn(20, 700_000) // past the anchor
    ])
    const whole = await computeTokenMetrics(main, 'default')
    const forked = await computeTokenMetrics(main, 'default', 'anchor')
    expect(folds()).toBe(2)
    // (the legacy sums count the sidechain line too: 100k + 400k, then +700k past the anchor)
    expect(forked.totalInputTokens).toBe(500_000)
    expect(whole.totalInputTokens).toBe(1_200_000)
    // Both are now memoized, each under its own key.
    expect(await computeTokenMetrics(main, 'default')).toEqual(whole)
    expect(await computeTokenMetrics(main, 'default', 'anchor')).toEqual(forked)
    expect(folds()).toBe(2)
  })
})

describe('token fold memo — any change to an input re-folds', () => {
  async function expectRefold(main: string, mutate: () => void): Promise<void> {
    await computeTokenMetrics(main, 'default')
    const before = folds()
    mutate()
    const after = await computeTokenMetrics(main, 'default')
    expect(folds()).toBe(before + 1)
    expect(after).toEqual(await fresh(main, 'default'))
  }

  it('main file grows', async () => {
    const main = writeMain()
    await expectRefold(main, () => fs.appendFileSync(main, toJsonl([mainTurn(30, 250_000)])))
  })

  it('main file rewritten at the SAME size: the mtime alone invalidates', async () => {
    const main = writeMain()
    await expectRefold(main, () => {
      const text = fs
        .readFileSync(main, 'utf-8')
        .replace('"input_tokens":100000', '"input_tokens":100001')
      fs.writeFileSync(main, text)
      const later = new Date(Date.now() + 5000)
      fs.utimesSync(main, later, later)
    })
  })

  it('a subagent file is added', async () => {
    const main = writeMain()
    writeSub(main, 'agent-a.jsonl', [subLine('s1', 100_000)])
    await expectRefold(main, () => writeSub(main, 'agent-b.jsonl', [subLine('s2', 900_000)]))
  })

  it('a subagent file changes', async () => {
    const main = writeMain()
    const sub = writeSub(main, 'agent-a.jsonl', [subLine('s1', 100_000)])
    await expectRefold(main, () => fs.appendFileSync(sub, toJsonl([subLine('s2', 900_000)])))
  })

  it('a subagent file is removed', async () => {
    const main = writeMain()
    writeSub(main, 'agent-a.jsonl', [subLine('s1', 100_000)])
    const gone = writeSub(main, 'agent-b.jsonl', [subLine('s2', 900_000)])
    await expectRefold(main, () => fs.unlinkSync(gone))
  })

  it('a non-agent file under subagents/ is not an input (no needless re-fold)', async () => {
    const main = writeMain()
    writeSub(main, 'agent-a.jsonl', [subLine('s1', 100_000)])
    await computeTokenMetrics(main)
    fs.writeFileSync(path.join(subDir(main), 'agent-a.meta.json'), '{"name":"x"}')
    await computeTokenMetrics(main)
    expect(folds()).toBe(1)
  })
})

describe('token fold memo — only a complete read is stored', () => {
  it('a missing transcript is the empty line and leaves nothing behind', async () => {
    const m = await computeTokenMetrics(path.join(ROOT, 'never-written.jsonl'))
    expect(m.totalTokens).toBe(0)
    expect(tokenFoldMemoSize()).toBe(0)
  })

  it('a read the transcript outgrew mid-fold is returned but not stored', async () => {
    const main = writeMain()
    let appended = false
    await computeTokenMetrics(main, undefined, undefined, () => {
      // cli.js appending while we read: the signature taken before the read no
      // longer describes the file the fold saw.
      if (!appended) {
        appended = true
        fs.appendFileSync(main, toJsonl([mainTurn(40, 1)]))
      }
    })
    expect(tokenFoldMemoSize()).toBe(0)
    // The next call folds the file as it is now, and THAT one is stored.
    const second = await computeTokenMetrics(main)
    expect(tokenFoldMemoSize()).toBe(1)
    expect(second).toEqual(await fresh(main))
  })
})

describe('token fold memo — bounded', () => {
  it('keeps at most 8 transcripts, evicting the least recently used', async () => {
    const files = Array.from({ length: 10 }, () => writeMain())
    for (const f of files) await computeTokenMetrics(f)
    expect(tokenFoldMemoSize()).toBe(8)
    const n = folds()
    expect(n).toBe(10)

    await computeTokenMetrics(files[9]) // newest: still held
    await computeTokenMetrics(files[2]) // oldest survivor: still held
    expect(folds()).toBe(n)
    await computeTokenMetrics(files[0]) // evicted
    expect(folds()).toBe(n + 1)
  })

  it('a hit refreshes recency', async () => {
    const files = Array.from({ length: 9 }, () => writeMain())
    for (const f of files.slice(0, 8)) await computeTokenMetrics(f)
    await computeTokenMetrics(files[0]) // touch the oldest
    await computeTokenMetrics(files[8]) // 9th entry evicts the LRU, now files[1]
    const n = folds()
    await computeTokenMetrics(files[0])
    expect(folds()).toBe(n) // survived
    await computeTokenMetrics(files[1])
    expect(folds()).toBe(n + 1) // evicted
  })
})

describe('token fold memo — concurrent callers share one read', () => {
  it('a second caller joins the in-flight fold: one read, equal output, its bytes reported once', async () => {
    const main = writeMain()
    const sub = writeSub(main, 'agent-a.jsonl', [subLine('s1', 200_000)])
    const total = fs.statSync(main).size + fs.statSync(sub).size
    const leaderDeltas: number[] = []
    const joinerDeltas: number[] = []

    // Both start before either read can finish: the second sees the first in flight.
    const [first, second] = await Promise.all([
      computeTokenMetrics(main, 'default', undefined, (d) => leaderDeltas.push(d)),
      computeTokenMetrics(main, 'opus', undefined, (d) => joinerDeltas.push(d))
    ])

    expect(folds()).toBe(1)
    // The joiner's own `model` still applies to the shared fold.
    expect(first.contextWindow.size).toBe(200_000)
    expect(second.contextWindow.size).toBe(1_000_000)
    expect(first).toEqual(await fresh(main, 'default'))
    expect(second).toEqual(await fresh(main, 'opus'))
    // Progress is not starved: the leader streams the bytes, the joiner gets the
    // whole total once, on completion (like a hit).
    expect(leaderDeltas.reduce((a, b) => a + b, 0)).toBe(total)
    expect(joinerDeltas).toEqual([total])
  })

  it('a caller whose signature differs from the in-flight fold folds for itself', async () => {
    const main = writeMain()
    const a = computeTokenMetrics(main)
    // The transcript moves after the first caller took its signature (and before
    // the second takes its own): joining would hand back a fold of the old file.
    fs.appendFileSync(main, toJsonl([mainTurn(40, 1_000_000)]))
    const b = computeTokenMetrics(main)
    await Promise.all([a, b])
    expect(folds()).toBe(2)
  })

  it('the in-flight entry is cleared once settled: a later call hits the memo, not a stale promise', async () => {
    const main = writeMain()
    await Promise.all([computeTokenMetrics(main), computeTokenMetrics(main)])
    expect(folds()).toBe(1)
    await computeTokenMetrics(main)
    expect(folds()).toBe(1) // memo hit
    // And after a change it folds again rather than joining anything left behind.
    fs.appendFileSync(main, toJsonl([mainTurn(40, 1)]))
    await computeTokenMetrics(main)
    expect(folds()).toBe(2)
  })

  it('a failed in-flight fold fails its joiner too (null → the empty line), caches nothing, and the next call reads again', async () => {
    // A directory where the transcript should be: it exists and stats, but the read errors.
    const bad = path.join(ROOT, `sess-dir-${seq++}.jsonl`)
    fs.mkdirSync(bad)
    const joinerDeltas: number[] = []
    const [a, b] = await Promise.all([
      computeTokenMetrics(bad),
      computeTokenMetrics(bad, undefined, undefined, (d) => joinerDeltas.push(d))
    ])
    expect(a.totalTokens).toBe(0)
    expect(b).toEqual(a)
    expect(joinerDeltas).toEqual([]) // nothing was read, so no bytes to claim
    expect(tokenFoldMemoSize()).toBe(0)

    // Becomes a real transcript: nothing failed was left in flight or memoized.
    fs.rmdirSync(bad)
    fs.writeFileSync(bad, toJsonl([{ type: 'user', timestamp: ts(0) }, mainTurn(5, 100_000)]))
    const ok = await computeTokenMetrics(bad)
    expect(ok.totalInputTokens).toBe(100_000)
  })
})
