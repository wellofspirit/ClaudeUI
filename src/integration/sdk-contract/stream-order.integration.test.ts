/**
 * Layer 4: Integration tests — assistant-snapshot ordering contract.
 *
 * `ClaudeItemStreamLifecycle` places each `assistant` line onto a live content
 * block by index/type (`src/core/services/claude-item-stream.ts`). That only
 * works because cli.js emits ONE single-block `assistant` line per content
 * block, sharing `message.id`, after the block's last delta and BEFORE its
 * `content_block_stop`. This test pins that invariant so a CLI bump that
 * changes it fails here instead of silently degrading the transcript.
 *
 * No credentials and no network: a `node:http` server on localhost plays a
 * canned Anthropic SSE stream, and the spawn runs against an isolated HOME.
 *
 * Gated behind CLAUDE_INTEGRATION_TESTS=1 environment variable.
 */

// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SKIP = !process.env.CLAUDE_INTEGRATION_TESTS

const MESSAGE_ID = 'msg_fixture'

/** The canned upstream turn: thinking, then text, then a tool_use. */
const sseEvents: Array<[string, Record<string, unknown>]> = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: MESSAGE_ID,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 }
      }
    }
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think' } }
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'content_block_start',
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' } }
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_fixture', name: 'Bash', input: {} }
    }
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"command"' }
    }
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: ':"ls"}' }
    }
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 2 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 8 }
    }
  ],
  ['message_stop', { type: 'message_stop' }]
]

function startFixtureServer(
  messages: Array<Array<[string, Record<string, unknown>]>> = [sseEvents]
): Promise<{ server: Server; port: number }> {
  let requestIndex = 0
  const server = createServer((req, res) => {
    if (req.url?.includes('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-version': '2023-06-01' })
      const events = messages[Math.min(requestIndex++, messages.length - 1)]
      for (const [name, data] of events) {
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      res.end()
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('fixture server has no port'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

/**
 * Best-effort temp cleanup. On Windows the spawned cli.js still holds `cwd`
 * for a moment after the iterator's SIGTERM, so an immediate delete raises
 * EPERM; retry briefly and never let cleanup mask a real assertion failure.
 */
async function removeIsolatedDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

type WireMessage = Record<string, unknown>

/** Index of each wire line, so ordering can be asserted by position. */
interface Positions {
  lastDelta: Map<number, number>
  stop: Map<number, number>
  snapshots: Array<{ at: number; block: Record<string, unknown>; messageId: unknown }>
  startMessageId: unknown
}

function index(wire: WireMessage[]): Positions {
  const lastDelta = new Map<number, number>()
  const stop = new Map<number, number>()
  const snapshots: Positions['snapshots'] = []
  let startMessageId: unknown
  wire.forEach((line, at) => {
    if (line.type === 'stream_event') {
      const event = line.event as Record<string, unknown> | undefined
      if (!event) return
      const blockIndex = event.index as number | undefined
      if (event.type === 'message_start') {
        startMessageId = (event.message as Record<string, unknown> | undefined)?.id
      } else if (event.type === 'content_block_delta' && typeof blockIndex === 'number') {
        lastDelta.set(blockIndex, at)
      } else if (event.type === 'content_block_stop' && typeof blockIndex === 'number') {
        if (!stop.has(blockIndex)) stop.set(blockIndex, at)
      }
      return
    }
    if (line.type === 'assistant') {
      const message = line.message as Record<string, unknown> | undefined
      const content = message?.content as Array<Record<string, unknown>> | undefined
      if (!message || !Array.isArray(content) || content.length !== 1) return
      snapshots.push({ at, block: content[0], messageId: message.id })
    }
  })
  return { lastDelta, stop, snapshots, startMessageId }
}

describe('SDK assistant-snapshot ordering', () => {
  describe.skipIf(SKIP)('against the pinned cli.js and a localhost SSE fixture', () => {
    it('emits one single-block assistant line per block, before its content_block_stop', async () => {
      const { query } = await import('../../core/sdk')
      const { server, port } = await startFixtureServer()
      const isolated = mkdtempSync(join(tmpdir(), 'claudeui-stream-order-'))
      const env = { ...process.env }
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      env.HOME = isolated
      env.USERPROFILE = isolated
      env.CLAUDE_CONFIG_DIR = join(isolated, '.claude')
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
      env.ANTHROPIC_API_KEY = 'fixture-key'

      const wire: WireMessage[] = []
      try {
        const q = query({
          prompt: 'fixture',
          options: {
            cwd: isolated,
            model: 'claude-sonnet-4-6',
            maxTurns: 1,
            tools: [],
            persistSession: false,
            includePartialMessages: true,
            thinking: { type: 'enabled', budgetTokens: 1024 },
            env
          }
        })
        for await (const message of q) {
          wire.push(message as WireMessage)
          if ((message as WireMessage).type === 'result') break
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await removeIsolatedDir(isolated)
      }

      const assistantLines = wire.filter((line) => line.type === 'assistant')
      expect(assistantLines.length).toBeGreaterThan(0)

      // 1. Every assistant line carries exactly ONE content block.
      for (const line of assistantLines) {
        const content = (line.message as Record<string, unknown>).content
        expect(Array.isArray(content) && content.length).toBe(1)
      }

      const positions = index(wire)
      expect(positions.startMessageId).toBe(MESSAGE_ID)

      // 2. All assistant lines share message.id with message_start.
      for (const snapshot of positions.snapshots) {
        expect(snapshot.messageId).toBe(positions.startMessageId)
      }

      // 3. Each snapshot lands after the matching block's last delta and
      //    before that block's content_block_stop.
      const blockTypes = new Map<number, string>([
        [0, 'thinking'],
        [1, 'text'],
        [2, 'tool_use']
      ])
      for (const [blockIndex, type] of blockTypes) {
        const snapshot = positions.snapshots.find((entry) => entry.block.type === type)
        expect(snapshot, `no assistant snapshot for block ${blockIndex} (${type})`).toBeDefined()
        expect(snapshot!.at).toBeGreaterThan(positions.lastDelta.get(blockIndex)!)
        expect(snapshot!.at).toBeLessThan(positions.stop.get(blockIndex)!)
      }

      // 4. The tool_use snapshot already carries fully parsed input.
      const toolUse = positions.snapshots.find((entry) => entry.block.type === 'tool_use')!
      expect(toolUse.block.input).toEqual({ command: 'ls' })

      // 5. The thinking snapshot carries the accumulated thinking text.
      const thinking = positions.snapshots.find((entry) => entry.block.type === 'thinking')!
      expect(thinking.block.thinking).toBe('think')
    })
  })
})
