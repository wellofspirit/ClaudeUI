#!/usr/bin/env node
/**
 * Test: rate-limit-relay
 *
 * Verifies that rate_limit_event messages appear in the SDK message stream
 * after inference calls. The patch forwards these from the CLI's internal
 * TUI queue to stdout.
 *
 * The event fires when rate limit state changes (after each inference call
 * updates the unified rate limit headers). For subscription users, at least
 * one rate_limit_event should appear during a normal query.
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const PROMPT = 'Say "hello" and nothing else.'

async function main() {
  const t = new TestRunner('rate-limit-relay')

  console.log('  Sending a simple prompt to trigger an inference call...\n')

  const { q, cleanup } = createQuery(PROMPT, {}, 60_000)

  let rateLimitEvents = []

  const messages = await collectMessages(q, {
    cleanup,
    onMessage: (msg) => {
      if (msg.type === 'rate_limit_event') {
        rateLimitEvents.push(msg)
        console.log(`  [rate_limit_event] status=${msg.rate_limit_info?.status} ` +
          `type=${msg.rate_limit_info?.rateLimitType} ` +
          `utilization=${msg.rate_limit_info?.utilization}`)
      }
    },
  })

  dumpMessages(messages)

  // ── Assertions ──────────────────────────────────────────────────────

  // Core: at least one rate_limit_event in the stream
  t.assertSome('rate_limit_event present in message stream', messages,
    (m) => m.type === 'rate_limit_event'
  )

  // Structure: event has rate_limit_info with expected fields
  t.assertSome('rate_limit_info has status field', messages,
    (m) => m.type === 'rate_limit_event' &&
      typeof m.rate_limit_info === 'object' &&
      typeof m.rate_limit_info.status === 'string'
  )

  t.assertSome('rate_limit_info has valid status value', messages,
    (m) => m.type === 'rate_limit_event' &&
      ['allowed', 'allowed_warning', 'rejected'].includes(m.rate_limit_info?.status)
  )

  // Envelope: event has uuid and session_id
  t.assertSome('rate_limit_event has uuid', messages,
    (m) => m.type === 'rate_limit_event' && typeof m.uuid === 'string' && m.uuid.length > 0
  )

  t.assertSome('rate_limit_event has session_id', messages,
    (m) => m.type === 'rate_limit_event' && typeof m.session_id === 'string' && m.session_id.length > 0
  )

  // header_utilization: enriched data from parsed response headers (hD4/pf8)
  // This contains per-window utilization that is MISSING from the standard
  // rate_limit_info when status is just "allowed".
  t.assertSome('header_utilization field present', messages,
    (m) => m.type === 'rate_limit_event' &&
      typeof m.header_utilization === 'object' &&
      m.header_utilization !== null
  )

  // Check per-window data shape (at least five_hour should be present for subscription users)
  const headerUtil = rateLimitEvents.find(e => e.header_utilization)?.header_utilization
  if (headerUtil && (headerUtil.five_hour || headerUtil.seven_day)) {
    if (headerUtil.five_hour) {
      t.assert('five_hour.utilization is a number',
        typeof headerUtil.five_hour.utilization === 'number'
      )
      t.assert('five_hour.resets_at is a number',
        typeof headerUtil.five_hour.resets_at === 'number'
      )
      console.log(`  five_hour: ${(headerUtil.five_hour.utilization * 100).toFixed(1)}% used`)
    }
    if (headerUtil.seven_day) {
      t.assert('seven_day.utilization is a number',
        typeof headerUtil.seven_day.utilization === 'number'
      )
      console.log(`  seven_day: ${(headerUtil.seven_day.utilization * 100).toFixed(1)}% used`)
    }
  } else {
    console.log('  (no header_utilization window data — may not be a subscription account)')
  }

  // Optional: rate_limit_info.utilization (only present when status is allowed_warning)
  if (rateLimitEvents.some(e => e.rate_limit_info?.utilization !== undefined)) {
    t.assert('rate_limit_info.utilization is a number', rateLimitEvents.some(
      e => typeof e.rate_limit_info.utilization === 'number'
    ))
  }

  // Ensure we also got a normal result (the query completed successfully)
  t.assertSome('query completed with result', messages,
    (m) => m.type === 'result'
  )

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
