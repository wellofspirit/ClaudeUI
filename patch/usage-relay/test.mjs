#!/usr/bin/env node
/**
 * Patch test: usage-relay
 *
 * Verifies that:
 *   1. getUsage() method exists on the query object
 *   2. getUsage() returns usage data with expected fields (five_hour, etc.)
 *   3. getUsage() does not throw (the CLI handles auth internally)
 *
 * Strategy:
 *   - Start a simple SDK query
 *   - Call q.getUsage() mid-turn (while the query is active)
 *   - Verify the response shape
 */

import {
  createStreamingQuery,
  collectMessages,
  TestRunner,
  dumpMessages,
} from '../test-helpers.mjs'

const PROMPT = 'Reply with the single word "hello" and nothing else.'

async function main() {
  const t = new TestRunner('usage-relay')

  console.log('  Starting SDK query...')
  const { q, channel, cleanup } = createStreamingQuery(PROMPT, {}, 60_000)

  let usageResult = null
  let usageError = null
  let methodExists = false
  let usageFetched = false

  const messages = await collectMessages(q, {
    cleanup,
    onMessage: async (msg) => {
      // Check that getUsage exists on the query object
      if (!methodExists && typeof q.getUsage === 'function') {
        methodExists = true
        console.log('  getUsage() method exists on query object')
      }

      // Call getUsage() on the first assistant message (session is active)
      if (
        !usageFetched &&
        methodExists &&
        msg.type === 'assistant' &&
        !msg.parent_tool_use_id
      ) {
        usageFetched = true
        console.log('  Calling q.getUsage()...')
        try {
          usageResult = await q.getUsage()
          console.log('  getUsage() returned:', JSON.stringify(usageResult).slice(0, 200))
        } catch (err) {
          usageError = err
          console.error('  getUsage() error:', err.message || err)
        }
      }
    },
  })

  dumpMessages(messages)

  // 1. getUsage method exists
  t.assert('getUsage() method exists on query', methodExists)

  // 2. getUsage was called
  t.assert('getUsage() was called during active session', usageFetched)

  // 3. No error thrown
  t.assert('getUsage() did not throw', usageError === null)

  // 4. Result is an object (not null/undefined)
  t.assert(
    'getUsage() returned an object',
    usageResult !== null && typeof usageResult === 'object'
  )

  // 5. Response contains expected fields
  // The API returns: { five_hour, seven_day, seven_day_sonnet, extra_usage }
  // For non-subscription accounts, it may return {} — that's fine too.
  // We just check it's an object. If it has five_hour, verify its shape.
  const hasFiveHour = usageResult && 'five_hour' in usageResult
  if (hasFiveHour) {
    const fh = usageResult.five_hour
    t.assert(
      'five_hour has utilization field',
      fh && typeof fh.utilization === 'number'
    )
    t.assert(
      'five_hour.utilization is a valid percentage (0-100)',
      fh && fh.utilization >= 0 && fh.utilization <= 100
    )
    console.log(`  five_hour utilization: ${fh.utilization}%`)

    if (usageResult.seven_day) {
      t.assert(
        'seven_day has utilization field',
        typeof usageResult.seven_day.utilization === 'number'
      )
    }
  } else {
    // Non-subscription or API-key auth — empty object is valid
    t.assert(
      'getUsage() returned valid response (empty = non-subscription)',
      typeof usageResult === 'object'
    )
    console.log('  Note: No five_hour data — likely non-subscription or API key auth')
  }

  // 6. Session completed normally
  t.assertSome('Session completed (result message)', messages, (m) => m.type === 'result')

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
