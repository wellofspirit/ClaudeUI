#!/usr/bin/env node
/**
 * Patch test: subagent-streaming
 *
 * Verifies that sub-agent stream events and assistant messages are forwarded
 * to the SDK consumer:
 *   - Patches F, A-D for sync (foreground) path
 *   - Patch G for async (background, run_in_background=true) path
 *
 * Test 1 (foreground): Prompt asks Claude to use the Agent tool synchronously.
 *   Checks for stream_event and assistant messages with parent_tool_use_id.
 *
 * Test 2 (background): Prompt asks Claude to use the Agent tool with
 *   run_in_background=true. Waits for streaming to appear then closes.
 *   Checks for stream_event and/or assistant messages with parent_tool_use_id.
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

// --- Test 1: Foreground sub-agent streaming (Patches F, A-D) ---

const FOREGROUND_PROMPT = `You MUST use the Task tool (also known as Agent tool) right now. Do NOT answer directly.

Call it with these exact parameters:
- description: "math question"
- prompt: "What is 2+2? Reply with just the number."
- subagent_type: "general-purpose"

This is a test. You MUST call the tool. Do not answer the question yourself.`

// --- Test 2: Background sub-agent streaming (Patch G) ---

const BACKGROUND_PROMPT = `You MUST use the Task tool (also known as Agent tool) right now with run_in_background set to true. Do NOT answer directly.

Call it with these exact parameters:
- description: "background math"
- prompt: "What is 3+3? Think step by step then reply with just the number."
- subagent_type: "general-purpose"
- run_in_background: true

This is a test. You MUST call the tool with run_in_background=true. Do not answer the question yourself.`

async function testForeground(t) {
  console.log('\n  === Test 1: Foreground sub-agent streaming ===')
  console.log('  Starting SDK query...')
  const { q, cleanup } = createQuery(FOREGROUND_PROMPT, { effort: 'medium' }, 120_000)
  const messages = await collectMessages(q, { cleanup })

  dumpMessages(messages)

  // 1. Parent used Task/Agent tool
  t.assertSome(
    '[FG] Parent assistant used Task/Agent tool',
    messages,
    (m) =>
      m.type === 'assistant' &&
      !m.parent_tool_use_id &&
      Array.isArray(m.message?.content) &&
      m.message.content.some(
        (b) => b.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent')
      )
  )

  // 2. Sub-agent stream_event with parent_tool_use_id
  t.assertSome(
    '[FG] Sub-agent stream_event received (parent_tool_use_id != null)',
    messages,
    (m) => m.type === 'stream_event' && !!m.parent_tool_use_id
  )

  // 3. Sub-agent assistant with thinking or text block
  t.assertSome(
    '[FG] Sub-agent assistant message with thinking/text',
    messages,
    (m) =>
      m.type === 'assistant' &&
      !!m.parent_tool_use_id &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'thinking' || b.type === 'text')
  )

  // 4. Session completed
  t.assertSome('[FG] Session completed (result message)', messages, (m) => m.type === 'result')
}

async function testBackground(t) {
  console.log('\n  === Test 2: Background sub-agent streaming (Patch G) ===')
  console.log('  Starting SDK query...')
  const { q, cleanup } = createQuery(BACKGROUND_PROMPT, { effort: 'medium' }, 120_000)

  let bgStreamCount = 0
  let bgAssistantCount = 0

  const messages = await collectMessages(q, {
    cleanup,
    onMessage: (msg) => {
      // Count background agent streaming messages
      if (msg.type === 'stream_event' && !!msg.parent_tool_use_id) {
        bgStreamCount++
      }
      if (msg.type === 'assistant' && !!msg.parent_tool_use_id) {
        bgAssistantCount++
      }

      // Once we have some streaming evidence + a task_notification (completed),
      // close after a short delay to avoid waiting for the full conversation
      if (
        msg.type === 'system' &&
        msg.subtype === 'task_notification' &&
        (bgStreamCount > 0 || bgAssistantCount > 0)
      ) {
        console.log(
          `  Background task completed. stream_events=${bgStreamCount}, assistants=${bgAssistantCount}`
        )
        setTimeout(() => q.close(), 500)
      }
    }
  })

  dumpMessages(messages)

  // 1. Parent used Task/Agent tool with run_in_background
  t.assertSome(
    '[BG] Parent assistant used Task/Agent tool',
    messages,
    (m) =>
      m.type === 'assistant' &&
      !m.parent_tool_use_id &&
      Array.isArray(m.message?.content) &&
      m.message.content.some(
        (b) => b.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent')
      )
  )

  // 2. Background sub-agent stream_event with parent_tool_use_id (Patch G)
  t.assertSome(
    '[BG] Background sub-agent stream_event received (parent_tool_use_id != null)',
    messages,
    (m) => m.type === 'stream_event' && !!m.parent_tool_use_id
  )

  // 3. Background sub-agent assistant with parent_tool_use_id (Patch G)
  t.assertSome(
    '[BG] Background sub-agent assistant message with parent_tool_use_id',
    messages,
    (m) =>
      m.type === 'assistant' &&
      !!m.parent_tool_use_id &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'thinking' || b.type === 'text')
  )

  // 4. Session completed or task_notification received
  const hasCompletion =
    messages.some((m) => m.type === 'result') ||
    messages.some((m) => m.type === 'system' && m.subtype === 'task_notification')
  t.assert('[BG] Session completed or task_notification received', hasCompletion)
}

async function main() {
  const t = new TestRunner('subagent-streaming')

  await testForeground(t)
  await testBackground(t)

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
