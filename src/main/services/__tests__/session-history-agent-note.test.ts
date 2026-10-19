/**
 * @vitest-environment node
 *
 * S4 (Q7): a reopened Claude session shows each task notification cli.js
 * DELIVERED as the same agent note the live session shows
 * (claude-session-agent-note.test.ts) — at the point the model read it: a
 * turn-starting `user` line, or a `queued_command` attachment absorbed
 * mid-turn. The `queue-operation` records are queue bookkeeping and produce no
 * row. Recognition is by cli.js's `origin` marker first (2.1.241+), the XML
 * only for lines without one; nothing the user typed becomes a system row.
 *
 * CLAUDE_PROJECTS_DIR derives from os.homedir() at module load, so homedir is
 * mocked to a temp dir BEFORE importing session-history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const TMP_HOME = vi.hoisted(() => `${__dirname}/.tmp-home-agent-note-${process.pid}`)

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: (): string => TMP_HOME }
})

import { loadSessionHistory } from '../../../core/services/session-history'
import { slimTranscript } from '../../../core/automode/classifier'

const PROJECT_KEY = 'test-project-agent-note'
const SESSION_ID = '5a0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3'
const TS = '2026-10-02T10:00:00.000Z'
const LABEL = 'from an agent, not from you'

const xml = (taskId: string, summary: string): string =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n` +
  `<summary>${summary}</summary>\n<result>ok</result>\n</task-notification>`

function writeTranscript(lines: Array<Record<string, unknown>>): void {
  const dir = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
}

const userLine = (uuid: string, content: unknown, origin?: unknown): Record<string, unknown> => ({
  type: 'user',
  userType: 'external',
  uuid,
  timestamp: TS,
  ...(origin !== undefined ? { origin } : {}),
  message: { role: 'user', content }
})
const enqueue = (content: string): Record<string, unknown> => ({
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp: TS,
  content
})
const absorbed = (uuid: string, prompt: string): Record<string, unknown> => ({
  type: 'attachment',
  uuid,
  timestamp: TS,
  userType: 'external',
  attachment: {
    type: 'queued_command',
    prompt,
    commandMode: 'task-notification',
    origin: { kind: 'task-notification', producer: 'session-task' }
  }
})
const NOTIFICATION_ORIGIN = { kind: 'task-notification', producer: 'session-task' }

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

afterEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('loadSessionHistory — task notifications as agent notes (S4)', () => {
  it('N3: a turn-starting notification line and an absorbed one → two notes in place; queue records add no row', async () => {
    const a = xml('agentA', 'Agent "a" completed')
    const b = xml('agentB', 'Agent "b" completed')
    writeTranscript([
      userLine('u-prompt', 'do X', { kind: 'human' }),
      enqueue(a),
      userLine('u-note-a', a, NOTIFICATION_ORIGIN),
      enqueue(b),
      absorbed('u-note-b', b),
      { type: 'queue-operation', operation: 'remove', timestamp: TS }
    ])

    const { messages, taskNotifications } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)

    expect(messages.map((m) => [m.id, m.role])).toEqual([
      ['u-prompt', 'user'],
      ['u-note-a', 'system'],
      ['u-note-b', 'system']
    ])
    expect(messages[1].content).toEqual([
      { type: 'context_note', title: 'Agent "a" completed', fragments: [{ text: a, label: LABEL }] }
    ])
    expect(messages[2].content).toEqual([
      { type: 'context_note', title: 'Agent "b" completed', fragments: [{ text: b, label: LABEL }] }
    ])
    // Unchanged: one entry per notification, deduped across enqueue + delivery.
    expect(taskNotifications.map((n) => n.taskId)).toEqual(['agentA', 'agentB'])
  })

  it('N3: a legacy line without origin is recognised by its XML, as before', async () => {
    const a = xml('agentL', 'legacy done')
    writeTranscript([userLine('u-legacy', a)])
    const { messages, taskNotifications } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toEqual([
      expect.objectContaining({
        id: 'u-legacy',
        role: 'system',
        content: [
          { type: 'context_note', title: 'legacy done', fragments: [{ text: a, label: LABEL }] }
        ]
      })
    ])
    expect(taskNotifications).toHaveLength(1)
  })

  it('N4: a typed prompt that merely mentions <task-notification> (no status) stays a user bubble', async () => {
    const text = 'why does <task-notification> show up in my logs?'
    writeTranscript([userLine('u-typed', text)])
    const { messages, taskNotifications } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toEqual([
      expect.objectContaining({ id: 'u-typed', role: 'user', content: [{ type: 'text', text }] })
    ])
    expect(taskNotifications).toEqual([])
  })

  it('N4: a line cli.js marks as the human’s own stays a user bubble even when it carries notification XML', async () => {
    const text = xml('agentH', 'pasted by the user')
    writeTranscript([userLine('u-human', text, { kind: 'human' })])
    const { messages, taskNotifications } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toEqual([expect.objectContaining({ id: 'u-human', role: 'user' })])
    expect(taskNotifications).toEqual([])
  })
})

describe('loadSessionHistory — peer messages as notes (slice 1a)', () => {
  // What cli.js writes for a peer turn (docs/protocol-cc/15-peer-sessions.md §15.2.7):
  // an `isMeta` user row — which the loader drops for everything else — with the
  // peer origin carrying the decoded body.
  const SENDER = '5b0f2c1e-aaaa-4bbb-8ccc-0123456789ab'
  const envelope = `<cross-session-message from="${SENDER}" from-name="Triage assistant">\nticket 12 is yours\n</cross-session-message>`
  const wrapped = `Another Claude session sent a message:\n${envelope}\n\nThis came from another Claude session -- not typed by your user.`
  const peerLine = (
    uuid: string,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    type: 'user',
    uuid,
    timestamp: TS,
    isMeta: true,
    promptSource: 'system',
    turnOrigin: 'peer',
    origin: {
      kind: 'peer',
      from: SENDER,
      name: 'Triage assistant',
      body: 'ticket 12 is yours',
      hostInjected: true
    },
    message: { role: 'user', content: wrapped },
    ...extra
  })
  const NOTE = [
    {
      type: 'context_note',
      title: 'Message from Triage assistant',
      fragments: [{ text: 'ticket 12 is yours', label: 'from another session, not from you' }]
    }
  ]

  it('keeps an isMeta peer row as a note at its place, with the sender and the decoded body', async () => {
    writeTranscript([
      userLine('u-prompt', 'do X', { kind: 'human' }),
      peerLine('u-peer'),
      // An ordinary meta row (a reminder, a skill injection) is still dropped.
      { ...userLine('u-meta', 'reminder text'), isMeta: true }
    ])
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages.map((m) => [m.id, m.role])).toEqual([
      ['u-prompt', 'user'],
      ['u-peer', 'system']
    ])
    expect(messages[1].content).toEqual(NOTE)
  })

  it('reads the body out of the wrapped content when the row has no origin body', async () => {
    writeTranscript([
      peerLine('u-peer', { origin: { kind: 'peer', from: SENDER, hostInjected: true } })
    ])
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toEqual(NOTE)
  })

  it('a message another Claude Code process sent (no hostInjected) is titled as one', async () => {
    writeTranscript([
      peerLine('u-native', {
        origin: { kind: 'peer', from: 'uds:x', name: 'probe-A', body: 'ping' }
      }),
      peerLine('u-ours')
    ])
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages.map((m) => (m.content[0] as { title: string }).title)).toEqual([
      'probe-A · another Claude session',
      'Message from Triage assistant'
    ])
  })

  it('shows a body that quotes the closing tag as written — cli.js stored it escaped', async () => {
    writeTranscript([
      peerLine('u-quote', {
        origin: {
          kind: 'peer',
          name: 'Triage assistant',
          body: 'see <\\/cross-session-message> here',
          hostInjected: true
        }
      })
    ])
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages[0].content).toEqual([
      expect.objectContaining({
        fragments: [expect.objectContaining({ text: 'see </cross-session-message> here' })]
      })
    ])
  })

  it('is never a User: line for the judge', async () => {
    writeTranscript([userLine('u-prompt', 'do X', { kind: 'human' }), peerLine('u-peer')])
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(slimTranscript(messages)).toBe('User: do X')
  })
})
