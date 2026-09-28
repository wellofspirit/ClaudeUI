/**
 * @vitest-environment node
 *
 * loadSessionHistory renders a message cli.js folded into a RUNNING turn.
 *
 * Such a steer is never persisted as a `user` line (a message that STARTS a
 * turn is). It is persisted at the fold — after the tool_result of the
 * boundary that absorbed it, before the answer — as
 *
 *   {type:'attachment', attachment:{type:'queued_command', prompt,
 *    source_uuid, commandMode:'prompt', …}}
 *
 * (docs/protocol-cc/03-inbound-messages.md §3.21). The loader had no branch for
 * `attachment` lines, so every steer vanished when a session was reopened, on
 * the patched and the official binary alike.
 *
 * `fixtures/queued-command-official-2.1.280.jsonl` is ten lines copied from the
 * 2026-09-24 official-binary probe transcript (session 903d5166…, the run whose
 * wire log is probes/queue-control/official.uuid.jsonl), `cwd` removed: the
 * first prompt, the Bash call and its tool_result, the PINEAPPLE steer folded
 * mid-turn (client uuid d6a3baa8…, the same uuid its `command_lifecycle` frames
 * carried), the answer, and a second prompt drained between turns.
 *
 * CLAUDE_PROJECTS_DIR derives from os.homedir() at module load, so homedir is
 * mocked to a temp dir BEFORE importing session-history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const TMP_HOME = vi.hoisted(() => `${__dirname}/.tmp-home-queued-${process.pid}`)

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: (): string => TMP_HOME }
})

import { loadSessionHistory } from '../../../core/services/session-history'

const PROJECT_KEY = 'test-project-queued-command'
const SESSION_ID = '903d5166-8025-4343-b927-eddd67c69bfb'
const FIXTURE = path.join(__dirname, 'fixtures', 'queued-command-official-2.1.280.jsonl')

function writeTranscript(lines: string[]): void {
  const dir = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n')
}

function fixtureLines(): string[] {
  return fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean)
}

/** A `queued_command` attachment line shaped like the real ones (2.1.231–2.1.280). */
function queuedLine(
  attachment: Record<string, unknown>,
  uuid = '7b1c2d3e-0000-4000-8000-000000000001'
): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    attachment: { type: 'queued_command', commandMode: 'prompt', ...attachment },
    type: 'attachment',
    uuid,
    timestamp: '2026-09-20T10:00:00.000Z',
    userType: 'external',
    sessionId: SESSION_ID,
    version: '2.1.268'
  })
}

const PNG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

afterEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('loadSessionHistory — steers folded into a running turn', () => {
  it('renders the official-binary steer as a user message at its line position', async () => {
    writeTranscript(fixtureLines())

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)

    expect(messages.map((m) => [m.role, m.id])).toEqual([
      ['user', 'a0495b11-eeea-4338-8ef3-d29839dffe98'],
      ['assistant', 'msg_011CfMGAg2D3mpBktVdoWuMY'],
      // Between the Bash call (its tool_result folded into the message above)
      // and the answer the model gave to it — where the live bubble sits too.
      ['user', 'd6a3baa8-e2c7-4b64-89ae-87dd294bece0'],
      ['assistant', 'msg_011CfMGBsqA5PkXAFkWYwGTv'],
      // Drained between turns: an ordinary `user` line whose uuid is the
      // client uuid, rendered by the existing branch.
      ['user', '8c3b9635-1a49-4bdc-9ca8-d63c5a205ab3'],
      ['assistant', 'msg_011CfMGCCXHiUbwJLTqAtjm2']
    ])

    const steer = messages[2]
    expect(steer.content).toEqual([
      { type: 'text', text: 'Also include the word PINEAPPLE in your reply.' }
    ])
    // The line's timestamp (cli.js stamps it with the enqueue time).
    expect(steer.timestamp).toBe(Date.parse('2026-09-23T23:46:18.497Z'))
    // The tool_result still attached to its call, unaffected by the steer.
    expect(messages[1].content).toContainEqual(
      expect.objectContaining({ type: 'tool_result', toolResult: 'slept' })
    )
  })

  it('normalizes a block-array prompt: attachments first, then its text', async () => {
    writeTranscript([
      queuedLine({ prompt: [PNG, { type: 'text', text: 'look at this' }] }, 'line-uuid-1')
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)

    expect(messages).toHaveLength(1)
    // Pre-2.1.280 lines carry no source_uuid: the line's own uuid is the id.
    expect(messages[0]).toMatchObject({ id: 'line-uuid-1', role: 'user' })
    expect(messages[0].content).toEqual([
      { type: 'image', mediaType: 'image/png', base64Data: 'AAAA' },
      { type: 'text', text: 'look at this' }
    ])
  })

  it('joins several text blocks the way cli.js reads a queued prompt', async () => {
    writeTranscript([
      queuedLine({
        prompt: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' }
        ],
        source_uuid: 'client-uuid-2'
      })
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'client-uuid-2',
        content: [{ type: 'text', text: 'first\nsecond' }]
      })
    ])
  })

  it('keeps an attachments-only steer', async () => {
    writeTranscript([queuedLine({ prompt: [PNG] })])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toEqual([
      { type: 'image', mediaType: 'image/png', base64Data: 'AAAA' }
    ])
  })

  it("skips cli.js's own meta injections, non-prompt commands and blank prompts", async () => {
    writeTranscript([
      // A forwarded-intent / peer copy: cli.js marks it meta, the model's context only.
      queuedLine({ prompt: 'forwarded context', isMeta: true }, 'meta'),
      queuedLine({ prompt: 'a bash-mode command', commandMode: 'bash' }, 'bash'),
      queuedLine({ prompt: '   ' }, 'blank'),
      // Other attachment types stay invisible, as before.
      JSON.stringify({
        type: 'attachment',
        uuid: 'reminder',
        attachment: { type: 'total_tokens_reminder', text: '<total_tokens>1</total_tokens>' }
      }),
      queuedLine({ prompt: 'the real one' }, 'real')
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)

    expect(messages.map((m) => m.id)).toEqual(['real'])
  })

  it('reads a task notification absorbed mid-turn as a notification, once', async () => {
    const xml =
      '<task-notification>\n<task-id>bg42</task-id>\n<status>completed</status>\n' +
      '<summary>done</summary>\n</task-notification>'
    writeTranscript([
      // cli.js records the enqueue first, then the attachment at the fold.
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: xml }),
      queuedLine({ prompt: xml, commandMode: 'task-notification' })
    ])

    const { messages, taskNotifications } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)

    expect(messages).toEqual([])
    expect(taskNotifications).toEqual([
      expect.objectContaining({ taskId: 'bg42', status: 'completed', summary: 'done' })
    ])
  })
})
