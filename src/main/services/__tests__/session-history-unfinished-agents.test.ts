/**
 * @vitest-environment node
 *
 * ADR-073 §5 — an agent whose transcript ends mid-run reads `unfinished`, not
 * "completed".
 *
 * A killed session leaves the async launch result ("Async agent launched
 * successfully") as the last word on the agent: no `<task-notification>` ever
 * follows, because the process that would have sent it is gone. Pre-fix the
 * history view took the launch result for the answer and drew a green check.
 * The loader cannot claim `stopped` either — the same transcript is what
 * session-watcher reads for a session another CLI is still running — so it
 * writes the neutral `unfinished`.
 *
 * Line shapes follow cli.js 2.1.280's transcript (probed 2026-09-23).
 * `CLAUDE_PROJECTS_DIR` derives from os.homedir() at module load, so homedir is
 * mocked to a temp dir BEFORE importing session-history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const TMP_HOME = vi.hoisted(() => `${__dirname}/.tmp-home-unfinished-${process.pid}`)

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: (): string => TMP_HOME }
})

import { loadSessionHistory } from '../../../core/services/session-history'
import type { TaskNotification as TaskNotificationEntry } from '../../../shared/types'

const PROJECT_KEY = 'test-project-unfinished'
const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const TS = '2026-09-23T07:04:40.000Z'
const AGENT = 'acb38d350312a25c3'
const ORIGIN = 'toolu_019e8GsqnZqS8mnY21TC4ohu'
const RESUME = 'toolu_017A1U8QZCKgnQsc6tk5snTD'

function toolUse(id: string, name: string, uuid: string): object {
  return {
    type: 'assistant',
    message: {
      id: `msg_${uuid}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: {} }]
    },
    uuid,
    timestamp: TS
  }
}

function toolResult(
  id: string,
  text: string,
  toolUseResult: Record<string, unknown>,
  uuid: string
): object {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    toolUseResult,
    uuid,
    timestamp: TS
  }
}

const SPAWN = [
  toolUse(ORIGIN, 'Agent', 'a1'),
  toolResult(
    ORIGIN,
    `Async agent launched successfully.\nagentId: ${AGENT} (internal ID)`,
    { isAsync: true, status: 'async_launched', agentId: AGENT },
    'r1'
  )
]

const RESUMED = [
  toolUse(RESUME, 'SendMessage', 'a2'),
  toolResult(
    RESUME,
    JSON.stringify({ success: true, message: 'Resuming agent acb38d3', resumedAgentId: AGENT }),
    { success: true, resumedAgentId: AGENT },
    'r2'
  )
]

/** cli.js records each notification as a queue-operation line (and again when consumed). */
function notification(status: string, runToolUseId?: string): object {
  return {
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: TS,
    content:
      `<task-notification>\n<task-id>${AGENT}</task-id>\n` +
      (runToolUseId ? `<tool-use-id>${runToolUseId}</tool-use-id>\n` : '') +
      `<status>${status}</status>\n<summary>done</summary>\n</task-notification>`
  }
}

function writeTranscript(lines: object[]): void {
  const dir = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
}

async function statusesFor(lines: object[]): Promise<Array<[string, number | undefined]>> {
  writeTranscript(lines)
  const { taskNotifications } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
  return taskNotifications
    .filter((n) => n.toolUseId === ORIGIN)
    .map((n) => [n.status, n.runIndex] as [string, number | undefined])
}

beforeEach(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }))
afterEach(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }))

describe('loadSessionHistory — agents the transcript never closes', () => {
  it('marks an agent killed mid-run as unfinished against the card that spawned it', async () => {
    expect(await statusesFor(SPAWN)).toEqual([['unfinished', 1]])
  })

  it('leaves an agent that reported back alone', async () => {
    expect(await statusesFor([...SPAWN, notification('completed', ORIGIN)])).toEqual([
      ['completed', 1]
    ])
  })

  it('marks a resumed run that never ended, with its run index', async () => {
    expect(await statusesFor([...SPAWN, notification('completed', ORIGIN), ...RESUMED])).toEqual([
      ['completed', 1],
      ['unfinished', 2]
    ])
  })

  it('a late notification for the EARLIER run does not close the resumed one', async () => {
    const statuses = await statusesFor([...SPAWN, ...RESUMED, notification('completed', ORIGIN)])
    expect(statuses.at(-1)).toEqual(['unfinished', 2])
  })

  it('the --resume reap closes the run it interrupted', async () => {
    expect(await statusesFor([...SPAWN, notification('stopped')])).toEqual([['stopped', 1]])
  })
})

/**
 * One entry per notification, with its real usage (2.1.280 transcript shape).
 *
 * cli.js writes each `<task-notification>` twice with identical text — the
 * queue-operation `enqueue`, then the user message when the parent consumes it
 * — and its `<usage>` is child elements, not the old `total_tokens: N` lines.
 * Pre-fix a reopened session showed two entries for one finish, each reading
 * "0 tokens · 0 tools · 0ms".
 */
describe('loadSessionHistory — task notifications as 2.1.280 writes them', () => {
  const xml = (runToolUseId: string, result: string, tokens: number): string =>
    `<task-notification>\n<task-id>${AGENT}</task-id>\n<tool-use-id>${runToolUseId}</tool-use-id>\n` +
    `<output-file>/tmp/tasks/${AGENT}.output</output-file>\n<status>completed</status>\n` +
    `<summary>Agent "regression done" finished</summary>\n<note>…</note>\n<result>${result}</result>\n` +
    `<usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>0</tool_uses><duration_ms>1191</duration_ms></usage>\n` +
    `</task-notification>`
  const enqueued = (text: string): object => ({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: TS,
    content: text
  })
  let consumedLines = 0
  const consumed = (text: string): object => ({
    type: 'user',
    userType: 'external',
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: text },
    uuid: `consumed-${++consumedLines}`,
    timestamp: TS
  })

  async function entriesFor(lines: object[]): Promise<TaskNotificationEntry[]> {
    writeTranscript(lines)
    const { taskNotifications } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    return taskNotifications.filter((n) => n.toolUseId === ORIGIN)
  }

  it('keeps one entry for the enqueued and the consumed copy, with its real usage', async () => {
    const done = xml(ORIGIN, 'ONE', 22020)
    const entries = await entriesFor([...SPAWN, enqueued(done), consumed(done)])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      status: 'completed',
      runIndex: 1,
      usage: { totalTokens: 22020, toolUses: 0, durationMs: 1191 }
    })
  })

  it('still loads a notification that was queued but never consumed', async () => {
    const entries = await entriesFor([...SPAWN, enqueued(xml(ORIGIN, 'ONE', 22020))])
    expect(entries.map((e) => e.status)).toEqual(['completed'])
  })

  it('numbers a resumed agent’s runs as the live session does', async () => {
    const run1 = xml(ORIGIN, 'ONE', 22020)
    const run2 = xml(RESUME, 'TWO', 23700)
    const entries = await entriesFor([
      ...SPAWN,
      enqueued(run1),
      consumed(run1),
      ...RESUMED,
      enqueued(run2),
      consumed(run2)
    ])
    expect(entries.map((e) => [e.runIndex, e.usage?.totalTokens])).toEqual([
      [1, 22020],
      [2, 23700]
    ])
  })
})
