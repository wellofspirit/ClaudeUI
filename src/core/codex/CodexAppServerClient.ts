import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import { getLogDir, logger } from '../services/logger'
import { killProcessTree } from '../services/process-tree'
import { codexHomeForEnv, codexHomeKey } from './codex-home'
import { locateCodexBinary } from './codex-locate'
import type { InitializeParams } from './protocol/InitializeParams'
import type { InitializeResponse } from './protocol/InitializeResponse'
import type { RequestId } from './protocol/RequestId'
import type { JSONRPCMessage } from './protocol/envelopes'
import provenance from './protocol/provenance.json'

/**
 * What the OS said about the child, filled in by the `exit` handler. One record
 * per client, shared BY REFERENCE with every error the client mints for that
 * death — see `CodexTransportError.exitCode`.
 */
export type CodexChildExit = {
  exited: boolean
  code: number | null
  signal: NodeJS.Signals | null
}

export class CodexTransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly ambiguousDelivery = false,
    /**
     * The native `error.message` of an `rpc-error-*` rejection, carried BESIDE
     * `message` (which stays the payload-free `Codex transport: <code>` every
     * existing caller logs and surfaces).
     *
     * It exists for exactly one caller: `CodexClient`'s token injection, where
     * the refusal IS the product message — a `forced_chatgpt_workspace_id` in
     * the user's `config.toml` rejects tokens from other workspaces and ADR-068
     * §1 requires that surfaced verbatim rather than as a numeric code. The
     * native strings on that path name workspaces, never token material
     * (`account_processor.rs::login_chatgpt_auth_tokens_response`, and
     * `IdTokenInfoError`, whose variants carry no JWT).
     *
     * Nothing else reads it, and nothing logs it.
     */
    public readonly nativeMessage?: string,
    /**
     * The native machine-readable error TAG of an `rpc-error-*` rejection, when
     * the app-server attached one: `error.data.config_write_error_code`, the one
     * `data` shape 0.154.0 emits (`request_processors/config_processor.rs`
     * `config_write_error`). `ConfigVersionConflict` is the value the Codex
     * config service has to branch on — a stale `expectedVersion` is a NORMAL
     * outcome (the file moved under us) that re-reads and retries, while every
     * other write failure is shown to the user verbatim.
     *
     * Payload-free by construction, like `code`: the extractor below admits only
     * a short bare-ASCII-identifier string, so it can carry a variant NAME and
     * never a config value, a path or token material. Nothing logs it.
     */
    public readonly nativeCode?: string,
    /**
     * The owning client's exit record, absent for errors minted before a child
     * existed. Held by reference rather than copied: the case worth debugging —
     * an app-server that dies during startup — rejects on `stdout-closed`
     * BEFORE Node delivers `exit`, so a snapshot taken here would read "no exit
     * yet" every time. Payload-free by construction (a number and a signal
     * name).
     */
    private readonly exit?: CodexChildExit,
    /**
     * Which call site built the client that minted this error — `session`,
     * `auth-probe`, `lineage-scan` — for the callers that log their own line
     * rather than reading the transport's. `unlabelled` when the site named
     * none; undefined on the errors `CodexService` and friends mint outside a
     * transport.
     *
     * Payload-free by construction: {@link callerLabel} admits only a short
     * bare identifier, so no path, account or user text can ride out here.
     */
    public readonly label?: string
  ) {
    super(`Codex transport: ${code}`)
  }

  /** The child's exit status, or undefined while it has not exited. */
  get exitCode(): number | null | undefined {
    return this.exit?.exited ? this.exit.code : undefined
  }

  /** The signal that killed the child, or undefined while it has not exited. */
  get exitSignal(): NodeJS.Signals | null | undefined {
    return this.exit?.exited ? this.exit.signal : undefined
  }
}

/**
 * Failure codes that mean the CHILD went away rather than the client closing a
 * healthy connection. Only these are worth a log line; `disposed`, timeouts and
 * `rpc-error-*` are ordinary operation.
 */
const DEATH_CODES = new Set(['stdout-closed', 'process-exited', 'process-closed', 'spawn-failed'])

/**
 * How long the death report waits for the child's `exit` before giving up and
 * reporting "still running". Node routinely delivers stdout's EOF first, and an
 * exit code is the single most useful field in the line.
 */
const EXIT_REPORT_GRACE_MS = 1000

/**
 * Opt-in, never on by default: with `CLAUDEUI_CODEX_STDERR=1` the child's
 * stderr is copied to a file beside the main log. Codex's stderr can carry key
 * fragments, so it reaches that file and nothing else — no error message, no
 * `session:error`, no log line (the line names the PATH only).
 */
const STDERR_CAPTURE_ENV = 'CLAUDEUI_CODEX_STDERR'

/**
 * Codex builds its sqlite state runtime the first time an app-server starts in a
 * home. Two app-servers racing on a home that has none of those databases yet
 * end with the loser exiting 1 (`failed to initialize sqlite state runtime under
 * <home>`, `app-server/src/lib.rs`), and ClaudeUI's boot starts three within
 * milliseconds — the catalog discovery, the lineage scan and the auth probe. So
 * the FIRST start per home is serialised: while it is in flight every other
 * start on the same home waits here, keyed by the normalised home path. One
 * process per home per ClaudeUI run pays for this; an already-initialised home
 * pays one `readdirSync`. Module-level on purpose — the racing clients are
 * separate instances with no shared owner.
 *
 * Known limit (2026-09-15, captured live): the same failure can also hit an
 * initialised home when an app-server starts while a short-lived sibling (the
 * auth probe's native read) is shutting down a few hundred milliseconds after
 * it started. Widening this gate to every start made that collision
 * deterministic (the waiter is released exactly when the sibling has answered
 * `initialize` and is about to exit), so the gate stays first-run only; the
 * second shape is an open item in `docs/codex-followups-spec.md` (F8 Landed).
 */
const firstRunGate = new Map<string, Promise<void>>()

/** The versioned state databases Codex writes into a home (`state_5.sqlite` in
 *  0.154; `codex-rs/cli/src/state_db_recovery.rs`). A home with one has been
 *  initialised and cannot lose the first-run race. */
function hasCodexStateDb(home: string): boolean {
  try {
    return readdirSync(home).some((name) => /^state_.+\.sqlite$/.test(name))
  } catch {
    // Missing or unreadable: treated as empty, and never created here. A home
    // Codex has not written to is exactly the case the gate exists for.
    return false
  }
}

/**
 * What a caller label may look like: a short bare identifier the CALL SITE
 * chose, never anything derived from the user's machine or input.
 *
 * Narrow on purpose, like {@link nativeErrorCode}. The label is logged, and the
 * transport's standing rule is that nothing with a path, an account, a token or
 * user text reaches the main log. A value outside this shape is dropped rather
 * than printed, so the rule holds even if a future call site passes the wrong
 * thing.
 */
const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** What an unnamed (or unprintable) caller reads as. Never throws. */
const UNLABELLED = 'unlabelled'

function callerLabel(label: string | undefined): string {
  return label !== undefined && LABEL_PATTERN.test(label) ? label : UNLABELLED
}

/**
 * The variant name inside a JSON-RPC `error.data`, or undefined.
 *
 * Deliberately narrow: one known key, a string of at most 64 characters drawn
 * from `[A-Za-z]` only. Anything else — a nested object, a path, a message, a
 * number — is dropped rather than carried, so no value out of the user's config
 * can ride out of the transport on this field.
 */
function nativeErrorCode(error: Record<string, unknown>): string | undefined {
  const data = error.data
  if (!record(data)) return undefined
  const tag = data.config_write_error_code
  return typeof tag === 'string' && /^[A-Za-z]{1,64}$/.test(tag) ? tag : undefined
}
export interface CodexClientOptions {
  cwd: string
  /**
   * Who is starting this app-server, as a bare identifier the call site picks
   * (`session`, `auth-probe`, `rate-limits`, `discovery`, `lineage-scan`, …).
   * About ten sites build a client and every one of their children looks alike
   * in the log, so the spawn and death lines carry this to turn "an app-server
   * died" into "the auth probe's app-server died". Never a path, an account or
   * anything typed by the user — see {@link LABEL_PATTERN}.
   */
  label?: string
  /** Replaces inheritance when supplied; never merged with process.env. */
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  maxFrameBytes?: number
  maxQueuedBytes?: number
  maxPendingRequests?: number
  killGraceMs?: number
  onNotification?: (method: string, params: unknown) => void
  onServerRequest?: (
    method: string,
    params: unknown,
    context: { id: RequestId; signal: AbortSignal }
  ) => Promise<unknown>
  /** Only these methods are dispatched to onServerRequest. */
  serverMethods?: readonly string[]
  onDisconnect?: (error: CodexTransportError) => void
}
type Pending = {
  resolve: (value: unknown) => void
  reject: (error: CodexTransportError) => void
  timer: ReturnType<typeof setTimeout>
  sent: boolean
}
type Incoming = { controller: AbortController; threadId?: string; turnId?: string }
type Write = { text: string; bytes: number; id?: number; serverId?: RequestId }
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const validId = (id: unknown): id is RequestId =>
  (typeof id === 'string' && id.length <= 256) ||
  (typeof id === 'number' && Number.isSafeInteger(id))

/** One process, one initialization, no restart or automatic retries. No raw wire logging. */
export class CodexAppServerClient {
  private state: 'new' | 'starting' | 'ready' | 'draining' | 'closed' = 'new'
  private closedError?: CodexTransportError
  private drainTimer?: ReturnType<typeof setTimeout>
  private child?: ChildProcessWithoutNullStreams
  private nextId = 0
  private pending = new Map<number, Pending>()
  private incoming = new Map<RequestId, Incoming>()
  private seenIncoming = new Set<RequestId>()
  private queue: Write[] = []
  private queuedBytes = 0
  private blocked = false
  private buffer = Buffer.alloc(0)
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private stopVersion?: () => void
  /** Set while this client waits on another's first run; `fail()` trips it so a
   *  disposal does not sit out the holder's whole startup. */
  private stopWaiting?: () => void
  /** Set only while this client HOLDS the first-run gate for its home. */
  private firstRunRelease?: () => void
  /** Mutated in place by the `exit` handler; read by every error it fathered. */
  private readonly exit: CodexChildExit = { exited: false, code: null, signal: null }
  /** `state` is already `closed` by the time the death is reported. */
  private reachedReady = false
  private reported = false
  private stderrFd?: number
  private stderrPath?: string
  /** The capture file is closed, or was never openable — drop further chunks. */
  private stderrDone = false
  /**
   * Capture was armed for this child. While it is, teardown must not destroy
   * the stderr pipe: a destroyed readable discards what the dying child already
   * wrote and the parent has not read yet, which is exactly the crash line the
   * flag exists to keep. The pipe closes on its own once the child is gone.
   */
  private capturing = false

  constructor(private readonly options: CodexClientOptions) {}

  /** The call site's name for this client, or `unlabelled`. Safe to log. */
  private get label(): string {
    return callerLabel(this.options.label)
  }

  /**
   * Every error this client mints, stamped with its caller label. Only that
   * field is added: `message` and the payload-free arguments are unchanged, so
   * nothing a caller reads today moves.
   */
  private error(
    code: string,
    ambiguousDelivery = false,
    nativeMessage?: string,
    nativeCode?: string,
    exit?: CodexChildExit
  ): CodexTransportError {
    return new CodexTransportError(
      code,
      ambiguousDelivery,
      nativeMessage,
      nativeCode,
      exit,
      this.label
    )
  }

  async start(params: InitializeParams): Promise<InitializeResponse> {
    if (this.state !== 'new') throw this.error('one-shot-client')
    this.state = 'starting'
    try {
      const binary = locateCodexBinary()
      if (!binary) throw this.error('binary-unavailable')
      await this.checkVersion(binary)
      if (this.closedError) throw this.closedError
      await this.awaitFirstRun()
      const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        detached: process.platform !== 'win32',
        stdio: 'pipe',
        windowsHide: true
      })
      this.child = child
      // One line per app-server this process starts, off unless asked for
      // (`CLAUDE_UI_LOG=CodexAppServerClient`). It is what makes a later death
      // line attributable to a caller and a moment, and it carries nothing a
      // warn line would not: a label, a pid and the working directory.
      logger.debug(
        'CodexAppServerClient',
        `app-server spawned: ${this.label} pid=${child.pid ?? 'unknown'} cwd=${this.options.cwd}`
      )
      // Discarded unless the capture flag is set: a `data` listener puts the
      // stream in flowing mode, so it replaces `resume()` rather than joining it.
      this.capturing = process.env[STDERR_CAPTURE_ENV] === '1'
      if (this.capturing) {
        child.stderr.on('data', (chunk: Buffer) => this.captureStderr(chunk))
        // The file follows the STREAM, not the process: `exit` lands before the
        // stdio pipes drain, and a crash message is exactly the chunk in that
        // window. `close` covers a destroyed pipe as well as a drained one.
        child.stderr.on('end', () => this.closeStderrFile())
        child.stderr.on('close', () => this.closeStderrFile())
      } else {
        child.stderr.resume()
      }
      child.stderr.on('error', () => this.fail('stderr-error'))
      child.stdin.on('error', () => this.fail('write-error'))
      child.stdout.on('error', () => this.fail('read-error'))
      child.stdin.on('drain', () => {
        this.blocked = false
        this.flush()
      })
      child.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
      child.stdout.on('end', () => {
        if (this.buffer.length) this.frame(this.buffer)
        this.buffer = Buffer.alloc(0)
        this.fail('stdout-closed')
      })
      child.stdout.on('close', () => this.fail('stdout-closed'))
      child.on('error', () => this.fail('spawn-failed'))
      child.on('exit', (code, signal) => {
        this.exit.exited = true
        this.exit.code = code
        this.exit.signal = signal
        if (this.closedError) return
        // Node's exit precedes stdio closure. Only trailing responses/notifications
        // may be consumed now; inherited pipes must not retain the client forever.
        this.closedError = this.error('process-exited')
        this.state = 'draining'
        this.drainTimer = setTimeout(() => this.fail('process-exited'), 1000)
        for (const pending of this.pending.values()) clearTimeout(pending.timer)
        for (const id of this.incoming.keys()) this.abortIncoming(id)
        this.queue = []
        this.queuedBytes = 0
      })
      child.on('close', () => this.fail('process-closed'))
      const result = await this.sendRequest<InitializeResponse>('initialize', params)
      // The state databases exist now: whatever this client does with the
      // answer, the next start on this home cannot lose the race.
      this.releaseFirstRun()
      if (
        !record(result) ||
        !['userAgent', 'codexHome', 'platformFamily', 'platformOs'].every(
          (k) => typeof result[k] === 'string'
        )
      ) {
        throw this.error('invalid-initialize')
      }
      if (this.closedError) throw this.closedError
      this.enqueue({ method: 'initialized' })
      this.state = 'ready'
      this.reachedReady = true
      return result
    } catch (error) {
      this.fail(error instanceof CodexTransportError ? error.code : 'start-failed')
      throw error instanceof CodexTransportError ? error : this.error('start-failed')
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.state !== 'ready' || method === 'initialize' || method === 'initialized')
      return Promise.reject(this.error('not-ready'))
    return this.sendRequest<T>(method, params)
  }

  /** Session adapter must invoke on owning turn termination, including missing native resolution. */
  abortServerRequests(threadId: string, turnId: string): void {
    for (const [id, request] of this.incoming) {
      if (request.threadId === threadId && request.turnId === turnId) this.abortIncoming(id)
    }
  }

  dispose(): void {
    this.fail('disposed')
  }
  private isClosed(): boolean {
    return this.state === 'closed'
  }

  private checkVersion(binary: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, ['--version'], {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        detached: process.platform !== 'win32',
        stdio: 'pipe',
        windowsHide: true
      })
      let output = ''
      let settled = false
      const finish = (valid: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.stopVersion = undefined
        this.terminate(child)
        if (valid) resolve()
        // `fail()` stamps closedError before it trips `stopVersion`, so a
        // teardown mid-probe already carries the real reason (`disposed`,
        // `spawn-failed`, …). Minting `version-check-failed` here would
        // overwrite it and tell `start()`'s caller the wrong thing.
        else reject(this.closedError ?? this.error('version-check-failed'))
      }
      const timer = setTimeout(() => finish(false), this.options.requestTimeoutMs ?? 15000)
      this.stopVersion = () => finish(false)
      child.stderr.resume()
      child.stderr.on('error', () => finish(false))
      child.stdin.on('error', () => finish(false))
      child.stdout.on('error', () => finish(false))
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 4096) finish(false)
      })
      child.on('error', () => finish(false))
      child.on('close', (code) =>
        finish(code === 0 && output.trim() === `codex-cli ${provenance.version}`)
      )
    })
  }

  private sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (this.pending.size >= (this.options.maxPendingRequests ?? 128))
      return Promise.reject(this.error('request-limit'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const request = this.pending.get(id)
        if (!request) return
        this.pending.delete(id)
        this.removeQueued(id)
        reject(this.error('request-timeout', request.sent))
      }, this.options.requestTimeoutMs ?? 30000)
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        sent: false
      })
      try {
        this.enqueue({ id, method, params }, id)
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(this.error('queue-limit-or-serialization'))
      }
    })
  }

  private enqueue(message: JSONRPCMessage, id?: number, serverId?: RequestId): void {
    if (this.closedError) throw this.closedError
    const text = JSON.stringify(message) + '\n'
    const bytes = Buffer.byteLength(text)
    if (
      bytes > (this.options.maxFrameBytes ?? 4 * 1024 * 1024) ||
      this.queuedBytes + bytes > (this.options.maxQueuedBytes ?? 8 * 1024 * 1024) ||
      this.queue.length >= 256
    ) {
      throw this.error('queue-limit')
    }
    this.queue.push({ text, bytes, id, serverId })
    this.queuedBytes += bytes
    this.flush()
    if (this.closedError) throw this.closedError
  }

  private removeQueued(id: number): void {
    this.queue = this.queue.filter((entry) => {
      if (entry.id !== id) return true
      this.queuedBytes -= entry.bytes
      return false
    })
  }

  private flush(): void {
    while (!this.blocked && !this.closedError && this.child && this.queue.length) {
      const entry = this.queue.shift()!
      this.queuedBytes -= entry.bytes
      if (entry.serverId !== undefined) {
        if (!this.incoming.delete(entry.serverId)) continue
      }
      if (entry.id !== undefined) {
        const pending = this.pending.get(entry.id)
        if (!pending) continue
        pending.sent = true
      }
      try {
        this.blocked = !this.child.stdin.write(entry.text)
      } catch {
        this.fail('write-error')
      }
    }
  }

  private consume(chunk: Buffer): void {
    if (this.isClosed()) return
    const max = this.options.maxFrameBytes ?? 4 * 1024 * 1024
    let start = 0
    while (start < chunk.length && !this.isClosed()) {
      const newline = chunk.indexOf(10, start)
      const end = newline < 0 ? chunk.length : newline
      if (this.buffer.length + end - start > max) {
        this.fail('frame-limit')
        return
      }
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(start, end)])
      if (newline < 0) return
      const frame = this.buffer
      this.buffer = Buffer.alloc(0)
      this.frame(frame)
      start = newline + 1
    }
  }

  private frame(bytes: Buffer): void {
    if (this.isClosed()) return
    try {
      const message: unknown = JSON.parse(this.decoder.decode(bytes))
      if (!record(message)) throw new Error()
      const hasId = Object.hasOwn(message, 'id')
      if (hasId && !validId(message.id)) throw new Error()
      if ('method' in message) {
        if (typeof message.method !== 'string' || 'result' in message || 'error' in message)
          throw new Error()
        if (hasId) this.serverRequest(message.id as RequestId, message.method, message.params)
        else {
          if (
            message.method === 'serverRequest/resolved' &&
            record(message.params) &&
            validId(message.params.requestId)
          )
            this.abortIncoming(message.params.requestId)
          this.options.onNotification?.(message.method, message.params)
        }
      } else {
        if (!hasId || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))
          throw new Error()
        if (
          'error' in message &&
          (!record(message.error) ||
            !Number.isSafeInteger(message.error.code) ||
            typeof message.error.message !== 'string')
        )
          throw new Error()
        const request = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
        if (!request || !request.sent) return
        this.pending.delete(message.id as number)
        clearTimeout(request.timer)
        if ('error' in message)
          request.reject(
            this.error(
              `rpc-error-${(message.error as { code: number }).code}`,
              false,
              (message.error as { message: string }).message,
              nativeErrorCode(message.error as Record<string, unknown>)
            )
          )
        else request.resolve(message.result)
      }
    } catch {
      this.fail('invalid-frame-or-handler')
    }
  }

  private serverRequest(id: RequestId, method: string, params: unknown): void {
    if (this.state === 'draining') return
    // IDs cannot be reused within this one-shot connection, even after resolution.
    if (this.seenIncoming.has(id)) throw new Error()
    if (
      this.seenIncoming.size >= 100000 ||
      this.incoming.size >= (this.options.maxPendingRequests ?? 128)
    )
      throw new Error()
    this.seenIncoming.add(id)
    if (!this.options.serverMethods?.includes(method) || !this.options.onServerRequest) {
      this.enqueue({ id, error: { code: -32601, message: 'Method not found' } })
      return
    }
    const request: Incoming = {
      controller: new AbortController(),
      threadId: record(params) && typeof params.threadId === 'string' ? params.threadId : undefined,
      turnId: record(params) && typeof params.turnId === 'string' ? params.turnId : undefined
    }
    this.incoming.set(id, request)
    Promise.resolve()
      .then(() => {
        if (request.controller.signal.aborted) return undefined
        return this.options.onServerRequest!(method, params, {
          id,
          signal: request.controller.signal
        })
      })
      .then(
        (result) => this.reply(id, request, { id, result: result ?? null }),
        () => this.reply(id, request, { id, error: { code: -32603, message: 'Handler failed' } })
      )
  }

  private reply(id: RequestId, request: Incoming, message: JSONRPCMessage): void {
    if (this.isClosed() || this.incoming.get(id) !== request) return
    try {
      this.enqueue(message, undefined, id)
    } catch {
      this.fail('reply-failed')
    }
  }

  private abortIncoming(id: RequestId): void {
    const request = this.incoming.get(id)
    this.incoming.delete(id)
    this.queue = this.queue.filter((entry) => {
      if (entry.serverId !== id) return true
      this.queuedBytes -= entry.bytes
      return false
    })
    request?.controller.abort()
  }

  private fail(code: string): void {
    if (this.isClosed()) return
    const draining = this.state === 'draining'
    this.closedError ??= this.error(code, false, undefined, undefined, this.exit)
    code = this.closedError.code
    this.state = 'closed'
    clearTimeout(this.drainTimer)
    this.stopVersion?.()
    this.stopWaiting?.()
    this.releaseFirstRun()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(this.error(code, pending.sent, undefined, undefined, this.exit))
    }
    this.pending.clear()
    for (const id of this.incoming.keys()) this.abortIncoming(id)
    this.seenIncoming.clear()
    this.queue = []
    this.queuedBytes = 0
    this.buffer = Buffer.alloc(0)
    if (draining && this.child) {
      // The root is already gone, including on Windows; inherited handles must
      // close locally even if a descendant cannot be found by tree cleanup.
      this.child.stdin.destroy()
      this.child.stdout.destroy()
      if (!this.capturing) this.child.stderr.destroy()
    }
    if (this.child) this.terminate(this.child)
    if (DEATH_CODES.has(code)) this.reportDeath(code)
    try {
      this.options.onDisconnect?.(this.closedError)
    } catch {
      /* observer cannot break teardown */
    }
  }

  /**
   * Serialise the first app-server per Codex home — see {@link firstRunGate}.
   *
   * Either this client becomes the holder (nobody holds the gate and the home
   * has no state database) and releases it once `initialize` has answered or
   * `fail()` runs, or it waits out the holder and re-checks: a holder that
   * lived created the databases, so the check passes; one that died left the
   * home uninitialised, so the first waiter to re-check becomes the next holder.
   */
  private async awaitFirstRun(): Promise<void> {
    const home = codexHomeForEnv(this.options.env)
    const key = codexHomeKey(home)
    // A loop, not one wait: a holder that died left the home uninitialised, and
    // its waiters would otherwise all spawn at once and recreate the race. After
    // each wait a waiter re-checks; whoever runs first becomes the next holder
    // and the rest wait on it. Bounded by the number of waiters.
    for (;;) {
      const held = firstRunGate.get(key)
      if (!held) break
      // `held` only ever resolves. `stopWaiting` is the `stopVersion` pattern:
      // a dispose while waiting must not sit here for the holder's timeout.
      await Promise.race([held, new Promise<void>((resolve) => (this.stopWaiting = resolve))])
      this.stopWaiting = undefined
      if (this.closedError) throw this.closedError
    }
    if (hasCodexStateDb(home)) return
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    firstRunGate.set(key, gate)
    this.firstRunRelease = (): void => {
      if (firstRunGate.get(key) === gate) firstRunGate.delete(key)
      release()
    }
  }

  /**
   * Hand the first-run gate on, if this client holds it. Idempotent, and called
   * from both ends of `start()`: the ready path releases it explicitly and every
   * other exit — a rejected initialize, a thrown error, a dead child, `dispose()`
   * — goes through `fail()`, which releases it too.
   */
  private releaseFirstRun(): void {
    const release = this.firstRunRelease
    this.firstRunRelease = undefined
    release?.()
  }

  /**
   * One warn line per client, once, saying why the app-server went away. Waits
   * for the child's `exit` (bounded) because the code arrives after the stdout
   * EOF that closed the client. Carries no stderr, no stdout and no RPC
   * payload — at most the PATH of the opt-in capture file.
   */
  private reportDeath(failure: string): void {
    if (this.reported) return
    this.reported = true
    const child = this.child
    if (!child || this.exit.exited) {
      this.logDeath(failure)
      return
    }
    let done = false
    const emit = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.removeListener('exit', emit)
      this.logDeath(failure)
    }
    const timer = setTimeout(emit, EXIT_REPORT_GRACE_MS)
    timer.unref()
    child.once('exit', emit)
  }

  private logDeath(failure: string): void {
    const exit = this.exit.exited
      ? `exit=${this.exit.code ?? 'null'} signal=${this.exit.signal ?? 'none'}`
      : 'exit=still running'
    logger.warn(
      'CodexAppServerClient',
      `app-server closed: ${failure} label=${this.label} pid=${this.child?.pid ?? 'unknown'} ${exit} ` +
        `ready=${this.reachedReady} cwd=${this.options.cwd}` +
        (this.stderrPath ? ` stderr=${this.stderrPath}` : '')
    )
  }

  /**
   * Append one stderr chunk to the capture file, opening it on the first one.
   * Synchronous on purpose: the flag exists to explain a child that dies, and a
   * buffered stream loses exactly the tail that says why.
   */
  private captureStderr(chunk: Buffer): void {
    if (this.stderrDone) return
    try {
      if (this.stderrFd === undefined) {
        const dir = getLogDir()
        mkdirSync(dir, { recursive: true })
        const path = join(dir, `codex-stderr-${this.child?.pid ?? 'unknown'}.log`)
        this.stderrFd = openSync(path, 'a')
        this.stderrPath = path
      }
      writeSync(this.stderrFd, chunk)
    } catch {
      // A debugging aid must never take the transport down with it.
      this.closeStderrFile()
    }
  }

  private closeStderrFile(): void {
    this.stderrDone = true
    const fd = this.stderrFd
    if (fd === undefined) return
    this.stderrFd = undefined
    try {
      closeSync(fd)
    } catch {
      /* already gone */
    }
  }

  private terminate(child: ChildProcessWithoutNullStreams): void {
    if (process.platform === 'win32') {
      killProcessTree(child)
      return
    }
    child.stdin.destroy()
    child.stdout.destroy()
    if (!this.capturing) child.stderr.destroy()
    const pid = child.pid
    if (pid === undefined) return
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig)
      } catch {
        /* group already gone */
      }
    }
    signal('SIGTERM')
    // Do not cancel escalation on parent exit: its group may still own children.
    setTimeout(() => signal('SIGKILL'), this.options.killGraceMs ?? 1000).unref()
  }
}
