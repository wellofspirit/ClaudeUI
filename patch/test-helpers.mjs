/**
 * Shared test utilities for patch verification.
 *
 * Drives the vendored cli.js directly (no SDK dependency). Implements just
 * enough of the stream-json protocol to send a prompt, collect messages,
 * and return.
 *
 * Usage:
 *   import { createQuery, collectMessages, TestRunner, dumpMessages,
 *            createStreamingQuery, MessageChannel, userMessage } from '../test-helpers.mjs'
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Project root — used as cwd so the CLI has real files to work with */
export const PROJECT_ROOT = resolve(__dirname, '..')

/** Path to the vendored, patched cli.js. */
export const CLI_JS_PATH = resolve(PROJECT_ROOT, 'vendor', 'claude-cli', 'cli.js')

/**
 * Unset CLAUDECODE env var to allow running tests from within a Claude Code session.
 * The CLI blocks nested sessions by checking this env var.
 */
delete process.env.CLAUDECODE

// ---------------------------------------------------------------------------
// Minimal stream-json driver
// ---------------------------------------------------------------------------

function buildArgs(options) {
  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
  ]
  if (options.thinking) {
    args.push('--thinking', options.thinking.type)
    if (options.thinking.budgetTokens) {
      args.push('--max-thinking-tokens', String(options.thinking.budgetTokens))
    }
  }
  if (options.effort) args.push('--effort', options.effort)
  if (options.maxTurns != null) args.push('--max-turns', String(options.maxTurns))
  if (options.model) args.push('--model', options.model)
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode)
  if (options.allowDangerouslySkipPermissions) args.push('--allow-dangerously-skip-permissions')
  if (options.persistSession === false) args.push('--no-session-persistence')
  if (options.resume) args.push('--resume', options.resume)
  if (Array.isArray(options.settingSources) && options.settingSources.length) {
    args.push('--setting-sources', options.settingSources.join(','))
  }
  if (Array.isArray(options.allowedTools) && options.allowedTools.length) {
    args.push('--allowedTools', options.allowedTools.join(','))
  }
  if (Array.isArray(options.tools)) {
    args.push('--tools', options.tools.length ? options.tools.join(',') : '')
  }
  return args
}

/**
 * Spawn cli.js and return a Query object compatible with the tests' expected
 * shape: an async-iterable over parsed stream-json messages + an interrupt()
 * method that sends SIGTERM.
 *
 * The query object also maintains an input writer so streaming queries
 * (createStreamingQuery) can push additional messages mid-turn.
 */
function spawnQuery({ prompt, options, ac }) {
  const args = [CLI_JS_PATH, ...buildArgs(options)]
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const writer = (obj) => {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + '\n')
  }

  // Feed the initial prompt(s).
  if (typeof prompt === 'string') {
    writer({ type: 'user', message: { role: 'user', content: prompt } })
  } else if (prompt && typeof prompt[Symbol.asyncIterator] === 'function') {
    ;(async () => {
      for await (const msg of prompt) writer(msg)
    })().catch(() => {})
  }

  // Abort propagation
  if (ac) {
    ac.signal.addEventListener('abort', () => {
      try { child.kill('SIGTERM') } catch {}
    })
  }

  // Stream parser
  const queue = []
  let waiter = null
  let done = false
  let error = null

  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (waiter) { const w = waiter; waiter = null; w({ value: obj, done: false }) }
        else queue.push(obj)
      } catch { /* skip non-JSON lines (shouldn't happen in stream-json mode) */ }
    }
  })

  child.stderr.on('data', () => { /* swallow */ })
  child.on('exit', () => {
    done = true
    if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }) }
  })
  child.on('error', (err) => {
    error = err
    done = true
    if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }) }
  })

  return {
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (queue.length) return { value: queue.shift(), done: false }
      if (done) {
        if (error) throw error
        return { value: undefined, done: true }
      }
      return new Promise((resolve) => { waiter = resolve })
    },
    async interrupt() { try { child.kill('SIGTERM') } catch {} },
    _writer: writer,
    _child: child,
  }
}

/**
 * Create a query with safe test defaults.
 *
 * @param {string} prompt
 * @param {object} [optsOverride]
 * @param {number} [timeoutMs=120_000]
 * @returns {{ q, cleanup, ac }}
 */
export function createQuery(prompt, optsOverride = {}, timeoutMs = 120_000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const cleanup = () => {
    clearTimeout(timer)
    if (!ac.signal.aborted) ac.abort()
  }
  const q = spawnQuery({
    prompt,
    ac,
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      settingSources: [],
      thinking: { type: 'enabled', budgetTokens: 10_000 },
      effort: 'low',
      model: 'claude-sonnet-4-6',
      cwd: PROJECT_ROOT,
      ...optsOverride,
    },
  })
  return { q, cleanup, ac }
}

export async function collectMessages(q, { onMessage, cleanup } = {}) {
  const messages = []
  try {
    for await (const msg of q) {
      if (!msg || typeof msg !== 'object') continue
      messages.push(msg)
      if (onMessage) onMessage(msg)
    }
  } catch (err) {
    if (err.name !== 'AbortError' && !String(err).includes('abort')) {
      console.error('[collectMessages] Error:', err.message || err)
    }
  } finally {
    cleanup?.()
  }
  return messages
}

// ---------------------------------------------------------------------------
// TestRunner
// ---------------------------------------------------------------------------

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
  assertSome(label, messages, predicateFn) {
    this.assert(label, messages.some(predicateFn))
  }
  summarize() {
    const total = this.passed + this.failed
    console.log('')
    console.log(`  ${this.name}: ${this.passed}/${total} passed`)
    if (this.failed > 0) console.log(`  \x1b[31m${this.failed} FAILED\x1b[0m`)
    else console.log(`  \x1b[32mALL PASSED\x1b[0m`)
    console.log('')
    return this.failed === 0
  }
}

// ---------------------------------------------------------------------------
// Streaming input channel (for tests that push messages mid-turn)
// ---------------------------------------------------------------------------

export class MessageChannel {
  constructor() { this.queue = []; this.waiting = null; this.isDone = false }
  push(msg) {
    if (this.isDone) return
    if (this.waiting) { const r = this.waiting; this.waiting = null; r({ value: msg, done: false }) }
    else this.queue.push(msg)
  }
  end() {
    this.isDone = true
    if (this.waiting) { const r = this.waiting; this.waiting = null; r({ value: undefined, done: true }) }
  }
  [Symbol.asyncIterator]() { return this }
  async next() {
    if (this.queue.length) return { value: this.queue.shift(), done: false }
    if (this.isDone) return { value: undefined, done: true }
    return new Promise((resolve) => { this.waiting = resolve })
  }
}

export function userMessage(text, sessionId = '') {
  return {
    type: 'user',
    session_id: sessionId,
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  }
}

export function createStreamingQuery(initialPrompt, optsOverride = {}, timeoutMs = 120_000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const channel = new MessageChannel()
  channel.push(userMessage(initialPrompt))
  const cleanup = () => {
    clearTimeout(timer)
    channel.end()
    if (!ac.signal.aborted) ac.abort()
  }
  const q = spawnQuery({
    prompt: channel,
    ac,
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      settingSources: [],
      thinking: { type: 'enabled', budgetTokens: 10_000 },
      effort: 'low',
      model: 'claude-sonnet-4-6',
      cwd: PROJECT_ROOT,
      ...optsOverride,
    },
  })
  return { q, channel, cleanup, ac }
}

// ---------------------------------------------------------------------------
// Debug dump
// ---------------------------------------------------------------------------

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
    if (type === 'assistant' && m.message?.content) {
      const blockTypes = m.message.content.map((b) => b.type || '?')
      parts.push(`blocks=[${blockTypes.join(',')}]`)
      for (const b of m.message.content) {
        if (b.type === 'tool_use') parts.push(`tool=${b.name}`)
      }
    }
    if (type === 'stream_event' && m.event) parts.push(`event_type=${m.event.type}`)
    if (type === 'system' && m.status) parts.push(`status=${m.status}`)
    console.log(`  ${parts.join('  ')}`)
  }
  console.log('--- End dump ---\n')
}

// Not actually used (randomUUID is imported) but kept for legacy imports.
export { randomUUID as _randomUUID }
