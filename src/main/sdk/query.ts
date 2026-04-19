/**
 * Main `query()` — spawns cli.js, wires up the stream-json protocol, and
 * returns an async-iterable with queryHandle methods attached.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type {
  CanUseTool,
  CanUseToolResult,
  HookCallback,
  PermissionMode,
  QueryHandle,
  QueryInput,
  QueryOptions,
  SDKMessage,
  McpServerConfig,
} from './types'
import { locateCliJs } from './locate'
import { buildArgs, buildEnv, splitMcpServers } from './args'
import { NdjsonReader, NdjsonWriter } from './protocol'
import { ControlChannel } from './control'
import { McpHost } from './mcp-host'
import { WireLog } from './wire-log'

interface MessageQueueItem {
  value: SDKMessage | undefined
  done: boolean
  error?: Error
}

/**
 * Buffered message channel — push from the protocol reader, pull from the
 * caller's `for await` loop.
 */
class MessageQueue {
  private items: MessageQueueItem[] = []
  private waiter: ((item: MessageQueueItem) => void) | null = null
  private finished = false

  push(msg: SDKMessage): void {
    if (this.finished) return
    this.dispatch({ value: msg, done: false })
  }

  finish(error?: Error): void {
    if (this.finished) return
    this.finished = true
    this.dispatch({ value: undefined, done: true, error })
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    return new Promise((resolve, reject) => {
      const hand = (item: MessageQueueItem): void => {
        if (item.error) return reject(item.error)
        if (item.done) return resolve({ value: undefined, done: true })
        resolve({ value: item.value as SDKMessage, done: false })
      }
      if (this.items.length) {
        hand(this.items.shift()!)
      } else {
        this.waiter = hand
      }
    })
  }

  private dispatch(item: MessageQueueItem): void {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w(item)
    } else {
      this.items.push(item)
    }
  }
}

export function query(input: QueryInput): QueryHandle {
  const options: QueryOptions = input.options ?? {}
  const cliPath = options.pathToClaudeCodeExecutable ?? locateCliJs()
  const executable = options.executable ?? process.execPath
  const executableArgs = options.executableArgs ?? []

  const args = [...executableArgs, cliPath, ...buildArgs(options)]
  // Merge options.env on top of process.env for the cli.js child ONLY.
  // Callers (e.g. getSdkExecutableOpts) use this to pass ELECTRON_RUN_AS_NODE
  // without mutating the main-process env — otherwise Electron's GPU /
  // renderer children would inherit it and fail to start.
  const env = buildEnv({ ...process.env, ...(options.env ?? {}) })

  const { sdkServers } = splitMcpServers(options.mcpServers)
  const mcpHost = new McpHost(sdkServers)

  // Custom spawn hook override — SDK parity. Lets embedders swap the default
  // child_process.spawn (e.g. for containerized launches).
  const child: ChildProcess = options.spawnClaudeCodeProcess
    ? options.spawnClaudeCodeProcess({
        command: executable,
        args,
        cwd: options.cwd,
        env,
        signal: options.abortController?.signal,
      })
    : spawn(executable, args, {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error('Failed to attach stdio to cli.js subprocess')
  }

  const wireLog = new WireLog({ capacity: options.wireLogCapacity ?? 1000 })
  // Tap the writer so every outbound line is captured before it crosses
  // the pipe. Cheap — one record per control_request / user message.
  const rawWriter = new NdjsonWriter(child.stdin)
  const origWrite = rawWriter.write.bind(rawWriter)
  rawWriter.write = (obj): void => {
    wireLog.record('out', obj)
    origWrite(obj)
  }
  const writer = rawWriter
  const queue = new MessageQueue()

  // Optional startup-timing logs — toggle with DEBUG_SDK=1. Prints to stderr.
  const t0 = Date.now()
  const stamp = (label: string): void => {
    if (process.env.DEBUG_SDK) {
      // eslint-disable-next-line no-console
      console.error(`[sdk] +${Date.now() - t0}ms ${label}`)
    }
  }
  stamp('spawn')

  // stderr pass-through (for logger/debug)
  child.stderr.on('data', (chunk: Buffer) => {
    options.stderr?.(chunk)
  })

  // ---- Control channel with pending-permission re-dispatch hook --------
  // When cli.js rejects a control_request and rides along
  // pending_permission_requests (can_use_tool prompts that were waiting
  // for the change), each bundled request is fed back through
  // handleControlRequest so the user's canUseTool callback still fires.
  // Otherwise those prompts are silently dropped and the tool calls hang.
  const control = new ControlChannel(writer, {
    onPendingPermissionRequests: (requests) => {
      for (const req of requests) {
        void handleControlRequest(req, {
          control,
          mcpHost,
          queue,
          options,
          hookCallbacks,
        })
      }
    },
  })

  // ---- Hook callback registry ------------------------------------------
  // Transform user-provided hooks config into { matcher, hookCallbackIds }
  // and keep a map callbackId → callback so we can dispatch when cli.js
  // fires a hook_callback control_request.
  const hookCallbacks = new Map<string, HookCallback>()
  let nextHookId = 0
  let initHooks:
    | Record<
        string,
        Array<{ matcher?: string; hookCallbackIds: string[]; timeout?: number }>
      >
    | undefined
  if (options.hooks) {
    initHooks = {}
    for (const [event, matchers] of Object.entries(options.hooks)) {
      if (!matchers.length) continue
      initHooks[event] = matchers.map((m) => {
        const ids: string[] = []
        for (const cb of m.hooks) {
          const id = `hook_${nextHookId++}`
          hookCallbacks.set(id, cb)
          ids.push(id)
        }
        return { matcher: m.matcher, hookCallbackIds: ids, timeout: m.timeout }
      })
    }
  }

  // Track first-byte / first-event timestamps for startup diagnostics.
  let sawFirstByte = false
  let sawFirstAssistant = false
  child.stdout.on('data', () => {
    if (!sawFirstByte) {
      sawFirstByte = true
      stamp('first cli.js stdout byte')
    }
  })

  // Main protocol loop
  const reader = new NdjsonReader(
    child.stdout,
    (line) => {
      wireLog.record('in', line)
      const t = line.type
      if (t === 'system' && (line as { subtype?: string }).subtype === 'init') {
        stamp('init system event')
      } else if (!sawFirstAssistant && t === 'assistant') {
        sawFirstAssistant = true
        stamp('first assistant message')
      }
      handleInbound(line, { control, mcpHost, queue, options, hookCallbacks })
    },
    (err) => {
      queue.finish(new Error(`Failed to parse CLI stream-json: ${err.message}`))
    },
  )
  void reader // reader self-attaches; reference kept to silence unused warning

  // Initialize: tell CLI about our in-process MCP servers + systemPrompt +
  // other runtime-only options. Must happen AFTER the stream reader is wired
  // so we see the response.
  //
  // The response payload is the authoritative source for `models`,
  // `commands`, `agents` — cli.js does NOT expose these via dedicated
  // control_request subtypes. We cache the promise and hand it to the
  // queryHandle methods `supportedModels/Commands/Agents`.
  const initPayload: Record<string, unknown> = { subtype: 'initialize' }
  // cli.js expects sdkMcpServers as an ARRAY OF NAMES (strings), not
  // descriptor objects. Source: sdk.mjs builds the payload as
  //   sdkMcpServers: Array.from(this.sdkMcpTransports.keys())
  if (mcpHost.names().length) initPayload.sdkMcpServers = mcpHost.names()
  if (initHooks) initPayload.hooks = initHooks
  if (options.jsonSchema !== undefined) initPayload.jsonSchema = options.jsonSchema
  if (options.appendSubagentSystemPrompt !== undefined) {
    initPayload.appendSubagentSystemPrompt = options.appendSubagentSystemPrompt
  }
  if (options.excludeDynamicSections !== undefined) {
    initPayload.excludeDynamicSections = options.excludeDynamicSections
  }
  if (options.agents !== undefined) initPayload.agents = options.agents
  if (options.promptSuggestions !== undefined) {
    initPayload.promptSuggestions = options.promptSuggestions
  }
  if (options.agentProgressSummaries !== undefined) {
    initPayload.agentProgressSummaries = options.agentProgressSummaries
  }
  if (options.enableAuthStatus) {
    // cli.js's initialize handler checks `O.enableAuthStatus` and, when
    // truthy, starts emitting `{type:'auth_status', ...}` lines on auth
    // state changes. Off by default — existing consumers don't expect
    // the extra stream type.
    initPayload.enableAuthStatus = true
  }

  const sp = options.systemPrompt
  if (typeof sp === 'string') {
    // SDK wraps bare strings into a single-element array in the init payload.
    initPayload.systemPrompt = [sp]
  } else if (Array.isArray(sp)) {
    initPayload.systemPrompt = sp
  } else if (sp && typeof sp === 'object' && sp.type === 'preset') {
    // preset:'claude_code' + optional `append` — CLI uses its preset by default,
    // we only need to forward the append string.
    if (sp.append) initPayload.appendSystemPrompt = sp.append
  }
  // Initialize can stall indefinitely on pathological cli.js states; bound
  // it with a generous timeout so consumers don't hang forever on spawn.
  const initPromise: Promise<Record<string, unknown>> = control
    .request(initPayload, { timeoutMs: 60_000 })
    .then((r) => {
      stamp('initialize response')
      return (r ?? {}) as Record<string, unknown>
    })
    .catch((err: Error) => {
      // Swallowing the error entirely used to mask real problems (bad init
      // payload, upstream version mismatch) as empty supportedModels/etc.
      // Log it so the failure is at least visible during debugging.
      // eslint-disable-next-line no-console
      console.error(`[sdk] initialize failed: ${err?.message ?? err}`)
      options.stderr?.(Buffer.from(`[sdk] initialize failed: ${err?.message ?? err}\n`))
      return {}
    })

  // Flag set once the child is no longer accepting input — used to suppress
  // the inevitable EPIPE / "write after end" that occurs when the streaming
  // input iterator races child teardown. Those aren't user-facing failures.
  let childClosed = false

  // Forward initial prompt(s) — do NOT await initPromise. cli.js queues
  // incoming messages and processes them in order after initialize completes,
  // so blocking on the response just adds user-visible latency to the first
  // turn.
  void (async () => {
    try {
      if (typeof input.prompt === 'string') {
        writer.write({
          type: 'user',
          message: { role: 'user', content: input.prompt },
        })
        stamp('first user message sent (string)')
      } else {
        for await (const msg of input.prompt) {
          if (childClosed) break
          writer.write(msg as Record<string, unknown>)
        }
      }
    } catch (err) {
      // Child teardown races the iterator — a write to a closed stdin is
      // expected and not a session failure. Everything else still surfaces.
      if (!childClosed) queue.finish(err as Error)
    }
  })()

  // Abort propagation. `{once:true}` + explicit removal on child exit so the
  // listener doesn't outlive the query — important for callers that reuse
  // the same AbortController across multiple query() calls.
  const onAbort = (): void => {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  if (options.abortController) {
    options.abortController.signal.addEventListener('abort', onAbort, { once: true })
  }

  child.on('exit', (code, signal) => {
    childClosed = true
    options.abortController?.signal.removeEventListener('abort', onAbort)
    control.rejectAll('cli.js exited')
    writer.end()
    if (code === 0 || signal === 'SIGTERM') {
      queue.finish()
    } else {
      queue.finish(new Error(`cli.js exited with code=${code} signal=${signal}`))
    }
  })

  child.on('error', (err) => {
    childClosed = true
    options.abortController?.signal.removeEventListener('abort', onAbort)
    control.rejectAll(err.message)
    queue.finish(err)
  })

  return makeHandle(queue, control, child, options, initPromise, wireLog)
}

interface InboundCtx {
  control: ControlChannel
  mcpHost: McpHost
  queue: MessageQueue
  options: QueryOptions
  hookCallbacks: Map<string, HookCallback>
}

async function handleInbound(line: Record<string, unknown>, ctx: InboundCtx): Promise<void> {
  const type = line.type
  if (type === 'control_response') {
    ctx.control.handleResponse(line)
    return
  }
  if (type === 'control_request') {
    void handleControlRequest(line, ctx)
    return
  }
  if (type === 'control_cancel_request') {
    // cli.js cancelled an inbound request it previously sent us. Fire the
    // AbortController for that request_id so our callback (canUseTool,
    // hook, elicitation, oauth) can observe .signal.aborted and bail.
    const rid = line.request_id as string | undefined
    if (rid) ctx.control.cancelInbound(rid)
    return
  }
  // Everything else flows up to the consumer.
  ctx.queue.push(line as SDKMessage)
}

async function handleControlRequest(line: Record<string, unknown>, ctx: InboundCtx): Promise<void> {
  const request_id = line.request_id as string
  const request = (line.request ?? {}) as { subtype?: string; [k: string]: unknown }
  const subtype = request.subtype

  // Register a per-request AbortController. cli.js can cancel this handler
  // by sending a control_cancel_request with the same request_id. Its
  // .signal is threaded into every callback context so user code can
  // short-circuit when the prompt is no longer relevant.
  const ac = ctx.control.beginInbound(request_id)
  try {
    if (subtype === 'can_use_tool') {
      const result = await handleCanUseTool(request, ctx.options.canUseTool, ac.signal)
      ctx.control.respondSuccess(request_id, result)
      return
    }
    if (subtype === 'mcp_message') {
      const serverName = request.server_name as string
      const message = request.message as Parameters<
        McpHost['dispatch']
      >[1]
      const innerMsg = message as { method?: string; id?: string | number | null }
      const isRequest =
        innerMsg && 'method' in innerMsg && 'id' in innerMsg && innerMsg.id != null
      const result = await ctx.mcpHost.dispatch(serverName, message)
      // cli.js expects the response wrapped as `{ mcp_response: <jsonrpc> }`.
      // For notifications (no id) the SDK synthesizes a dummy RPC result so
      // cli.js sees a well-formed reply.
      const mcp_response =
        isRequest && result
          ? result
          : { jsonrpc: '2.0' as const, result: {}, id: 0 }
      ctx.control.respondSuccess(request_id, { mcp_response })
      return
    }

    if (subtype === 'hook_callback') {
      // cli.js fires this when a matcher-registered hook triggers.
      const callback_id = request.callback_id as string
      const cb = ctx.hookCallbacks.get(callback_id)
      if (!cb) {
        ctx.control.respondError(request_id, `No hook callback for id: ${callback_id}`)
        return
      }
      const result = await cb(
        (request.input as Record<string, unknown>) ?? {},
        request.tool_use_id as string | undefined,
        { signal: ac.signal },
      )
      ctx.control.respondSuccess(request_id, (result as Record<string, unknown>) ?? {})
      return
    }

    if (subtype === 'elicitation') {
      // MCP server is asking the user for input.
      if (!ctx.options.onElicitation) {
        ctx.control.respondSuccess(request_id, { action: 'decline' })
        return
      }
      const result = await ctx.options.onElicitation(
        {
          serverName: request.mcp_server_name as string,
          message: request.message,
          mode: request.mode as string | undefined,
          url: request.url as string | undefined,
          elicitationId: request.elicitation_id as string | undefined,
          requestedSchema: request.requested_schema,
          title: request.title as string | undefined,
          displayName: request.display_name as string | undefined,
          description: request.description as string | undefined,
        },
        { signal: ac.signal },
      )
      ctx.control.respondSuccess(request_id, (result as Record<string, unknown>) ?? {})
      return
    }

    if (subtype === 'oauth_token_refresh') {
      if (!ctx.options.getOAuthToken) {
        ctx.control.respondError(request_id, 'getOAuthToken callback is not provided.')
        return
      }
      const token = await ctx.options.getOAuthToken({ signal: ac.signal })
      ctx.control.respondSuccess(request_id, { accessToken: token ?? null })
      return
    }

    if (subtype === 'request_user_dialog') {
      // Generic user-dialog prompt. cli.js's default on no response is a
      // multi-second hang; always reply promptly. When the consumer hasn't
      // wired a handler we auto-cancel so the feature at the other end
      // (e.g. tool-use disambiguation) unblocks immediately.
      if (!ctx.options.onUserDialog) {
        ctx.control.respondSuccess(request_id, { behavior: 'cancelled' })
        return
      }
      const result = await ctx.options.onUserDialog(
        {
          dialogKind: request.dialog_kind as string | undefined,
          payload: request.payload,
          toolUseId: request.tool_use_id as string | undefined,
        },
        { signal: ac.signal },
      )
      ctx.control.respondSuccess(request_id, (result as Record<string, unknown>) ?? {})
      return
    }

    // Unknown subtype — benign success so cli.js doesn't stall. Gated log
    // so we catch new subtypes that appear upstream without grepping diffs.
    if (process.env.DEBUG_SDK) {
      // eslint-disable-next-line no-console
      console.error(
        `[sdk] unknown inbound control subtype: ${subtype} (request_id=${request_id})`,
      )
    }
    ctx.control.respondSuccess(request_id, {})
  } catch (err) {
    ctx.control.respondError(request_id, (err as Error)?.message ?? 'handler failed')
  } finally {
    ctx.control.endInbound(request_id)
  }
}

async function handleCanUseTool(
  request: Record<string, unknown>,
  callback: CanUseTool | undefined,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!callback) {
    return { permitted: true, toolUseID: request.tool_use_id as string }
  }
  const toolName = (request.tool_name as string) ?? ''
  const input = (request.input as Record<string, unknown>) ?? {}
  const context = {
    // cli.js-scoped abort: fires if cli.js sends control_cancel_request for
    // this request_id, or if the query is torn down. Callers can observe
    // signal.aborted to dismiss UI prompts that are no longer wanted.
    signal,
    suggestions: request.permission_suggestions as CanUseToolResult['updatedPermissions'],
    blockedPath: request.blocked_path as string | undefined,
    decisionReason: request.decision_reason as string | undefined,
    title: request.title as string | undefined,
    displayName: request.display_name as string | undefined,
    description: request.description as string | undefined,
    toolUseId: request.tool_use_id as string | undefined,
    agentId: request.agent_id as string | undefined,
  }
  const result: CanUseToolResult = await callback(toolName, input, context)
  if (result.behavior === 'allow') {
    return {
      permitted: true,
      updatedInput: result.updatedInput ?? input,
      updatedPermissions: result.updatedPermissions,
      toolUseID: request.tool_use_id as string,
    }
  }
  return {
    permitted: false,
    message: result.message,
    toolUseID: request.tool_use_id as string,
  }
}

function makeHandle(
  queue: MessageQueue,
  control: ControlChannel,
  child: ChildProcess,
  options: QueryOptions,
  initResponse: Promise<Record<string, unknown>>,
  wireLog: WireLog,
): QueryHandle {
  const pickInit = async <T>(field: string): Promise<T[]> => {
    const r = await initResponse
    const v = r[field]
    return Array.isArray(v) ? (v as T[]) : []
  }
  const handle: QueryHandle = {
    [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
      return {
        next: () => queue.next(),
        return: async () => {
          try {
            child.kill('SIGTERM')
          } catch {
            /* ignore */
          }
          return { value: undefined, done: true }
        },
      }
    },
    // --- Turn / session control -------------------------------------------
    interrupt: () => control.request({ subtype: 'interrupt' }),
    endSession: () =>
      // cli.js's `end_session` subtype is a cleaner shutdown than SIGTERM —
      // the main loop `break`s out gracefully after completing any final
      // flush. Host should still observe the child's exit event afterwards.
      control.request({ subtype: 'end_session' }, { timeoutMs: 5_000 }),
    setPermissionMode: (mode: PermissionMode) =>
      control.request({ subtype: 'set_permission_mode', mode }),
    setModel: (model?: string) => control.request({ subtype: 'set_model', model }),
    setMaxThinkingTokens: (max_thinking_tokens: number | null) =>
      control.request({ subtype: 'set_max_thinking_tokens', max_thinking_tokens }),
    applyFlagSettings: (settings: Record<string, unknown>) =>
      control.request({ subtype: 'apply_flag_settings', settings }),
    getSettings: () => control.request({ subtype: 'get_settings' }),
    rewindFiles: (user_message_id: string, opts?: { dryRun?: boolean }) =>
      control.request({
        subtype: 'rewind_files',
        user_message_id,
        dry_run: opts?.dryRun,
      }),
    cancelAsyncMessage: (message_uuid: string) =>
      control
        .request({ subtype: 'cancel_async_message', message_uuid })
        .then((r) => (r ?? {}) as { cancelled: boolean }),
    seedReadState: (path: string, mtime: number) =>
      control.request({ subtype: 'seed_read_state', path, mtime }),
    enableRemoteControl: (enabled: boolean, opts?: { name?: string }) =>
      control.request({ subtype: 'remote_control', enabled, name: opts?.name }),
    generateSessionTitle: (description: string, opts?: { persist?: boolean }) =>
      control.request({
        subtype: 'generate_session_title',
        description,
        persist: opts?.persist,
      }),
    askSideQuestion: (question: string) =>
      control
        .request<{ answer?: string } | null>({ subtype: 'side_question', question })
        .then((r) => r?.answer ?? null),
    launchUltrareview: (args: unknown, opts?: { confirm?: boolean }) =>
      control.request({ subtype: 'ultrareview_launch', args, confirm: opts?.confirm }),
    stopTask: (task_id: string) => control.request({ subtype: 'stop_task', task_id }),
    backgroundTask: (tool_use_id: string) =>
      control.request({ subtype: 'background_task', tool_use_id }),
    dequeueMessage: (value: string) =>
      control
        .request<{ removed?: number } | null>({ subtype: 'dequeue_message', value })
        .then((r) => ({ removed: r?.removed ?? 0 })),
    voiceServerStart: () =>
      control
        .request<{ port?: number } | null>({ subtype: 'voice_server_start' })
        .then((r) => ({ port: r?.port ?? 0 })),
    voiceServerStop: () =>
      control
        .request<{ stopped?: boolean } | null>({ subtype: 'voice_server_stop' })
        .then((r) => ({ stopped: r?.stopped ?? true })),
    getUsage: () =>
      control
        .request<Record<string, unknown> | null>({ subtype: 'get_usage' })
        .then((r) => r ?? {}),
    getContextUsage: () =>
      control
        .request<Record<string, unknown> | null>({ subtype: 'get_context_usage' })
        .then((r) => r ?? {}),

    // --- MCP servers ------------------------------------------------------
    mcpServerStatus: () =>
      control
        .request<{ mcpServers?: unknown[] } | unknown[] | null>({ subtype: 'mcp_status' })
        .then((r) => {
          if (Array.isArray(r)) return r
          const resp = (r ?? {}) as { mcpServers?: unknown[] }
          return resp.mcpServers ?? []
        }),
    toggleMcpServer: (serverName: string, enabled: boolean) =>
      control.request({ subtype: 'mcp_toggle', serverName, enabled }),
    reconnectMcpServer: (serverName: string) =>
      control.request({ subtype: 'mcp_reconnect', serverName }),
    setMcpServers: (servers: Record<string, McpServerConfig>) => {
      const { cliServers, sdkServers } = splitMcpServers(servers)
      return control.request({
        subtype: 'mcp_set_servers',
        servers: cliServers,
        sdkMcpServers: Object.keys(sdkServers),
      })
    },
    enableChannel: (serverName: string) =>
      control.request({ subtype: 'channel_enable', serverName }),
    mcpAuthenticate: (serverName: string) =>
      // Long-lived: blocks on user completing OAuth flow in a browser.
      control.request({ subtype: 'mcp_authenticate', serverName }, { timeoutMs: 0 }),
    mcpClearAuth: (serverName: string) =>
      control.request({ subtype: 'mcp_clear_auth', serverName }),
    mcpSubmitOAuthCallbackUrl: (serverName: string, callbackUrl: string) =>
      control.request({ subtype: 'mcp_oauth_callback_url', serverName, callbackUrl }),

    // --- Claude OAuth -----------------------------------------------------
    // All three are user-driven and can take minutes; never timeout.
    claudeAuthenticate: (loginWithClaudeAi: boolean) =>
      control.request(
        { subtype: 'claude_authenticate', loginWithClaudeAi },
        { timeoutMs: 0 },
      ),
    claudeOAuthCallback: (authorizationCode: string, state: string) =>
      control.request(
        { subtype: 'claude_oauth_callback', authorizationCode, state },
        { timeoutMs: 0 },
      ),
    claudeOAuthWaitForCompletion: () =>
      control.request({ subtype: 'claude_oauth_wait_for_completion' }, { timeoutMs: 0 }),

    // --- Plugins ----------------------------------------------------------
    reloadPlugins: () => control.request({ subtype: 'reload_plugins' }),

    // --- Initialization accessors (cached from initialize response) ------
    // cli.js doesn't expose these as dedicated control_request subtypes —
    // the values come bundled inside the `initialize` response.
    initializationResult: () => initResponse,
    supportedModels: () => pickInit<unknown>('models'),
    supportedCommands: () => pickInit<unknown>('commands'),
    supportedAgents: () => pickInit<unknown>('agents'),

    // --- Diagnostics ------------------------------------------------------
    /** Snapshot the per-query wire-log ring buffer (every ndjson line the
     *  harness has read from or written to cli.js). Shallow copy — callers
     *  may mutate. Intended for debug dumps on unexpected session state. */
    wireLog: () => wireLog.snapshot(),
  }
  void options
  return handle
}
