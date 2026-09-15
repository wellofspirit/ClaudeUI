/**
 * One long-lived `codex app-server` per Codex HOME and injected ACCOUNT
 * ([ADR-069](../../../docs/adr/adr-069_codex-host-per-home-and-account.md) §1).
 *
 * ## Why a host at all
 *
 * Until H1 every read started its own app-server: the catalog discovery, the
 * sidebar's 30-second thread listing, the lineage scan, rate limits, the config
 * page, the auth probe, deletes. That cost a version probe, a spawn and an
 * `initialize` (about a second) per read, and — worse — it put several
 * app-servers on one home at once, which is the assumption the binary itself
 * violates: the daemon transport takes a per-home startup lock before it builds
 * its sqlite state runtime, and the boot deaths F7/F8 chased were that
 * assumption breaking (`docs/codex-followups-spec.md`).
 *
 * The one piece of PROCESS-level state is identity: `account/login/start
 * {chatgptAuthTokens}` binds the whole process to one ChatGPT account and a
 * second native login is refused while external auth is active (ADR-068 §1). So
 * the unit of sharing is a process per home AND account, never per home alone.
 *
 * ## What this slice (H1) does and does not do
 *
 * Reads run on hosts. Sessions still own their own `CodexAppServerClient`
 * ({@link CodexHost.retain} is the empty seam H2 will call). Nothing here routes
 * notifications by `threadId`, recycles a host on an account switch, or resumes
 * a thread: those are ADR-069 decisions 2, 4 and 7, and they are H2/H3.
 */
import { homedir } from 'node:os'
import { CodexTransportError, type CodexClientOptions } from './CodexAppServerClient'
import { CodexClient } from './CodexClient'
import { codexAuthHook, type CodexAuthHook } from './codex-auth-hook'
import { codexHomeForEnv, codexHomeKey } from './codex-home'
import { credentialSync } from '../auth/vault/CredentialSync'
import { logger } from '../services/logger'
import type { InitializeParams } from './protocol/InitializeParams'
import type { CodexMethods } from './protocol/methods'

const LOG_SOURCE = 'CodexHost'

/**
 * How long a host with no handle and no registered session stays warm.
 *
 * Five minutes, and — see {@link CodexHost.idleDeadline} — it is a DEADLINE, not
 * a sliding window: the sidebar polls every 30 seconds, and a window would keep
 * every host alive for as long as the app is open, which is the cost this whole
 * design exists to remove.
 */
export const CODEX_HOST_IDLE_MS = 5 * 60_000

/** The label every host's app-server spawns under. Reads name themselves per
 *  acquire instead, at debug — see {@link CodexHost.acquire}. */
export const CODEX_HOST_LABEL = 'host'

/**
 * The key segment of a host that injects NOTHING.
 *
 * Two callers land on it: one that asked for no identity at all (`startLogin`'s
 * dedicated client, and the tests that must never reach the vault), and one that
 * asked for the ACTIVE account on a machine whose vault holds none — which is
 * not a substitution but the literal answer, and the same fallback the auth
 * probe already reports (`CodexAuthProvider.probe`: no vault account, describe
 * Codex's own login). Distinguishable from every vault id by construction, since
 * an account keys as `acct:<id>`.
 */
const NATIVE = 'native'

/** The one server request a host answers: the vault refills an expired token. */
const SERVER_METHODS = ['account/chatgptAuthTokens/refresh'] as const

const initializeParams: InitializeParams = {
  clientInfo: { name: 'claudeui_host', title: 'Codex host', version: '1' },
  capabilities: { experimentalApi: true, requestAttestation: false }
}

/**
 * Which ChatGPT identity a host runs as.
 *
 * `accountId: null` means the ACTIVE vault account, resolved to a concrete id at
 * acquire time so a caller that follows active and one pinned to the same
 * account share one process — and to {@link NATIVE} when the vault holds no
 * active account.
 *
 * An ABSENT identity means "never read the vault at all". Every PRODUCT reader
 * passes `{ accountId: null }`, including config, history and delete: none of
 * them needs an uninjected process, and a delete in particular has to be issued
 * on the host that holds the thread, which is the session's host (probe P5). The
 * absent case is left for `CodexService.startLogin`'s dedicated client — a native
 * login is refused outright while external auth is active — and for the tests and
 * integration suites that must never touch a developer's credentials.
 */
export interface CodexHostIdentity {
  accountId: string | null
}

export interface CodexHostAcquireOptions {
  /** Absent = never read the vault. See {@link CodexHostIdentity}. */
  identity?: CodexHostIdentity
  /**
   * The child's working directory. Only the FIRST acquirer of a host sets it:
   * home-scoped reads (`thread/list`, `thread/read`, `model/list`) do not depend
   * on it, and `config/read` / `config/batchWrite` carry an explicit `cwd`
   * parameter, so nothing a host answers changes with the process's own cwd.
   */
  cwd?: string
  /** Replaces inheritance when supplied; also decides which HOME is keyed. */
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  killGraceMs?: number
  /**
   * Who is acquiring — `discovery`, `history-list`, `auth-probe`. The PROCESS is
   * labelled {@link CODEX_HOST_LABEL}, because it belongs to no single caller;
   * this name is logged once per acquire at debug so a warm-host read is still
   * attributable. Held to the transport's label shape.
   */
  label?: string
}

/**
 * One caller's lease on a host. Every read holds one for the length of the read
 * and drops it in a `finally`; a host with no handles starts dying.
 */
export interface CodexHostHandle {
  request<M extends keyof CodexMethods>(
    method: M,
    params: CodexMethods[M]['params']
  ): Promise<CodexMethods[M]['result']>
  /** The vault account this host's process was injected with, or null. */
  readonly injectedAccountId: string | null
  /** The host itself, so a SESSION can {@link CodexHost.retain} it (H2). */
  readonly host: CodexHost
  /** Idempotent. */
  release(): void
}

/** What a host drives. `CodexClient` satisfies it; a unit test fakes it. */
export interface CodexHostClient {
  start(params: InitializeParams, auth?: CodexAuthHook | null): Promise<unknown>
  request<M extends keyof CodexMethods>(
    method: M,
    params: CodexMethods[M]['params']
  ): Promise<CodexMethods[M]['result']>
  dispose(): void
}

/** Construction seams. Production passes none of them. */
export interface CodexHostDeps {
  createClient?: (options: CodexClientOptions) => CodexHostClient
  createHook?: (accountId: string | null) => CodexAuthHook
  /** The vault's active account id, or null. Token-free. */
  activeAccountId?: () => Promise<string | null>
  idleMs?: number
}

const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

function acquireLabel(label: string | undefined): string {
  return label !== undefined && LABEL_PATTERN.test(label) ? label : 'unlabelled'
}

async function vaultActiveAccountId(): Promise<string | null> {
  try {
    return (await credentialSync.getStatus()).activeId ?? null
  } catch {
    // An unreadable vault answers the same as an empty one: there is no active
    // account to inject, so the host is the uninjected {@link NATIVE} one. That
    // is what `inject()` would have produced anyway — `injectionTokenFor` cannot
    // mint a token the vault will not yield — so nothing is substituted here
    // that was not already the outcome before ADR-069.
    return null
  }
}

/**
 * One app-server, its identity, and everyone currently using it.
 *
 * Constructed by {@link CodexHostRegistry} and never by a caller: sharing is the
 * whole point, and a host built outside the registry would be a second process
 * on a home the registry already holds one for.
 */
export class CodexHost {
  private client?: CodexHostClient
  private ready?: Promise<void>
  private hook: CodexAuthHook | null = null
  private handles = 0
  /** Registered SESSIONS (H2). A host with one never idles out. */
  private retained = 0
  private closedError?: CodexTransportError
  private idleTimer?: ReturnType<typeof setTimeout>
  /**
   * When this host may be closed, fixed the first time it fell to zero users.
   *
   * A DEADLINE rather than a sliding window: the sidebar's directory poll reads
   * every 30 seconds, and a window reset by each read would keep a host alive
   * for the life of the app. A read landing during the wait cancels the timer
   * (nothing is closed under a live request) and re-arms it on release for
   * whatever is LEFT, so reads keep a host warm without keeping it alive. Only a
   * registered session does that, and {@link retain} is what clears the deadline.
   */
  private idleDeadline?: number

  constructor(
    readonly key: string,
    private readonly identity: CodexHostIdentity | undefined,
    private readonly options: Pick<
      CodexClientOptions,
      'cwd' | 'env' | 'requestTimeoutMs' | 'killGraceMs'
    >,
    private readonly deps: Required<Pick<CodexHostDeps, 'createClient' | 'createHook' | 'idleMs'>>,
    /** Rung once, when this host stops being usable, so the registry forgets it. */
    private readonly onClosed: (host: CodexHost) => void
  ) {}

  /** The vault account the process was injected with, or null. */
  get injectedAccountId(): string | null {
    return this.hook?.injectedAccountId ?? null
  }

  /** Test/diagnostic view: is a process running behind this host? */
  get started(): boolean {
    return this.client !== undefined
  }

  /**
   * Take a lease. Concurrent acquirers share ONE start — `ready` is reserved
   * before the first await, so two callers landing in the same tick cannot
   * spawn two app-servers.
   *
   * A start that fails closes the host and rejects every acquirer with the
   * transport's own error; the registry has already dropped it, so the next
   * `acquire` builds a fresh one. Nothing retries here.
   */
  async acquire(label?: string): Promise<CodexHostHandle> {
    if (this.closedError) throw this.closedError
    this.handles++
    this.cancelIdle()
    logger.debug(LOG_SOURCE, `host acquired: ${acquireLabel(label)} key=${this.key}`)
    if (!this.ready) this.ready = this.startClient()
    try {
      await this.ready
    } catch (error) {
      this.drop()
      // A start that failed has already tripped `onDisconnect` on the real
      // transport; this makes the host's removal true of any client.
      this.close(error instanceof CodexTransportError ? error.code : 'host-start-failed')
      throw error
    }
    if (this.closedError) {
      this.drop()
      throw this.closedError
    }
    return this.handle()
  }

  /**
   * Keep this host alive regardless of reads — the seam ADR-069 decision 2 will
   * call when a SESSION registers its thread. Unused in H1 (sessions still own
   * their own process), and deliberately trivial: the idle rule is the only
   * thing a registration has to change here.
   */
  retain(): void {
    this.retained++
    this.cancelIdle()
    // A session is not a read: it may hold the host indefinitely, so the
    // deadline the last read left behind is dropped rather than resumed.
    this.idleDeadline = undefined
  }

  /** Counterpart of {@link retain}. The last session leaving starts the idle wait. */
  release(): void {
    if (this.retained === 0) return
    this.retained--
    this.armIdle()
  }

  /** Close the process gracefully and reject everything afterwards. */
  close(code = 'host-closed'): void {
    if (this.closedError) return
    this.closedError = new CodexTransportError(code)
    this.cancelIdle()
    this.onClosed(this)
    // `dispose()` ends stdin and only kills after the grace (F7/ADR-069 §6), and
    // its failure code is `disposed`, so this never writes a death line.
    this.client?.dispose()
  }

  private async startClient(): Promise<void> {
    const hook = this.identity ? this.deps.createHook(this.identity.accountId) : null
    this.hook = hook
    const client = this.deps.createClient({
      ...this.options,
      label: CODEX_HOST_LABEL,
      serverMethods: SERVER_METHODS,
      ...(hook ? { onServerRequest: (_method, params) => hook.onRefreshRequest(params) } : {}),
      onDisconnect: (error) => this.onDisconnect(error)
    })
    this.client = client
    await client.start(initializeParams, hook)
  }

  /**
   * The transport went away — a crash, a kill, an EOF. ADR-069 §5: this is the
   * opencode server's death. The host is gone, in-flight requests have already
   * been rejected by the transport with its own error, and the next `acquire`
   * starts a fresh process. Nothing is retried on a caller's behalf.
   */
  private onDisconnect(error: CodexTransportError): void {
    if (this.closedError) return
    this.closedError = error
    this.cancelIdle()
    this.onClosed(this)
  }

  private handle(): CodexHostHandle {
    let released = false
    const handle: CodexHostHandle = {
      host: this,
      // Live, not snapshotted: a token refresh can move the injected account
      // under a long-lived handle (`codex-auth-hook.ts`), and a lease that
      // remembered the old one would key a rate-limit read onto it.
      get injectedAccountId(): string | null {
        return handle.host.injectedAccountId
      },
      request: <M extends keyof CodexMethods>(
        method: M,
        params: CodexMethods[M]['params']
      ): Promise<CodexMethods[M]['result']> => {
        if (released) return Promise.reject(new CodexTransportError('handle-released'))
        if (this.closedError) return Promise.reject(this.closedError)
        return this.client!.request(method, params)
      },
      release: (): void => {
        if (released) return
        released = true
        this.drop()
      }
    }
    return handle
  }

  private drop(): void {
    if (this.handles === 0) return
    this.handles--
    this.armIdle()
  }

  private armIdle(): void {
    if (this.closedError || this.handles > 0 || this.retained > 0 || this.idleTimer) return
    this.idleDeadline ??= Date.now() + this.deps.idleMs
    const remaining = Math.max(0, this.idleDeadline - Date.now())
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      this.close('host-idle')
    }, remaining)
    this.idleTimer.unref?.()
  }

  private cancelIdle(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    // `idleDeadline` deliberately survives: reads keep a host warm, not alive.
  }
}

/**
 * Every live host, keyed `<normalised home>|acct:<vault account>` or
 * `<normalised home>|native`.
 *
 * A module singleton ({@link codexHostRegistry}) because the callers that need
 * to share a process have no common owner — the auth provider, the sidebar
 * poll, the settings page and model discovery are built independently.
 */
export class CodexHostRegistry {
  private readonly hosts = new Map<string, CodexHost>()
  private readonly deps: Required<Pick<CodexHostDeps, 'createClient' | 'createHook' | 'idleMs'>> & {
    activeAccountId: () => Promise<string | null>
  }

  constructor(deps: CodexHostDeps = {}) {
    this.deps = {
      createClient: deps.createClient ?? ((options) => new CodexClient(options)),
      createHook: deps.createHook ?? ((accountId) => codexAuthHook({ accountId })),
      activeAccountId: deps.activeAccountId ?? vaultActiveAccountId,
      idleMs: deps.idleMs ?? CODEX_HOST_IDLE_MS
    }
  }

  /**
   * The host for this home and account, started if it is not already, plus a
   * lease on it.
   *
   * The account is resolved BEFORE the key is built, and the RESOLVED value is
   * what the host is built with, so:
   *
   *  · a caller following the active account and one pinned to that same id land
   *    on one process (and the host's hook is pinned to the concrete id, which
   *    is what the key already promised);
   *  · "the active account" on a vault that holds none resolves to
   *    {@link NATIVE} — one uninjected host for the home, not a second identical
   *    process in an `active` bucket of its own.
   *
   * Since every reader now asks for the active account, the common machine runs
   * exactly ONE app-server per home: the active account's, or the uninjected one
   * when there is no account to inject.
   */
  async acquire(options: CodexHostAcquireOptions = {}): Promise<CodexHostHandle> {
    const account = await this.resolveAccount(options.identity)
    const key = `${codexHomeKey(codexHomeForEnv(options.env))}|${account}`
    let host = this.hosts.get(key)
    if (!host) {
      host = new CodexHost(
        key,
        account === NATIVE ? undefined : { accountId: account.slice('acct:'.length) },
        {
          cwd: options.cwd ?? homedir(),
          ...(options.env ? { env: options.env } : {}),
          ...(options.requestTimeoutMs !== undefined
            ? { requestTimeoutMs: options.requestTimeoutMs }
            : {}),
          ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {})
        },
        this.deps,
        (closed) => {
          if (this.hosts.get(closed.key) === closed) this.hosts.delete(closed.key)
        }
      )
      this.hosts.set(key, host)
    }
    return host.acquire(options.label)
  }

  private async resolveAccount(identity: CodexHostIdentity | undefined): Promise<string> {
    if (!identity) return NATIVE
    if (identity.accountId !== null) return `acct:${identity.accountId}`
    const active = await this.deps.activeAccountId()
    return active === null ? NATIVE : `acct:${active}`
  }

  /** How many hosts are live. Diagnostics and tests only. */
  get size(): number {
    return this.hosts.size
  }

  /**
   * Close every host, gracefully (stdin EOF first, kill only after the grace).
   *
   * Bounded by construction: `CodexClient.dispose()` returns as soon as it has
   * rejected the client's pending work and ended stdin, so app quit never waits
   * on a child — and a parent that exits first closes the pipe anyway, which is
   * the same EOF the app-server shuts down on.
   */
  dispose(): void {
    for (const host of [...this.hosts.values()]) host.close('host-disposed')
    this.hosts.clear()
  }
}

export const codexHostRegistry = new CodexHostRegistry()
