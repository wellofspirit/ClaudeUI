#!/usr/bin/env node
/**
 * Patch test: sandbox-network-fix
 *
 * Verifies that the sandbox network proxy does NOT start when no domain
 * restrictions are configured (empty allowedDomains / deniedDomains).
 *
 * Strategy:
 *   - Launch a query with sandbox enabled but NO network.allowedDomains
 *   - Ask the model to curl a public URL
 *   - If the patch works: proxy doesn't start → curl succeeds (HTTP 200/301/302)
 *   - If unpatched: proxy starts with empty allowlist → curl fails (connection refused)
 *
 * Also tests the positive case: when allowedDomains IS provided, the proxy
 * should start and allow the listed domain.
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

// Test 1: No domain restrictions → network should be unrestricted
const PROMPT_UNRESTRICTED =
  'Use the Bash tool to run this exact command: curl -s -o /dev/null -w "%{http_code}" https://www.google.com ' +
  '-- output ONLY the HTTP status code number. Do NOT add any other commands or flags.'

// Test 2: With allowedDomains → network proxy starts, listed domain works
const PROMPT_RESTRICTED =
  'Use the Bash tool to run this exact command: curl -s -o /dev/null -w "%{http_code}" https://www.google.com ' +
  '-- output ONLY the HTTP status code number. Do NOT add any other commands or flags.'

/**
 * Extract the HTTP status code from Bash tool result messages.
 * Looks for a 3-digit number (like 200, 301, 302) in tool results.
 */
function extractHttpStatus(messages) {
  for (const m of messages) {
    // Check synthetic user messages (tool_result)
    if (m.type === 'user' && m.message) {
      const content = typeof m.message.content === 'string'
        ? m.message.content
        : Array.isArray(m.message.content)
          ? m.message.content.map((b) => b.text || b.content || '').join(' ')
          : ''
      const match = content.match(/\b([1-5]\d{2})\b/)
      if (match) return parseInt(match[1], 10)
    }
    // Check assistant text for the status code
    if (m.type === 'assistant' && m.message?.content) {
      for (const block of m.message.content) {
        if (block.type === 'text') {
          const match = block.text.match(/\b([1-5]\d{2})\b/)
          if (match) return parseInt(match[1], 10)
        }
      }
    }
  }
  return null
}

/**
 * Check if any message indicates a curl connection failure
 * (proxy intercepted and blocked the connection).
 */
function hasCurlFailure(messages) {
  const failurePatterns = [
    /Connection refused/i,
    /Failed to connect/i,
    /Could not resolve proxy/i,
    /curl: \(\d+\)/,
    /000/,  // curl returns 000 on connection failure
    /proxy/i,
  ]
  for (const m of messages) {
    if (m.type === 'user' && m.message) {
      const content = typeof m.message.content === 'string'
        ? m.message.content
        : Array.isArray(m.message.content)
          ? m.message.content.map((b) => b.text || b.content || '').join(' ')
          : ''
      for (const pat of failurePatterns) {
        if (pat.test(content)) return true
      }
    }
  }
  return false
}

async function main() {
  const t = new TestRunner('sandbox-network-fix')

  // =========================================================================
  // Test 1: Sandbox enabled, NO allowedDomains → network unrestricted
  // =========================================================================
  console.log('  --- Test 1: Sandbox enabled, no allowedDomains ---')
  console.log('  Expecting curl to succeed (proxy should NOT start)...')

  const { q: q1, cleanup: cleanup1 } = createQuery(PROMPT_UNRESTRICTED, {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      // NO network.allowedDomains — this is the key:
      // With the patch, the proxy won't start because there are no domain rules.
      // Without the patch, oz1() creates an empty allowedDomains array and the
      // proxy starts with an empty allowlist, blocking everything.
    },
    maxTurns: 3,
  }, 120_000)

  const msgs1 = await collectMessages(q1, { cleanup: cleanup1 })
  dumpMessages(msgs1)

  const status1 = extractHttpStatus(msgs1)
  console.log(`  HTTP status from unrestricted test: ${status1}`)

  // Bash tool was used
  t.assertSome(
    '[unrestricted] Bash tool was used',
    msgs1,
    (m) =>
      m.type === 'assistant' &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'tool_use' && b.name === 'Bash')
  )

  // curl succeeded — got a valid HTTP status code (not 000 or null)
  t.assert(
    '[unrestricted] curl returned valid HTTP status (not blocked by proxy)',
    status1 !== null && status1 >= 100 && status1 < 600 && status1 !== 0
  )

  // No connection failure indicators
  t.assert(
    '[unrestricted] No curl connection failure detected',
    !hasCurlFailure(msgs1)
  )

  // Session completed
  t.assertSome('[unrestricted] Session completed', msgs1, (m) => m.type === 'result')

  // =========================================================================
  // Test 2: Sandbox enabled, WITH allowedDomains → proxy starts, domain works
  // =========================================================================
  console.log('\n  --- Test 2: Sandbox enabled, with allowedDomains for google.com ---')
  console.log('  Expecting curl to succeed (domain is in allowlist)...')

  const { q: q2, cleanup: cleanup2 } = createQuery(PROMPT_RESTRICTED, {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: ['google.com', '*.google.com'],
      },
    },
    maxTurns: 3,
  }, 120_000)

  const msgs2 = await collectMessages(q2, { cleanup: cleanup2 })
  dumpMessages(msgs2)

  const status2 = extractHttpStatus(msgs2)
  console.log(`  HTTP status from restricted test: ${status2}`)

  // Bash tool was used
  t.assertSome(
    '[restricted] Bash tool was used',
    msgs2,
    (m) =>
      m.type === 'assistant' &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'tool_use' && b.name === 'Bash')
  )

  // curl succeeded — google.com is in the allowlist
  t.assert(
    '[restricted] curl returned valid HTTP status (domain allowed)',
    status2 !== null && status2 >= 100 && status2 < 600 && status2 !== 0
  )

  // Session completed
  t.assertSome('[restricted] Session completed', msgs2, (m) => m.type === 'result')

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
