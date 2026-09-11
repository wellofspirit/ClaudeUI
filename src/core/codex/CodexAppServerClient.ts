import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { killProcessTree } from '../services/process-tree'
import { locateCodexBinary } from './codex-locate'
import type { InitializeParams } from './protocol/InitializeParams'
import type { InitializeResponse } from './protocol/InitializeResponse'
import type { RequestId } from './protocol/RequestId'
import type { JSONRPCMessage } from './protocol/envelopes'
import provenance from './protocol/provenance.json'

export class CodexTransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly ambiguousDelivery = false
  ) {
    super(`Codex transport: ${code}`)
  }
}
export interface CodexClientOptions {
  cwd: string
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

  constructor(private readonly options: CodexClientOptions) {}

  async start(params: InitializeParams): Promise<InitializeResponse> {
    if (this.state !== 'new') throw new CodexTransportError('one-shot-client')
    this.state = 'starting'
    try {
      const binary = locateCodexBinary()
      if (!binary) throw new CodexTransportError('binary-unavailable')
      await this.checkVersion(binary)
      if (this.closedError) throw this.closedError
      const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        detached: process.platform !== 'win32',
        stdio: 'pipe',
        windowsHide: true
      })
      this.child = child
      child.stderr.resume()
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
      child.on('exit', () => {
        if (this.closedError) return
        // Node's exit precedes stdio closure. Only trailing responses/notifications
        // may be consumed now; inherited pipes must not retain the client forever.
        this.closedError = new CodexTransportError('process-exited')
        this.state = 'draining'
        this.drainTimer = setTimeout(() => this.fail('process-exited'), 1000)
        for (const pending of this.pending.values()) clearTimeout(pending.timer)
        for (const id of this.incoming.keys()) this.abortIncoming(id)
        this.queue = []
        this.queuedBytes = 0
      })
      child.on('close', () => this.fail('process-closed'))
      const result = await this.sendRequest<InitializeResponse>('initialize', params)
      if (
        !record(result) ||
        !['userAgent', 'codexHome', 'platformFamily', 'platformOs'].every(
          (k) => typeof result[k] === 'string'
        )
      ) {
        throw new CodexTransportError('invalid-initialize')
      }
      if (this.closedError) throw this.closedError
      this.enqueue({ method: 'initialized' })
      this.state = 'ready'
      return result
    } catch (error) {
      this.fail(error instanceof CodexTransportError ? error.code : 'start-failed')
      throw error instanceof CodexTransportError ? error : new CodexTransportError('start-failed')
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.state !== 'ready' || method === 'initialize' || method === 'initialized')
      return Promise.reject(new CodexTransportError('not-ready'))
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
        else reject(new CodexTransportError('version-check-failed'))
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
      return Promise.reject(new CodexTransportError('request-limit'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const request = this.pending.get(id)
        if (!request) return
        this.pending.delete(id)
        this.removeQueued(id)
        reject(new CodexTransportError('request-timeout', request.sent))
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
        reject(new CodexTransportError('queue-limit-or-serialization'))
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
      throw new CodexTransportError('queue-limit')
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
            new CodexTransportError(`rpc-error-${(message.error as { code: number }).code}`)
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
    this.closedError ??= new CodexTransportError(code)
    code = this.closedError.code
    this.state = 'closed'
    clearTimeout(this.drainTimer)
    this.stopVersion?.()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new CodexTransportError(code, pending.sent))
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
      this.child.stderr.destroy()
    }
    if (this.child) this.terminate(this.child)
    try {
      this.options.onDisconnect?.(this.closedError)
    } catch {
      /* observer cannot break teardown */
    }
  }

  private terminate(child: ChildProcessWithoutNullStreams): void {
    if (process.platform === 'win32') {
      killProcessTree(child)
      return
    }
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
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
