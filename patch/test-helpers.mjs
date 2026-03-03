/**
 * Shared test utilities for SDK patch verification.
 *
 * Usage:
 *   import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Project root — used as cwd so the SDK has real files to work with */
export const PROJECT_ROOT = resolve(__dirname, '..')

/**
 * Unset CLAUDECODE env var to allow running SDK tests from within a Claude Code session.
 * The SDK blocks nested sessions by checking this env var.
 */
delete process.env.CLAUDECODE

/**
 * Create an SDK query with safe defaults for testing.
 *
 * @param {string} prompt - The prompt to send
 * @param {object} [optsOverride] - Override any default option
 * @param {number} [timeoutMs=120_000] - Abort timeout in milliseconds
 * @returns {{ q: import('@anthropic-ai/claude-agent-sdk').Query, cleanup: () => void, ac: AbortController }}
 */
export function createQuery(prompt, optsOverride = {}, timeoutMs = 120_000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)

  const cleanup = () => {
    clearTimeout(timer)
    if (!ac.signal.aborted) ac.abort()
  }

  const q = query({
    prompt,
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      settingSources: [],
      thinking: { type: 'enabled', budgetTokens: 10_000 },
      effort: 'low',
      model: 'claude-sonnet-4-6',
      cwd: PROJECT_ROOT,
      abortController: ac,
      ...optsOverride,
    },
  })

  return { q, cleanup, ac }
}

/**
 * Iterate a query and collect all messages.
 *
 * @param {AsyncGenerator} q - The SDK query generator
 * @param {object} opts
 * @param {(msg: object) => void} [opts.onMessage] - Optional per-message callback (for interactive tests)
 * @param {() => void} opts.cleanup - Cleanup function from createQuery
 * @returns {Promise<object[]>} All collected messages
 */
export async function collectMessages(q, { onMessage, cleanup }) {
  const messages = []
  try {
    for await (const msg of q) {
      if (!msg || typeof msg !== 'object') continue
      messages.push(msg)
      if (onMessage) onMessage(msg)
    }
  } catch (err) {
    // AbortError is expected when we intentionally stop
    if (err.name !== 'AbortError' && !String(err).includes('abort')) {
      console.error('[collectMessages] Error:', err.message || err)
    }
  } finally {
    cleanup()
  }
  return messages
}

/**
 * Simple test runner with per-assertion tracking.
 */
export class TestRunner {
  constructor(name) {
    this.name = name
    this.passed = 0
    this.failed = 0
    this.results = []
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  TEST: ${name}`)
    console.log(`${'='.repeat(60)}\n`)
  }

  assert(label, bool) {
    if (bool) {
      this.passed++
      this.results.push({ label, ok: true })
      console.log(`  \x1b[32mPASS\x1b[0m  ${label}`)
    } else {
      this.failed++
      this.results.push({ label, ok: false })
      console.log(`  \x1b[31mFAIL\x1b[0m  ${label}`)
    }
  }

  /**
   * Assert that at least one message in the array matches the predicate.
   */
  assertSome(label, messages, predicateFn) {
    const found = messages.some(predicateFn)
    this.assert(label, found)
  }

  /**
   * Print summary and return true if all passed.
   */
  summarize() {
    const total = this.passed + this.failed
    console.log('')
    console.log(`  ${this.name}: ${this.passed}/${total} passed`)
    if (this.failed > 0) {
      console.log(`  \x1b[31m${this.failed} FAILED\x1b[0m`)
    } else {
      console.log(`  \x1b[32mALL PASSED\x1b[0m`)
    }
    console.log('')
    return this.failed === 0
  }
}

/**
 * Async iterable channel for pushing messages to an SDK query mid-turn.
 * Mirrors the MessageChannel pattern from src/main/services/claude-session.ts.
 */
export class MessageChannel {
  constructor() {
    this.queue = []
    this.waiting = null
    this.isDone = false
  }

  push(msg) {
    if (this.isDone) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: msg, done: false })
    } else {
      this.queue.push(msg)
    }
  }

  end() {
    this.isDone = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator]() {
    return this
  }

  async next() {
    if (this.queue.length > 0) {
      return { value: this.queue.shift(), done: false }
    }
    if (this.isDone) {
      return { value: undefined, done: true }
    }
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}

/**
 * Build an SDKUserMessage object from a plain text string.
 */
export function userMessage(text, sessionId = '') {
  return {
    type: 'user',
    session_id: sessionId,
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  }
}

/**
 * Create an SDK query with streaming input (AsyncIterable) for tests
 * that need to send messages mid-turn (e.g., queue steering, multi-turn MCP toggle).
 *
 * @param {string} initialPrompt - First message to send
 * @param {object} [optsOverride] - Override any default option
 * @param {number} [timeoutMs=120_000] - Abort timeout in milliseconds
 * @returns {{ q: Query, channel: MessageChannel, cleanup: () => void, ac: AbortController }}
 */
export function createStreamingQuery(initialPrompt, optsOverride = {}, timeoutMs = 120_000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const channel = new MessageChannel()

  // Push initial prompt as SDKUserMessage
  channel.push(userMessage(initialPrompt))

  const cleanup = () => {
    clearTimeout(timer)
    channel.end()
    if (!ac.signal.aborted) ac.abort()
  }

  const q = query({
    prompt: channel,
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      settingSources: [],
      thinking: { type: 'enabled', budgetTokens: 10_000 },
      effort: 'low',
      model: 'claude-sonnet-4-6',
      cwd: PROJECT_ROOT,
      abortController: ac,
      ...optsOverride,
    },
  })

  return { q, channel, cleanup, ac }
}

/**
 * Debug dump of collected messages for diagnosing test failures.
 */
export function dumpMessages(messages) {
  console.log(`\n--- Collected ${messages.length} messages ---`)
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const type = m.type || '?'
    const subtype = m.subtype || ''
    const parentId = m.parent_tool_use_id ?? null
    const teammateId = m.teammate_id ?? null
    const taskId = m.task_id ?? null

    const parts = [`[${i}] type=${type}`]
    if (subtype) parts.push(`subtype=${subtype}`)
    if (parentId !== null) parts.push(`parent_tool_use_id=${parentId || 'null'}`)
    if (teammateId) parts.push(`teammate_id=${teammateId}`)
    if (taskId) parts.push(`task_id=${taskId}`)

    // For assistant messages, show content block types
    if (type === 'assistant' && m.message?.content) {
      const blockTypes = m.message.content.map((b) => b.type || '?')
      parts.push(`blocks=[${blockTypes.join(',')}]`)
      // Show tool names
      for (const b of m.message.content) {
        if (b.type === 'tool_use') parts.push(`tool=${b.name}`)
      }
    }

    // For stream_event, show event type
    if (type === 'stream_event' && m.event) {
      parts.push(`event_type=${m.event.type}`)
    }

    // For system messages with status
    if (type === 'system' && m.status) {
      parts.push(`status=${m.status}`)
    }

    console.log(`  ${parts.join('  ')}`)
  }
  console.log('--- End dump ---\n')
}
