/**
 * PiRpcClient — owns a single `pi --mode rpc` child process and speaks its
 * JSONL wire protocol (see docs/protocol-pi/README.md +
 * vendor/pi-src/packages/coding-agent/docs/rpc.md).
 *
 * Framing rules (verified — README.md "Transport"): split stdout on `\n` ONLY,
 * strip a trailing `\r`, never use Node `readline` (it also splits on
 * U+2028/U+2029, which are legal inside JSON strings — corrupting any message
 * text/thinking content containing them). stdout is pure protocol; stderr is
 * free-form logging.
 *
 * The framing/correlation core (handleStdout/handleLine) takes no dependency
 * on `spawn` itself, so it's unit-testable by feeding chunks directly (see
 * __tests__/pi-rpc-client.test.ts) without spawning a real process.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { v4 as uuid } from 'uuid'
import type { PiEvent, PiRpcCommand, PiRpcResponse } from './pi-protocol'
import { logger } from '../services/logger'
import { killProcessTree } from '../services/process-tree'
import { toLaunch, withLaunch, type HarnessLaunch } from '../harness/launch'

export interface PiRpcClientOptions {
  cwd: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

interface PendingRequest {
  resolve: (response: PiRpcResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * How long dispose() waits for pi to exit on its own after stdin EOF before
 * tree-killing it. pi answers EOF with its normal shutdown (aborting the agent
 * and its tools) and exits in ~0.07s median / ~0.25s worst measured — the grace
 * only has to cover a shutdown that hangs (e.g. an extension's
 * `session_shutdown` handler).
 */
export const PI_DISPOSE_GRACE_MS = 2_000

export class PiRpcClient {
  private proc: ChildProcess | null = null
  private stdoutBuffer = ''
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventHandlers: Array<(ev: PiEvent) => void> = []
  private readonly exitHandlers: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = []
  private exited = false
  /** Set by dispose(): no more requests, no more events — only the exit is still reported. */
  private disposed = false
  /** dispose()'s tree-kill fallback, armed while pi shuts down on stdin EOF; cleared on exit. */
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private readonly launch: HarnessLaunch

  /**
   * `launch` is how to start pi (`locatePiLaunch()`): a native executable, or
   * `<node> <cli.js>` for an npm install (ADR-082 §2). A bare path is a native
   * launch.
   */
  constructor(
    launch: HarnessLaunch | string,
    private readonly opts: PiRpcClientOptions
  ) {
    this.launch = toLaunch(launch)
  }

  /** Spawn the child process and wire stdout/stderr framing. Resolves once the process has spawned. */
  start(): Promise<void> {
    // A process spawned after dispose() would have no owner left to end it.
    if (this.disposed) return Promise.reject(new Error('PiRpcClient: disposed'))
    return new Promise((resolve, reject) => {
      let proc: ChildProcess
      try {
        const spec = withLaunch(this.launch, this.opts.args, { ...process.env, ...this.opts.env })
        proc = spawn(spec.command, spec.args, {
          cwd: this.opts.cwd,
          env: spec.env,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      this.proc = proc

      proc.stdout?.setEncoding('utf-8')
      proc.stdout?.on('data', (chunk: string) => this.handleStdoutChunk(chunk))

      proc.stderr?.setEncoding('utf-8')
      proc.stderr?.on('data', (chunk: string) => {
        const text = chunk.toString().trimEnd()
        if (text) logger.debug('PiRpcClient', `stderr: ${text}`)
      })

      // A half-open stdin can emit an async 'error' (EPIPE) after the child
      // dies while a request write is in flight. With no listener that becomes
      // a process-level uncaughtException. Swallow it — handleExit already
      // rejects every pending request (mirrors sdk/query.ts's stdin guard).
      proc.stdin?.on('error', (err: Error) => {
        logger.debug('PiRpcClient', `stdin error (child teardown race): ${err.message}`)
      })

      // Both listeners can be attached simultaneously: on a bad binary path,
      // 'error' fires (spawn never happened) and 'spawn' never fires. On a
      // healthy spawn, 'spawn' fires first and settles the promise; a LATER
      // 'error' (e.g. EPIPE) is a no-op against an already-resolved promise.
      proc.once('spawn', () => resolve())
      proc.once('error', (err) => reject(err))
      // once('error') above only settles the START promise. It fires at most
      // once, so a SECOND process 'error' (or any error after spawn) would have
      // no listener → uncaughtException. This persistent handler absorbs those.
      proc.on('error', (err: Error) => {
        logger.debug('PiRpcClient', `process error: ${err.message}`)
      })

      proc.on('exit', (code, signal) => this.handleExit(code, signal))
    })
  }

  /**
   * Send a command and await its correlated response. Auto-assigns `id` when
   * absent. Rejects on timeout or if the process exits before a response
   * arrives. Resolves (does NOT reject) on `success: false` — callers decide
   * what an application-level failure means.
   */
  request<T = unknown>(
    cmd: PiRpcCommand,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<PiRpcResponse<T>> {
    if (!this.proc || this.exited || this.disposed) {
      return Promise.reject(new Error('PiRpcClient: process is not running'))
    }
    const id = cmd.id ?? uuid()
    const outgoing: PiRpcCommand = { ...cmd, id }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `PiRpcClient: request "${outgoing.type}" (id=${id}) timed out after ${timeoutMs}ms`
          )
        )
      }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (response: PiRpcResponse) => void,
        reject,
        timer
      })

      try {
        this.writeLine(outgoing)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Subscribe to every non-response stdout JSON line (agent events). Returns an unsubscribe function. */
  onEvent(cb: (ev: PiEvent) => void): () => void {
    this.eventHandlers.push(cb)
    return () => {
      const idx = this.eventHandlers.indexOf(cb)
      if (idx >= 0) this.eventHandlers.splice(idx, 1)
    }
  }

  /** Subscribe to process exit. Returns an unsubscribe function. */
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitHandlers.push(cb)
    return () => {
      const idx = this.exitHandlers.indexOf(cb)
      if (idx >= 0) this.exitHandlers.splice(idx, 1)
    }
  }

  /**
   * End the child: close its stdin so pi shuts itself down, and tree-kill it
   * only if it is still running {@link PI_DISPOSE_GRACE_MS} later. Synchronous
   * and idempotent. Pending requests reject now and no further events are
   * delivered; onExit handlers still fire when the process actually exits.
   *
   * Why not signal straight away: pi takes proper-lockfile locks on
   * `~/.pi/agent/models-store.json`/`auth.json` while it starts, and installs
   * its SIGTERM handler only once RPC mode runs. A signal during startup kills
   * it holding the lock dir, and every pi started in the next 30s (the lock's
   * stale window) blocks on it — long enough to time out model discovery's
   * probe. stdin EOF instead lets pi finish starting, then run its own
   * shutdown (`onInputEnd` in vendor/pi-src/packages/coding-agent/src/modes/
   * rpc/rpc-mode.ts), which releases the locks and aborts the agent — its bash
   * tool kills its own process tree on that abort. Same on every platform:
   * Windows has no graceful signal at all (both kill paths terminate), so it
   * is the one place a leaked lock could happen at any point in pi's life.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Callers tearing down must not wait out pi's shutdown (or the grace) for
    // an answer that will never come.
    this.rejectPending(new Error('PiRpcClient: disposed before responding'))
    const proc = this.proc
    if (!proc || this.exited) return
    const stdin = proc.stdin
    if (stdin && !stdin.destroyed) {
      try {
        stdin.end()
      } catch {
        /* already torn down — the fallback below still reaps the process */
      }
    }
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      if (this.exited) return
      // M-PI3: taskkill MUST reap the tree before proc.kill() runs — see
      // killProcessTree. taskkill terminating the root still fires the 'exit'
      // event exit-handler cleanup relies on.
      killProcessTree(proc)
    }, PI_DISPOSE_GRACE_MS)
    // Never hold the app open just to reap a child.
    this.killTimer.unref?.()
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  // ---------------------------------------------------------------------------
  // Framing internals (unit-testable without a real process — see start()'s
  // caller wiring the same handlers to a fake stdout stream in tests)
  // ---------------------------------------------------------------------------

  /** Exposed for tests: feed a raw stdout chunk through the same framing path `start()` wires up. */
  handleStdoutChunk(chunk: string): void {
    // After dispose() the 'data' listener stays attached so stdout keeps
    // draining (pi flushes it before exiting — an unread pipe would stall its
    // shutdown into the kill); the lines are just never delivered.
    if (this.disposed) return
    this.stdoutBuffer += chunk
    // Split on '\n' ONLY — never a generic line-reader (see file header).
    const lines = this.stdoutBuffer.split('\n')
    // The last element is either '' (chunk ended on a newline) or a partial
    // line to keep buffering — either way, hold it back for the next chunk.
    this.stdoutBuffer = lines.pop() ?? ''
    for (const rawLine of lines) {
      this.handleLine(rawLine)
    }
  }

  private handleLine(rawLine: string): void {
    // Strip a trailing '\r' (tolerate CRLF input) per the framing rules.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0) return

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      logger.warn('PiRpcClient', `Non-JSON stdout line ignored: ${line.slice(0, 200)}`)
      return
    }

    if (!parsed || typeof parsed !== 'object') {
      logger.warn('PiRpcClient', `Ignoring non-object stdout line: ${line.slice(0, 200)}`)
      return
    }

    const obj = parsed as Record<string, unknown>
    if (obj.type === 'response') {
      this.handleResponse(obj as unknown as PiRpcResponse)
      return
    }

    // Everything else is an agent event.
    for (const cb of this.eventHandlers) {
      try {
        cb(obj as unknown as PiEvent)
      } catch (err) {
        logger.error('PiRpcClient', 'onEvent handler threw', err)
      }
    }
  }

  private handleResponse(response: PiRpcResponse): void {
    const id = response.id
    if (!id) {
      logger.warn(
        'PiRpcClient',
        `Response with no id (command=${response.command}) — cannot correlate`
      )
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      // No matching request (e.g. a stale/duplicate response) — nothing to resolve.
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(response)
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    this.rejectPending(
      new Error(`pi process exited (code=${code}, signal=${signal}) before responding`)
    )
    for (const cb of this.exitHandlers) {
      try {
        cb(code, signal)
      } catch (handlerErr) {
        logger.error('PiRpcClient', 'onExit handler threw', handlerErr)
      }
    }
  }

  private rejectPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }

  private writeLine(obj: Record<string, unknown>): void {
    if (!this.proc?.stdin || !this.proc.stdin.writable) {
      throw new Error('PiRpcClient: stdin is not writable')
    }
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }
}
