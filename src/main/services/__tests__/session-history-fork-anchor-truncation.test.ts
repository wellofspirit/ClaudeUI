/**
 * @vitest-environment node
 *
 * F3 — `loadSessionHistory` truncates at the fork anchor.
 *
 * A forked ("branch off") session spawns with `--resume <parent> --fork-session
 * --resume-session-at <anchorUuid>`, and cli.js resumes from `lines.slice(0, w+1)`
 * where `lines[w].uuid === anchorUuid` (see `services/fork-anchor.ts`, which
 * picks the anchor so that prefix is tool-cycle balanced).
 *
 * Every READER of that transcript has to cut at the same line: canonical's seed
 * (`ipc/create-session.ts`) and each client's own cold seed (`useClaudeEvents`'s
 * `session:created` observer). PRE-FIX neither did — both loaded the parent's
 * FULL transcript — so a fork opened showing turns the engine had been resumed
 * without, with the model answering as if they were not there.
 *
 * `CLAUDE_PROJECTS_DIR` derives from os.homedir() at module load, so homedir is
 * mocked to a temp dir BEFORE importing session-history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const TMP_HOME = vi.hoisted(() => `${__dirname}/.tmp-home-fork-${process.pid}`)

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: (): string => TMP_HOME }
})

import { computeTokenMetrics, loadSessionHistory } from '../../../core/services/session-history'
import { findForkAnchorUuid } from '../../../core/services/fork-anchor'

const PROJECT_KEY = 'test-project-fork'
const SESSION_ID = '99999999-8888-7777-6666-555555555555'
const TS = '2026-06-10T06:22:16.376Z'

function userLine(text: string, uuid: string): object {
  return {
    type: 'user',
    userType: 'external',
    message: { role: 'user', content: text },
    uuid,
    timestamp: TS
  }
}

function assistantLine(text: string, uuid: string): object {
  return {
    type: 'assistant',
    message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
    uuid,
    timestamp: TS
  }
}

/** u1 → a1 → u2 → a2, the shape a fork at `a1` truncates. */
const TRANSCRIPT = [
  userLine('first question', 'u1'),
  assistantLine('first answer', 'a1'),
  userLine('second question', 'u2'),
  assistantLine('second answer', 'a2')
]

function writeTranscript(lines: object[]): void {
  const dir = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
}

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
  writeTranscript(TRANSCRIPT)
})

afterEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('loadSessionHistory — fork-anchor truncation', () => {
  it('loads the WHOLE transcript when no anchor is given (every non-fork resume)', async () => {
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages.map((m) => m.id)).toEqual(['u1', 'msg_a1', 'u2', 'msg_a2'])
  })

  it('keeps the anchor line and drops everything after it', async () => {
    // cli.js's boundary is `slice(0, w + 1)` — INCLUSIVE of the anchor, which is
    // why the assistant turn the user branched from is still visible.
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY, 'a1')
    // Assistant rows are keyed by the API `message.id`; the ANCHOR is the JSONL
    // line `uuid`, which is exactly the distinction `--resume-session-at` uses.
    expect(messages.map((m) => m.id)).toEqual(['u1', 'msg_a1'])
  })

  it('truncates at a tool_result line too (the balanced-boundary case)', async () => {
    // `findForkAnchorUuid` walks past an assistant line that issued tools to the
    // last trailing tool_result, so the anchor is frequently a USER line.
    writeTranscript([
      userLine('do a thing', 'u1'),
      {
        type: 'assistant',
        message: {
          id: 'msg_a1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]
        },
        uuid: 'a1',
        timestamp: TS
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]
        },
        uuid: 'tr1',
        timestamp: TS
      },
      userLine('and now something else', 'u2')
    ])
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY, 'tr1')
    expect(messages.map((m) => m.id)).toEqual(['u1', 'msg_a1'])
    // The tool_result attached to its tool_use rather than becoming its own row.
    expect(messages[1].content.some((b) => b.type === 'tool_result')).toBe(true)
  })

  it('a fork from the reply to an agent handback keeps the completion delivered after it', async () => {
    // A real 2.1.290 transcript's order: the handback note, then the reply the
    // user forks from, then the agent's <task-notification> as a user line.
    const agent = 'a590150601107b985'
    const launch = 'toolu_launch'
    const xml =
      `<task-notification>\n<task-id>${agent}</task-id>\n<tool-use-id>${launch}</tool-use-id>\n` +
      `<status>completed</status>\n<summary>Agent "sleep" finished</summary>\n</task-notification>`
    const lines: object[] = [
      userLine('start an agent', 'u1'),
      {
        type: 'assistant',
        message: {
          id: 'msg_a1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: launch, name: 'Agent', input: {} }]
        },
        uuid: 'a1',
        timestamp: TS
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: launch,
              content: `Async agent launched successfully.\nagentId: ${agent} (internal ID)`
            }
          ]
        },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: agent },
        uuid: 'r1',
        timestamp: TS
      },
      assistantLine('launched', 'a2'),
      { type: 'queue-operation', operation: 'enqueue', timestamp: TS, content: xml },
      {
        type: 'user',
        isMeta: true,
        origin: { kind: 'peer', from: agent, handback: true },
        message: { role: 'user', content: 'Another Claude session sent a message: done' },
        uuid: 'hb',
        timestamp: TS
      },
      assistantLine('The background agent replied "done".', 'a3'),
      { type: 'queue-operation', operation: 'dequeue', timestamp: TS },
      {
        type: 'user',
        origin: { kind: 'task-notification', producer: 'session-task' },
        message: { role: 'user', content: xml },
        uuid: 'n1',
        timestamp: TS
      },
      userLine('and now something else', 'u2')
    ]
    writeTranscript(lines)
    const anchor = findForkAnchorUuid(lines as Array<Record<string, unknown>>, 'msg_a3')
    expect(anchor).toBe('n1')
    const { messages, taskNotifications } = await loadSessionHistory(
      SESSION_ID,
      PROJECT_KEY,
      anchor!
    )
    // The delivery is the branch's last row (u2 is cut), shown as the agent note.
    const last = messages[messages.length - 1]
    expect(last).toEqual(expect.objectContaining({ id: 'n1', role: 'system' }))
    expect(last.content[0].type).toBe('context_note')
    // One entry: the pre-anchor enqueue and the delivery carry the same XML.
    expect(taskNotifications).toEqual([
      expect.objectContaining({ taskId: agent, toolUseId: launch, status: 'completed' })
    ])
  })

  it('an anchor that is not in this file truncates NOTHING', async () => {
    // Too much beats an empty conversation, and it is also the pre-F3 behavior —
    // so an anchor from a different transcript degrades rather than blanks.
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY, 'no-such-uuid')
    expect(messages.map((m) => m.id)).toEqual(['u1', 'msg_a1', 'u2', 'msg_a2'])
  })
})

// ---------------------------------------------------------------------------
// The status line (token / cost / duration figures) stops at the anchor too
// ---------------------------------------------------------------------------

describe('fork-anchor truncation — the status line', () => {
  const MODEL = 'claude-sonnet-4-6'

  /** An assistant turn that spent `input` / `output` tokens (distinct message id). */
  function spendLine(uuid: string, input: number, output: number, content: unknown[] = []): object {
    return {
      type: 'assistant',
      message: {
        id: `msg_${uuid}`,
        role: 'assistant',
        model: MODEL,
        content,
        usage: { input_tokens: input, output_tokens: output }
      },
      uuid,
      timestamp: TS
    }
  }

  const SPEND = [
    userLine('q1', 'u1'),
    spendLine('a1', 100, 10),
    userLine('q2', 'u2'),
    spendLine('a2', 1000, 200)
  ]

  it('counts the whole parent without an anchor (every non-fork resume)', async () => {
    writeTranscript(SPEND)
    const { statusLine } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(statusLine?.totalInputTokens).toBe(1100)
    expect(statusLine?.totalOutputTokens).toBe(210)
  })

  it('a fork counts through the anchor line only (GUARD)', async () => {
    writeTranscript(SPEND)
    const { statusLine } = await loadSessionHistory(SESSION_ID, PROJECT_KEY, 'a1')
    // Pre-fix: 1100 / 210 — the parent's whole file, including the discarded turn.
    expect(statusLine?.totalInputTokens).toBe(100)
    expect(statusLine?.totalOutputTokens).toBe(10)
    expect(statusLine?.totalCostUsd).toBeLessThan(
      (await loadSessionHistory(SESSION_ID, PROJECT_KEY)).statusLine!.totalCostUsd!
    )
  })

  it('the context figure is the last kept turn, not the last of the parent (GUARD)', async () => {
    writeTranscript(SPEND)
    const fork = (await loadSessionHistory(SESSION_ID, PROJECT_KEY, 'a1')).statusLine
    const whole = (await loadSessionHistory(SESSION_ID, PROJECT_KEY)).statusLine
    expect(fork?.contextWindow.used).toBe(100)
    expect(whole?.contextWindow.used).toBe(1000)
  })

  it('an anchor that is not in the file truncates nothing', async () => {
    writeTranscript(SPEND)
    const { statusLine } = await loadSessionHistory(SESSION_ID, PROJECT_KEY, 'no-such-uuid')
    expect(statusLine?.totalInputTokens).toBe(1100)
  })

  it('subagent spend follows the anchor: only agents the kept lines spawned count (GUARD)', async () => {
    const spawn = (uuid: string, toolUseId: string, agentId: string): object[] => [
      spendLine(uuid, 1, 1, [{ type: 'tool_use', id: toolUseId, name: 'Task', input: {} }]),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolUseId, content: `done\nagentId: ${agentId}` }
          ]
        },
        uuid: `tr_${uuid}`,
        timestamp: TS
      }
    ]
    writeTranscript([
      userLine('q1', 'u1'),
      ...spawn('a1', 'tu1', 'early'),
      userLine('q2', 'u2'),
      ...spawn('a2', 'tu2', 'late')
    ])
    const dir = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY, SESSION_ID, 'subagents')
    fs.mkdirSync(dir, { recursive: true })
    for (const [id, input] of [
      ['early', 500],
      ['late', 7000]
    ] as const)
      fs.writeFileSync(
        path.join(dir, `agent-${id}.jsonl`),
        JSON.stringify(spendLine(`sub_${id}`, input, 0)) + '\n'
      )
    const file = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY, `${SESSION_ID}.jsonl`)
    const cost = async (anchor?: string): Promise<number> =>
      (await computeTokenMetrics(file, undefined, anchor)).totalCostUsd ?? 0
    const whole = await cost()
    const throughFirst = await cost('tr_a1')
    expect(throughFirst).toBeLessThan(whole)
    // Removing the late agent's file changes nothing for a fork cut after the first
    // spawn (pre-fix its 7000 tokens were counted), but does for the whole parent.
    fs.rmSync(path.join(dir, 'agent-late.jsonl'))
    expect(await cost('tr_a1')).toBe(throughFirst)
    expect(await cost()).toBeLessThan(whole)
    // ...and the early agent, which the kept lines DID spawn, is counted: without
    // its file the fork's figure drops. (A `keptAgentIds` that came out empty would
    // pass the two checks above and fail this one.)
    fs.rmSync(path.join(dir, 'agent-early.jsonl'))
    expect(await cost('tr_a1')).toBeLessThan(throughFirst)
  })
})
