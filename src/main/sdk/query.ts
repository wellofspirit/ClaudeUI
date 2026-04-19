/**
 * Main `query()` — spawns cli.js, wires up the stream-json protocol, and
 * returns an async-iterable with queryHandle methods attached.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type {
  CanUseTool,
  CanUseToolResult,
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

  const child: ChildProcess = spawn(executable, args, {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error('Failed to attach stdio to cli.js subprocess')
  }

  const writer = new NdjsonWriter(child.stdin)
  const control = new ControlChannel(writer)
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
      const t = line.type
      if (t === 'system' && (line as { subtype?: string }).subtype === 'init') {
        stamp('init system event')
      } else if (!sawFirstAssistant && t === 'assistant') {
        sawFirstAssistant = true
        stamp('first assistant message')
      }
      handleInbound(line, { control, mcpHost, queue, options })
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
  // descriptor objects. Passing objects caused cli.js to coerce them with
  // String() → "[object Object]" and hang for ~60s waiting for an MCP
  // server by that name to respond. Source: sdk.mjs builds the payload as
  //   sdkMcpServers: Array.from(this.sdkMcpTransports.keys())
  if (mcpHost.names().length) initPayload.sdkMcpServers = mcpHost.names()
  const sp = options.systemPrompt
  if (typeof sp === 'string') {
    initPayload.systemPrompt = sp
  } else if (sp && typeof sp === 'object' && sp.type === 'preset') {
    // preset:'claude_code' + optional `append` — CLI uses its preset by default,
    // we only need to forward the append string.
    if (sp.append) initPayload.appendSystemPrompt = sp.append
  }
  const initPromise: Promise<Record<string, unknown>> = control
    .request(initPayload)
    .then((r) => {
      stamp('initialize response')
      return (r ?? {}) as Record<string, unknown>
    })
    .catch(() => ({}))

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
          writer.write(msg as Record<string, unknown>)
        }
      }
    } catch (err) {
      queue.finish(err as Error)
    }
  })()

  // Abort propagation
  if (options.abortController) {
    options.abortController.signal.addEventListener('abort', () => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    })
  }

  child.on('exit', (code, signal) => {
    control.rejectAll('cli.js exited')
    writer.end()
    if (code === 0 || signal === 'SIGTERM') {
      queue.finish()
    } else {
      queue.finish(new Error(`cli.js exited with code=${code} signal=${signal}`))
    }
  })

  child.on('error', (err) => {
    control.rejectAll(err.message)
    queue.finish(err)
  })

  // canUseTool handler: if set, wire up the inbound can_use_tool branch.
  if (options.canUseTool) {
    void options.canUseTool // captured in closure via handleInbound ctx
  }

  return makeHandle(queue, control, child, options, initPromise)
}

interface InboundCtx {
  control: ControlChannel
  mcpHost: McpHost
  queue: MessageQueue
  options: QueryOptions
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
    // We don't currently track cancellable side-requests; drop silently.
    return
  }
  // Everything else flows up to the consumer.
  ctx.queue.push(line as SDKMessage)
}

async function handleControlRequest(line: Record<string, unknown>, ctx: InboundCtx): Promise<void> {
  const request_id = line.request_id as string
  const request = (line.request ?? {}) as { subtype?: string; [k: string]: unknown }
  const subtype = request.subtype

  try {
    if (subtype === 'can_use_tool') {
      const result = await handleCanUseTool(request, ctx.options.canUseTool)
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
    // Hook events and other control requests we don't implement yet —
    // respond with a benign success so the CLI continues.
    ctx.control.respondSuccess(request_id, {})
  } catch (err) {
    ctx.control.respondError(request_id, (err as Error)?.message ?? 'handler failed')
  }
}

async function handleCanUseTool(
  request: Record<string, unknown>,
  callback: CanUseTool | undefined,
): Promise<Record<string, unknown>> {
  if (!callback) {
    return { permitted: true, toolUseID: request.tool_use_id as string }
  }
  const toolName = (request.tool_name as string) ?? ''
  const input = (request.input as Record<string, unknown>) ?? {}
  // Per-request abort signal. We don't currently track CLI-side cancellation
  // of pending permission prompts — if the CLI cancels, we'll simply drop the
  // eventual response. A never-firing signal is safe for the callback's usage
  // (it's used to clean up UI state on interrupt).
  const controller = new AbortController()
  const context = {
    signal: controller.signal,
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
      control.request({ subtype: 'side_question', question }),
    launchUltrareview: (args: unknown, opts?: { confirm?: boolean }) =>
      control.request({ subtype: 'ultrareview_launch', args, confirm: opts?.confirm }),
    stopTask: (task_id: string) => control.request({ subtype: 'stop_task', task_id }),
    backgroundTask: (tool_use_id: string) =>
      control.request({ subtype: 'background_task', tool_use_id }),
    dequeueMessage: (value: string) => control.request({ subtype: 'dequeue_message', value }),
    voiceServerStart: () => control.request({ subtype: 'voice_server_start' }),
    voiceServerStop: () => control.request({ subtype: 'voice_server_stop' }),
    getUsage: () => control.request({ subtype: 'get_usage' }),
    getContextUsage: () => control.request({ subtype: 'get_context_usage' }),

    // --- MCP servers ------------------------------------------------------
    mcpServerStatus: () =>
      control.request({ subtype: 'mcp_status' }).then((r) => {
        const resp = (r ?? {}) as { mcpServers?: unknown }
        return resp.mcpServers ?? r
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
      control.request({ subtype: 'mcp_authenticate', serverName }),
    mcpClearAuth: (serverName: string) =>
      control.request({ subtype: 'mcp_clear_auth', serverName }),
    mcpSubmitOAuthCallbackUrl: (serverName: string, callbackUrl: string) =>
      control.request({ subtype: 'mcp_oauth_callback_url', serverName, callbackUrl }),

    // --- Claude OAuth -----------------------------------------------------
    claudeAuthenticate: (loginWithClaudeAi: boolean) =>
      control.request({ subtype: 'claude_authenticate', loginWithClaudeAi }),
    claudeOAuthCallback: (authorizationCode: string, state: string) =>
      control.request({ subtype: 'claude_oauth_callback', authorizationCode, state }),
    claudeOAuthWaitForCompletion: () =>
      control.request({ subtype: 'claude_oauth_wait_for_completion' }),

    // --- Plugins ----------------------------------------------------------
    reloadPlugins: () => control.request({ subtype: 'reload_plugins' }),

    // --- Initialization accessors (cached from initialize response) ------
    // cli.js doesn't expose these as dedicated control_request subtypes —
    // the values come bundled inside the `initialize` response.
    initializationResult: () => initResponse,
    supportedModels: () => pickInit<unknown>('models'),
    supportedCommands: () => pickInit<unknown>('commands'),
    supportedAgents: () => pickInit<unknown>('agents'),
  }
  void options
  return handle
}
