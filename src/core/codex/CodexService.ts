import { CodexClient } from './CodexClient'
import { CodexTransportError, type CodexClientOptions } from './CodexAppServerClient'
import {
  codexHostRegistry,
  type CodexHostAcquireOptions,
  type CodexHostHandle,
  type CodexHostIdentity
} from './CodexHost'
import type { Account } from './protocol/v2/Account'
import type { Config } from './protocol/v2/Config'
import type { ConfigBatchWriteParams } from './protocol/v2/ConfigBatchWriteParams'
import type { ConfigReadResponse } from './protocol/v2/ConfigReadResponse'
import type { ConfigWriteResponse } from './protocol/v2/ConfigWriteResponse'
import type { LoginAccountParams } from './protocol/v2/LoginAccountParams'
import type { LoginAccountResponse } from './protocol/v2/LoginAccountResponse'
import type { Model } from './protocol/v2/Model'
import type { GetAccountRateLimitsResponse } from './protocol/v2/GetAccountRateLimitsResponse'
import type { ThreadReadParams } from './protocol/v2/ThreadReadParams'
import type { ThreadListParams } from './protocol/v2/ThreadListParams'
import { assertCodexProvider, selectCodexModel } from './model-selection'
import type { Turn } from './protocol/v2/Turn'
import type { Thread } from './protocol/v2/Thread'

export type CodexAccountStatus =
  | {
      available: true
      authenticated: boolean
      authKind: Account['type'] | null
      requiresLogin: boolean
    }
  | { available: false; failure: 'unavailable' | 'native-error' }
export type CodexNativeLoginParams = Extract<
  LoginAccountParams,
  { type: 'apiKey' | 'chatgpt' | 'chatgptDeviceCode' }
>
export type CodexNativeLoginStart = Extract<
  LoginAccountResponse,
  { type: CodexNativeLoginParams['type'] }
>
export type CodexLoginOutcome = { status: 'completed' | 'failed' | 'cancelled' | 'timed-out' }
export type CodexEffectiveConfig = Pick<
  Config,
  | 'model'
  | 'model_provider'
  | 'model_reasoning_effort'
  | 'approval_policy'
  | 'approvals_reviewer'
  | 'sandbox_mode'
>

const initialize = {
  clientInfo: { name: 'claudeui_service', title: 'Codex service', version: '1' },
  capabilities: { experimentalApi: true, requestAttestation: false }
}

/** The slice of {@link CodexHostRegistry} a service needs. A test fakes it. */
export interface CodexHostSource {
  acquire(options?: CodexHostAcquireOptions): Promise<CodexHostHandle>
}

/**
 * What a service is built with. `identity` is the ChatGPT account its reads run
 * as (ADR-068 §1, ADR-069 §1) and is deliberately absent by default — a service
 * built without one runs on the UNINJECTED host for the home and never reads the
 * vault, which keeps the real-binary integration suite away from a developer's
 * credentials and keeps the config page off the vault's refresh path. The
 * production identity-bearing paths (`CodexAuthProvider`, model discovery, rate
 * limits) pass `{ accountId: null }` — the active account.
 */
export type CodexServiceOptions = Pick<
  CodexClientOptions,
  'cwd' | 'env' | 'requestTimeoutMs' | 'killGraceMs' | 'label'
> & { identity?: CodexHostIdentity; registry?: CodexHostSource }

/**
 * A facade over Codex HOSTS (ADR-069 §3). Never starts/resumes/forks a thread or
 * owns a root.
 *
 * Every read borrows the one app-server for its home and account for the length
 * of the read and gives it back; nothing here owns a process any more. The one
 * exception is {@link CodexService.startLogin}, which keeps a dedicated client
 * by design: while external auth is active the native login paths are refused
 * outright, so a login must run on a process nothing has injected.
 */
export class CodexService {
  private disposed = false
  private clients = new Set<CodexClient>()
  private handles = new Set<CodexHostHandle>()
  private statusRead?: Promise<CodexAccountStatus>
  private catalogRead?: Promise<Model[]>
  private login?: { cancel: () => void }

  private readonly options: Pick<
    CodexClientOptions,
    'cwd' | 'env' | 'requestTimeoutMs' | 'killGraceMs' | 'label'
  >
  private readonly identity: CodexHostIdentity | undefined
  private readonly registry: CodexHostSource

  constructor(options: CodexServiceOptions) {
    const { identity, registry, ...transport } = options
    this.options = transport
    this.identity = identity
    this.registry = registry ?? codexHostRegistry
  }

  private client(
    callbacks: Pick<CodexClientOptions, 'onNotification' | 'onDisconnect'> = {}
  ): CodexClient {
    if (this.disposed) throw new CodexTransportError('disposed')
    const client = new CodexClient({ ...this.options, ...callbacks })
    this.clients.add(client)
    return client
  }

  private release(client: CodexClient): void {
    if (this.clients.delete(client)) client.dispose()
  }

  /** One lease on this service's host. The caller must `release()` it. */
  private async acquire(identity = this.identity): Promise<CodexHostHandle> {
    const handle = await this.registry.acquire({
      ...this.options,
      ...(identity ? { identity } : {})
    })
    if (this.disposed) {
      handle.release()
      throw new CodexTransportError('disposed')
    }
    this.handles.add(handle)
    return handle
  }

  private forget(handle: CodexHostHandle): void {
    this.handles.delete(handle)
    handle.release()
  }

  private async read<T>(operation: (host: CodexHostHandle) => Promise<T>): Promise<T> {
    if (this.disposed) throw new CodexTransportError('disposed')
    let handle: CodexHostHandle | undefined
    try {
      handle = await this.acquire()
      return await operation(handle)
    } catch (error) {
      // Never propagate native payloads, config values or caller-supplied error
      // messages — which is why a non-transport throw is collapsed to one opaque
      // code. A `CodexTransportError` is NOT such a throw: every code
      // `CodexAppServerClient` raises is payload-free by construction (fixed
      // literals, plus `rpc-error-<n>` off a code the frame reader has already
      // proven a safe integer), so rethrowing it unchanged leaks nothing and
      // keeps the one distinction callers need — "the native binary refused
      // this" versus "the read broke".
      if (error instanceof CodexTransportError) throw error
      throw new CodexTransportError('service-read-failed')
    } finally {
      if (handle) this.forget(handle)
    }
  }

  accountStatus(): Promise<CodexAccountStatus> {
    if (this.statusRead) return this.statusRead
    this.statusRead = this.read(async (host) => {
      const result = await host.request('account/read', { refreshToken: false })
      const authKind = result.account?.type ?? null
      if (
        typeof result.requiresOpenaiAuth !== 'boolean' ||
        (result.account !== null && authKind === null) ||
        ![null, 'apiKey', 'chatgpt', 'amazonBedrock'].includes(authKind)
      )
        throw new Error('invalid account state')
      return {
        available: true as const,
        authenticated: authKind !== null,
        authKind,
        requiresLogin: result.requiresOpenaiAuth && authKind === null
      }
    })
      .catch((error): CodexAccountStatus => ({
        available: false,
        failure:
          error instanceof CodexTransportError && error.code === 'binary-unavailable'
            ? 'unavailable'
            : 'native-error'
      }))
      .finally(() => {
        this.statusRead = undefined
      })
    return this.statusRead
  }

  models(): Promise<Model[]> {
    if (this.catalogRead) return this.catalogRead
    this.catalogRead = this.read(async (host) => {
      const models: Model[] = []
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < 100; page++) {
        const result = await host.request('model/list', {
          cursor,
          limit: 100,
          includeHidden: false
        })
        models.push(...result.data)
        if (!result.nextCursor) return models
        if (cursors.has(result.nextCursor)) throw new Error('repeated catalog cursor')
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
      }
      throw new Error('catalog page limit')
    }).finally(() => {
      this.catalogRead = undefined
    })
    return this.catalogRead
  }

  /** Empty discovery cannot invalidate an explicit model. Native turn/start decides availability. */
  async modelOptions(
    explicitModel?: string
  ): Promise<{ model: string | undefined; catalog: Model[] }> {
    const [catalog, config] = await Promise.all([this.models(), this.effectiveConfig()])
    assertCodexProvider(config.model_provider)
    return { model: selectCodexModel(catalog, config.model, explicitModel), catalog }
  }

  /**
   * `config/read` WITH layers — the raw read the Codex settings page is built
   * on (ADR-068 §6, Slice 5a).
   *
   * Unlike {@link effectiveConfig} this returns the response whole, layers
   * included, because the page needs three things the picked projection cannot
   * carry: the base USER layer's own TOML (what "changed from default" means on
   * that page — the key is present in the user's file), that layer's `version`
   * (the optimistic-concurrency token every write must echo), and its `file`
   * (the write target and the Raw config row's key line). Shaping it into the
   * product snapshot is `codex-config.ts`'s job, not the transport's.
   */
  readConfigLayers(cwd?: string): Promise<ConfigReadResponse> {
    return this.read((host) =>
      host.request('config/read', { includeLayers: true, cwd: cwd ?? this.options.cwd })
    )
  }

  /**
   * One `config/batchWrite`, then the `config/read` that shows its result — on
   * the SAME client, inside one `read()` operation.
   *
   * They are one method because `read()` disposes its client the moment the last
   * user drops: a write followed by a separate read is two app-server children,
   * so every toggle on the settings page would pay two process starts (~2.4 s
   * each on the pinned binary) before the row could show what it had written.
   * Here the child is started once and answers both.
   *
   * The app-server owns the TOML writer, so comments and untouched siblings
   * survive and ClaudeUI never has to parse or re-emit the file.
   *
   * Errors are NOT collapsed — `read()` rethrows a `CodexTransportError`
   * unchanged, and its `nativeCode` / `nativeMessage` are exactly what the
   * caller needs to tell a version conflict (retry) from a refusal (show). A
   * refused write never reaches the read: the whole operation rejects, which is
   * right, because there is nothing new to show.
   */
  batchWriteConfigAndRead(
    params: ConfigBatchWriteParams,
    cwd?: string
  ): Promise<{ write: ConfigWriteResponse; read: ConfigReadResponse }> {
    return this.read(async (host) => ({
      write: await host.request('config/batchWrite', params),
      read: await host.request('config/read', {
        includeLayers: true,
        cwd: cwd ?? this.options.cwd
      })
    }))
  }

  effectiveConfig(): Promise<CodexEffectiveConfig> {
    return this.read(async (host) => {
      const { config } = await host.request('config/read', {
        includeLayers: false,
        cwd: this.options.cwd
      })
      // Config has an arbitrary-value index signature. Never expose the whole object to clients.
      return {
        model: config.model,
        model_provider: config.model_provider,
        model_reasoning_effort: config.model_reasoning_effort,
        approval_policy: config.approval_policy,
        approvals_reviewer: config.approvals_reviewer,
        sandbox_mode: config.sandbox_mode
      }
    })
  }

  /**
   * Per-account ChatGPT rate limits (ADR-068 §2), one HOST per account
   * (ADR-069 §1).
   *
   * Before the host model this re-injected each account in turn on ONE process
   * (`account/login/start {chatgptAuthTokens}` is legal while external auth is
   * active), because `read()` disposed its client the moment the last user
   * dropped and N calls would have been N children. That is exactly what a host
   * per account removes: each account's process is already injected with it and
   * stays warm, so the sweep is one `account/rateLimits/read` per host and
   * NOTHING re-injects across accounts. The list-taking signature survives
   * because the sweep is still one unit of work to the caller.
   *
   * `null` in the list means the ACTIVE account. An account the vault cannot
   * produce a token for, or one whose read the binary refuses, is simply absent
   * from the result: a missing subscription is reported as "unavailable", never
   * as another account's numbers — which is why the map is keyed by the id the
   * HOST was actually injected with, never by the id that was asked for.
   *
   * The WHOLE response is handed back, not a picked snapshot: a credits-based
   * plan answers with empty windows at the top level and the real figures in
   * `rateLimitsByLimitId`, and which bucket to believe is a product decision
   * (`chatgpt-rate-limits.ts`), not a transport one.
   */
  async rateLimits(
    accountIds: ReadonlyArray<string | null>
  ): Promise<Map<string, GetAccountRateLimitsResponse>> {
    const out = new Map<string, GetAccountRateLimitsResponse>()
    if (this.disposed || !this.identity || accountIds.length === 0) return out
    for (const accountId of accountIds) {
      const handle = await this.acquire({ accountId }).catch(() => null)
      if (!handle) continue
      try {
        const injected = handle.injectedAccountId
        // No token, no numbers: a host the vault could not inject is running as
        // somebody else, and its figures are not this account's.
        if (!injected) continue
        const result = await handle.request('account/rateLimits/read', {}).catch(() => null)
        if (result) out.set(injected, result)
      } finally {
        this.forget(handle)
      }
    }
    return out
  }

  readThread(params: ThreadReadParams) {
    return this.read((host) => host.request('thread/read', params))
  }

  listThreads(params: ThreadListParams) {
    return this.read((host) => host.request('thread/list', params))
  }

  /**
   * Native permanent deletion. Callers must stop the owning root process first;
   * this service never resumes or owns the thread it deletes.
   */
  deleteThread(threadId: string): Promise<void> {
    return this.read(async (host) => {
      await host.request('thread/delete', { threadId })
    })
  }

  /** Native archive: hidden from the default listing, native data retained. */
  archiveThread(threadId: string): Promise<void> {
    return this.read(async (host) => {
      await host.request('thread/archive', { threadId })
    })
  }

  listAllThreads(): Promise<Thread[]> {
    return this.read(async (host) => {
      const threads: Thread[] = []
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < 1000; page++) {
        const result = await host.request('thread/list', { cursor, limit: 100, archived: false })
        threads.push(...result.data)
        if (!result.nextCursor) return threads
        if (cursors.has(result.nextCursor)) throw new Error('Repeated native session cursor')
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
      }
      throw new Error('Native session page limit')
    })
  }

  history(threadId: string) {
    return this.read(async (host) => {
      const { thread } = await host.request('thread/read', { threadId, includeTurns: false })
      if (thread.historyMode !== 'paginated')
        return (await host.request('thread/read', { threadId, includeTurns: true })).thread
      const turns: Turn[] = []
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < 1000; page++) {
        const result = await host.request('thread/turns/list', {
          threadId,
          cursor,
          limit: 100,
          sortDirection: 'asc',
          itemsView: 'full'
        })
        if (result.data.some((turn) => turn.itemsView !== 'full'))
          throw new Error('Incomplete native history page')
        turns.push(...result.data)
        if (!result.nextCursor) return { ...thread, turns }
        if (cursors.has(result.nextCursor)) throw new Error('Repeated native history cursor')
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
      }
      throw new Error('Native history page limit')
    })
  }

  /** Explicit host action only. No vault, external tokens, browser opening or implicit logout. */
  startLogin(
    params: CodexNativeLoginParams,
    timeoutMs = 10 * 60_000
  ): {
    started: Promise<CodexNativeLoginStart>
    completed: Promise<CodexLoginOutcome>
    cancel: () => void
  } {
    if (this.login) throw new CodexTransportError('login-in-progress')
    if (!['apiKey', 'chatgpt', 'chatgptDeviceCode'].includes(params.type))
      throw new CodexTransportError('unsupported-login')
    let settled = false
    let loginId: string | null | undefined
    const early: { loginId: string | null; success: boolean }[] = []
    let resolve!: (result: CodexLoginOutcome) => void
    const completed = new Promise<CodexLoginOutcome>((done) => {
      resolve = done
    })
    const finish = (status: CodexLoginOutcome['status']): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      early.length = 0
      this.login = undefined
      resolve({ status })
      this.release(client)
    }
    const client = this.client({
      onDisconnect: () => finish('failed'),
      onNotification: (method, params) => {
        if (
          settled ||
          method !== 'account/login/completed' ||
          !params ||
          typeof params !== 'object'
        )
          return
        const event = params as Record<string, unknown>
        if (
          (event.loginId !== null && typeof event.loginId !== 'string') ||
          typeof event.success !== 'boolean'
        )
          return
        if (loginId === undefined) {
          if (early.length < 16) early.push({ loginId: event.loginId, success: event.success })
        } else if (event.loginId === loginId) finish(event.success ? 'completed' : 'failed')
      }
    })
    const cancel = (status: 'cancelled' | 'timed-out'): void => {
      if (settled) return
      // Cancellation is best effort; disposing the retained process is the bounded fallback.
      if (typeof loginId === 'string') {
        void client.request('account/login/cancel', { loginId }).catch(() => {})
      }
      finish(status)
    }
    const timer = setTimeout(
      () => cancel('timed-out'),
      Math.max(1, Math.min(timeoutMs, 10 * 60_000))
    )
    this.login = { cancel: () => cancel('cancelled') }
    const started = (async (): Promise<CodexNativeLoginStart> => {
      try {
        // NO auth hook, deliberately: while external auth is active the native
        // login paths are refused outright ("External auth is active…",
        // `account_processor.rs`), so a login process must never be injected.
        await client.start(initialize)
        if (settled) throw new Error('cancelled')
        const result = await client.request('account/login/start', params)
        if (settled) throw new Error('cancelled')
        if (
          result.type !== params.type ||
          (result.type !== 'apiKey' &&
            result.type !== 'chatgpt' &&
            result.type !== 'chatgptDeviceCode')
        )
          throw new Error('unexpected login response')
        loginId = result.type === 'apiKey' ? null : result.loginId
        const event = early.find((event) => event.loginId === loginId)
        if (event) finish(event.success ? 'completed' : 'failed')
        early.length = 0
        // Rebuild metadata rather than forwarding unknown extra wire properties.
        if (result.type === 'apiKey') return { type: result.type }
        if (result.type === 'chatgpt')
          return { type: result.type, loginId: result.loginId, authUrl: result.authUrl }
        return {
          type: result.type,
          loginId: result.loginId,
          verificationUrl: result.verificationUrl,
          userCode: result.userCode
        }
      } catch {
        finish('failed')
        throw new CodexTransportError('login-start-failed')
      }
    })()
    // The flow may be cancelled before a host awaits its start response.
    void started.catch(() => {})
    return { started, completed, cancel: () => cancel('cancelled') }
  }

  dispose(): void {
    this.disposed = true
    this.login?.cancel()
    for (const client of this.clients) this.release(client)
    // Leases, not processes: a host outlives every service that borrowed it and
    // is reaped by its own idle rule (or by `codexHostRegistry.dispose()` on
    // quit). Dropping them here is what lets that rule start counting.
    for (const handle of [...this.handles]) this.forget(handle)
  }
}
