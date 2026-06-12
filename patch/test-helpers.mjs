/**
 * Shared test utilities for patch verification.
 *
 * Drives the rebundled Bun standalone binary (`vendor/claude-cli/bun-claude`)
 * directly — no Node shim, no cli.js arg. The binary embeds our patched
 * cli.js inside Anthropic's Bun runtime; patches are verified against real
 * observable wire behaviour.
 *
 * Produced by `bun run ensure-cli` / `bun run update-cli`.
 *
 * Protocol mirrors src/main/sdk/: newline-delimited JSON on stdio, with a
 * control channel for request/response pairs (stopTask, mcpServerStatus,
 * dequeueMessage, toggleMcpServer, …).
 *
 * Usage:
 *   import { createQuery, collectMessages, TestRunner, dumpMessages,
 *            createStreamingQuery, MessageChannel, userMessage } from '../test-helpers.mjs'
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Project root — used as cwd so cli.js has real files to work with. */
export const PROJECT_ROOT = resolve(__dirname, '..')

/**
 * Path to the rebundled Bun standalone binary. This is the same binary
 * production ClaudeUI spawns — running tests through it guarantees patches
 * are tested in the exact form they ship.
 */
const BIN_NAME = process.platform === 'win32' ? 'bun-claude.exe' : 'bun-claude'
export const BUN_CLAUDE_PATH = resolve(PROJECT_ROOT, 'vendor', 'claude-cli', BIN_NAME)

/** @deprecated Kept for legacy imports — prefer BUN_CLAUDE_PATH. */
export const CLI_JS_PATH = BUN_CLAUDE_PATH

/**
 * Unset CLAUDECODE env var so tests can run from within a Claude Code
 * session. cli.js blocks nested sessions by checking this variable.
 */
delete process.env.CLAUDECODE

// ---------------------------------------------------------------------------
// CLI argv builder — mirrors src/main/sdk/args.ts for the flags tests use
// ---------------------------------------------------------------------------

function buildArgs(options) {
  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
  ]
  if (options.thinking) {
    const t = options.thinking
    if (t.type === 'enabled' && t.budgetTokens === undefined) {
      args.push('--thinking', 'adaptive')
    } else if (t.type === 'enabled') {
      args.push('--max-thinking-tokens', String(t.budgetTokens))
    } else if (t.type === 'disabled') {
      args.push('--thinking', 'disabled')
    } else {
      args.push('--thinking', t.type)
      if (typeof t.budgetTokens === 'number') {
        args.push('--max-thinking-tokens', String(t.budgetTokens))
      }
    }
  }
  if (options.effort) args.push('--effort', options.effort)
  if (options.maxTurns != null) args.push('--max-turns', String(options.maxTurns))
  if (options.model) args.push('--model', options.model)
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode)
  if (options.allowDangerouslySkipPermissions) args.push('--allow-dangerously-skip-permissions')
  if (options.persistSession === false) args.push('--no-session-persistence')
  if (options.resume) args.push('--resume', options.resume)
  if (options.includePartialMessages !== false) args.push('--include-partial-messages')
  if (options.includeHookEvents) args.push('--include-hook-events')
  if (Array.isArray(options.settingSources)) {
    args.push(`--setting-sources=${options.settingSources.join(',')}`)
  }
  if (Array.isArray(options.allowedTools) && options.allowedTools.length) {
    args.push('--allowedTools', options.allowedTools.join(','))
  }
  if (Array.isArray(options.tools)) {
    args.push('--tools', options.tools.length ? options.tools.join(',') : '')
  }
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: options.mcpServers }))
  }
  if (options.strictMcpConfig) args.push('--strict-mcp-config')
  if (options.sandbox) {
    args.push('--settings', JSON.stringify({ sandbox: options.sandbox }))
  } else if (options.settings !== undefined) {
    args.push(
      '--settings',
      typeof options.settings === 'string' ? options.settings : JSON.stringify(options.settings),
    )
  }
  return args
}

// ---------------------------------------------------------------------------
// spawnQuery — spawn bun-claude, parse stream-json, expose a control channel
// ---------------------------------------------------------------------------

/**
 * Spawn bun-claude and return an async-iterable query handle with control
 * methods (close/stopTask/mcpServerStatus/dequeueMessage/toggleMcpServer).
 *
 * The handle iterates stream-json data messages. Control responses are
 * intercepted and routed to the pending request map instead of being yielded.
 */
function spawnQuery({ prompt, options, ac }) {
  if (!existsSync(BUN_CLAUDE_PATH)) {
    throw new Error(
      `bun-claude not found at ${BUN_CLAUDE_PATH}. Run "bun run ensure-cli" (or "bun run update-cli") first.`,
    )
  }

  const child = spawn(BUN_CLAUDE_PATH, buildArgs(options), {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  // Fatal spawn error — child.pid will be undefined and exit will fire with an error.
  let spawnError = null
  child.on('error', (err) => { spawnError = err })

  const writer = (obj) => {
    if (!child.stdin || !child.stdin.writable) return
    try {
      child.stdin.write(JSON.stringify(obj) + '\n')
    } catch {
      // Pipe closed — race with child teardown, ignore.
    }
  }

  // --- Control channel -----------------------------------------------------
  const pending = new Map()
  const controlRequest = (subtype, fields = {}, { timeoutMs = 30_000 } = {}) =>
    new Promise((resolve, reject) => {
      const request_id = randomUUID().slice(0, 13)
      let timer = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const p = pending.get(request_id)
          if (!p) return
          pending.delete(request_id)
          reject(new Error(`control_request ${subtype} (${request_id}) timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }
      pending.set(request_id, {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value) },
        reject: (err) => { if (timer) clearTimeout(timer); reject(err) },
      })
      writer({ type: 'control_request', request_id, request: { subtype, ...fields } })
    })

  // --- Message queue -------------------------------------------------------
  const queue = []
  let waiter = null
  let done = false
  let iterError = null

  const finish = (err) => {
    if (done) return
    done = true
    if (err) iterError = err
    // Reject any in-flight control requests — the child is gone.
    for (const [, p] of pending) {
      try { p.reject(new Error(err ? err.message : 'cli.js exited')) } catch {}
    }
    pending.clear()
    if (waiter) {
      const w = waiter
      waiter = null
      w({ value: undefined, done: true })
    }
  }

  // --- Stdin: initial prompt feed -----------------------------------------
  if (typeof prompt === 'string') {
    writer({ type: 'user', message: { role: 'user', content: prompt } })
  } else if (prompt && typeof prompt[Symbol.asyncIterator] === 'function') {
    ;(async () => {
      for await (const msg of prompt) writer(msg)
    })().catch(() => { /* child teardown races input iterator — ignore */ })
  }

  // --- Abort propagation --------------------------------------------------
  if (ac) {
    ac.signal.addEventListener(
      'abort',
      () => { try { child.kill('SIGTERM') } catch { /* already dead */ } },
      { once: true },
    )
  }

  // --- Stdout: NDJSON stream parser ---------------------------------------
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue // cli.js in stream-json mode shouldn't emit non-JSON, but be defensive.
      }

      // Intercept control_response — never deliver to the message iterator.
      if (obj && obj.type === 'control_response') {
        const resp = obj.response ?? {}
        const id = resp.request_id
        const p = id ? pending.get(id) : null
        if (p) {
          pending.delete(id)
          if (resp.subtype === 'error') {
            p.reject(new Error(resp.error || 'control request failed'))
          } else {
            p.resolve(resp.response ?? null)
          }
        }
        continue
      }

      // Inbound control_request (can_use_tool, hooks, initialize, etc.) —
      // the test harness doesn't register handlers; drop them. Tests that
      // need these features should use the real SDK harness.
      if (obj && obj.type === 'control_request') continue

      if (waiter) {
        const w = waiter
        waiter = null
        w({ value: obj, done: false })
      } else {
        queue.push(obj)
      }
    }
  })

  // --- Stderr: forward if DEBUG_HARNESS, else swallow ---------------------
  if (process.env.DEBUG_HARNESS) {
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  } else {
    child.stderr.on('data', () => { /* swallow */ })
  }

  child.on('exit', (code, signal) => {
    if (spawnError) return finish(spawnError)
    // Clean exits (SIGTERM from close/abort, normal exit 0, exit 143 = 128+SIGTERM)
    // are treated as normal stream termination, not errors.
    if (signal === 'SIGTERM' || code === 0 || code === 143 || code === null) {
      finish()
    } else {
      finish(new Error(`cli.js exited with code=${code} signal=${signal}`))
    }
  })

  // No explicit initialize — cli.js auto-initialises its own session for
  // tests that don't need to register SDK-hosted MCP servers or hook
  // callbacks. Tests that DO need those features should go through
  // src/main/sdk/ via the main process, not this harness.

  return {
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (queue.length) return { value: queue.shift(), done: false }
      if (done) {
        if (iterError) throw iterError
        return { value: undefined, done: true }
      }
      return new Promise((resolve) => { waiter = resolve })
    },
    /** Send SIGTERM. Prefer close() for graceful shutdown. */
    async interrupt() { try { child.kill('SIGTERM') } catch { /* ignore */ } },
    /** Close stdin, then send SIGTERM so cli.js shuts down cleanly. */
    async close() {
      try { child.stdin.end() } catch { /* ignore */ }
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    },

    // --- Control-channel methods (mirror src/main/sdk/query.ts) -----------
    async stopTask(task_id) {
      return controlRequest('stop_task', { task_id })
    },
    async dequeueMessage(value) {
      const r = await controlRequest('dequeue_message', { value })
      return { removed: r?.removed ?? 0 }
    },
    async mcpServerStatus() {
      const r = await controlRequest('mcp_status', {})
      if (Array.isArray(r)) return r
      return r?.mcpServers ?? []
    },
    async toggleMcpServer(serverName, enabled) {
      return controlRequest('mcp_toggle', { serverName, enabled })
    },
    async reconnectMcpServer(serverName) {
      return controlRequest('mcp_reconnect', { serverName })
    },
    async getUsage() {
      return (await controlRequest('get_usage', {})) ?? {}
    },
    async getContextUsage() {
      return (await controlRequest('get_context_usage', {})) ?? {}
    },
    /** Escape hatch — call any control subtype by name. */
    async controlRequest(subtype, fields = {}, opts = {}) {
      return controlRequest(subtype, fields, opts)
    },

    _writer: writer,
    _child: child,
  }
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  persistSession: false,
  settingSources: [],
  thinking: { type: 'enabled', budgetTokens: 10_000 },
  effort: 'low',
  model: 'claude-sonnet-4-6',
}

/**
 * Create a query with safe test defaults.
 *
 * @param {string} prompt
 * @param {object} [optsOverride]
 * @param {number} [timeoutMs=120_000]
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
    options: { ...DEFAULT_OPTIONS, cwd: PROJECT_ROOT, ...optsOverride },
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
// Streaming input channel — for tests that push messages mid-turn
// ---------------------------------------------------------------------------

export class MessageChannel {
  constructor() { this.queue = []; this.waiting = null; this.isDone = false }
  push(msg) {
    if (this.isDone) return
    if (this.waiting) {
      const r = this.waiting
      this.waiting = null
      r({ value: msg, done: false })
    } else {
      this.queue.push(msg)
    }
  }
  end() {
    this.isDone = true
    if (this.waiting) {
      const r = this.waiting
      this.waiting = null
      r({ value: undefined, done: true })
    }
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
    options: { ...DEFAULT_OPTIONS, cwd: PROJECT_ROOT, ...optsOverride },
  })
  return { q, channel, cleanup, ac }
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

// Legacy re-export — some tests still import this.
export { randomUUID as _randomUUID }
