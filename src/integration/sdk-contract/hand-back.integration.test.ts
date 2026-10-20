/**
 * Layer 4: Integration test — a Claude dispatch TARGET's `hand_back` (ADR-105 §3).
 *
 * The dispatcher gives a Claude target a one-tool in-process MCP server and lists its tool in
 * `allowedTools`. This pins, against the pinned cli.js, what that arrangement relies on:
 * the tool_use of an in-process MCP tool is RUN without a permission ask (`canUseTool` is
 * never called), the handler sees the call's own `claudecode/toolUseId`, the assistant frame
 * announcing the call precedes the handler (so a tool call can be attributed to the root
 * agent from the stream), and `interrupt()` after the tool_result ends the turn with an error
 * result while the process lives on.
 *
 * No credentials and no network: a `node:http` server on localhost plays the Anthropic
 * stream (one `tool_use` of the hand_back tool, then a text reply), the spawn runs against an
 * isolated HOME. No model is called.
 *
 * Gated behind CLAUDE_INTEGRATION_TESTS=1.
 */

// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const SKIP = !process.env.CLAUDE_INTEGRATION_TESTS

const TOOL = 'mcp__claude-ui-handback__hand_back'

const sse = (events: Array<[string, Record<string, unknown>]>): string =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

const start = (id: string): [string, Record<string, unknown>] => [
  'message_start',
  {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-6',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 }
    }
  }
]

/** The model's first turn: call hand_back. Every later request gets a plain text reply. */
const TOOL_TURN = sse([
  start('msg_hb_1'),
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_hb', name: TOOL, input: {} }
    }
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"report":"fixture report"}' }
    }
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 8 }
    }
  ],
  ['message_stop', { type: 'message_stop' }]
])
const TEXT_TURN = sse([
  start('msg_hb_2'),
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 }
    }
  ],
  ['message_stop', { type: 'message_stop' }]
])

function startFixtureServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url?.includes('/v1/messages')) {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'anthropic-version': '2023-06-01'
        })
        // The agent loop (the request that offers the tool, before any tool result) is told to
        // call it; every other request (side calls, the turn after the result) gets plain text.
        const agentLoop = body.includes(TOOL) && !body.includes('"tool_result"')
        res.end(agentLoop ? TOOL_TURN : TEXT_TURN)
      })
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no port'))
      resolve({ server, port: address.port })
    })
  })
}

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

describe('a Claude dispatch target’s hand_back', () => {
  describe.skipIf(SKIP)('against the pinned cli.js and a localhost fixture', () => {
    it('runs without an ask, announces the call before the handler, and survives interrupt()', async () => {
      const { query, createSdkMcpServer, tool } = await import('../../core/sdk')
      const { server, port } = await startFixtureServer()
      const isolated = mkdtempSync(join(tmpdir(), 'claudeui-hand-back-'))
      const env = { ...process.env }
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      env.HOME = isolated
      env.USERPROFILE = isolated
      env.CLAUDE_CONFIG_DIR = join(isolated, '.claude')
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
      env.ANTHROPIC_API_KEY = 'fixture-key'

      const wire: Array<Record<string, unknown>> = []
      const frames: Array<Record<string, unknown>> = []
      const handled: Array<{ report: string; callId: unknown; framesBefore: number }> = []
      const asked: string[] = []
      let q: ReturnType<typeof query> | undefined
      try {
        const handBack = createSdkMcpServer({
          name: 'claude-ui-handback',
          version: '1.0.0',
          tools: [
            tool(
              'hand_back',
              'Deliver your final report.',
              { report: z.string() },
              async ({ report }, extra) => {
                handled.push({
                  report,
                  callId: extra?.meta?.['claudecode/toolUseId'],
                  framesBefore: frames.length
                })
                return { content: [{ type: 'text' as const, text: 'Report delivered.' }] }
              },
              { alwaysLoad: true }
            )
          ]
        })
        q = query({
          prompt: 'deliver your report',
          options: {
            cwd: isolated,
            model: 'claude-sonnet-4-6',
            persistSession: false,
            permissionMode: 'default',
            mcpServers: { 'claude-ui-handback': handBack },
            allowedTools: [TOOL],
            canUseTool: async (name) => {
              asked.push(name)
              return { behavior: 'deny', message: 'asked' }
            },
            onInboundFrame: (frame) => frames.push(frame),
            env
          }
        })
        let interrupted = false
        for await (const message of q) {
          wire.push(message as Record<string, unknown>)
          const m = message as { type?: string; message?: { content?: unknown } }
          // The dispatcher ends the turn when the call's own tool_result goes by.
          if (
            !interrupted &&
            m.type === 'user' &&
            JSON.stringify(m.message?.content).includes('toolu_hb')
          ) {
            interrupted = true
            await q.interrupt()
          }
          if (m.type === 'result') break
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await removeIsolatedDir(isolated)
      }

      // No ask: the tool is pre-allowed.
      expect(asked).toEqual([])
      expect(handled).toHaveLength(1)
      expect(handled[0]).toMatchObject({ report: 'fixture report', callId: 'toolu_hb' })
      // The assistant frame announcing the call was read off the wire before the handler ran.
      const announced = frames.findIndex(
        (f) =>
          f.type === 'assistant' &&
          JSON.stringify((f.message as { content?: unknown })?.content).includes('toolu_hb')
      )
      expect(announced).toBeGreaterThanOrEqual(0)
      expect(announced).toBeLessThan(handled[0].framesBefore)
      // The interrupted turn ends with a result; the iterator did not die before it.
      expect(wire.at(-1)).toMatchObject({ type: 'result' })
    }, 60_000)
  })
})
