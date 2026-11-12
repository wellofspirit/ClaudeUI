/**
 * @vitest-environment node
 *
 * Live/cold parity of the Claude block mapping: one transcript, read three ways,
 * must give the same assistant blocks.
 *
 *   (a) live:  each assistant frame through `transformAssistantMessage`, each user
 *              frame's results through `claudeToolResults`, folded by the sync
 *              reducer (`session:message` upsert, `session:tool-result` attach);
 *   (b) cold:  the lines written to a JSONL and read by `loadSessionHistory`;
 *   (c) cold:  the same lines as a subagent transcript, `loadSubagentHistory`.
 *
 * Normalised by design (and only these): `timestamp` (live stamps `Date.now()`,
 * cold reads the line's own), and user messages (only assistant messages are
 * compared: a prompt is not built from blocks).
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
  const home = join(actual.tmpdir(), `claudeui-history-parity-${process.pid}`)
  return { ...actual, homedir: (): string => home }
})

import { loadSessionHistory, loadSubagentHistory } from '../session-history'
import { transformAssistantMessage } from '../assistant-message'
import { claudeToolResults } from '../claude-transcript'
import { applyEvent } from '../../shared/sync/reducer'
import { emptyCanonicalState } from '../../shared/sync/state'
import type { ChatMessage } from '../../../shared/types'

const TMP_HOME = os.homedir()
const PROJECT_KEY = 'test-project-parity'
const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const AGENT_ID = 'a1b2c3d4'
const ROUTING_ID = 'routing-1'
const TS = '2026-10-17T06:22:16.376Z'
const PNG = 'iVBORw0KGgo='

const assistant = (id: string, uuid: string, content: object[]): Record<string, unknown> => ({
  type: 'assistant',
  uuid,
  timestamp: TS,
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content }
})
const user = (uuid: string, content: object[]): Record<string, unknown> => ({
  type: 'user',
  uuid,
  timestamp: TS,
  message: { role: 'user', content }
})
const result = (toolUseId: string, extra: object): object => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  ...extra
})

const LINES: Array<Record<string, unknown>> = [
  { ...user('u0', [{ type: 'text', text: 'go' }]), userType: 'external' },
  assistant('m1', 'a1', [
    { type: 'thinking', thinking: 'plan', signature: 's' },
    { type: 'text', text: 'looking' },
    { type: 'tool_use', id: 't1', name: 'Read', input: {} }
  ]),
  // The same API message re-sent as a partial snapshot: tool_use only, input now filled.
  assistant('m1', 'a2', [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } }]),
  user('u1', [result('t1', { content: 'file body' })]),
  assistant('m2', 'a3', [
    { type: 'text', text: 'two calls' },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'false' } },
    { type: 'tool_use', id: 't3', name: 'Screenshot', input: {} },
    { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    { type: 'server_tool_use', id: 'x', name: 'web_search' }
  ]),
  user('u2', [
    result('t2', { content: 'exit 1', is_error: true }),
    result('t3', {
      content: [
        { type: 'text', text: 'shot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
      ]
    })
  ]),
  assistant('m3', 'a4', [{ type: 'text', text: 'done' }])
]

/** Fold the lines the way a live session does: frames in, reducer events out. */
function liveMessages(): ChatMessage[] {
  let state = applyEvent(emptyCanonicalState(), {
    channel: 'session:created',
    args: [ROUTING_ID, { cwd: '/tmp/proj', engineId: 'claude' }],
    seq: 1
  } as never)
  let seq = 2
  const apply = (channel: string, data: unknown): void => {
    state = applyEvent(state, { channel, args: [ROUTING_ID, data], seq: seq++ } as never)
  }
  for (const line of LINES) {
    if (line.type === 'assistant') {
      const message = transformAssistantMessage(line)
      if (message) apply('session:message', message)
    } else {
      const content = (line.message as { content: unknown }).content
      for (const r of claudeToolResults(content)) {
        apply('session:tool-result', {
          toolUseId: r.toolUseId,
          result: r.text,
          isError: r.isError,
          ...(r.images ? { images: r.images } : {})
        })
      }
    }
  }
  return state.sessions[ROUTING_ID]?.messages ?? []
}

const writeJsonl = (file: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, LINES.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** The comparable shape: id and blocks of each assistant message. */
const assistantBlocks = (messages: ChatMessage[]): Array<Pick<ChatMessage, 'id' | 'content'>> =>
  messages.filter((m) => m.role === 'assistant').map((m) => ({ id: m.id, content: m.content }))

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

afterEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('Claude transcript: live, cold and subagent readings agree', () => {
  it('the live fold carries the whole transcript', () => {
    const live = assistantBlocks(liveMessages())
    expect(live.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    const m2 = live[1].content
    // text, 2 tool_use, fallback note, unknown-as-JSON, then the 2 results.
    expect(m2.map((b) => b.type)).toEqual([
      'text',
      'tool_use',
      'tool_use',
      'text',
      'text',
      'tool_result',
      'tool_result'
    ])
    expect(m2[3]).toEqual({ type: 'text', text: 'Switched models from a to b.' })
  })

  it('loadSessionHistory reads exactly what the live fold built', async () => {
    writeJsonl(path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY, `${SESSION_ID}.jsonl`))
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(assistantBlocks(messages)).toEqual(assistantBlocks(liveMessages()))
  })

  it('loadSubagentHistory reads the same blocks', async () => {
    writeJsonl(
      path.join(
        TMP_HOME,
        '.claude',
        'projects',
        PROJECT_KEY,
        SESSION_ID,
        'subagents',
        `agent-${AGENT_ID}.jsonl`
      )
    )
    const messages = await loadSubagentHistory(SESSION_ID, PROJECT_KEY, AGENT_ID)
    expect(assistantBlocks(messages)).toEqual(assistantBlocks(liveMessages()))
  })
})
