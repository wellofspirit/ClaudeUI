#!/usr/bin/env node
/**
 * Behavioral test for the request-usage patch.
 *
 * Verifies that each completed API response emits a top-level `request_usage`
 * message to stdout carrying the per-request token breakdown + model.
 *
 * The patch injects a `process.stdout.write({type:"request_usage",...})` into
 * the streaming generator's `message_stop` case. One emit per API response.
 *
 * Usage: node patch/request-usage/test.mjs
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const PROMPT = 'Reply with the single word "hello" and nothing else.'

async function main() {
  const t = new TestRunner('request-usage')

  console.log('  Starting SDK query...')
  const { q, cleanup } = createQuery(PROMPT, { effort: 'low' }, 60_000)

  const usageMsgs = []
  const messages = await collectMessages(q, {
    cleanup,
    onMessage: (msg) => {
      if (msg.type === 'request_usage') {
        usageMsgs.push(msg)
        if (usageMsgs.length === 1) {
          console.log('  First request_usage:', JSON.stringify(msg).slice(0, 200))
        }
      }
    }
  })

  dumpMessages(messages)

  // 1. At least one request_usage message emitted.
  t.assert('request_usage message emitted', usageMsgs.length > 0)

  if (usageMsgs.length > 0) {
    const u = usageMsgs[0]

    // 2. Carries a usage object.
    t.assert('request_usage has usage object', u.usage !== null && typeof u.usage === 'object')

    // 3. usage has the canonical token fields (input/output tokens always present).
    const usage = u.usage || {}
    t.assert('usage has input_tokens (number)', typeof usage.input_tokens === 'number')
    t.assert('usage has output_tokens (number)', typeof usage.output_tokens === 'number')
    // Cache fields exist on Anthropic usage objects (may be 0, but present).
    t.assert(
      'usage exposes cache breakdown field',
      'cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage
    )

    // 4. Carries a model string (the patch reads it off the message object).
    t.assert('request_usage has model (string)', typeof u.model === 'string')
    t.assert('request_usage model is non-empty', (u.model || '').length > 0)
    console.log(`  model=${u.model} input=${usage.input_tokens} output=${usage.output_tokens}`)
  }

  // 5. The emit sits with the stream (does not break the session).
  t.assertSome('Session completed (result message)', messages, (m) => m.type === 'result')

  // 6. One emit per API response — the single-turn "hello" prompt yields exactly
  //    one assistant response, so exactly one request_usage (allow >=1 to stay
  //    robust against an internal retry, but never zero — covered by #1).
  t.assert(
    'request_usage count is reasonable (1-3)',
    usageMsgs.length >= 1 && usageMsgs.length <= 3
  )

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
