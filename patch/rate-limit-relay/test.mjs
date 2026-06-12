#!/usr/bin/env node
/**
 * Test: rate-limit-relay
 *
 * Verifies that rate_limit_event messages with header_utilization appear in
 * the SDK message stream after inference calls. The patch injects a stdout
 * write after every streaming API call in the stream loop (XiK), emitting
 * the per-window utilization parsed from response headers.
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const PROMPT = 'Say "hello" and nothing else.'

async function main() {
  const t = new TestRunner('rate-limit-relay')

  console.log('  Sending a simple prompt to trigger an inference call...\n')

  const { q, cleanup } = createQuery(PROMPT, {}, 60_000)

  const rateLimitEvents = []

  const messages = await collectMessages(q, {
    cleanup,
    onMessage: (msg) => {
      if (msg.type === 'rate_limit_event') {
        rateLimitEvents.push(msg)
        const hu = msg.header_utilization
        const fiveHr = hu?.five_hour
        const sevenDay = hu?.seven_day
        console.log(
          `  [rate_limit_event] header_utilization: ` +
            `five_hour=${fiveHr ? (fiveHr.utilization * 100).toFixed(1) + '%' : 'absent'} ` +
            `seven_day=${sevenDay ? (sevenDay.utilization * 100).toFixed(1) + '%' : 'absent'}`
        )
      }
    }
  })

  dumpMessages(messages)

  // ── Assertions ──────────────────────────────────────────────────────

  // Core: at least one rate_limit_event in the stream
  t.assertSome(
    'rate_limit_event present in message stream',
    messages,
    (m) => m.type === 'rate_limit_event'
  )

  // Structure: event has header_utilization object
  t.assertSome(
    'header_utilization field present',
    messages,
    (m) =>
      m.type === 'rate_limit_event' &&
      typeof m.header_utilization === 'object' &&
      m.header_utilization !== null
  )

  // Per-window data shape (at least five_hour should be present for subscription users)
  const headerUtil = rateLimitEvents.find((e) => e.header_utilization)?.header_utilization
  if (headerUtil && (headerUtil.five_hour || headerUtil.seven_day)) {
    if (headerUtil.five_hour) {
      t.assert(
        'five_hour.utilization is a number',
        typeof headerUtil.five_hour.utilization === 'number'
      )
      t.assert(
        'five_hour.utilization in range [0, 1]',
        headerUtil.five_hour.utilization >= 0 && headerUtil.five_hour.utilization <= 1
      )
      t.assert(
        'five_hour.resets_at is a number',
        typeof headerUtil.five_hour.resets_at === 'number'
      )
      t.assert(
        'five_hour.resets_at is a valid epoch (> 2024)',
        headerUtil.five_hour.resets_at > 1700000000
      )
      console.log(
        `  five_hour: ${(headerUtil.five_hour.utilization * 100).toFixed(1)}% used, ` +
          `resets ${new Date(headerUtil.five_hour.resets_at * 1000).toISOString()}`
      )
    }
    if (headerUtil.seven_day) {
      t.assert(
        'seven_day.utilization is a number',
        typeof headerUtil.seven_day.utilization === 'number'
      )
      t.assert(
        'seven_day.resets_at is a number',
        typeof headerUtil.seven_day.resets_at === 'number'
      )
      console.log(
        `  seven_day: ${(headerUtil.seven_day.utilization * 100).toFixed(1)}% used, ` +
          `resets ${new Date(headerUtil.seven_day.resets_at * 1000).toISOString()}`
      )
    }
  } else {
    console.log('  (no header_utilization window data — may not be a subscription account)')
  }

  // Ensure we also got a normal result (the query completed successfully)
  t.assertSome('query completed with result', messages, (m) => m.type === 'result')

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
