/**
 * @vitest-environment node
 *
 * ADR-102 — byte progress of `loadSessionHistory`.
 *
 * The Claude read reports raw bytes planned over the whole load:
 * `total = 2*M + 2*S` (M = main transcript, S = all `subagents/agent-*.jsonl`);
 * the first report is `done: 0` with that total, the LAST report is
 * `done = 2*M + S` (the renderer's per-agent fetches add the remaining S), and
 * `done` never decreases. Asking for progress must not change the result.
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
  const home = join(actual.tmpdir(), `claudeui-history-progress-${process.pid}`)
  return { ...actual, homedir: (): string => home }
})

import { loadSessionHistory } from '../../../core/services/session-history'
import type { InvokeProgress } from '../../../shared/remote-protocol'

const TMP_HOME = os.homedir()
const PROJECT_KEY = 'test-project-progress'
const SESSION_ID = '99999999-2222-3333-4444-555555555555'
const TS = '2026-09-30T04:03:00.000Z'

const projectDir = (): string => path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY)
const mainFile = (): string => path.join(projectDir(), `${SESSION_ID}.jsonl`)
const subagentsDir = (): string => path.join(projectDir(), SESSION_ID, 'subagents')

/** Multi-byte text, so a char count and a byte count disagree. */
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
        usage: { input_tokens: 10, output_tokens: 5 }
      },
      uuid: `a${n}`,
      timestamp: TS
    }
  ]
}

function writeLines(file: string, lines: object[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** Enough turns to span several 64 KiB stream chunks. */
function manyTurns(from: number, count: number): object[] {
  return Array.from({ length: count }, (_, i) => turn(from + i)).flat()
}

function writeSubagent(agentId: string, turns: number): void {
  writeLines(path.join(subagentsDir(), `agent-${agentId}.jsonl`), manyTurns(1000, turns))
}

async function loadWithProgress(
  anchor?: string
): Promise<{ result: Awaited<ReturnType<typeof loadSessionHistory>>; reports: InvokeProgress[] }> {
  const reports: InvokeProgress[] = []
  const result = await loadSessionHistory(SESSION_ID, PROJECT_KEY, anchor, (p) => {
    reports.push({ ...p })
  })
  return { result, reports }
}

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
  writeLines(mainFile(), manyTurns(0, 120))
  writeSubagent('aaa111', 60)
  writeSubagent('bbb222', 25)
  // Not a transcript: the sidecar must not count toward the plan.
  fs.writeFileSync(path.join(subagentsDir(), 'agent-aaa111.meta.json'), '{"toolUseId":"x"}')
})

afterEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('loadSessionHistory — progress (ADR-102)', () => {
  it('plans total = 2*M + 2*S, starts at 0 and ends at 2*M + S', async () => {
    const M = fs.statSync(mainFile()).size
    const S =
      fs.statSync(path.join(subagentsDir(), 'agent-aaa111.jsonl')).size +
      fs.statSync(path.join(subagentsDir(), 'agent-bbb222.jsonl')).size
    // Guard the fixture: several chunks per file, or monotonicity proves nothing.
    expect(M).toBeGreaterThan(3 * 65536)

    const { reports } = await loadWithProgress()

    expect(reports[0]).toEqual({ done: 0, total: 2 * M + 2 * S, phase: 'transcript' })
    expect(reports.every((r) => r.total === 2 * M + 2 * S)).toBe(true)
    expect(reports.at(-1)).toEqual({ done: 2 * M + S, total: 2 * M + 2 * S, phase: 'costs' })
    // The renderer owns the last S: the read must never claim the whole job.
    expect(reports.at(-1)!.done).toBeLessThan(reports.at(-1)!.total!)
  })

  it('is monotonic, clamped to the total, and walks transcript -> costs', async () => {
    const { reports } = await loadWithProgress()
    for (let i = 1; i < reports.length; i++) {
      expect(reports[i].done).toBeGreaterThanOrEqual(reports[i - 1].done)
      expect(reports[i].done).toBeLessThanOrEqual(reports[i].total!)
    }
    const phases = reports.map((r) => r.phase)
    expect(new Set(phases)).toEqual(new Set(['transcript', 'costs']))
    expect(phases.lastIndexOf('transcript')).toBeLessThan(phases.indexOf('costs'))
    // Several intermediate frames, not just the endpoints.
    expect(reports.length).toBeGreaterThan(8)
  })

  it('counts raw bytes: each pass lands exactly on its budget despite multi-byte text', async () => {
    const M = fs.statSync(mainFile()).size
    const { reports } = await loadWithProgress()
    const transcriptDones = reports.filter((r) => r.phase === 'transcript').map((r) => r.done)
    expect(Math.max(...transcriptDones)).toBe(M)
    // The metrics pass ends exactly at 2*M, then the subagent fold takes over.
    expect(reports.some((r) => r.phase === 'costs' && r.done === 2 * M)).toBe(true)
  })

  it('returns exactly what a progress-less call returns, plus subagentFileBytes', async () => {
    const plain = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    const { result } = await loadWithProgress()
    expect(result).toEqual(plain)
    expect(result.messages.length).toBeGreaterThan(50)
  })

  it('subagentFileBytes matches the transcript files on disk (sidecars excluded)', async () => {
    const { result } = await loadWithProgress()
    expect(result.subagentFileBytes).toEqual({
      aaa111: fs.statSync(path.join(subagentsDir(), 'agent-aaa111.jsonl')).size,
      bbb222: fs.statSync(path.join(subagentsDir(), 'agent-bbb222.jsonl')).size
    })
    // Also present without a progress callback: the renderer weights by it either way.
    const plain = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(plain.subagentFileBytes).toEqual(result.subagentFileBytes)
  })

  it('a session without subagents plans total = 2*M and ends at 2*M', async () => {
    fs.rmSync(path.join(projectDir(), SESSION_ID), { recursive: true, force: true })
    const M = fs.statSync(mainFile()).size
    const { result, reports } = await loadWithProgress()
    expect(result.subagentFileBytes).toEqual({})
    expect(reports[0]).toEqual({ done: 0, total: 2 * M, phase: 'transcript' })
    expect(reports.at(-1)).toEqual({ done: 2 * M, total: 2 * M, phase: 'costs' })
  })

  it('a fork-anchored read that skips every agent still lands on 2*M + S, monotonically', async () => {
    // The anchor is the very first line: no kept tool result names an agent, so
    // the cost fold reads none of the subagent files.
    const first = JSON.parse(fs.readFileSync(mainFile(), 'utf-8').split('\n')[0]) as {
      uuid: string
    }
    const M = fs.statSync(mainFile()).size
    const S =
      fs.statSync(path.join(subagentsDir(), 'agent-aaa111.jsonl')).size +
      fs.statSync(path.join(subagentsDir(), 'agent-bbb222.jsonl')).size
    const { reports } = await loadWithProgress(first.uuid)
    expect(reports.at(-1)!.done).toBe(2 * M + S)
    for (let i = 1; i < reports.length; i++) {
      expect(reports[i].done).toBeGreaterThanOrEqual(reports[i - 1].done)
    }
  })

  it('a live file that grows after the stat is clamped to its budget (done <= total, monotonic)', async () => {
    const M = fs.statSync(mainFile()).size
    const S =
      fs.statSync(path.join(subagentsDir(), 'agent-aaa111.jsonl')).size +
      fs.statSync(path.join(subagentsDir(), 'agent-bbb222.jsonl')).size
    const reports: InvokeProgress[] = []
    await loadSessionHistory(SESSION_ID, PROJECT_KEY, undefined, (p) => {
      // The plan is fixed by the first report; the session then keeps writing.
      if (reports.length === 0) {
        fs.appendFileSync(
          mainFile(),
          manyTurns(5000, 40)
            .map((l) => JSON.stringify(l))
            .join('\n') + '\n'
        )
      }
      reports.push({ ...p })
    })
    expect(reports[0].total).toBe(2 * M + 2 * S)
    for (let i = 1; i < reports.length; i++) {
      expect(reports[i].done).toBeGreaterThanOrEqual(reports[i - 1].done)
      expect(reports[i].done).toBeLessThanOrEqual(2 * M + 2 * S)
    }
    // Each pass is held to its own budget, so growth cannot eat the next one's.
    expect(Math.max(...reports.filter((r) => r.phase === 'transcript').map((r) => r.done))).toBe(M)
    expect(reports.at(-1)!.done).toBe(2 * M + S)
  })

  it('a missing transcript still resolves empty and never reports past the total', async () => {
    fs.rmSync(mainFile())
    fs.rmSync(path.join(projectDir(), SESSION_ID), { recursive: true, force: true })
    const { result, reports } = await loadWithProgress()
    expect(result.messages).toEqual([])
    expect(reports.every((r) => r.done <= (r.total ?? 0))).toBe(true)
  })
})
