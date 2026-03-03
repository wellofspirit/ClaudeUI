#!/usr/bin/env node
/**
 * Patch test: subagent-streaming
 *
 * Verifies that sub-agent stream events and assistant messages are forwarded
 * to the SDK consumer (patches F, A-D for sync path, E for async/background).
 *
 * Prompt asks Claude to use the Task tool synchronously, which triggers the
 * sub-agent code path. We then check for:
 *   1. Parent used Task tool
 *   2. Sub-agent stream_event with parent_tool_use_id
 *   3. Sub-agent assistant message with thinking/text blocks
 *   4. Session completed (result message)
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const PROMPT = `You MUST use the Task tool (also known as Agent tool) right now. Do NOT answer directly.

Call it with these exact parameters:
- description: "math question"
- prompt: "What is 2+2? Reply with just the number."
- subagent_type: "general-purpose"

This is a test. You MUST call the tool. Do not answer the question yourself.`

async function main() {
  const t = new TestRunner('subagent-streaming')

  console.log('  Starting SDK query...')
  const { q, cleanup, ac } = createQuery(PROMPT, { effort: 'medium' }, 120_000)
  const messages = await collectMessages(q, { cleanup })

  dumpMessages(messages)

  // 1. Parent used Task/Agent tool (renamed to Agent in SDK 0.2.60+)
  t.assertSome(
    'Parent assistant used Task/Agent tool',
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
    'Sub-agent stream_event received (parent_tool_use_id != null)',
    messages,
    (m) => m.type === 'stream_event' && !!m.parent_tool_use_id
  )

  // 3. Sub-agent assistant with thinking or text block
  t.assertSome(
    'Sub-agent assistant message with thinking/text',
    messages,
    (m) =>
      m.type === 'assistant' &&
      !!m.parent_tool_use_id &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'thinking' || b.type === 'text')
  )

  // 4. Session completed
  t.assertSome('Session completed (result message)', messages, (m) => m.type === 'result')

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
