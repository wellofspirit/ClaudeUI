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
 * ## What this slice (H2) does and does not do
 *
 * Reads AND sessions run on hosts: a session is a thread here (ADR-069 §2), and
 * {@link CodexHost.attach} hands it a per-thread connection whose notifications
 * and server requests are demultiplexed by `threadId`. What is still out: a host
 * is not recycled when the ACTIVE account changes (ADR-069 §4), which is H3.
 */
import { homedir } from 'node:os'
import {
  CodexMethodNotFound,
  CodexTransportError,
  type CodexClientOptions
} from './CodexAppServerClient'
import { CodexClient } from './CodexClient'
import { codexAuthHook, type CodexAuthHook } from './codex-auth-hook'
import { codexHomeForEnv, codexHomeKey } from './codex-home'
import { credentialSync } from '../auth/vault/CredentialSync'
import { logger } from '../services/logger'
import type { InitializeParams } from './protocol/InitializeParams'
import type { RequestId } from './protocol/RequestId'
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

/**
 * Every server request a host takes delivery of.
 *
 * The UNION of what its attached owners need, because the transport gates on
 * this list before any routing happens: a method absent here is answered
 * `-32601` by `CodexAppServerClient` itself and never reaches the demultiplexer.
 * The refresh is the host's own (ADR-069 §8); the rest belong to whichever owner
 * claimed the request's thread, and a dispatch TARGET's narrower surface
 * (`CODEX_TARGET_SERVER_METHODS`, no `item/tool/call`) is enforced by that owner
 * rather than by the transport now that it shares a process with sessions.
 */
const SERVER_METHODS = [
  'account/chatgptAuthTokens/refresh',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
  'item/tool/call',
  'mcpServer/elicitation/request'
] as const

/**
 * How many notifications from threads NOBODY has claimed yet are held, and for
 * how long they are worth replaying.
 *
 * A native child thread's first notifications routinely beat the spawning
 * `item/completed` that names it, and under one shared process the host is the
 * only place that can hold them: the owner they belong to is not known until it
 * claims the thread. Held here, replayed on
 * {@link CodexThreadConnection.claim}.
 *
 * Both bounds exist because nothing else prunes a bucket nobody ever claims. A
 * disposed session's trailing `turn/completed` would otherwise sit here until
 * the process ended and then be replayed — minutes or hours later — into
 * whatever session next resumed that thread, and a few hundred such leftovers
 * would saturate the cap and silence the hold for every real child after them.
 * So: a bucket older than {@link HOLD_TTL_MS} is discarded rather than replayed,
 * a thread the binary says it CLOSED loses its bucket immediately, and a full
 * hold evicts its oldest bucket instead of refusing the new notification — the
 * newest child is the one with a claim still coming.
 */
const HOLD_LIMIT = 200
const HOLD_TTL_MS = 30_000

/**
 * Bumped on every host START, so an approval or a one-shot hosted call minted
 * on one process is refused after a resume onto another — the rule that used to
 * be `CodexSession`'s per-object `generation` (ADR-069 §2). Module-level because
 * a host object starts exactly once: the registry replaces a dead host rather
 * than restarting it, and a per-instance counter would always read 1.
 */
let generations = 0

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
   * Serve this acquire from the host that has LOADED `thread`, whatever account
   * that host runs as (ADR-069 §3, probe P5).
   *
   * The writer lock a loaded thread takes is PROCESS-scoped: every other
   * app-server on the home is refused `-32600` for `thread/delete` and
   * `thread/resume` alike ("thread <id> already has an active writer"), while
   * the holder may delete its own. So a delete has to be issued on the holder,
   * and the holder is whichever host last loaded the thread — not necessarily
   * the active account's, since a session pinned to another account lives on
   * that account's host.
   *
   * Falls back to {@link identity} when no live host holds it (the thread is on
   * disk and unloaded, which every host can delete).
   */
  thread?: string
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
  /** The host itself, so a SESSION can {@link CodexHost.attach} to it. */
  readonly host: CodexHost
  /** Idempotent. */
  release(): void
}

/** The context a server request reaches a thread owner with. */
export type CodexServerRequestContext = { id: RequestId; signal: AbortSignal }

/**
 * What a THREAD on a host is driven by: a session (ADR-069 §2) or a dispatch
 * target (§7). Exactly the three transport callbacks each of them used to pass
 * to its own `CodexClient`, plus the one signal that used to reach it through a
 * hook it owned alone.
 */
export interface CodexThreadOwner {
  onNotification(method: string, params: unknown): void
  onServerRequest(
    method: string,
    params: unknown,
    context: CodexServerRequestContext
  ): Promise<unknown>
  /** The host went away (ADR-069 §5). Rung at most once per attachment. */
  onDisconnect(error: CodexTransportError): void
  /** The vault cannot refresh this host's ChatGPT token (ADR-069 §8). */
  onAuthRequired?(accountId: string | null): void
}

/** One owner's view of its host. Every method is a no-op after {@link detach}. */
export interface CodexThreadConnection {
  request<M extends keyof CodexMethods>(
    method: M,
    params: CodexMethods[M]['params']
  ): Promise<CodexMethods[M]['result']>
  /** Cancel the parked server requests of one ended turn. */
  abortServerRequests(threadId: string, turnId: string): void
  /**
   * Take delivery of everything stamped with `threadId` — the owner's own
   * thread, and every child thread it binds. Recent held notifications for a
   * thread nobody had claimed yet are replayed SYNCHRONOUSLY here; stale ones
   * (see {@link HOLD_TTL_MS}) are discarded rather than delivered to a session
   * that was not running when they arrived.
   *
   * THROWS if another owner already holds the thread: one live session per
   * thread is an invariant, not a race to win.
   */
  claim(threadId: string): void
  /**
   * Leave the host: unsubscribe every claimed thread (so a thread this owner
   * abandoned stops sending, and the binary can unload it and release its
   * writer lock) and release the host's retain. Idempotent.
   */
  detach(): void
  /** The vault account the host's process was injected with, or null. */
  readonly injectedAccountId: string | null
  /** This host's start generation — see {@link generations}. */
  readonly generation: number
  readonly host: CodexHost
}

/** One attached owner and the threads it has claimed. */
type Attachment = {
  owner: CodexThreadOwner
  claims: Set<string>
  detached: boolean
}

/** One notification for a thread no owner has claimed yet. */
type Held = { method: string; params: unknown; at: number }

/**
 * The slice of {@link CodexHostRegistry} a caller needs. Structural so a unit
 * test can hand a session, a service or the dispatcher a fake registry with no
 * binary and no vault behind it.
 */
export interface CodexHostSource {
  acquire(options?: CodexHostAcquireOptions): Promise<CodexHostHandle>
}

/** What a host drives. `CodexClient` satisfies it; a unit test fakes it. */
export interface CodexHostClient {
  start(params: InitializeParams, auth?: CodexAuthHook | null): Promise<unknown>
  request<M extends keyof CodexMethods>(
    method: M,
    params: CodexMethods[M]['params']
  ): Promise<CodexMethods[M]['result']>
  /** Absent on a fake that never parks server requests. */
  abortServerRequests?(threadId: string, turnId: string): void
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
  /** Attached OWNERS (ADR-069 §2). A host with one never idles out. */
  private retained = 0
  /** Every attached owner, in attach order. */
  private readonly attachments = new Set<Attachment>()
  /** Who takes delivery of each claimed thread — the demultiplexer's table. */
  private readonly claims = new Map<string, Attachment>()
  /**
   * Every thread this PROCESS has loaded and not seen closed: what the writer
   * lock actually follows. Filled from the `thread/start` / `thread/resume` /
   * `thread/fork` RESPONSES rather than from {@link claim}, because the lock is
   * taken when the thread opens, not when an owner takes delivery of it — a
   * session that threw in between still left one here. Survives `detach` on
   * purpose: the binary keeps a thread loaded (and locked) until it unloads it
   * about a minute after its last subscriber leaves, so a delete issued in
   * between still has to come here.
   */
  private readonly loaded = new Set<string>()
  /** Unclaimed threads' notifications, by thread id — see {@link HOLD_LIMIT}. */
  private readonly held = new Map<string, Held[]>()
  private heldCount = 0
  /** This host's start generation; 0 until the process is up. */
  private gen = 0
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
    /** The normalised Codex home this host's process runs against. */
    readonly homeKey: string,
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

  /** Which host START this is, process-wide. See {@link generations}. */
  get generation(): number {
    return this.gen
  }

  /**
   * How many THREAD OWNERS are attached — sessions and dispatch targets, never
   * reads. What decides whether a host may be closed to free its threads' writer
   * locks (`CodexSession.leaveHost`): a read that loses its host fails once and
   * the next one starts a fresh one (ADR-069 §5), while an owner would lose a
   * live turn.
   */
  get owners(): number {
    return this.attachments.size
  }

  /** Has this process loaded `threadId` (and therefore its writer lock)? */
  holds(threadId: string): boolean {
    return this.loaded.has(threadId)
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
   * Put one thread owner on this host (ADR-069 §2).
   *
   * The owner gets a connection, the host gets a user that keeps it alive
   * regardless of reads: an owner is not a read — it may hold the host
   * indefinitely — so the idle deadline the last read left behind is dropped
   * rather than resumed.
   *
   * Nothing is routed to it until it {@link CodexThreadConnection.claim}s a
   * thread, except the account-level notifications that carry no `threadId` at
   * all, which every attached owner sees.
   */
  attach(owner: CodexThreadOwner): CodexThreadConnection {
    if (this.closedError) throw this.closedError
    const attachment: Attachment = { owner, claims: new Set(), detached: false }
    this.attachments.add(attachment)
    this.retained++
    this.cancelIdle()
    this.idleDeadline = undefined
    return this.connection(attachment)
  }

  /**
   * Which requests OPEN a thread in this process — and so take its writer lock.
   *
   * Sniffed on the way out rather than learned from {@link claim}, because the
   * lock follows the PROCESS: a thread whose `thread/start` answered and whose
   * owner then threw before claiming it is still loaded here, and a delete
   * routed anywhere else would be refused with nothing left to retry (`delete.ts`
   * dropped its retry when the holder became knowable).
   */
  private static readonly OPENERS = new Set(['thread/start', 'thread/resume', 'thread/fork'])

  /** Remember a thread this process just opened. */
  private opened(result: unknown): void {
    if (typeof result !== 'object' || result === null) return
    const thread = (result as { thread?: unknown }).thread
    if (typeof thread !== 'object' || thread === null) return
    const id = (thread as { id?: unknown }).id
    if (typeof id === 'string' && id) this.loaded.add(id)
  }

  private connection(attachment: Attachment): CodexThreadConnection {
    // Live getters through the connection's own `host`, never a snapshot: a
    // token refresh can move the injected account under a long-lived session
    // (`codex-auth-hook.ts`), and an owner that remembered the old one would
    // attribute its usage to it. Same shape as {@link handle}.
    const connection: CodexThreadConnection = {
      host: this,
      get injectedAccountId(): string | null {
        return connection.host.injectedAccountId
      },
      get generation(): number {
        return connection.host.generation
      },
      request: <M extends keyof CodexMethods>(
        method: M,
        params: CodexMethods[M]['params']
      ): Promise<CodexMethods[M]['result']> => {
        if (attachment.detached) return Promise.reject(new CodexTransportError('detached'))
        if (this.closedError) return Promise.reject(this.closedError)
        const sent = this.client!.request(method, params)
        if (!CodexHost.OPENERS.has(method)) return sent
        return sent.then((result) => {
          this.opened(result)
          return result
        })
      },
      abortServerRequests: (threadId: string, turnId: string): void => {
        if (attachment.detached || this.closedError) return
        this.client?.abortServerRequests?.(threadId, turnId)
      },
      claim: (threadId: string): void => this.claim(attachment, threadId),
      detach: (): void => this.detach(attachment)
    }
    return connection
  }

  private claim(attachment: Attachment, threadId: string): void {
    if (attachment.detached) return
    const current = this.claims.get(threadId)
    // REFUSED, not stolen. One live session per thread is the session manager's
    // invariant and a second claim means something upstream is wrong; taking the
    // thread would silently move a running turn's approvals to another owner.
    // An owner that legitimately re-takes a thread (a re-pin's resume) detaches
    // first, and detaching frees the claim.
    if (current && current !== attachment)
      throw new Error(`Codex thread ${threadId} is already claimed on this host`)
    this.claims.set(threadId, attachment)
    attachment.claims.add(threadId)
    this.loaded.add(threadId)
    const held = this.held.get(threadId)
    if (!held) return
    this.forget(threadId)
    const fresh = Date.now() - HOLD_TTL_MS
    for (const entry of held)
      if (entry.at >= fresh) this.deliver(attachment, entry.method, entry.params)
  }

  /** Drop one thread's held notifications, if it has any. */
  private forget(threadId: string): void {
    const held = this.held.get(threadId)
    if (!held) return
    this.held.delete(threadId)
    this.heldCount -= held.length
  }

  /**
   * One owner leaves.
   *
   * Every thread it claimed is unsubscribed on the wire: that is what stops the
   * firehose for a thread the binary keeps LOADED, and — because a thread with
   * no subscribers is unloaded once it has been idle for `thread_unload_delay`
   * (60 s by default, `app-server/src/request_processors/thread_lifecycle.rs`)
   * — it is also what eventually releases the thread's writer lock. Best effort:
   * a host that is already gone has nothing to tell.
   */
  private detach(attachment: Attachment): void {
    if (attachment.detached) return
    attachment.detached = true
    this.attachments.delete(attachment)
    for (const threadId of attachment.claims) {
      if (this.claims.get(threadId) === attachment) this.claims.delete(threadId)
      if (!this.closedError)
        void this.client?.request('thread/unsubscribe', { threadId }).catch(() => {})
    }
    attachment.claims.clear()
    if (this.attachments.size === 0) {
      this.held.clear()
      this.heldCount = 0
    }
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
    // ADR-069 §5: a host closing IS the opencode server's death for every
    // session on it. Said AFTER the dispose, so an owner that reacts by asking
    // for a new host cannot be handed this one.
    this.notifyClosed(this.closedError)
  }

  private async startClient(): Promise<void> {
    const hook = this.identity ? this.deps.createHook(this.identity.accountId) : null
    this.hook = hook
    if (hook)
      // One hook per PROCESS, so the sign-in notice cannot be owned by one
      // session any more: every owner on this host runs on the credential that
      // just failed to refresh (ADR-069 §8).
      hook.onAuthRequired = (accountId): void => {
        for (const attachment of [...this.attachments]) attachment.owner.onAuthRequired?.(accountId)
      }
    const client = this.deps.createClient({
      ...this.options,
      label: CODEX_HOST_LABEL,
      serverMethods: SERVER_METHODS,
      onNotification: (method, params) => this.notification(method, params),
      onServerRequest: (method, params, context) => this.serverRequest(method, params, context),
      onDisconnect: (error) => this.onDisconnect(error)
    })
    this.client = client
    this.gen = ++generations
    await client.start(initializeParams, hook)
  }

  /** The `threadId` a wire payload is stamped with, or undefined. */
  private static threadOf(params: unknown): string | undefined {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined
    const threadId = (params as { threadId?: unknown }).threadId
    return typeof threadId === 'string' ? threadId : undefined
  }

  /**
   * The demultiplexer, notification half (ADR-069 §2).
   *
   * A notification with no `threadId` — `account/rateLimits/updated`,
   * `account/updated` — is ACCOUNT-level: it belongs to the identity this whole
   * process runs as, so every attached owner sees it. One with a `threadId` goes
   * to the owner that claimed it; one for a thread nobody has claimed is HELD
   * (a child's first events routinely beat the item that names it) and replayed
   * when someone claims it, or dropped once the hold is full.
   */
  private notification(method: string, params: unknown): void {
    if (this.closedError) return
    const threadId = CodexHost.threadOf(params)
    if (threadId === undefined) {
      for (const attachment of [...this.attachments]) this.deliver(attachment, method, params)
      return
    }
    // The binary unloaded the thread: its writer lock is gone with it, so this
    // host is no longer the holder a delete has to be issued on — and anything
    // held for it can never be claimed by anyone, so it goes too. The
    // notification itself is delivered to a current claimant and otherwise
    // dropped: holding the news of a close would replay it into whichever
    // session next resumes that id.
    if (method === 'thread/closed') {
      this.loaded.delete(threadId)
      this.forget(threadId)
      const claimant = this.claims.get(threadId)
      if (claimant) this.deliver(claimant, method, params)
      return
    }
    const owner = this.claims.get(threadId)
    if (owner) return this.deliver(owner, method, params)
    if (this.attachments.size === 0) return
    if (this.heldCount >= HOLD_LIMIT) this.evictOldestHold()
    const held = this.held.get(threadId) ?? []
    held.push({ method, params, at: Date.now() })
    this.held.set(threadId, held)
    this.heldCount++
  }

  /**
   * Make room in a full hold by dropping the thread whose oldest entry is
   * oldest. The newest bucket is the one whose claim is still plausibly coming.
   */
  private evictOldestHold(): void {
    let oldest: { threadId: string; at: number } | undefined
    for (const [threadId, held] of this.held) {
      const at = held[0]?.at ?? 0
      if (!oldest || at < oldest.at) oldest = { threadId, at }
    }
    if (oldest) this.forget(oldest.threadId)
  }

  private deliver(attachment: Attachment, method: string, params: unknown): void {
    if (attachment.detached) return
    try {
      attachment.owner.onNotification(method, params)
    } catch {
      // One owner throwing is a BUG, and a loud one — but it must not cost the
      // others their notification, and it must never take the transport's frame
      // reader down (which would kill the whole host over one bad handler).
      logger.warn(LOG_SOURCE, `owner threw on ${method} key=${this.key}`)
    }
  }

  /**
   * The demultiplexer, server-request half.
   *
   * `account/chatgptAuthTokens/refresh` carries no thread and is the host's own
   * (ADR-069 §8). Everything else is a question about ONE thread and is answered
   * by the owner that claimed it. A request for a thread nobody claimed is
   * answered `-32601`, exactly as an unregistered method would be, and logged:
   * an approval that no client can answer must be visible, never silently
   * accepted.
   */
  private serverRequest(
    method: string,
    params: unknown,
    context: CodexServerRequestContext
  ): Promise<unknown> {
    if (method === 'account/chatgptAuthTokens/refresh') {
      if (!this.hook)
        return Promise.reject(new Error('This Codex host holds no ClaudeUI-managed credential'))
      return this.hook.onRefreshRequest(params)
    }
    const threadId = CodexHost.threadOf(params)
    const attachment = threadId === undefined ? undefined : this.claims.get(threadId)
    if (!attachment) {
      logger.debug(LOG_SOURCE, `unclaimed thread request refused: ${method} key=${this.key}`)
      return Promise.reject(new CodexMethodNotFound())
    }
    return attachment.owner.onServerRequest(method, params, context)
  }

  /** Tell every attached owner this host is gone, exactly once each. */
  private notifyClosed(error: CodexTransportError): void {
    for (const attachment of [...this.attachments]) {
      attachment.detached = true
      this.attachments.delete(attachment)
      try {
        attachment.owner.onDisconnect(error)
      } catch {
        /* one owner's teardown cannot break the next one's */
      }
    }
    this.claims.clear()
    this.loaded.clear()
    this.held.clear()
    this.heldCount = 0
    this.retained = 0
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
    this.notifyClosed(error)
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
    const homeKey = codexHomeKey(codexHomeForEnv(options.env))
    // The holder first, when one was asked for: which ACCOUNT the process runs
    // as is irrelevant to a thread that is already loaded somewhere, and
    // resolving the vault's active account here would pick the wrong process.
    const holder = options.thread ? this.holderFor(homeKey, options.thread) : undefined
    if (holder) return holder.acquire(options.label)
    const account = await this.resolveAccount(options.identity)
    const key = `${homeKey}|${account}`
    let host = this.hosts.get(key)
    if (!host) {
      host = new CodexHost(
        key,
        homeKey,
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

  /**
   * The live host on this home that has `threadId` loaded, if any — the one
   * process whose `thread/delete` the binary will not refuse (probe P5).
   */
  holderFor(homeKey: string, threadId: string): CodexHost | undefined {
    for (const host of this.hosts.values())
      if (host.homeKey === homeKey && host.holds(threadId)) return host
    return undefined
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
