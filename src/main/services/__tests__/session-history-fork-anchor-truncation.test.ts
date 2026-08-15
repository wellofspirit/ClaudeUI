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

import { loadSessionHistory } from '../session-history'

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

  it('an anchor that is not in this file truncates NOTHING', async () => {
    // Too much beats an empty conversation, and it is also the pre-F3 behavior —
    // so an anchor from a different transcript degrades rather than blanks.
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY, 'no-such-uuid')
    expect(messages.map((m) => m.id)).toEqual(['u1', 'msg_a1', 'u2', 'msg_a2'])
  })
})
