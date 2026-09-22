#!/usr/bin/env node
/**
 * Patch test: queue-control
 *
 * Verifies three behaviors:
 *   1. queued_command_consumed fires when a steer is absorbed MID-TURN
 *      (Part A2 — the `queued_command` attachment path)
 *   2. queued_command_consumed fires when a queued command is taken by the
 *      BETWEEN-TURNS drain and run as the next turn's prompt (Part A3 — no
 *      attachment is ever built on this path, so A2 cannot see it)
 *   3. dequeueMessage() exists and returns { removed: N }
 *
 * Strategy:
 *   - Streaming query, initial prompt triggers a long Bash tool call
 *   - Mid-turn, push a steer via the channel        → exercises A2
 *   - Wait for queued_command_consumed, then probe dequeueMessage()
 *   - On the FIRST `result` (cli.js is now between turns, exactly the state a
 *     running background subagent leaves it in), push a second message
 *                                                   → exercises A3
 *   - On the SECOND `result`, close the session
 *
 * The two notifications are told apart by their `prompt` field, which carries
 * the queued text verbatim on both paths.
 */

import {
  createStreamingQuery,
  userMessage,
  collectMessages,
  TestRunner,
  dumpMessages
} from '../test-helpers.mjs'

const PROMPT =
  "Use the Bash tool to run this exact command: sleep 8 && echo 'done sleeping'. Do not add any other commands."

const STEER_TEXT = 'After the sleep finishes, just say OK.'
const DRAIN_TEXT = 'Reply with exactly: DRAINED.'

/**
 * cli.js's own queue-text rule (docs/protocol-cc/04-system-subtypes.md §4.10):
 * `prompt` is the queued value VERBATIM, so it is a content-block array
 * whenever the message carried an image or a PDF.
 */
function promptText(prompt) {
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) {
    return prompt
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

async function main() {
  const t = new TestRunner('queue-control')

  console.log('  Starting streaming SDK query...')
  const { q, channel, cleanup } = createStreamingQuery(PROMPT, {}, 120_000)

  let steerSent = false
  let drainSent = false
  let consumedReceived = false
  let dequeueResult = null
  let resultCount = 0

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
      if (msg.type === 'system' && msg.subtype === 'queued_command_consumed' && !consumedReceived) {
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

      if (msg.type !== 'result') return
      resultCount++

      // Turn 1 is over: cli.js is idle between turns with an open stdin. A push
      // now is taken by drainCommandQueue and run as the next turn's PROMPT —
      // never as a queued_command attachment. That is the A3 path.
      if (resultCount === 1 && !drainSent) {
        drainSent = true
        console.log(`  Turn 1 finished, sending between-turns message: "${DRAIN_TEXT}"`)
        channel.push(userMessage(DRAIN_TEXT))
        return
      }

      if (resultCount >= 2) {
        channel.end()
        await q.close()
      }
    }
  })

  dumpMessages(messages)

  const consumed = messages.filter(
    (m) => m.type === 'system' && m.subtype === 'queued_command_consumed'
  )

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
  t.assert('queued_command_consumed system notification received', consumed.length > 0)

  // 4. Part A2 — the mid-turn steer was reported by its own text
  t.assert(
    'queued_command_consumed carries the mid-turn steer text (Part A2)',
    consumed.some((m) => promptText(m.prompt) === STEER_TEXT)
  )

  // 5. Part A3 — the between-turns drain reported the command it ran as the
  //    next turn's prompt. Without Part A3 no notification is emitted here at
  //    all: the drain builds no queued_command attachment (the turn-start
  //    attachment builder is called with an empty queued-command list), so the
  //    UI's queue card only ever cleared on the turn-end flush.
  t.assert('Between-turns message was sent', drainSent)
  t.assert(
    'queued_command_consumed fires for the between-turns drain (Part A3)',
    consumed.some((m) => promptText(m.prompt) === DRAIN_TEXT)
  )

  // 6. The A3 notification precedes the turn it starts — the whole point is
  //    that the UI clears the card BEFORE the answer streams, not after.
  const drainIdx = messages.findIndex(
    (m) =>
      m.type === 'system' &&
      m.subtype === 'queued_command_consumed' &&
      promptText(m.prompt) === DRAIN_TEXT
  )
  const lastResultIdx = messages.map((m) => m.type).lastIndexOf('result')
  t.assert(
    'A3 notification arrives before the drained turn completes',
    drainIdx !== -1 && lastResultIdx !== -1 && drainIdx < lastResultIdx
  )

  // 7. dequeueMessage returns object with removed field
  // The SDK wraps the response in a control_response envelope:
  //   { subtype: 'success', request_id: '...', response: { removed: N } }
  // Or it may return the unwrapped { removed: N } directly.
  const removedValue = dequeueResult?.removed ?? dequeueResult?.response?.removed ?? undefined
  t.assert(
    'dequeueMessage() returns response with removed field',
    dequeueResult !== null && typeof removedValue === 'number'
  )

  // 8. dequeueMessage for non-existent returns removed: 0
  t.assert('dequeueMessage() for non-existent returns removed: 0', removedValue === 0)

  // 9. Session completed
  t.assertSome('Session completed (result message)', messages, (m) => m.type === 'result')

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
