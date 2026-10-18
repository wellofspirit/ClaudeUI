/**
 * @vitest-environment node
 *
 * A transcript line carries `message.model`; the history parser puts it on the
 * assistant ChatMessage it builds, for a subagent transcript
 * (`loadSubagentHistory`) and for the session's own (`loadSessionHistory`), and
 * the newest-wins merge of a message's partial lines keeps it.
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
  const home = join(actual.tmpdir(), `claudeui-model-history-${process.pid}`)
  return { ...actual, homedir: (): string => home }
})

import { loadSessionHistory, loadSubagentHistory } from '../../../core/services/session-history'

const TMP_HOME = os.homedir()
const PROJECT_KEY = 'test-project-model'
const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const AGENT_ID = 'a1b2c3d4'
const TS = '2026-10-17T06:22:16.376Z'

function writeSubagentTranscript(lines: object[]): void {
  const dir = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY, SESSION_ID, 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `agent-${AGENT_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
}

const assistantLine = (id: string, model: string | undefined, content: object[]): object => ({
  type: 'assistant',
  message: { id, role: 'assistant', ...(model ? { model } : {}), content },
  uuid: `u-${id}-${content.length}`,
  timestamp: TS
})

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

afterEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('loadSubagentHistory — model', () => {
  it('puts message.model on the assistant message', async () => {
    writeSubagentTranscript([
      assistantLine('msg_a', 'claude-haiku-4-5-20251001', [{ type: 'text', text: 'hello' }])
    ])
    const messages = await loadSubagentHistory(SESSION_ID, PROJECT_KEY, AGENT_ID)
    expect(messages.map((m) => m.model)).toEqual(['claude-haiku-4-5-20251001'])
  })

  it('keeps it when a message arrives as several lines that merge', async () => {
    writeSubagentTranscript([
      assistantLine('msg_a', 'claude-opus-5-5', [{ type: 'text', text: 'hello' }]),
      assistantLine('msg_a', 'claude-opus-5-5', [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }
      ])
    ])
    const messages = await loadSubagentHistory(SESSION_ID, PROJECT_KEY, AGENT_ID)
    expect(messages).toHaveLength(1)
    expect(messages[0].content.map((b) => b.type)).toEqual(['text', 'tool_use'])
    expect(messages[0].model).toBe('claude-opus-5-5')
  })

  it('leaves the field off a line that names no model', async () => {
    writeSubagentTranscript([assistantLine('msg_a', undefined, [{ type: 'text', text: 'hi' }])])
    const [message] = await loadSubagentHistory(SESSION_ID, PROJECT_KEY, AGENT_ID)
    expect(message).not.toHaveProperty('model')
  })
})

describe('loadSessionHistory — model', () => {
  function writeMainTranscript(lines: object[]): void {
    const dir = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${SESSION_ID}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    )
  }

  it('puts message.model on the main transcript’s assistant message', async () => {
    writeMainTranscript([
      assistantLine('msg_a', 'claude-opus-5-5', [{ type: 'text', text: 'hello' }])
    ])
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages.filter((m) => m.role === 'assistant').map((m) => m.model)).toEqual([
      'claude-opus-5-5'
    ])
  })

  it('leaves the field off a line that names no model', async () => {
    writeMainTranscript([assistantLine('msg_a', undefined, [{ type: 'text', text: 'hi' }])])
    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant).not.toHaveProperty('model')
  })
})
