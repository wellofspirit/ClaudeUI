import type {
  ConfigProvidersResponse,
  ProviderListResponse,
  AuthCredentials,
  AuthOption,
  Session,
  StoredMessage,
  CreateSessionRequest,
  PromptRequest,
  ForkRequest,
  OpencodeEvent,
  Command,
  RunCommandRequest,
  Skill
} from './protocol/types'

/**
 * M-OC5: every request gets a timeout + AbortSignal so a dead/hung opencode
 * server can never block a caller forever. Two tiers:
 *  - control-plane calls (create/patch/list/reply/…) — fast; 60 s is generous.
 *  - `prompt()`/`runCommand()` run a whole model turn — a much larger cap, set
 *    ABOVE the cross-engine dispatcher's own 10-min DISPATCH_TIMEOUT so a
 *    client timeout never pre-empts the dispatcher's timeout/abort handling; it
 *    is purely the network-level backstop for a genuinely wedged server
 *    (the synchronous judge/askSideQuestion/agent-generate prompts).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const PROMPT_TIMEOUT_MS = 15 * 60_000

/** Per-request overrides. `timeoutMs <= 0` disables the timeout. */
export interface OpencodeRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export class OpencodeClient {
  private baseUrl: string
  private authHeader: string

  constructor(baseUrl: string, authHeader: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.authHeader = authHeader
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: OpencodeRequestOptions
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const controller = new AbortController()
    let timedOut = false
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeoutMs)
        : undefined
    // Chain a caller-supplied signal onto our controller so BOTH a caller abort
    // and the timeout cancel the in-flight fetch.
    const external = opts?.signal
    const onExternalAbort = (): void => controller.abort()
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`opencode ${method} ${path} → ${res.status}: ${text}`)
      }
      if (res.status === 204) return undefined as unknown as T
      return (await res.json()) as T
    } catch (err) {
      // Turn our own timeout abort into a clear, actionable error (fetch throws
      // a generic AbortError). A caller-initiated abort is re-thrown as-is.
      if (timedOut) {
        throw new Error(`opencode ${method} ${path} timed out after ${timeoutMs}ms`)
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      if (external) external.removeEventListener('abort', onExternalAbort)
    }
  }

  private get<T>(path: string, opts?: OpencodeRequestOptions) {
    return this.request<T>('GET', path, undefined, opts)
  }
  private post<T>(path: string, body?: unknown, opts?: OpencodeRequestOptions) {
    return this.request<T>('POST', path, body, opts)
  }
  private put<T>(path: string, body?: unknown, opts?: OpencodeRequestOptions) {
    return this.request<T>('PUT', path, body, opts)
  }
  private del<T>(path: string, opts?: OpencodeRequestOptions) {
    return this.request<T>('DELETE', path, undefined, opts)
  }
  private patch<T>(path: string, body?: unknown, opts?: OpencodeRequestOptions) {
    return this.request<T>('PATCH', path, body, opts)
  }

  // ── Config / Providers ────────────────────────────────────────────────────

  /** GET /config/providers — all providers with models + capabilities */
  getConfigProviders(): Promise<ConfigProvidersResponse> {
    return this.get('/config/providers')
  }

  /** GET /provider — all configured providers */
  getProviders(): Promise<ProviderListResponse> {
    return this.get('/provider')
  }

  /** GET /provider/auth — per-provider auth options */
  getProviderAuth(): Promise<Record<string, AuthOption[]>> {
    return this.get('/provider/auth')
  }

  /** PUT /auth/{id} — set credentials for a provider */
  setAuth(providerId: string, credentials: AuthCredentials): Promise<boolean> {
    return this.put(`/auth/${encodeURIComponent(providerId)}`, credentials)
  }

  /** DELETE /auth/{id} — remove credentials for a provider */
  removeAuth(providerId: string): Promise<boolean> {
    return this.del(`/auth/${encodeURIComponent(providerId)}`)
  }

  /**
   * POST /provider/{providerID}/oauth/authorize
   * Starts an OAuth flow for the provider. Returns the URL to open + method + instructions.
   * `method` is the array index from GET /provider/auth.
   */
  oauthAuthorize(
    providerId: string,
    method: number,
    inputs?: Record<string, string>
  ): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }> {
    return this.post(`/provider/${encodeURIComponent(providerId)}/oauth/authorize`, {
      method,
      ...(inputs ? { inputs } : {})
    })
  }

  /**
   * POST /provider/{providerID}/oauth/callback
   * Submit the paste code (method:'code' flow). Returns true on success.
   */
  oauthCallback(providerId: string, method: number, code?: string): Promise<boolean> {
    return this.post(`/provider/${encodeURIComponent(providerId)}/oauth/callback`, {
      method,
      ...(code !== undefined ? { code } : {})
    })
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /**
   * GET /session — list sessions for THIS server's project (git-root) scope.
   *
   * NOTE: this is PROJECT-scoped, not global — opencode only returns sessions whose
   * `directory` is under the project the server was started in. The sidebar's
   * cross-cwd list therefore does NOT use this (it reads opencode's DB directly via
   * `readOpencodeSessionRows`); this stays for the usage reconciler, which runs
   * within a given cwd's project.
   */
  listSessions(): Promise<Session[]> {
    return this.get('/session')
  }

  /** POST /session */
  createSession(req?: CreateSessionRequest): Promise<Session> {
    return this.post('/session', req ?? {})
  }

  /** GET /session/{id} */
  getSession(sessionId: string): Promise<Session> {
    return this.get(`/session/${encodeURIComponent(sessionId)}`)
  }

  /**
   * GET /session/{id}/message — list all messages for a session.
   * Returns `Array<StoredMessage>` where each item has:
   *   `info`  — message metadata (role, id, cost, tokens, providerID, modelID, time, …)
   *   `parts` — ordered content parts (text, reasoning, tool, step-start, …)
   *
   * The usage reconciler (sole prior caller) only reads `info`, so widening the
   * return type to expose `parts` is backward-compatible.
   */
  listMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.get(`/session/${encodeURIComponent(sessionId)}/message`)
  }

  /** DELETE /session/{id} */
  deleteSession(sessionId: string): Promise<boolean> {
    return this.del(`/session/${encodeURIComponent(sessionId)}`)
  }

  /** POST /session/{id}/abort */
  abortSession(sessionId: string): Promise<boolean> {
    return this.post(`/session/${encodeURIComponent(sessionId)}/abort`)
  }

  /**
   * POST /session/{id}/fork
   * Intentionally unwired for now — no production caller. opencode fork is not
   * exposed (see OPENCODE_ENGINE_CAPABILITIES.fork = false, engine-hardening-plan.md
   * Item 1 / ADR-030). Kept for a future native-fork implementation.
   */
  forkSession(sessionId: string, req?: ForkRequest): Promise<Session> {
    return this.post(`/session/${encodeURIComponent(sessionId)}/fork`, req ?? {})
  }

  /**
   * POST /session/{id}/message — send a prompt and get back the assistant message.
   * Note: 5b will drive this; typed as unknown for now since AssistantMessage shape
   * is complex and will be fully typed in 5b.
   */
  prompt(sessionId: string, req: PromptRequest, opts?: OpencodeRequestOptions): Promise<unknown> {
    return this.post(`/session/${encodeURIComponent(sessionId)}/message`, req, {
      timeoutMs: PROMPT_TIMEOUT_MS,
      ...opts
    })
  }

  /**
   * POST /session/{id}/prompt_async — fire-and-forget prompt; response comes via /event.
   * Returns void on 200 (server accepts the prompt without waiting for completion).
   */
  promptAsync(sessionId: string, req: PromptRequest): Promise<unknown> {
    return this.post(`/session/${encodeURIComponent(sessionId)}/prompt_async`, req)
  }

  /** PATCH /session/{id} — update per-session settings (permission ruleset, title, agent) */
  /**
   * PATCH /session/{id}.
   *
   * `permissionHermetic` is a ClaudeUI fork field (ADR-037 P2): it seals the
   * session so opencode evaluates it against this ruleset ALONE, ignoring the
   * instance-global "always" approvals that would otherwise outrank a deny-all.
   * Safe to send unconditionally — the stock payload schema ignores unknown
   * keys (verified against the unpatched 1.18.9 release build), so an
   * unpatched server simply drops it. See patch/opencode-fork/README.md.
   */
  patchSession(
    sessionId: string,
    patch: {
      permission?: Array<{ permission: string; pattern: string; action: string }>
      permissionHermetic?: boolean
      title?: string
      agent?: string
    }
  ): Promise<unknown> {
    return this.patch(`/session/${encodeURIComponent(sessionId)}`, patch)
  }

  /**
   * POST /permission/{id}/reply — reply to a permission.asked event.
   * On 'reject', an optional `message` becomes model-visible feedback: opencode
   * fails the tool call with a CorrectedError (non-fatal — the loop continues
   * and the model can adjust) instead of a bare RejectedError.
   */
  replyPermission(
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    message?: string
  ): Promise<unknown> {
    return this.post(`/permission/${encodeURIComponent(requestId)}/reply`, {
      reply,
      ...(message ? { message } : {})
    })
  }

  /** POST /question/{id}/reply — submit answers to a question.asked event */
  replyQuestion(requestId: string, answers: string[][]): Promise<unknown> {
    return this.post(`/question/${encodeURIComponent(requestId)}/reply`, { answers })
  }

  /** POST /question/{id}/reject — dismiss a question.asked event */
  rejectQuestion(requestId: string): Promise<unknown> {
    return this.post(`/question/${encodeURIComponent(requestId)}/reject`)
  }

  // ── Commands + Skills ─────────────────────────────────────────────────────

  /** GET /command — list all available commands (built-in, config, MCP, slash-skills). */
  listCommands(): Promise<Command[]> {
    return this.get('/command')
  }

  /**
   * POST /session/{id}/command — invoke a named command.
   * Runs a full turn server-side (template expansion, inline cmd, @file mentions).
   * Output also streams via GET /event as normal message.updated / message.part.updated;
   * completion is marked by session.idle (not the command.executed informational event).
   */
  runCommand(
    sessionId: string,
    body: RunCommandRequest,
    opts?: OpencodeRequestOptions
  ): Promise<unknown> {
    return this.post(`/session/${encodeURIComponent(sessionId)}/command`, body, {
      timeoutMs: PROMPT_TIMEOUT_MS,
      ...opts
    })
  }

  /** GET /skill — list all discovered skills (project, user, built-in). */
  listSkills(): Promise<Skill[]> {
    return this.get('/skill')
  }

  // ── SSE Event Stream ──────────────────────────────────────────────────────

  /**
   * Subscribe to the SSE event stream at GET /event.
   * Returns an AsyncGenerator yielding parsed OpencodeEvent objects.
   * Handles chunked `data:` frames robustly.
   * The caller is responsible for cancellation via the AbortSignal.
   */
  async *subscribeEvents(signal?: AbortSignal): AsyncGenerator<OpencodeEvent> {
    const res = await fetch(`${this.baseUrl}/event`, {
      headers: {
        Authorization: this.authHeader,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache'
      },
      signal
    })

    if (!res.ok) {
      throw new Error(`opencode GET /event → ${res.status}`)
    }
    if (!res.body) {
      throw new Error('opencode GET /event: no response body')
    }

    yield* parseSSEStream(res.body, signal)
  }
}

// ── SSE line parser ───────────────────────────────────────────────────────────

/**
 * Parse an SSE stream from a ReadableStream<Uint8Array>.
 * Handles chunked delivery: accumulates a line buffer, emits events when
 * a double-newline boundary is encountered.
 *
 * SSE format per spec:
 *   data: <json>\n\n
 * We only care about `data:` fields; `id:`, `event:`, `retry:` are ignored.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<OpencodeEvent> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buf = ''

  // Wire the signal to reader.cancel() so an idle stream aborts promptly: a
  // pending reader.read() on a silent /event channel won't otherwise unblock
  // until the next chunk arrives. cancel() resolves the in-flight read with
  // { done: true }, which we treat as end-of-stream below.
  let onAbort: (() => void) | undefined
  if (signal) {
    if (signal.aborted) {
      // Already aborted before we started — bail without reading.
      reader.releaseLock()
      return
    }
    onAbort = () => {
      // Best-effort: cancel rejects if the stream is already closed/locked.
      reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    while (true) {
      if (signal?.aborted) break

      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch {
        // reader.cancel() (from abort) or a transport error rejects the read.
        break
      }
      if (result.done) break

      buf += decoder.decode(result.value, { stream: true })

      // Split on double-newline (SSE event boundary)
      const events = buf.split(/\n\n/)
      // Keep the last (possibly incomplete) chunk
      buf = events.pop() ?? ''

      for (const block of events) {
        const event = parseSSEBlock(block)
        if (event) yield event
      }
    }

    // Flush any trailing data (skip if aborted — caller no longer wants events).
    if (!signal?.aborted && buf.trim()) {
      const event = parseSSEBlock(buf)
      if (event) yield event
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

function parseSSEBlock(block: string): OpencodeEvent | null {
  let dataLine: string | null = null

  for (const line of block.split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed.startsWith('data:')) {
      dataLine = trimmed.slice(5).trimStart()
    }
    // Skip id:, event:, retry:, comment lines
  }

  if (!dataLine) return null

  try {
    const parsed = JSON.parse(dataLine)
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
      return parsed as OpencodeEvent
    }
    return null
  } catch {
    return null
  }
}
