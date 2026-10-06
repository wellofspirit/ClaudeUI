/**
 * HTTP client for the opencode 2.x server (ADR-093 §7), built on the
 * GENERATED operation table (`./protocol-v2/openapi`): every request and
 * response is typed per operationId, and a pin bump that moves a route or a
 * field breaks the build here, not at runtime.
 *
 * Every request carries:
 * - `authorization` — Basic `opencode:<password>` (`ServerConnection.authHeader`);
 * - `x-opencode-directory` — the lease's directory, URI-encoded. One 2.x server
 *   serves every directory (ADR-093 §2), and a request without it is answered
 *   for the SERVER's cwd (`packages/server/src/location.ts requestRef`), which
 *   is never the caller's project. `forDirectory()` re-targets a client.
 *
 * Failure model:
 * - non-2xx → `OpencodeApiError` with the spec's error union for that
 *   operation (`error`, narrowed by `is(tag)`), the raw body otherwise;
 * - our own timeout → `OpencodeTimeoutError`;
 * - a caller abort or a transport failure propagates as fetch threw it.
 *
 * No call here waits header-silently for a model turn: `prompt` and
 * `runCommand` enqueue into the session inbox and answer at once; the turn is
 * followed on the event feed (`subscribeEvents`, `./opencode-event-stream`).
 * The one synchronous model call is `generate` (one completion, no tool
 * loop); its timeout stays under undici's 300 s `headersTimeout` so it fails
 * with our error rather than a bare "fetch failed".
 */
import {
  OPERATIONS,
  type Agent_Info,
  type Command_Info,
  type Config_Entry,
  type Credential_CreateInput,
  type Credential_Entry,
  type Form_Answer,
  type Form_Info,
  type Integration_Info,
  type Mcp_Server,
  type Model_Info,
  type Model_Ref,
  type OperationId,
  type Operations,
  type Permission_Request,
  type Permission_Ruleset,
  type Provider_Info,
  type Session_Inbox_Delivery,
  type Session_Inbox_Info,
  type Session_Inbox_User,
  type Session_Info,
  type Session_Message_Info,
  type Shell_Info,
  type Skill_Info,
  type SessionActive
} from './protocol-v2/openapi'
import {
  openOpencodeEventStream,
  subscribeOpencodeEvents,
  type ConnectOptions,
  type FetchFn,
  type OpencodeFeedItem,
  type SubscribeOptions
} from './opencode-event-stream'
import type { OpencodeEvent } from './protocol-v2/events'

// --- Timeouts ---------------------------------------------------------------

/** Control-plane calls (create/list/reply/…): generous for a local server. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/**
 * `session.generate` — one synchronous completion. Below undici's default
 * 300 s `headersTimeout` (Electron main's global fetch), which would otherwise
 * kill it first with an opaque "fetch failed".
 */
export const GENERATE_TIMEOUT_MS = 240_000

// --- Typed request shape ----------------------------------------------------

type Op<K extends OperationId> = Operations[K]

type SseOperationId = {
  [K in OperationId]: Op<K>['responseKind'] extends 'sse' ? K : never
}[OperationId]
/** Operations `call` can send (the SSE ones have their own readers). */
export type RequestOperationId = Exclude<OperationId, SseOperationId>

type ParamsField<P> = [P] extends [never] ? { readonly params?: undefined } : { readonly params: P }
type OptionalUnlessRequired<Name extends string, T> = [T] extends [never]
  ? { readonly [N in Name]?: undefined }
  : object extends T
    ? { readonly [N in Name]?: T }
    : { readonly [N in Name]: T }

export interface OpencodeRequestOptions {
  /** `<= 0` disables. Default `DEFAULT_REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /** Overrides the client's directory for this request. */
  readonly directory?: string
}

export type CallInit<K extends RequestOperationId> = ParamsField<Op<K>['params']> &
  OptionalUnlessRequired<'query', Op<K>['query']> &
  OptionalUnlessRequired<'body', Op<K>['body']> &
  OpencodeRequestOptions

type CallArgs<K extends RequestOperationId> =
  object extends CallInit<K> ? [init?: CallInit<K>] : [init: CallInit<K>]

export type OperationResponse<K extends OperationId> = Op<K>['response']

// --- Errors -----------------------------------------------------------------

/** The spec-declared error bodies of an operation. */
export type OperationError<K extends OperationId> = Op<K>['errors']
export type OperationErrorTag<K extends OperationId> =
  OperationError<K> extends infer E ? (E extends { readonly _tag: infer T } ? T : never) : never

/**
 * The server answered non-2xx. `error` is the body when it is a tagged error
 * (the spec's union for `operation`; the server also sends a few untagged
 * cases, e.g. a plain-text 404 for an unknown route, or the location
 * middleware's `LocationNotFoundError`, which no operation lists).
 */
export class OpencodeApiError<K extends OperationId = OperationId> extends Error {
  override readonly name = 'OpencodeApiError'
  readonly tag: string | undefined
  constructor(
    readonly operation: K,
    readonly status: number,
    readonly body: unknown
  ) {
    const tag = tagOf(body)
    const detail =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : typeof body === 'string'
          ? body
          : JSON.stringify(body ?? '')
    const { method, path } = OPERATIONS[operation]
    super(
      `opencode ${operation} (${method} ${path}) → ${status}${tag ? ` ${tag}` : ''}: ${String(detail).slice(0, 500)}`
    )
    this.tag = tag
  }

  /** The tagged body, typed by the operation's declared errors (undefined when untagged). */
  get error(): OperationError<K> | undefined {
    return this.tag ? (this.body as OperationError<K>) : undefined
  }

  is<T extends OperationErrorTag<K>>(
    tag: T
  ): this is OpencodeApiError<K> & {
    readonly error: Extract<OperationError<K>, { readonly _tag: T }>
  } {
    return this.tag === tag
  }
}

function tagOf(body: unknown): string | undefined {
  return typeof body === 'object' &&
    body !== null &&
    typeof (body as { _tag?: unknown })._tag === 'string'
    ? (body as { _tag: string })._tag
    : undefined
}

/** `err` is an API error (of `operation`, when given). */
export function isOpencodeApiError<K extends OperationId>(
  err: unknown,
  operation?: K
): err is OpencodeApiError<K> {
  return err instanceof OpencodeApiError && (operation === undefined || err.operation === operation)
}

export class OpencodeTimeoutError extends Error {
  override readonly name = 'OpencodeTimeoutError'
  constructor(
    readonly operation: OperationId,
    readonly timeoutMs: number
  ) {
    super(`opencode ${operation} timed out after ${timeoutMs} ms`)
  }
}

// --- Domain shapes ----------------------------------------------------------

/**
 * A permission answer. A reject MUST carry a non-empty message (ADR-093 §3):
 * 2.x ends the whole turn on a messageless reject, while a reject with a
 * message fails only the tool and the model reads the message. The type makes
 * the message mandatory; `replyPermission` also refuses a blank one at runtime.
 */
export type PermissionReply =
  | { readonly decision: 'once' | 'always'; readonly message?: string }
  | { readonly decision: 'reject'; readonly message: string }

export type CreateSessionInput = NonNullable<Op<'session.create'>['body']>
export type PromptInput = Op<'session.prompt'>['body']
export type CommandInput = Op<'session.command'>['body']
export type SessionListQuery = NonNullable<Op<'session.list'>['query']>
export type MessageListQuery = NonNullable<Op<'session.message.list'>['query']>
export type SessionUpdate = Op<'session.update'>['body']

/** What a client needs from a lease (`ServerConnection` satisfies it). */
export interface OpencodeEndpoint {
  readonly baseUrl: string
  readonly authHeader: string
  /** Absolute directory every request is about (`x-opencode-directory`). */
  readonly directory: string
}

export interface OpencodeClientOptions {
  /** Test seam; defaults to the global fetch. */
  readonly fetch?: FetchFn
}

const PAGE_SIZE = 200
const MAX_PAGES = 500

// --- Client -----------------------------------------------------------------

export class OpencodeClient {
  readonly baseUrl: string
  readonly directory: string
  private readonly authHeader: string
  private readonly fetchFn: FetchFn | undefined
  /** `awaitLocationReady` memo, per directory. */
  private readonly locationReady = new Map<string, Promise<void>>()

  constructor(endpoint: OpencodeEndpoint, options: OpencodeClientOptions = {}) {
    if (!endpoint.directory) throw new TypeError('OpencodeClient: a directory is required')
    this.baseUrl = endpoint.baseUrl.replace(/\/$/, '')
    this.authHeader = endpoint.authHeader
    this.directory = endpoint.directory
    this.fetchFn = options.fetch
  }

  /** The same server, scoped to another directory. */
  forDirectory(directory: string): OpencodeClient {
    return new OpencodeClient(
      { baseUrl: this.baseUrl, authHeader: this.authHeader, directory },
      { fetch: this.fetchFn }
    )
  }

  // ── Generic ───────────────────────────────────────────────────────────────

  /** Send any non-SSE operation of the pinned spec. */
  call<K extends RequestOperationId>(id: K, ...[init]: CallArgs<K>): Promise<OperationResponse<K>> {
    return this.request(id, (init ?? {}) as CallInit<K>)
  }

  private async request<K extends RequestOperationId>(
    id: K,
    init: CallInit<K>,
    pathOverride?: string
  ): Promise<OperationResponse<K>> {
    const operation = OPERATIONS[id]
    const path =
      pathOverride ?? fillPath(id, operation.path, init.params as Record<string, unknown>)
    const url = this.baseUrl + path + encodeQuery(init.query as Record<string, unknown> | undefined)
    const headers: Record<string, string> = {
      authorization: this.authHeader,
      'x-opencode-directory': encodeURIComponent(init.directory ?? this.directory),
      accept: operation.responseKind === 'binary' ? '*/*' : 'application/json'
    }
    let body: BodyInit | undefined
    if (operation.bodyKind === 'json' && init.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.body)
    } else if (operation.bodyKind === 'binary' && init.body !== undefined) {
      headers['content-type'] = 'application/octet-stream'
      body = init.body as Uint8Array<ArrayBuffer>
    }

    const external = init.signal
    // Already cancelled: never reach the server.
    if (external?.aborted) throw external.reason ?? new DOMException('aborted', 'AbortError')
    const timeoutMs = init.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const controller = new AbortController()
    let timedOut = false
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeoutMs)
        : undefined
    const onAbort = (): void => controller.abort()
    external?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await (this.fetchFn ?? fetch)(url, {
        method: operation.method,
        headers,
        body,
        signal: controller.signal
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new OpencodeApiError(id, response.status, parseMaybeJson(text))
      }
      switch (operation.responseKind) {
        case 'empty':
          await response.arrayBuffer().catch(() => undefined)
          return undefined as OperationResponse<K>
        case 'binary':
          return new Uint8Array(await response.arrayBuffer()) as OperationResponse<K>
        default: {
          const text = await response.text()
          try {
            return JSON.parse(text) as OperationResponse<K>
          } catch {
            throw new Error(`opencode ${id}: response is not JSON: ${text.slice(0, 200)}`)
          }
        }
      }
    } catch (err) {
      if (timedOut) throw new OpencodeTimeoutError(id, timeoutMs)
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /**
   * `POST /api/session`, located in this client's directory unless `location`
   * says otherwise. The body's `location` is REQUIRED for that: session.create
   * ignores `x-opencode-directory` and falls back to the server's own cwd
   * (`packages/server/src/handlers/session.ts`). A child (`parentID`) inherits
   * its parent's location and the server ignores `location`.
   */
  async createSession(
    input: CreateSessionInput = {},
    opts?: OpencodeRequestOptions
  ): Promise<Session_Info> {
    const body = input.parentID ? input : { location: { directory: this.directory }, ...input }
    return (await this.call('session.create', { body, ...opts })).data
  }

  async getSession(sessionID: string, opts?: OpencodeRequestOptions): Promise<Session_Info> {
    return (await this.call('session.get', { params: { sessionID }, ...opts })).data
  }

  /**
   * One page of `GET /api/session`. The list is GLOBAL (every directory the
   * DB knows): the directory header does not filter it, `query.directory`
   * does. `parentID:'null'` = root sessions only.
   */
  listSessionsPage(
    query: SessionListQuery = {},
    opts?: OpencodeRequestOptions
  ): Promise<OperationResponse<'session.list'>> {
    return this.call('session.list', { query, ...opts })
  }

  /** Every session matching `query`, following cursors (newest first unless `order`). */
  async listSessions(
    query: Omit<SessionListQuery, 'cursor' | 'limit'> = {},
    opts?: OpencodeRequestOptions
  ): Promise<Session_Info[]> {
    return this.collect(
      (cursor) =>
        this.listSessionsPage(
          cursor ? { cursor, limit: String(PAGE_SIZE) } : { ...query, limit: String(PAGE_SIZE) },
          opts
        ),
      'session.list'
    )
  }

  /** Root sessions located in `directory` (default: this client's). */
  listRootSessions(
    directory = this.directory,
    opts?: OpencodeRequestOptions
  ): Promise<Session_Info[]> {
    return this.listSessions({ directory, parentID: 'null' }, opts)
  }

  /** `PATCH /api/session/{id}` — title, metadata, permissions (S6 compiles the ruleset). */
  updateSession(
    sessionID: string,
    patch: SessionUpdate,
    opts?: OpencodeRequestOptions
  ): Promise<void> {
    return this.call('session.update', { params: { sessionID }, body: patch, ...opts })
  }

  renameSession(sessionID: string, title: string, opts?: OpencodeRequestOptions): Promise<void> {
    return this.updateSession(sessionID, { title }, opts)
  }

  setSessionPermissions(
    sessionID: string,
    permissions: Permission_Ruleset,
    opts?: OpencodeRequestOptions
  ): Promise<void> {
    return this.updateSession(sessionID, { permissions }, opts)
  }

  switchAgent(sessionID: string, agent: string, opts?: OpencodeRequestOptions): Promise<void> {
    return this.call('session.switchAgent', { params: { sessionID }, body: { agent }, ...opts })
  }

  switchModel(sessionID: string, model: Model_Ref, opts?: OpencodeRequestOptions): Promise<void> {
    return this.call('session.switchModel', { params: { sessionID }, body: { model }, ...opts })
  }

  deleteSession(sessionID: string, opts?: OpencodeRequestOptions): Promise<void> {
    return this.call('session.remove', { params: { sessionID }, ...opts })
  }

  async forkSession(
    sessionID: string,
    body: Op<'session.fork'>['body'] = {},
    opts?: OpencodeRequestOptions
  ): Promise<Session_Info> {
    return (await this.call('session.fork', { params: { sessionID }, body, ...opts })).data
  }

  // ── Turns and the inbox ───────────────────────────────────────────────────

  /**
   * `POST /api/session/{id}/prompt` — enqueue user input; answers at once with
   * the inbox item (the turn runs on the event feed). Pass a ClaudeUI-chosen
   * `id` (`msg_…`) to make it addressable for `cancelInbox` /
   * `setInboxDelivery` (ADR-093 §9) and idempotent: re-posting an id the
   * session already has returns the FIRST admission unchanged (the new text is
   * ignored); an id owned by another session is a 409 `ConflictError`
   * (`packages/core/src/session/inbox.ts reconcile`). `delivery`: `steer`
   * (into the running turn, the default) or `queue`.
   */
  async prompt(
    sessionID: string,
    input: PromptInput,
    opts?: OpencodeRequestOptions
  ): Promise<Session_Inbox_User> {
    return (await this.call('session.prompt', { params: { sessionID }, body: input, ...opts })).data
  }

  /** `POST /api/session/{id}/command` — expands a command into an inbox prompt (async, like `prompt`). */
  runCommand(sessionID: string, input: CommandInput, opts?: OpencodeRequestOptions): Promise<void> {
    return this.call('session.command', { params: { sessionID }, body: input, ...opts })
  }

  /** `DELETE …/inbox/{id}` — dequeue an item not yet delivered. */
  cancelInbox(sessionID: string, inboxID: string, opts?: OpencodeRequestOptions): Promise<void> {
    return this.call('session.inbox.cancel', { params: { sessionID, inboxID }, ...opts })
  }

  /** `PATCH …/inbox/{id}` — steer ↔ queue. */
  setInboxDelivery(
    sessionID: string,
    inboxID: string,
    delivery: Session_Inbox_Delivery,
    opts?: OpencodeRequestOptions
  ): Promise<void> {
    return this.call('session.inbox.update', {
      params: { sessionID, inboxID },
      body: { delivery },
      ...opts
    })
  }

  async listInbox(
    sessionID: string,
    opts?: OpencodeRequestOptions
  ): Promise<readonly Session_Inbox_Info[]> {
    return (await this.call('session.inbox.list', { params: { sessionID }, ...opts })).data
  }

  /**
   * `POST …/interrupt` → whether a running execution was interrupted.
   * `resume:true` continues with the inbox after the interrupt.
   */
  async interrupt(
    sessionID: string,
    options: { resume?: boolean } = {},
    opts?: OpencodeRequestOptions
  ): Promise<boolean> {
    const query =
      options.resume === undefined
        ? {}
        : { resume: options.resume ? ('true' as const) : ('false' as const) }
    return (await this.call('session.interrupt', { params: { sessionID }, query, ...opts }))
      .interrupted
  }

  /**
   * `GET /api/session/active` — the sessions with a running execution. ABSENT
   * MEANS IDLE: the reconnect catch-up for a turn believed running.
   */
  async activeSessions(
    opts?: OpencodeRequestOptions
  ): Promise<Readonly<Record<string, SessionActive>>> {
    return (await this.call('session.active', opts ?? {})).data
  }

  /**
   * `POST …/generate` — one transient completion from the session's context
   * (its model, agent, history) plus `prompt`; nothing is written to the
   * session. Synchronous: the response arrives when the model is done.
   */
  async generate(
    sessionID: string,
    prompt: string,
    opts?: OpencodeRequestOptions
  ): Promise<string> {
    const result = await this.call('session.generate', {
      params: { sessionID },
      body: { prompt },
      timeoutMs: GENERATE_TIMEOUT_MS,
      ...opts
    })
    return result.data.text
  }

  // ── Approvals ─────────────────────────────────────────────────────────────

  /** Reply to `permission.asked`. See `PermissionReply` for the reject invariant. */
  replyPermission(
    sessionID: string,
    requestID: string,
    reply: PermissionReply,
    opts?: OpencodeRequestOptions
  ): Promise<void> {
    if (reply.decision === 'reject' && !reply.message?.trim())
      throw new TypeError(
        'opencode permission reject needs a non-empty message (ADR-093 §3: a messageless reject ends the turn)'
      )
    const message = reply.message?.trim() ? reply.message : undefined
    return this.call('session.permission.reply', {
      params: { sessionID, requestID },
      body: { decision: reply.decision, ...(message !== undefined ? { message } : {}) },
      ...opts
    })
  }

  async listPermissionRequests(
    sessionID: string,
    opts?: OpencodeRequestOptions
  ): Promise<readonly Permission_Request[]> {
    return (await this.call('session.permission.list', { params: { sessionID }, ...opts })).data
  }

  /** Answer a `form.created` (`{answer:{<field key>: value}}`). */
  replyForm(
    sessionID: string,
    formID: string,
    answer: Form_Answer,
    opts?: OpencodeRequestOptions
  ): Promise<void> {
    return this.call('session.form.reply', {
      params: { sessionID, formID },
      body: { answer },
      ...opts
    })
  }

  /**
   * Dismiss a form; `message` reaches the model as the call's failure. It is
   * REQUIRED, like a reject's (ADR-093 §3, review #4c): a cancel without one
   * fails the question tool `aborted` and ends the turn `interrupted{shutdown}`,
   * which keeps the execution claim — opencode would resume the turn on its
   * next start. A blank message throws before anything is sent.
   */
  cancelForm(
    sessionID: string,
    formID: string,
    message: string,
    opts?: OpencodeRequestOptions
  ): Promise<void> {
    if (!message?.trim())
      throw new TypeError(
        'opencode form cancel needs a non-empty message (ADR-093 §3: a messageless cancel ends the turn and keeps its claim)'
      )
    return this.call('session.form.cancel', {
      params: { sessionID, formID },
      query: { message },
      ...opts
    })
  }

  async listForms(sessionID: string, opts?: OpencodeRequestOptions): Promise<readonly Form_Info[]> {
    return (await this.call('session.form.list', { params: { sessionID }, ...opts })).data
  }

  // ── History ───────────────────────────────────────────────────────────────

  listMessagesPage(
    sessionID: string,
    query: MessageListQuery = {},
    opts?: OpencodeRequestOptions
  ): Promise<OperationResponse<'session.message.list'>> {
    return this.call('session.message.list', { params: { sessionID }, query, ...opts })
  }

  /**
   * The whole transcript, oldest first (the server's default order is newest
   * first), following cursors. `type` filters before pagination and is
   * re-sent with every cursor, as the spec requires.
   */
  listMessages(
    sessionID: string,
    filter: Pick<MessageListQuery, 'type'> = {},
    opts?: OpencodeRequestOptions
  ): Promise<Session_Message_Info[]> {
    const limit = String(PAGE_SIZE)
    return this.collect(
      (cursor) =>
        this.listMessagesPage(
          sessionID,
          cursor ? { ...filter, cursor, limit } : { ...filter, order: 'asc', limit },
          opts
        ),
      'session.message.list'
    )
  }

  // ── Shells ────────────────────────────────────────────────────────────────

  /**
   * `GET /api/shell/{id}/output` — one page of a shell's captured
   * stdout+stderr from `cursor` (an absolute byte offset; the page's `cursor`
   * is where the next starts, equal to `size` once caught up). 2.x pushes no
   * shell output on the feed (`session.tool.progress` carries only the
   * `shellID`), so this is how a running command's output is followed (S4).
   */
  async shellOutput(
    shellID: string,
    page: { cursor?: number; limit?: number } = {},
    opts?: OpencodeRequestOptions
  ): Promise<OperationResponse<'shell.output'>['data']> {
    const query = {
      ...(page.cursor !== undefined ? { cursor: String(page.cursor) } : {}),
      ...(page.limit !== undefined ? { limit: String(page.limit) } : {})
    }
    return (await this.call('shell.output', { params: { id: shellID }, query, ...opts })).data
  }

  /** `GET /api/shell/{id}` — a shell's status (`running`/`exited`/`timeout`/`killed`). */
  async getShell(shellID: string, opts?: OpencodeRequestOptions): Promise<Shell_Info> {
    return (await this.call('shell.get', { params: { id: shellID }, ...opts })).data
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  /**
   * Resolves once opencode has activated the plugins of `directory`'s
   * location. A location starts on its first request and its plugins register
   * the built-in agents, commands, skills, providers and models; the catalog
   * routes do NOT wait for that, so on a cold location they answer EMPTY for
   * ~100–250 ms (measured on 2.0.24, every catalog). `integration.list` does
   * wait (`Plugin.awaitActivation`, `packages/server/src/handlers/integration.ts`),
   * so it is the barrier. Memoized per directory until `reloadLocation()`; a
   * failure is not memoized. The catalog methods below call it first.
   */
  awaitLocationReady(opts?: OpencodeRequestOptions): Promise<void> {
    const directory = opts?.directory ?? this.directory
    let ready = this.locationReady.get(directory)
    if (!ready) {
      ready = this.call('integration.list', { ...opts, directory }).then(() => undefined)
      this.locationReady.set(directory, ready)
      ready.catch(() => {
        if (this.locationReady.get(directory) === ready) this.locationReady.delete(directory)
      })
    }
    return ready
  }

  async agents(opts?: OpencodeRequestOptions): Promise<readonly Agent_Info[]> {
    await this.awaitLocationReady(opts)
    return (await this.call('agent.list', opts ?? {})).data
  }

  async commands(opts?: OpencodeRequestOptions): Promise<readonly Command_Info[]> {
    await this.awaitLocationReady(opts)
    return (await this.call('command.list', opts ?? {})).data
  }

  async skills(opts?: OpencodeRequestOptions): Promise<readonly Skill_Info[]> {
    await this.awaitLocationReady(opts)
    return (await this.call('skill.list', opts ?? {})).data
  }

  /**
   * MCP servers of this directory with their status (2.x connects MCP per
   * directory, asynchronously — the server manager's readiness wait covers
   * ClaudeUI's own hosted server).
   */
  async mcpServers(opts?: OpencodeRequestOptions): Promise<readonly Mcp_Server[]> {
    return (await this.call('mcp.list', opts ?? {})).data
  }

  /**
   * `GET /api/model`. Can still be empty right after a server boots even past
   * the activation barrier (the catalog loads) — see `modelListIsAuthoritative`
   * before caching an empty answer.
   */
  async models(opts?: OpencodeRequestOptions): Promise<readonly Model_Info[]> {
    await this.awaitLocationReady(opts)
    return (await this.call('model.list', opts ?? {})).data
  }

  async defaultModel(opts?: OpencodeRequestOptions): Promise<Model_Info | null> {
    await this.awaitLocationReady(opts)
    return (await this.call('model.default', opts ?? {})).data
  }

  async providers(opts?: OpencodeRequestOptions): Promise<readonly Provider_Info[]> {
    await this.awaitLocationReady(opts)
    return (await this.call('provider.list', opts ?? {})).data
  }

  /** Integrations (providers, MCP OAuth, …) with their connect methods. Waits for activation itself. */
  async integrations(opts?: OpencodeRequestOptions): Promise<readonly Integration_Info[]> {
    return (await this.call('integration.list', opts ?? {})).data
  }

  // ── Credentials (S7) ──────────────────────────────────────────────────────

  /** Every stored credential WITH its secret value — never log the result. */
  async listCredentials(opts?: OpencodeRequestOptions): Promise<readonly Credential_Entry[]> {
    return (await this.call('credential.list', opts ?? {})).data
  }

  /**
   * `POST /api/credential` with a caller-chosen `id` (409 if it exists — rotate
   * by creating the next generation, then deleting the old one; ADR-093 §5).
   */
  async createCredential(
    input: Credential_CreateInput,
    opts?: OpencodeRequestOptions
  ): Promise<Credential_Entry> {
    return (await this.call('credential.create', { body: input, ...opts })).data
  }

  /** Only the label can change: a value in a PATCH is silently ignored upstream. */
  updateCredentialLabel(
    credentialID: string,
    label: string,
    opts?: OpencodeRequestOptions
  ): Promise<void> {
    return this.call('credential.update', { params: { credentialID }, body: { label }, ...opts })
  }

  removeCredential(credentialID: string, opts?: OpencodeRequestOptions): Promise<void> {
    return this.call('credential.remove', { params: { credentialID }, ...opts })
  }

  activateCredential(credentialID: string, opts?: OpencodeRequestOptions): Promise<void> {
    return this.call('credential.activate', { params: { credentialID }, ...opts })
  }

  // ── Config (S8) ───────────────────────────────────────────────────────────

  /** The config documents and directories in effect for this directory. */
  getConfig(opts?: OpencodeRequestOptions): Promise<readonly Config_Entry[]> {
    return this.call('config.get', opts ?? {})
  }

  /**
   * `POST /api/location/reload` — re-read config for this directory (after a
   * file write). Reconnects MCP: follow with the server manager's
   * `refreshReadiness(conn)`.
   */
  async reloadLocation(opts?: OpencodeRequestOptions): Promise<void> {
    // The reloaded location activates its plugins again.
    this.locationReady.delete(opts?.directory ?? this.directory)
    await this.call('location.reload', opts ?? {})
  }

  // ── Plugin RPC ────────────────────────────────────────────────────────────

  /**
   * `POST /api/rpc/{rpcID}/{method}`. (The spec's params omit `{method}`, so
   * the path is built here.)
   */
  async rpc(
    rpcID: string,
    method: string,
    input?: unknown,
    opts?: OpencodeRequestOptions
  ): Promise<unknown> {
    const path = `/api/rpc/${encodeURIComponent(rpcID)}/${encodeURIComponent(method)}`
    const result = await this.request(
      'rpc.call',
      { params: { rpcID }, body: { input }, ...opts } as CallInit<'rpc.call'>,
      path
    )
    return result.output
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * The reconnecting event feed — see `./opencode-event-stream` for the
   * reconnect contract (`{kind:'connected', reconnected:true}` = re-read state).
   * The feed is server-wide (every directory and session); filter by
   * `eventSessionID` / `event.location`.
   */
  subscribeEvents(options?: SubscribeOptions): AsyncGenerator<OpencodeFeedItem, void, undefined> {
    return subscribeOpencodeEvents(this.eventEndpoint(), options)
  }

  /** One subscription without reconnects (`server.connected` first; throws when it drops). */
  openEventStream(options?: ConnectOptions): AsyncGenerator<OpencodeEvent, void, undefined> {
    return openOpencodeEventStream(this.eventEndpoint(), options)
  }

  private eventEndpoint() {
    return { baseUrl: this.baseUrl, authHeader: this.authHeader, fetch: this.fetchFn }
  }

  // ── Paging ────────────────────────────────────────────────────────────────

  private async collect<T>(
    page: (cursor: string | undefined) => Promise<{
      readonly data: ReadonlyArray<T>
      readonly cursor: { readonly next?: string | null }
    }>,
    label: string
  ): Promise<T[]> {
    const all: T[] = []
    let cursor: string | undefined
    for (let n = 0; n < MAX_PAGES; n++) {
      const result = await page(cursor)
      all.push(...result.data)
      // `next` is present whenever the page had a last row, so an empty or
      // short page is the end.
      if (!result.cursor.next || result.data.length < PAGE_SIZE) return all
      cursor = result.cursor.next
    }
    throw new Error(`opencode ${label}: more than ${MAX_PAGES} pages`)
  }
}

// --- Request building -------------------------------------------------------

function fillPath(
  id: OperationId,
  template: string,
  params: Record<string, unknown> | undefined
): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params?.[name]
    if (typeof value !== 'string' || value === '')
      throw new TypeError(`opencode ${id}: missing path param ${name}`)
    return encodeURIComponent(value)
  })
}

/**
 * Query string per the spec's styles: scalars as `k=v`, arrays repeated, and
 * objects as `deepObject` (`location[directory]=…`). Undefined/null skipped.
 */
export function encodeQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const item of value) search.append(key, String(item))
    else if (typeof value === 'object') {
      for (const [sub, inner] of Object.entries(value as Record<string, unknown>))
        if (inner !== undefined && inner !== null) search.append(`${key}[${sub}]`, String(inner))
    } else search.append(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

function parseMaybeJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
