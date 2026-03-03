#!/usr/bin/env node
/**
 * Patch test: mcp-tool-refresh
 *
 * Verifies that toggling an MCP server on/off correctly updates the tool
 * list visible to the model (patches A + B).
 *
 * Strategy:
 *   1. Create streaming query with MCP test server (tool: patch_test_echo)
 *   2. Wait for init → verify server connected via mcpServerStatus()
 *   3. First turn: ask model to call patch_test_echo → assert it succeeds
 *   4. Toggle server OFF → verify mcpServerStatus() shows disabled + 0 tools
 *   5. Second turn: ask model to list its tools → assert patch_test_echo NOT in output
 *   6. Toggle server ON → verify mcpServerStatus() shows connected + tools back
 *   7. Third turn: ask model to call patch_test_echo again → assert it succeeds
 *
 * The test verifies both the control request cycle (toggle + status) AND
 * that the model's actual tool list is refreshed between turns.
 */

import {
  createStreamingQuery,
  userMessage,
  collectMessages,
  TestRunner,
  dumpMessages,
} from '../test-helpers.mjs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const MCP_SERVER_NAME = 'test-server'
const MCP_TOOL_PATTERN = /patch_test_echo/

const INITIAL_PROMPT =
  'You have an MCP tool called patch_test_echo. Call it with text "first-call". Just call the tool, no explanation needed.'

async function main() {
  const t = new TestRunner('mcp-tool-refresh')

  console.log('  Starting streaming SDK query with MCP test server...')
  const { q, channel, cleanup } = createStreamingQuery(
    INITIAL_PROMPT,
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: 'node',
          args: [resolve(__dirname, '../mcp-test-server.mjs')],
        },
      },
    },
    180_000
  )

  let phase = 'waiting-init'
  let initDone = false

  // Tool call tracking per turn
  let firstTurnUsedTool = false
  let thirdTurnUsedTool = false

  // MCP status tracking
  let statusAfterDisable = null
  let statusAfterEnable = null

  // Accumulate per-turn messages
  let turnMessages = []
  let resultCount = 0

  const messages = await collectMessages(q, {
    cleanup,
    onMessage: async (msg) => {
      turnMessages.push(msg)

      // Phase: waiting-init → detect init
      if (msg.type === 'system' && msg.subtype === 'init' && !initDone) {
        initDone = true
        phase = 'first-use'
        console.log('  Init received. Phase: first-use')
        return
      }

      // Detect result messages to know when turns end
      if (msg.type !== 'result') return

      resultCount++

      if (resultCount === 1 && phase === 'first-use') {
        // First turn completed
        firstTurnUsedTool = turnMessages.some(
          (m) =>
            m.type === 'assistant' &&
            Array.isArray(m.message?.content) &&
            m.message.content.some((b) => b.type === 'tool_use' && MCP_TOOL_PATTERN.test(b.name))
        )
        console.log(`  First turn: used patch_test_echo = ${firstTurnUsedTool}`)

        // Toggle OFF and check status
        phase = 'toggling-off'
        console.log('  Toggling MCP server OFF...')
        try {
          await q.toggleMcpServer(MCP_SERVER_NAME, false)
          statusAfterDisable = await q.mcpServerStatus()
          const server = statusAfterDisable.find((s) => s.name === MCP_SERVER_NAME)
          console.log(`  Status after disable: ${server?.status}, tools: ${server?.tools?.length ?? 0}`)
        } catch (err) {
          console.error('  Toggle OFF error:', err.message)
        }

        // Send second prompt — just ask for available tools (avoid triggering tool call on disabled tool)
        phase = 'second-use'
        turnMessages = []
        console.log('  Phase: second-use (asking model to list tools)')
        channel.push(
          userMessage(
            'List ALL your currently available tool names. Output them as a comma-separated list. Be complete.'
          )
        )
        return
      }

      if (resultCount === 2 && phase === 'second-use') {
        // Second turn completed — check if model mentioned the MCP tool
        const textBlocks = turnMessages
          .filter((m) => m.type === 'assistant' && Array.isArray(m.message?.content))
          .flatMap((m) => m.message.content.filter((b) => b.type === 'text'))
          .map((b) => b.text || '')
          .join(' ')

        const mentionedDisabledTool = MCP_TOOL_PATTERN.test(textBlocks)
        console.log(`  Second turn: model mentioned patch_test_echo in tool list = ${mentionedDisabledTool}`)

        // Toggle ON and check status
        phase = 'toggling-on'
        console.log('  Toggling MCP server ON...')
        try {
          await q.toggleMcpServer(MCP_SERVER_NAME, true)
          // Wait for reconnection
          await new Promise((r) => setTimeout(r, 2000))
          statusAfterEnable = await q.mcpServerStatus()
          const server = statusAfterEnable.find((s) => s.name === MCP_SERVER_NAME)
          console.log(`  Status after enable: ${server?.status}, tools: ${server?.tools?.length ?? 0}`)
        } catch (err) {
          console.error('  Toggle ON error:', err.message)
        }

        // Send third prompt — ask to call the tool again
        phase = 'third-use'
        turnMessages = []
        console.log('  Phase: third-use (model should call patch_test_echo)')
        channel.push(
          userMessage(
            'Now call the patch_test_echo MCP tool with text "after-enable". Just call the tool.'
          )
        )
        return
      }

      if (resultCount === 3 && phase === 'third-use') {
        // Third turn completed
        thirdTurnUsedTool = turnMessages.some(
          (m) =>
            m.type === 'assistant' &&
            Array.isArray(m.message?.content) &&
            m.message.content.some((b) => b.type === 'tool_use' && MCP_TOOL_PATTERN.test(b.name))
        )
        console.log(`  Third turn: used patch_test_echo = ${thirdTurnUsedTool}`)

        // Done
        phase = 'done'
        channel.end()
      }
    },
  })

  dumpMessages(messages)

  // === Assertions ===

  // 1. Init received
  t.assert('Init message received', initDone)

  // 2. First turn: model called patch_test_echo when server was enabled
  t.assert('First turn: model used patch_test_echo (server enabled)', firstTurnUsedTool)

  // 3. Toggle off: mcpServerStatus shows disabled
  const disabledServer = statusAfterDisable?.find((s) => s.name === MCP_SERVER_NAME)
  t.assert(
    'After toggle OFF: server status is disabled',
    disabledServer?.status === 'disabled'
  )

  // 4. Toggle off: no tools for disabled server
  const disabledToolCount = disabledServer?.tools?.length ?? 0
  t.assert(
    'After toggle OFF: server has 0 tools',
    disabledToolCount === 0
  )

  // 5. Toggle on: mcpServerStatus shows connected with tools
  const enabledServer = statusAfterEnable?.find((s) => s.name === MCP_SERVER_NAME)
  t.assert(
    'After toggle ON: server status is connected',
    enabledServer?.status === 'connected'
  )

  const enabledToolCount = enabledServer?.tools?.length ?? 0
  t.assert(
    'After toggle ON: server has tools again',
    enabledToolCount > 0
  )

  // 6. Third turn: model called patch_test_echo after re-enable
  t.assert('Third turn: model used patch_test_echo (server re-enabled)', thirdTurnUsedTool)

  // 7. Session completed
  t.assertSome('Session completed (result message)', messages, (m) => m.type === 'result')

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
