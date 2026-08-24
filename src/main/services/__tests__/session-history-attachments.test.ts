/**
 * @vitest-environment node
 *
 * Tests the REAL jsonl parsers (loadSessionHistory + loadSubagentHistory)
 * against temp transcripts, covering user-attachment rehydration:
 *
 *   cli.js persists user attachments as content blocks on `type:'user'` lines:
 *     { type:'image',    source:{ type:'base64', media_type:'image/png', data } }
 *     { type:'document', source:{ type:'base64', media_type:'application/pdf', data } }
 *   (verified against real transcripts in ~/.claude/projects — no filename field)
 *
 * Before this suite the parsers dropped those blocks entirely (text-only
 * emission), and dropped attachment-only user messages altogether.
 *
 * CLAUDE_PROJECTS_DIR derives from os.homedir() at module load, so homedir is
 * mocked to a temp dir BEFORE importing session-history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const TMP_HOME = vi.hoisted(() => `${__dirname}/.tmp-home-att-${process.pid}`)

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: (): string => TMP_HOME }
})

import { loadSessionHistory, loadSubagentHistory } from '../../../core/services/session-history'

const PROJECT_KEY = 'test-project-attachments'
const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const AGENT_ID = 'a1b2c3d4'
const TS = '2026-06-10T06:22:16.376Z'

function writeTranscript(lines: object[]): void {
  const dir = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
}

function writeSubagentTranscript(lines: object[]): void {
  const dir = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY, SESSION_ID, 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `agent-${AGENT_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
}

/** A `type:'user'` transcript line with array content. */
function userLine(content: unknown[], uuid = 'u1'): object {
  return {
    type: 'user',
    userType: 'external',
    message: { role: 'user', content },
    uuid,
    timestamp: TS
  }
}

function imageBlock(mediaType: string, data: string): object {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
}

function documentBlock(mediaType: string, data: string): object {
  return { type: 'document', source: { type: 'base64', media_type: mediaType, data } }
}

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

afterEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('loadSessionHistory — user attachment rehydration', () => {
  it('emits the image block before the text block (image + text)', async () => {
    writeTranscript([
      userLine([imageBlock('image/png', 'AAAA'), { type: 'text', text: 'look at this' }])
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toEqual([
      { type: 'image', mediaType: 'image/png', base64Data: 'AAAA' },
      { type: 'text', text: 'look at this' }
    ])
  })

  it('emits an attachments-only user message (image, no text block)', async () => {
    writeTranscript([userLine([imageBlock('image/jpeg', 'BBBB')])])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toEqual([
      { type: 'image', mediaType: 'image/jpeg', base64Data: 'BBBB' }
    ])
  })

  it('preserves multiple attachments in transcript order', async () => {
    writeTranscript([
      userLine([
        imageBlock('image/png', 'ONE'),
        imageBlock('image/webp', 'TWO'),
        { type: 'text', text: 'two shots' }
      ])
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages[0].content).toEqual([
      { type: 'image', mediaType: 'image/png', base64Data: 'ONE' },
      { type: 'image', mediaType: 'image/webp', base64Data: 'TWO' },
      { type: 'text', text: 'two shots' }
    ])
  })

  it('skips an unknown media_type but still emits the text', async () => {
    writeTranscript([
      userLine([imageBlock('image/tiff', 'CCCC'), { type: 'text', text: 'unsupported' }])
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toEqual([{ type: 'text', text: 'unsupported' }])
  })

  it('drops a user message whose only block is an unsupported attachment', async () => {
    writeTranscript([userLine([imageBlock('image/tiff', 'CCCC')])])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toHaveLength(0)
  })

  it('rehydrates a PDF as a document block', async () => {
    writeTranscript([
      userLine([documentBlock('application/pdf', 'PDFDATA'), { type: 'text', text: 'read this' }])
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages[0].content).toEqual([
      { type: 'document', mediaType: 'application/pdf', base64Data: 'PDFDATA' },
      { type: 'text', text: 'read this' }
    ])
  })

  it('skips a document block with a non-pdf media_type', async () => {
    writeTranscript([
      userLine([documentBlock('text/plain', 'TXT'), { type: 'text', text: 'hello' }])
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages[0].content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('does not throw on a malformed attachment block (missing source/data)', async () => {
    writeTranscript([
      userLine([
        { type: 'image' },
        { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        { type: 'text', text: 'still here' }
      ])
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages[0].content).toEqual([{ type: 'text', text: 'still here' }])
  })

  it('still routes a cli-command text block to a cli_command message (attachments do not reorder it)', async () => {
    writeTranscript([userLine([{ type: 'text', text: '<command-name>/clear</command-name>' }])])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content[0]).toMatchObject({ type: 'cli_command', commandName: '/clear' })
  })

  it('still routes a task-notification text block to taskNotifications, not a message', async () => {
    writeTranscript([
      userLine([
        {
          type: 'text',
          text: '<task-notification>\n<task-id>agent-9</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>'
        }
      ])
    ])

    const { messages, taskNotifications } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toHaveLength(0)
    expect(taskNotifications).toHaveLength(1)
    expect(taskNotifications[0].taskId).toBe('agent-9')
  })

  it('ignores attachments on non-external user lines', async () => {
    writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: [imageBlock('image/png', 'DDDD')] },
        uuid: 'u-int',
        timestamp: TS
      }
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toHaveLength(0)
  })

  it('still drops isMeta lines carrying attachments', async () => {
    writeTranscript([
      {
        type: 'user',
        userType: 'external',
        isMeta: true,
        message: { role: 'user', content: [imageBlock('image/png', 'EEEE')] },
        uuid: 'u-meta',
        timestamp: TS
      }
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages).toHaveLength(0)
  })
})

describe('loadSubagentHistory — user attachment rehydration', () => {
  it('emits the image block before the text block (image + text)', async () => {
    writeSubagentTranscript([
      userLine([imageBlock('image/gif', 'GIFDATA'), { type: 'text', text: 'subagent prompt' }])
    ])

    const messages = await loadSubagentHistory(SESSION_ID, PROJECT_KEY, AGENT_ID)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toEqual([
      { type: 'image', mediaType: 'image/gif', base64Data: 'GIFDATA' },
      { type: 'text', text: 'subagent prompt' }
    ])
  })

  it('emits an attachments-only user message', async () => {
    writeSubagentTranscript([userLine([documentBlock('application/pdf', 'SUBPDF')])])

    const messages = await loadSubagentHistory(SESSION_ID, PROJECT_KEY, AGENT_ID)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toEqual([
      { type: 'document', mediaType: 'application/pdf', base64Data: 'SUBPDF' }
    ])
  })

  it('still emits plain string content unchanged', async () => {
    writeSubagentTranscript([
      {
        type: 'user',
        userType: 'external',
        message: { role: 'user', content: 'plain' },
        uuid: 's1',
        timestamp: TS
      }
    ])

    const messages = await loadSubagentHistory(SESSION_ID, PROJECT_KEY, AGENT_ID)
    expect(messages[0].content).toEqual([{ type: 'text', text: 'plain' }])
  })
})

// ---------------------------------------------------------------------------
// Tool-result images (a tool that RETURNED an image, e.g. Read on a .png)
//
// cli.js persists these as image content blocks INSIDE the tool_result block —
// the same `{type:'image', source:{type:'base64',…}}` shape as a user
// attachment, but hanging off the tool call rather than the prompt. Both
// parsers collapsed the tool_result content with `(c.text)||''`, dropping them.
// ---------------------------------------------------------------------------

/** A `type:'user'` transcript line carrying tool_result blocks. */
function toolResultLine(blocks: unknown[], uuid = 'tr1'): object {
  return { type: 'user', message: { role: 'user', content: blocks }, uuid, timestamp: TS }
}

function toolResultBlock(toolUseId: string, content: unknown): object {
  return { type: 'tool_result', tool_use_id: toolUseId, content }
}

/** An assistant line whose message content holds a tool_use (so results can attach). */
function assistantToolUse(toolUseId: string, uuid = 'a1'): object {
  return {
    type: 'assistant',
    message: {
      id: `msg-${toolUseId}`,
      content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/x.png' } }]
    },
    uuid,
    timestamp: TS
  }
}

describe('loadSessionHistory — tool-result images', () => {
  it('attaches images from a user-line tool_result to the preceding assistant message', async () => {
    writeTranscript([
      assistantToolUse('tu-1'),
      toolResultLine([toolResultBlock('tu-1', [imageBlock('image/png', 'SHOT')])])
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    const result = messages[0].content.find((b) => b.type === 'tool_result')
    expect(result).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tu-1',
      images: [{ mediaType: 'image/png', base64Data: 'SHOT' }]
    })
  })

  it('attaches images from an assistant-line tool_result block', async () => {
    writeTranscript([
      {
        type: 'assistant',
        message: {
          id: 'msg-emb',
          content: [
            toolResultBlock('tu-emb', [
              { type: 'text', text: 'Image read' },
              imageBlock('image/webp', 'EMB')
            ])
          ]
        },
        uuid: 'a-emb',
        timestamp: TS
      }
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(messages[0].content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tu-emb',
      images: [{ mediaType: 'image/webp', base64Data: 'EMB' }]
    })
  })

  it('omits images for a text-only tool_result', async () => {
    writeTranscript([
      assistantToolUse('tu-txt'),
      toolResultLine([toolResultBlock('tu-txt', 'plain output')])
    ])

    const { messages } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    const result = messages[0].content.find((b) => b.type === 'tool_result')
    expect(result).toBeDefined()
    expect('images' in result!).toBe(false)
  })
})

describe('loadSubagentHistory — tool-result images', () => {
  it('attaches images from a user-line tool_result', async () => {
    writeSubagentTranscript([
      assistantToolUse('tu-s1', 'sa1'),
      toolResultLine([toolResultBlock('tu-s1', [imageBlock('image/jpeg', 'SUBSHOT')])], 'str1')
    ])

    const messages = await loadSubagentHistory(SESSION_ID, PROJECT_KEY, AGENT_ID)
    const result = messages[0].content.find((b) => b.type === 'tool_result')
    expect(result).toMatchObject({
      toolUseId: 'tu-s1',
      images: [{ mediaType: 'image/jpeg', base64Data: 'SUBSHOT' }]
    })
  })

  it('attaches images from an assistant-line tool_result block', async () => {
    writeSubagentTranscript([
      {
        type: 'assistant',
        message: {
          id: 'msg-sub-emb',
          content: [toolResultBlock('tu-s2', [imageBlock('image/gif', 'SUBEMB')])]
        },
        uuid: 'sa2',
        timestamp: TS
      }
    ])

    const messages = await loadSubagentHistory(SESSION_ID, PROJECT_KEY, AGENT_ID)
    expect(messages[0].content[0]).toMatchObject({
      toolUseId: 'tu-s2',
      images: [{ mediaType: 'image/gif', base64Data: 'SUBEMB' }]
    })
  })
})
