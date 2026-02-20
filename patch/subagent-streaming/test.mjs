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

const PROMPT = "Use the Task tool to answer: 'What is 2+2? Reply with just the number.' Use synchronous mode (not background)."

async function main() {
  const t = new TestRunner('subagent-streaming')

  console.log('  Starting SDK query...')
  const { q, cleanup, ac } = createQuery(PROMPT, {}, 120_000)
  const messages = await collectMessages(q, { cleanup })

  dumpMessages(messages)

  // 1. Parent used Task tool
  t.assertSome(
    'Parent assistant used Task tool',
    messages,
    (m) =>
      m.type === 'assistant' &&
      !m.parent_tool_use_id &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'tool_use' && b.name === 'Task')
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
