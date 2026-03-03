#!/usr/bin/env node
/**
 * Patch test: mcp-status
 *
 * Verifies that mcpServerStatus() returns a non-empty array with connected
 * MCP servers when an MCP server is configured (patches A + B).
 *
 * Without the patch, mcpServerStatus() returns [] in SDK mode because the
 * plugin MCP refresh is fire-and-forget and the status handler reads state
 * before servers are loaded.
 *
 * Strategy:
 *   1. Create a query with a test MCP server configured
 *   2. Wait for init message (ensures session is ready)
 *   3. Call q.mcpServerStatus()
 *   4. Assert non-empty array with our test server present and connected
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const MCP_SERVER_NAME = 'test-server'

const PROMPT = 'Say "hello" in one word.'

async function main() {
  const t = new TestRunner('mcp-status')

  console.log('  Starting SDK query with MCP test server...')
  const { q, cleanup, ac } = createQuery(
    PROMPT,
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: 'node',
          args: [resolve(__dirname, '../mcp-test-server.mjs')],
        },
      },
    },
    60_000
  )

  // We need to get the mcpServerStatus before the query finishes,
  // so use onMessage to catch the init event.
  let mcpStatus = null
  let mcpStatusError = null
  let initReceived = false

  const messages = await collectMessages(q, {
    cleanup,
    onMessage: async (msg) => {
      // Wait for init (session ready)
      if (msg.type === 'system' && msg.subtype === 'init' && !initReceived) {
        initReceived = true
        console.log('  init received, querying MCP status...')
        try {
          mcpStatus = await q.mcpServerStatus()
          console.log('  mcpServerStatus:', JSON.stringify(mcpStatus, null, 2))
        } catch (err) {
          mcpStatusError = err
          console.error('  mcpServerStatus error:', err.message || err)
        }
      }
    },
  })

  dumpMessages(messages)

  // 1. Init received
  t.assert('Init message received', initReceived)

  // 2. mcpServerStatus returned without error
  t.assert('mcpServerStatus() returned successfully', mcpStatus !== null && mcpStatusError === null)

  // 3. Status is a non-empty array
  t.assert(
    'mcpServerStatus() returned non-empty array',
    Array.isArray(mcpStatus) && mcpStatus.length > 0
  )

  // 4. Our test server is in the list
  const testServer = Array.isArray(mcpStatus)
    ? mcpStatus.find((s) => s.name === MCP_SERVER_NAME)
    : null
  t.assert(`Server "${MCP_SERVER_NAME}" found in status`, testServer !== null)

  // 5. Test server is connected
  t.assert(
    `Server "${MCP_SERVER_NAME}" is connected`,
    testServer !== null && testServer.status === 'connected'
  )

  // 6. Test server has tools
  const hasTools =
    testServer !== null &&
    ((Array.isArray(testServer.tools) && testServer.tools.length > 0) ||
      (typeof testServer.toolCount === 'number' && testServer.toolCount > 0))
  t.assert(`Server "${MCP_SERVER_NAME}" has tools`, hasTools)

  // 7. Session completed
  t.assertSome('Session completed (result message)', messages, (m) => m.type === 'result')

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
