/**
 * @vitest-environment node
 *
 * ADR-102 Arc 2 — the content-first split of `loadSessionHistory`.
 *
 *  - `deferStatusLine` returns the same transcript result as the full read, minus
 *    the cost/token pass: `statusLine: null`, progress plan `total = M`.
 *  - `loadSessionStatusLine` computes that pass alone: its result deep-equals the
 *    full read's `statusLine`, progress plan `total = M + S`, phase `costs`.
 *  - `subagentIndex` lists every agent the main transcript (or a nested agent's
 *    sidecar) mapped, by origin tool_use id, with sizes / recency / parent / names.
 *  - `transcriptMtimeMs` is the main file's mtime when the read STARTED.
 *
 * `CLAUDE_PROJECTS_DIR` derives from os.homedir() at module load, so homedir is
 * mocked to a temp dir BEFORE importing session-history. Never the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const { join } = await import('path')
  const home = join(actual.tmpdir(), `claudeui-history-deferred-${process.pid}`)
  return { ...actual, homedir: (): string => home }
})

// The durable dispatched-cost rows come from the operational DB; a fixed row
// proves BOTH paths merge it (the status line is one function behind both).
const dispatched = vi.hoisted(() => ({
  rows: [] as Array<{ targetEngine: string; targetModel: string; costUsd: number }>,
  calls: 0
}))
vi.mock('../../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/services/db')>()
  return {
    ...actual,
    dispatchedCostsByRouting: () => {
      dispatched.calls++
      return dispatched.rows
    }
  }
})

import { loadSessionHistory, loadSessionStatusLine } from '../../../core/services/session-history'
import type { InvokeProgress } from '../../../shared/remote-protocol'

const TMP_HOME = os.homedir()
const PROJECT_KEY = 'test-project-deferred'
const SESSION_ID = 'aaaaaaaa-2222-3333-4444-555555555555'
const TS = '2026-09-30T04:03:00.000Z'

const AGENT_A = 'af110ad6ad039a313' // depth 1, mapped by the main transcript
const AGENT_B = 'ae1c808a813a4dcb5' // nested in A: mapped by its sidecar
const AGENT_C = 'a3333333333333333' // depth 1, mapped, but its transcript file is gone
const AGENT_D = 'a4444444444444444' // depth 1, mapped, sidecar without a toolUseId
const AGENT_E = 'a5555555555555555' // a file nothing maps: not indexed
const ORIGIN_A = 'toolu_01A'
const ORIGIN_B = 'toolu_01B'
const ORIGIN_C = 'toolu_01C'
const ORIGIN_D = 'toolu_01D'

const projectDir = (): string => path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY)
const mainFile = (): string => path.join(projectDir(), `${SESSION_ID}.jsonl`)
const subagentsDir = (): string => path.join(projectDir(), SESSION_ID, 'subagents')
const agentFile = (id: string): string => path.join(subagentsDir(), `agent-${id}.jsonl`)

const PADDING = 'héllo wörld — 日本語 '.repeat(40)

function turn(n: number): object[] {
  return [
    {
      type: 'user',
      message: { role: 'user', content: `q${n} ${PADDING}` },
      uuid: `u${n}`,
      timestamp: TS
    },
    {
      type: 'assistant',
      message: {
        id: `msg_${n}`,
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: `a${n} ${PADDING}` }],
        usage: { input_tokens: 10 + n, output_tokens: 5 }
      },
      uuid: `a${n}`,
      timestamp: TS
    }
  ]
}

const manyTurns = (from: number, count: number): object[] =>
  Array.from({ length: count }, (_, i) => turn(from + i)).flat()

function writeLines(file: string, lines: object[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function writeSidecar(agentId: string, meta: Record<string, unknown>): void {
  fs.mkdirSync(subagentsDir(), { recursive: true })
  fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.meta.json`), JSON.stringify(meta))
}

/** A Task spawn + its async-launch result, the shape cli.js 2.1.280 writes. */
function spawn(toolUseId: string, agentId: string): object[] {
  return [
    {
      type: 'assistant',
      message: {
        id: `msg_${toolUseId}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: 'x' } }]
      },
      uuid: `s-${toolUseId}`,
      timestamp: TS
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)`
          }
        ]
      },
      toolUseResult: { agentId, isAsync: true },
      uuid: `r-${toolUseId}`,
      timestamp: TS
    }
  ]
}

function stamp(file: string, secondsAgo: number): void {
  const t = new Date(Date.now() - secondsAgo * 1000)
  fs.utimesSync(file, t, t)
}

async function withProgress(
  fn: (onProgress: (p: InvokeProgress) => void) => Promise<unknown>
): Promise<InvokeProgress[]> {
  const reports: InvokeProgress[] = []
  await fn((p) => reports.push({ ...p }))
  return reports
}

const sizeOf = (file: string): number => fs.statSync(file).size

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
  dispatched.rows = []
  dispatched.calls = 0
  writeLines(mainFile(), [
    ...manyTurns(0, 120),
    ...spawn(ORIGIN_A, AGENT_A),
    ...spawn(ORIGIN_C, AGENT_C),
    ...spawn(ORIGIN_D, AGENT_D)
  ])
  writeLines(agentFile(AGENT_A), manyTurns(1000, 50))
  writeLines(agentFile(AGENT_B), manyTurns(2000, 20))
  writeLines(agentFile(AGENT_D), manyTurns(3000, 10))
  writeLines(agentFile(AGENT_E), manyTurns(4000, 5))
  writeSidecar(AGENT_A, {
    agentType: 'general-purpose',
    name: 'alpha',
    description: 'first agent',
    toolUseId: ORIGIN_A,
    spawnDepth: 1
  })
  writeSidecar(AGENT_B, {
    agentType: 'Explore',
    description: 'nested in alpha',
    toolUseId: ORIGIN_B,
    parentAgentId: AGENT_A,
    spawnDepth: 2
  })
  // ~5% of real sidecars carry no toolUseId: the agent keeps its mapping from
  // the main transcript but nothing else about it is known.
  writeSidecar(AGENT_D, { agentType: 'general-purpose', name: 'ignored', spawnDepth: 1 })
  // An unmapped agent: a sidecar with an origin but no parent maps nothing.
  writeSidecar(AGENT_E, { toolUseId: 'toolu_01E', spawnDepth: 1 })
  stamp(agentFile(AGENT_A), 300)
  stamp(agentFile(AGENT_B), 100)
  stamp(agentFile(AGENT_D), 200)
  stamp(agentFile(AGENT_E), 50)
})

afterEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('loadSessionHistory — deferStatusLine', () => {
  it('returns the full read minus the status line: same messages, notifications and index', async () => {
    const full = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    const deferred = await loadSessionHistory(SESSION_ID, PROJECT_KEY, undefined, {
      deferStatusLine: true
    })

    expect(full.statusLine).not.toBeNull()
    expect(deferred.statusLine).toBeNull()
    expect(deferred.messages.length).toBeGreaterThan(100)
    expect({ ...deferred, statusLine: full.statusLine }).toEqual(full)
  })

  it('plans total = M (the transcript pass alone): first report 0, last report M, phase transcript', async () => {
    const M = sizeOf(mainFile())
    expect(M).toBeGreaterThan(3 * 65536)
    const reports = await withProgress((onProgress) =>
      loadSessionHistory(SESSION_ID, PROJECT_KEY, undefined, { deferStatusLine: true, onProgress })
    )

    expect(reports[0]).toEqual({ done: 0, total: M, phase: 'transcript' })
    expect(reports.at(-1)).toEqual({ done: M, total: M, phase: 'transcript' })
    expect(reports.every((r) => r.total === M && r.phase === 'transcript')).toBe(true)
    for (let i = 1; i < reports.length; i++) {
      expect(reports[i].done).toBeGreaterThanOrEqual(reports[i - 1].done)
    }
    expect(reports.length).toBeGreaterThan(4)
  })

  it('a transcript that shrinks after the stat still ends exactly on M (the plan closes)', async () => {
    const M = sizeOf(mainFile())
    const reports: InvokeProgress[] = []
    await loadSessionHistory(SESSION_ID, PROJECT_KEY, undefined, {
      deferStatusLine: true,
      onProgress: (p) => {
        // The plan is fixed by the first report; then the file loses half its bytes.
        if (reports.length === 0) fs.truncateSync(mainFile(), Math.floor(M / 2))
        reports.push({ ...p })
      }
    })
    expect(reports[0].total).toBe(M)
    expect(reports.at(-1)).toEqual({ done: M, total: M, phase: 'transcript' })
  })

  it('the full read keeps its 2M + 2S plan (nothing about the old contract moved)', async () => {
    const M = sizeOf(mainFile())
    const S = [AGENT_A, AGENT_B, AGENT_D, AGENT_E].reduce((n, id) => n + sizeOf(agentFile(id)), 0)
    const reports = await withProgress((onProgress) =>
      loadSessionHistory(SESSION_ID, PROJECT_KEY, undefined, { onProgress })
    )
    expect(reports[0]).toEqual({ done: 0, total: 2 * M + 2 * S, phase: 'transcript' })
    expect(reports.at(-1)).toEqual({ done: 2 * M + S, total: 2 * M + 2 * S, phase: 'costs' })
  })

  it('a deferred read never queries the dispatched-cost ledger; the full read and the status channel do', async () => {
    await loadSessionHistory(SESSION_ID, PROJECT_KEY, undefined, { deferStatusLine: true })
    expect(dispatched.calls).toBe(0)
    await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(dispatched.calls).toBe(1)
    await loadSessionStatusLine(SESSION_ID, PROJECT_KEY)
    expect(dispatched.calls).toBe(2)
  })
})

describe('loadSessionStatusLine', () => {
  it('deep-equals the status line of the full read of the same transcript', async () => {
    dispatched.rows = [{ targetEngine: 'codex', targetModel: 'gpt-x', costUsd: 0.5 }]
    const full = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    const status = await loadSessionStatusLine(SESSION_ID, PROJECT_KEY)

    expect(status).toEqual(full.statusLine)
    // Not a vacuous equality: the subagent spend and the dispatched row are in it.
    expect(status.totalTokens).toBeGreaterThan(0)
    expect(status.modelCosts?.some((m) => m.dispatched === true && m.modelId === 'gpt-x')).toBe(
      true
    )
    expect(status.modelCosts?.some((m) => m.modelId.includes('sonnet'))).toBe(true)
  })

  it('plans total = M + S in phase costs: first report 0, last report the total, monotonic', async () => {
    const M = sizeOf(mainFile())
    const S = [AGENT_A, AGENT_B, AGENT_D, AGENT_E].reduce((n, id) => n + sizeOf(agentFile(id)), 0)
    const reports = await withProgress((onProgress) =>
      loadSessionStatusLine(SESSION_ID, PROJECT_KEY, onProgress)
    )

    expect(reports[0]).toEqual({ done: 0, total: M + S, phase: 'costs' })
    expect(reports.at(-1)).toEqual({ done: M + S, total: M + S, phase: 'costs' })
    expect(reports.every((r) => r.total === M + S && r.phase === 'costs')).toBe(true)
    for (let i = 1; i < reports.length; i++) {
      expect(reports[i].done).toBeGreaterThanOrEqual(reports[i - 1].done)
    }
    // The metrics pass ends exactly at M, then the subagent fold takes over.
    expect(reports.some((r) => r.done === M)).toBe(true)
    expect(reports.length).toBeGreaterThan(8)
  })

  it('reports nothing without a callback and yields the same figures', async () => {
    const a = await loadSessionStatusLine(SESSION_ID, PROJECT_KEY)
    const b = await loadSessionStatusLine(SESSION_ID, PROJECT_KEY, () => {})
    expect(b).toEqual(a)
  })

  it('a missing transcript resolves an all-zero status line and a closed plan', async () => {
    fs.rmSync(mainFile())
    fs.rmSync(path.join(projectDir(), SESSION_ID), { recursive: true, force: true })
    const reports = await withProgress((onProgress) =>
      loadSessionStatusLine(SESSION_ID, PROJECT_KEY, onProgress)
    )
    const status = await loadSessionStatusLine(SESSION_ID, PROJECT_KEY)
    expect(status.totalTokens).toBe(0)
    expect(reports.every((r) => r.done <= (r.total ?? 0))).toBe(true)
  })
})

describe('loadSessionHistory — subagentIndex', () => {
  it('lists every mapped agent by origin tool_use id, with bytes, parent and sidecar names', async () => {
    const { subagentIndex } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(subagentIndex).toBeDefined()
    expect(Object.keys(subagentIndex!).sort()).toEqual(
      [ORIGIN_A, ORIGIN_B, ORIGIN_C, ORIGIN_D].sort()
    )

    expect(subagentIndex![ORIGIN_A]).toEqual({
      agentId: AGENT_A,
      parentToolUseId: null,
      bytes: sizeOf(agentFile(AGENT_A)),
      order: fs.statSync(agentFile(AGENT_A)).mtimeMs,
      name: 'alpha',
      description: 'first agent',
      agentType: 'general-purpose'
    })
    // Nested: the sidecar's parentAgentId maps to the PARENT'S origin tool_use id.
    expect(subagentIndex![ORIGIN_B]).toEqual({
      agentId: AGENT_B,
      parentToolUseId: ORIGIN_A,
      bytes: sizeOf(agentFile(AGENT_B)),
      order: fs.statSync(agentFile(AGENT_B)).mtimeMs,
      description: 'nested in alpha',
      agentType: 'Explore'
    })
  })

  it('lists an agent whose file is missing with bytes 0 and order 0', async () => {
    const { subagentIndex } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(subagentIndex![ORIGIN_C]).toEqual({
      agentId: AGENT_C,
      parentToolUseId: null,
      bytes: 0,
      order: 0
    })
  })

  it('an agent whose sidecar lacks a toolUseId keeps its mapping but no names or parent', async () => {
    const { subagentIndex, agentIdToToolUseId } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(agentIdToToolUseId[AGENT_D]).toBe(ORIGIN_D)
    expect(subagentIndex![ORIGIN_D]).toEqual({
      agentId: AGENT_D,
      parentToolUseId: null,
      bytes: sizeOf(agentFile(AGENT_D)),
      order: fs.statSync(agentFile(AGENT_D)).mtimeMs
    })
  })

  it('does not index a transcript file nothing maps', async () => {
    const { subagentIndex } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(Object.values(subagentIndex!).some((e) => e.agentId === AGENT_E)).toBe(false)
  })

  it('order is the file mtime: a newer transcript sorts higher', async () => {
    const { subagentIndex } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    const byOrder = Object.values(subagentIndex!)
      .filter((e) => e.bytes > 0)
      .sort((a, b) => b.order - a.order)
      .map((e) => e.agentId)
    // stamped: B 100 s ago (newest), D 200 s ago, A 300 s ago.
    expect(byOrder).toEqual([AGENT_B, AGENT_D, AGENT_A])
  })

  it('is a null-prototype object, so an origin id named __proto__ stays plain data', async () => {
    writeSidecar(AGENT_B, {
      toolUseId: '__proto__',
      parentAgentId: AGENT_A,
      spawnDepth: 2
    })
    const { subagentIndex } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(Object.getPrototypeOf(subagentIndex)).toBeNull()
    expect(Object.keys(subagentIndex!)).toContain('__proto__')
    expect(subagentIndex!['__proto__']).toMatchObject({ agentId: AGENT_B })
    expect(Object.keys(subagentIndex!)).toHaveLength(4)
  })

  it('is present on a deferred read, and empty (not absent) for a session without subagents', async () => {
    const deferred = await loadSessionHistory(SESSION_ID, PROJECT_KEY, undefined, {
      deferStatusLine: true
    })
    expect(Object.keys(deferred.subagentIndex!)).toHaveLength(4)

    fs.rmSync(path.join(projectDir(), SESSION_ID), { recursive: true, force: true })
    writeLines(mainFile(), manyTurns(0, 3))
    const none = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(none.subagentIndex).toEqual({})
  })
})

describe('loadSessionHistory — transcriptMtimeMs', () => {
  it('is the main transcript mtime', async () => {
    const t = new Date('2026-01-02T03:04:05.000Z')
    fs.utimesSync(mainFile(), t, t)
    const result = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(result.transcriptMtimeMs).toBe(t.getTime())
  })

  it('is taken before the first byte is read: a file that changes mid-read does not move it', async () => {
    const before = new Date('2026-01-02T03:04:05.000Z')
    const after = new Date('2026-01-02T03:09:00.000Z')
    fs.utimesSync(mainFile(), before, before)
    const result = await loadSessionHistory(SESSION_ID, PROJECT_KEY, undefined, {
      onProgress: (p) => {
        // The first report precedes the read; the session "writes" right after it.
        if (p.done === 0) fs.utimesSync(mainFile(), after, after)
      }
    })
    expect(result.transcriptMtimeMs).toBe(before.getTime())
  })

  it('is absent when there is no transcript', async () => {
    fs.rmSync(mainFile())
    const result = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(result.transcriptMtimeMs).toBeUndefined()
  })
})
