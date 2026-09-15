import { CodexClient } from './CodexClient'
import { CodexTransportError, type CodexClientOptions } from './CodexAppServerClient'
import type { CodexAuthHook } from './codex-auth-hook'
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

/**
 * What a service is built with. `auth` is the ChatGPT identity its READ clients
 * run as (ADR-068 §1) and is deliberately absent by default — a service built
 * without one injects nothing and never reads the vault, which keeps the
 * real-binary integration suite away from a developer's credentials. The
 * production read paths (`CodexAuthProvider`, model discovery) supply it.
 */
export type CodexServiceOptions = Pick<
  CodexClientOptions,
  'cwd' | 'env' | 'requestTimeoutMs' | 'killGraceMs' | 'label'
> & { auth?: CodexAuthHook | null }

/** Host-only, bounded read clients. Never starts/resumes/forks a thread or owns a root. */
export class CodexService {
  private disposed = false
  private clients = new Set<CodexClient>()
  private reads?: { client: CodexClient; ready: Promise<unknown>; users: number }
  private statusRead?: Promise<CodexAccountStatus>
  private catalogRead?: Promise<Model[]>
  private login?: { cancel: () => void }

  private readonly options: Pick<
    CodexClientOptions,
    'cwd' | 'env' | 'requestTimeoutMs' | 'killGraceMs' | 'label'
  >
  private readonly auth: CodexAuthHook | null

  constructor(options: CodexServiceOptions) {
    const { auth = null, ...transport } = options
    this.options = transport
    this.auth = auth
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

  private async read<T>(operation: (client: CodexClient) => Promise<T>): Promise<T> {
    if (this.disposed) throw new CodexTransportError('disposed')
    if (!this.reads) {
      const client = this.client()
      this.reads = { client, ready: client.start(initialize, this.auth), users: 0 }
    }
    const reads = this.reads
    reads.users++
    try {
      await reads.ready
      return await operation(reads.client)
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
      if (--reads.users === 0) {
        this.reads = undefined
        this.release(reads.client)
      }
    }
  }

  accountStatus(): Promise<CodexAccountStatus> {
    if (this.statusRead) return this.statusRead
    this.statusRead = this.read(async (client) => {
      const result = await client.request('account/read', { refreshToken: false })
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
    this.catalogRead = this.read(async (client) => {
      const models: Model[] = []
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < 100; page++) {
        const result = await client.request('model/list', {
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
    return this.read((client) =>
      client.request('config/read', { includeLayers: true, cwd: cwd ?? this.options.cwd })
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
    return this.read(async (client) => ({
      write: await client.request('config/batchWrite', params),
      read: await client.request('config/read', {
        includeLayers: true,
        cwd: cwd ?? this.options.cwd
      })
    }))
  }

  effectiveConfig(): Promise<CodexEffectiveConfig> {
    return this.read(async (client) => {
      const { config } = await client.request('config/read', {
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
   * Per-account ChatGPT rate limits (ADR-068 §2), read through ONE app-server.
   *
   * The signature takes the whole LIST rather than one account because the
   * constraint is the process, not the call: `read()` disposes its client the
   * moment the last user drops, so N single-account calls would be N app-server
   * children. Here the re-injection and the read both happen inside one
   * operation — `account/login/start {chatgptAuthTokens}` is legal while
   * external auth is active, so the same process answers for every account in
   * turn, sequentially.
   *
   * `null` in the list means the ACTIVE account. An account the vault cannot
   * produce a token for, or one whose read the binary refuses, is simply absent
   * from the result: a missing subscription is reported as "unavailable", never
   * as another account's numbers.
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
    if (!this.auth || accountIds.length === 0) return out
    const auth = this.auth
    await this.read(async (client) => {
      for (const accountId of accountIds) {
        auth.requestAccount(accountId)
        const token = await client.injectAccount(auth).catch(() => null)
        if (!token) continue
        const result = await client.request('account/rateLimits/read', {}).catch(() => null)
        if (result) out.set(token.vaultAccountId, result)
      }
    })
    return out
  }

  readThread(params: ThreadReadParams) {
    return this.read((client) => client.request('thread/read', params))
  }

  listThreads(params: ThreadListParams) {
    return this.read((client) => client.request('thread/list', params))
  }

  /**
   * Native permanent deletion. Callers must stop the owning root process first;
   * this service never resumes or owns the thread it deletes.
   */
  deleteThread(threadId: string): Promise<void> {
    return this.read(async (client) => {
      await client.request('thread/delete', { threadId })
    })
  }

  /** Native archive: hidden from the default listing, native data retained. */
  archiveThread(threadId: string): Promise<void> {
    return this.read(async (client) => {
      await client.request('thread/archive', { threadId })
    })
  }

  listAllThreads(): Promise<Thread[]> {
    return this.read(async (client) => {
      const threads: Thread[] = []
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < 1000; page++) {
        const result = await client.request('thread/list', { cursor, limit: 100, archived: false })
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
    return this.read(async (client) => {
      const { thread } = await client.request('thread/read', { threadId, includeTurns: false })
      if (thread.historyMode !== 'paginated')
        return (await client.request('thread/read', { threadId, includeTurns: true })).thread
      const turns: Turn[] = []
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < 1000; page++) {
        const result = await client.request('thread/turns/list', {
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
  }
}
