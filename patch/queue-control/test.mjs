#!/usr/bin/env node
/**
 * Patch test: queue-control
 *
 * Verifies two behaviors:
 *   1. queued_command_consumed notification fires when a steer message is consumed
 *   2. dequeueMessage() method exists and returns { removed: N }
 *
 * Strategy:
 *   - Use streaming query to send initial prompt that triggers a long tool call
 *   - Mid-turn, push a steer message via channel
 *   - Wait for queued_command_consumed notification
 *   - Test dequeueMessage() on a non-existent message returns { removed: 0 }
 */

import {
  createStreamingQuery,
  userMessage,
  collectMessages,
  TestRunner,
  dumpMessages,
} from '../test-helpers.mjs'

const PROMPT =
  "Use the Bash tool to run this exact command: sleep 8 && echo 'done sleeping'. Do not add any other commands."

const STEER_TEXT = 'After the sleep finishes, just say OK.'

async function main() {
  const t = new TestRunner('queue-control')

  console.log('  Starting streaming SDK query...')
  const { q, channel, cleanup } = createStreamingQuery(PROMPT, {}, 120_000)

  let steerSent = false
  let consumedReceived = false
  let dequeueResult = null

  const messages = await collectMessages(q, {
    cleanup,
    onMessage: async (msg) => {
      // Wait for the Bash tool to be invoked (assistant message with tool_use for Bash)
      // Then send a steer message
      if (
        !steerSent &&
        msg.type === 'assistant' &&
        !msg.parent_tool_use_id &&
        Array.isArray(msg.message?.content) &&
        msg.message.content.some((b) => b.type === 'tool_use' && b.name === 'Bash')
      ) {
        steerSent = true
        console.log('  Bash tool_use detected, sending steer in 1s...')
        setTimeout(() => {
          console.log(`  Sending steer: "${STEER_TEXT}"`)
          channel.push(userMessage(STEER_TEXT))
        }, 1000)
      }

      // Detect queued_command_consumed
      if (
        msg.type === 'system' &&
        msg.subtype === 'queued_command_consumed' &&
        !consumedReceived
      ) {
        consumedReceived = true
        console.log('  queued_command_consumed received')

        // Test dequeueMessage on a non-existent value
        try {
          dequeueResult = await q.dequeueMessage('this-message-does-not-exist')
          console.log('  dequeueMessage result:', JSON.stringify(dequeueResult))
        } catch (err) {
          console.error('  dequeueMessage error:', err.message || err)
          dequeueResult = { error: err.message }
        }
      }
    },
  })

  dumpMessages(messages)

  // 1. Bash tool was used
  t.assertSome(
    'Parent used Bash tool',
    messages,
    (m) =>
      m.type === 'assistant' &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'tool_use' && b.name === 'Bash')
  )

  // 2. Steer was sent
  t.assert('Steer message was sent', steerSent)

  // 3. queued_command_consumed notification received
  t.assertSome(
    'queued_command_consumed system notification received',
    messages,
    (m) => m.type === 'system' && m.subtype === 'queued_command_consumed'
  )

  // 4. dequeueMessage returns object with removed field
  // The SDK wraps the response in a control_response envelope:
  //   { subtype: 'success', request_id: '...', response: { removed: N } }
  // Or it may return the unwrapped { removed: N } directly.
  const removedValue =
    dequeueResult?.removed ?? dequeueResult?.response?.removed ?? undefined
  t.assert(
    'dequeueMessage() returns response with removed field',
    dequeueResult !== null && typeof removedValue === 'number'
  )

  // 5. dequeueMessage for non-existent returns removed: 0
  t.assert(
    'dequeueMessage() for non-existent returns removed: 0',
    removedValue === 0
  )

  // 6. Session completed
  t.assertSome('Session completed (result message)', messages, (m) => m.type === 'result')

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
