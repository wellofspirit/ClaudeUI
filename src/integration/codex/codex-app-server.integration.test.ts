import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { CodexAppServerClient } from '../../core/codex/CodexAppServerClient'
import { CodexClient } from '../../core/codex/CodexClient'
import { CodexService } from '../../core/codex/CodexService'
import { CodexSession } from '../../core/codex/CodexSession'
import {
  listCodexSessions,
  loadCodexHistory,
  resolveCodexForkAnchor
} from '../../core/codex/history'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'

// Wrap only test spawns. Production exposes neither a command override nor a PATH fallback.
const containment = vi.hoisted(() => ({ profile: '', pids: [] as number[] }))
const coreEvents = vi.hoisted(() => vi.fn())
vi.mock('../../core/services/sync-host', () => ({ emitEvent: coreEvents }))
// The shared permission gate merges the USER's real ~/.claude rules. Pin them
// empty so these probes measure the mode base, not this machine's settings.
vi.mock('../../core/services/claude-settings', () => ({
  loadClaudePermissions: () => ({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  }),
  saveClaudePermissions: vi.fn()
}))
const persistence = vi.hoisted(() => ({ close: () => {} }))
/** The isolated `session_meta` table these probes read their fork ids out of. */
const sessionMeta = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/db')>()
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  actual.runMigrations(db)
  persistence.close = () => db.close()
  return {
    dispatchedCostsByRouting: () => [],
    // Real rows, not spies: the fork sweep in `listCodexSessions` IS a
    // session_meta read, so a stubbed table would make it trivially pass.
    // `setSessionMeta` and friends take no db handle, so the isolated table is
    // this map rather than the in-memory database used for the overrides.
    setSessionMeta: (id: string, meta: unknown) => void sessionMeta.set(id, meta),
    getSessionMeta: (id: string) => sessionMeta.get(id),
    allSessionMeta: () => Object.fromEntries(sessionMeta),
    getCodexSessionOverrides: (id: string) => actual.getCodexSessionOverrides(id, db),
    hasCodexSessionOverrides: (id: string) => actual.hasCodexSessionOverrides(id, db),
    ensureCodexSessionOverrides: (id: string) => actual.ensureCodexSessionOverrides(id, db),
    setCodexSessionOverrides: (
      id: string,
      settings: Parameters<typeof actual.setCodexSessionOverrides>[1]
    ) => actual.setCodexSessionOverrides(id, settings, db)
  }
})
afterAll(() => persistence.close())
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: ((command, args, options) => {
      const child = original.spawn(
        '/usr/bin/sandbox-exec',
        ['-f', containment.profile, command, ...args],
        options
      )
      if (child.pid) containment.pids.push(child.pid)
      return child
    }) as typeof original.spawn
  }
})

const enabled =
  process.env.CODEX_INTEGRATION === '1' && process.platform === 'darwin' && process.arch === 'arm64'
let client: CodexAppServerClient | undefined
let typedClient: CodexClient | undefined
let service: CodexService | undefined
let session: CodexSession | undefined
let directory: string | undefined
let server: ReturnType<typeof createServer> | undefined
let websocket: WebSocketServer | undefined
afterEach(async () => {
  coreEvents.mockClear()
  sessionMeta.clear()
  const survivors: number[] = []
  try {
    client?.dispose()
    typedClient?.dispose()
    service?.dispose()
    session?.dispose()
    for (const socket of websocket?.clients ?? []) socket.terminate()
    websocket?.close()
    websocket = undefined
    await new Promise((resolve) => setTimeout(resolve, 1200))
    for (const pid of containment.pids.splice(0)) {
      let alive = false
      try {
        process.kill(-pid, 0)
        alive = true
      } catch {
        /* reaped */
      }
      if (alive) {
        survivors.push(pid)
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* reaped */
        }
      }
    }
  } finally {
    try {
      if (server) {
        const closed = new Promise<void>((resolve) => server!.close(() => resolve()))
        server.closeAllConnections()
        await closed
      }
    } finally {
      setHostPaths(null)
      if (directory) rmSync(directory, { recursive: true, force: true })
    }
  }
  expect(survivors, 'app-server groups survived bounded disposal').toEqual([])
})

/**
 * A guardian auto-review call, told apart from the agent's own. Codex frames the
 * planned action between `>>> APPROVAL REQUEST START` / `END`
 * (`core/src/guardian/prompt.rs`), in the reviewer prompt and nowhere else, so
 * this holds whether the reviewer got the catalog policy template or the
 * bundled one.
 */
const isGuardianRequest = (request: Record<string, unknown>): boolean =>
  JSON.stringify(request).includes('>>> APPROVAL REQUEST START')

async function setupFixture(
  plainResponse = false,
  nativeSession = false,
  nativeCommand = false,
  autoReview = false,
  hostedTool = false
) {
  const installed = resolve('vendor/codex-cli/codex')
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.binarySha256
  )
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-m1a-integration-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, 'vendor/codex-cli')])
    mkdirSync(name, { recursive: true })
  const binary = join(directory, 'vendor/codex-cli/codex')
  copyFileSync(installed, binary)
  setHostPaths({ getAppPath: () => directory! })
  const requests: Record<string, unknown>[] = []
  const errors: string[] = []
  /** Final-message text the fixture answers a guardian review with. */
  const verdict = {
    current: JSON.stringify({
      risk_level: 'low',
      user_authorization: 'high',
      outcome: 'allow',
      rationale: 'Isolated fixture allow'
    })
  }
  const completed = {
    type: 'response.completed',
    response: {
      id: 'resp-fixture',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    }
  }
  server = createServer((req, res) => {
    let body = ''
    const bodyTimeout = setTimeout(() => req.destroy(), 15000)
    req.on('close', () => clearTimeout(bodyTimeout))
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 4_000_000) req.destroy()
    })
    req.on('error', () => {})
    req.on('end', () => {
      clearTimeout(bodyTimeout)
      const expectedAuth = nativeSession ? 'Bearer codex-fixture-not-a-real-key' : undefined
      if (
        req.method !== 'POST' ||
        req.url !== '/v1/responses' ||
        req.headers.authorization !== expectedAuth
      ) {
        errors.push(
          `unexpected provider request: ${req.method} ${req.url}; auth matched: ${req.headers.authorization === expectedAuth}`
        )
        res.writeHead(400).end()
        return
      }
      try {
        requests.push(JSON.parse(body))
      } catch {
        errors.push('invalid provider JSON')
        res.writeHead(400).end()
        return
      }
      const call = !plainResponse && requests.length !== 2
      const item = call
        ? {
            type: 'function_call',
            call_id: `call-${requests.length}`,
            name: 'fixture_echo',
            arguments: '{"value":"synthetic"}'
          }
        : {
            type: 'message',
            id: 'msg-fixture',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'fixture complete' }]
          }
      const events = [
        { type: 'response.created', response: { id: 'resp-fixture' } },
        { type: 'response.output_item.done', item },
        completed
      ]
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      res.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      )
    })
  })
  if (nativeSession) {
    websocket = new WebSocketServer({ noServer: true, maxPayload: 4_000_000 })
    server.on('upgrade', (req, socket, head) => {
      if (
        req.url !== '/v1/responses' ||
        req.headers.authorization !== 'Bearer codex-fixture-not-a-real-key'
      ) {
        errors.push('unexpected websocket upgrade')
        socket.destroy()
        return
      }
      websocket!.handleUpgrade(req, socket, head, (connection) => {
        connection.on('message', (data) => {
          const request = JSON.parse(data.toString()) as Record<string, unknown>
          requests.push(request)
          // The reviewer is a SECOND model session on the SAME provider, so its
          // calls interleave with the agent's; the step index must count only
          // the agent's or the scripted command never fires.
          const guardian = isGuardianRequest(request)
          const agentTurns = requests.filter(
            (entry) => !isGuardianRequest(entry) && entry.generate !== false
          ).length
          for (const event of [
            { type: 'response.created', response: { id: 'resp-fixture' } },
            {
              type: 'response.output_item.done',
              item: guardian
                ? {
                    type: 'message',
                    id: 'msg-guardian',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: verdict.current }]
                  }
                : nativeCommand && request.generate !== false && agentTurns === 1
                  ? {
                      type: 'function_call',
                      call_id: 'fixture-command',
                      name: 'exec_command',
                      arguments: JSON.stringify({
                        cmd: `printf fixture-approved > "${cwd}/approval.txt"`,
                        sandbox_permissions: 'require_escalated',
                        justification: 'Isolated fixture write inside the test directory'
                      })
                    }
                  : hostedTool && request.generate !== false && agentTurns === 1
                    ? {
                        type: 'function_call',
                        call_id: 'fixture-mermaid',
                        name: 'render_mermaid',
                        arguments: JSON.stringify({
                          source: 'graph TD; A-->B',
                          title: 'Fixture diagram'
                        })
                      }
                    : {
                        type: 'message',
                        id: 'msg-fixture',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'fixture complete' }]
                      }
            },
            completed
          ])
            connection.send(JSON.stringify(event))
        })
      })
    })
  }
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  containment.profile = join(directory, 'isolation.sb')
  writeFileSync(
    containment.profile,
    `(version 1)
(allow default)
(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/Network") (subpath "/private/var/root") (subpath "/private/etc/codex"))
(deny file-read-data (require-all (subpath "/private/var/folders") (require-not (subpath "${directory}"))))
(deny file-write*)
(allow file-write* (subpath "${directory}") (subpath "/dev"))
(deny network*)
(allow network-outbound (remote ip "localhost:${port}"))
`
  )
  writeFileSync(
    join(codexHome, 'config.toml'),
    `${nativeSession ? '' : 'model = "mock-model"'}
model_provider = "${nativeSession ? 'openai' : 'fixture'}"
${nativeSession ? `openai_base_url = "http://127.0.0.1:${port}/v1"` : ''}
approval_policy = "on-request"
approvals_reviewer = "${autoReview ? 'auto_review' : 'user'}"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"
[model_providers.fixture]
name = "Isolated localhost fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 15000
[analytics]
enabled = false
[feedback]
enabled = false
[otel]
exporter = "none"
[features]
apps = false
plugins = false
remote_plugin = false
browser_use = false
computer_use = false
shell_snapshot = false
`
  )
  if (nativeSession)
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'codex-fixture-not-a-real-key' })
    )
  return {
    cwd,
    home,
    codexHome,
    requests,
    errors,
    verdict,
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: join(directory, 'tmp'),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SHELL: '/bin/sh',
      LANG: 'en_US.UTF-8',
      USER: 'fixture',
      LOGNAME: 'fixture',
      RUST_LOG: 'off'
    }
  }
}

it.skipIf(!enabled)(
  'runs the new root session against an isolated localhost Responses provider',
  async () => {
    const { cwd, env, requests, errors } = await setupFixture(true, true)
    session = new CodexSession('isolated-root', null, cwd, {}, { env, requestTimeoutMs: 15000 })
    await session.run(null)
    expect(session.getSessionId()).toBeTruthy()
    // Pinned-native limitation, not an empty-history fallback or a completed M3
    // gate. The code is the binary's own `-32600` now that `CodexService.read()`
    // rethrows transport codes instead of collapsing them — pinned, because
    // "the native binary said no" is what this asserts, not "a read broke".
    await expect(loadCodexHistory(session.getSessionId()!, { cwd, env })).rejects.toThrow(
      'Codex transport: rpc-error--32600'
    )
    await session.run('Return the fixture response.')
    await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 20000 })
    expect(errors).toEqual([])
    expect(requests.length).toBeGreaterThan(0)
    expect(
      session
        .getMessages()
        .some((message) =>
          message.content.some(
            (block) => block.type === 'text' && block.text === 'fixture complete'
          )
        )
    ).toBe(true)
  },
  40000
)

it.skipIf(!enabled)(
  'plan mode declines the write command through the shared gate and leaves no file',
  async () => {
    const { cwd, env, errors } = await setupFixture(true, true, true)
    session = new CodexSession(
      'isolated-plan',
      null,
      cwd,
      { permissionMode: 'plan' },
      { env, requestTimeoutMs: 15000 }
    )
    await session.run(null)
    await session.run('Execute the isolated fixture command.')
    await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 20000 })
    // `untrusted` asks BEFORE running (reason: null), so nothing was executed
    // and the macOS nested-seatbelt limitation in codex-spike.md cannot
    // confound this: the gate, not the sandbox, is what stopped the write.
    expect(coreEvents.mock.calls.some(([channel]) => channel === 'session:approval-request')).toBe(
      false
    )
    expect(existsSync(join(cwd, 'approval.txt'))).toBe(false)
    expect(
      coreEvents.mock.calls.some(
        ([channel, args]) =>
          channel === 'session:error' && String(args[1]).includes('Plan mode is read-only')
      )
    ).toBe(true)
    expect(errors).toEqual([])
  },
  60000
)

it.skipIf(!enabled)(
  'default mode asks the human, runs the approved command and keeps resume/overrides intact',
  async () => {
    const { cwd, env, errors } = await setupFixture(true, true, true)
    session = new CodexSession('isolated-approval', null, cwd, {}, { env, requestTimeoutMs: 15000 })
    await session.run(null)
    await session.run('Execute the isolated fixture command.')
    await vi.waitFor(
      () =>
        expect(
          coreEvents.mock.calls.some(([channel]) => channel === 'session:approval-request') ||
            !session!.willQueue
        ).toBe(true),
      { timeout: 20000 }
    )
    expect(coreEvents.mock.calls.some(([channel]) => channel === 'session:approval-request')).toBe(
      true
    )
    const card = coreEvents.mock.calls.find(
      ([channel]) => channel === 'session:approval-request'
    )![1][1]
    // A STANDARD card: no engine-specific decision vocabulary at all.
    expect(card.codex).toBeUndefined()
    expect(card.toolName).toBe('commandExecution')
    expect(card.suggestions).toHaveLength(3)
    session.resolveApproval(card.requestId, 'allow')
    await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 20000 })
    expect(readFileSync(join(cwd, 'approval.txt'), 'utf8')).toBe('fixture-approved')
    expect(
      coreEvents.mock.calls.some(
        ([channel, args]) =>
          channel === 'session:approval-dismiss' && args[1].requestId === card.requestId
      )
    ).toBe(true)
    expect(errors).toEqual([])
    const history = await loadCodexHistory(session.getSessionId()!, { cwd, env })
    service = new CodexService({ cwd, env })
    const listing = await service.listAllThreads()
    expect(listing.some((thread) => thread.id === session!.getSessionId())).toBe(true)
    expect(history.messages.map((message) => message.id)).toEqual(
      session.getMessages().map((message) => message.id)
    )
    expect(
      history.messages
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'tool_result')
    ).toHaveLength(1)
    const nativeId = session.getSessionId()!
    const resumedModel = coreEvents.mock.calls
      .filter(([channel, args]) => channel === 'session:status' && args[0] === 'isolated-approval')
      .at(-1)![1][1].model.modelId
    session.dispose()
    session = new CodexSession(
      'isolated-resume',
      null,
      cwd,
      { resumeSessionId: nativeId, permissionMode: 'acceptEdits' },
      { env, requestTimeoutMs: 15000 }
    )
    await session.run(null)
    expect(session.getSessionId()).toBe(nativeId)
    // Persist the resumed model as an explicit override the way the app does
    // (`session:set-model` → setModel), then hand the thread to a fresh session.
    await session.setModel(resumedModel)
    session.dispose()
    const requestSpy = vi.spyOn(CodexClient.prototype, 'request')
    try {
      session = new CodexSession(
        'isolated-inherited',
        null,
        cwd,
        { resumeSessionId: nativeId },
        { env, requestTimeoutMs: 15000 }
      )
      await session.run(null)
      const inheritedStatus = coreEvents.mock.calls
        .filter(
          ([channel, args]) => channel === 'session:status' && args[0] === 'isolated-inherited'
        )
        .at(-1)![1][1]
      const resumeIndex = requestSpy.mock.calls.findIndex(([method]) => method === 'thread/resume')
      // The thread BASELINE carries the mode's policy, so a turn that somehow
      // starts without a per-turn override still runs gated.
      expect(requestSpy.mock.calls[resumeIndex][1]).toEqual({
        threadId: nativeId,
        cwd,
        model: resumedModel,
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        approvalsReviewer: 'user'
      })
      expect(inheritedStatus.codex.overrides).toEqual({ model: resumedModel })
      expect(inheritedStatus.codex).not.toHaveProperty('approvalPolicy')
    } finally {
      requestSpy.mockRestore()
    }
  },
  60000
)

it.skipIf(!enabled)(
  'uses production transport for isolated handshake, dynamic turn, interrupt and pending disposal',
  async () => {
    const { cwd, codexHome, requests, errors, env } = await setupFixture()
    const notifications: { method: string; params: unknown }[] = []
    let calls = 0
    let interruptedSignal: AbortSignal | undefined
    const disconnect = vi.fn()
    client = new CodexAppServerClient({
      cwd,
      env,
      requestTimeoutMs: 15000,
      serverMethods: ['item/tool/call'],
      onServerRequest: async (_method, _params, { signal }) => {
        calls++
        if (calls === 1)
          return {
            contentItems: [{ type: 'inputText', text: 'fixture tool output' }],
            success: true
          }
        interruptedSignal = signal
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve({ success: false, contentItems: [] }), {
            once: true
          })
        )
      },
      onNotification: (method, params) => {
        notifications.push({ method, params })
        // M2 session ownership belongs above the transport. Exercise the documented callback.
        if (method === 'turn/completed') {
          const value = params as { threadId: string; turn: { id: string } }
          client!.abortServerRequests(value.threadId, value.turn.id)
        }
      },
      onDisconnect: disconnect
    })
    const initialized = await client.start({
      clientInfo: { name: 'codex_m1a_fixture', title: null, version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    expect(initialized.codexHome).toBe(codexHome)
    const thread = await client.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      dynamicTools: [
        {
          name: 'fixture_echo',
          description: 'Synthetic fixture only',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
          }
        }
      ]
    })
    const threadId = thread.thread.id
    const turn = await client.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'synthetic fixture', text_elements: [] }]
    })
    const wait = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 15000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Isolated Codex fixture deadline exceeded')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    const terminal = (id: string, status: string): boolean =>
      notifications.some(({ method, params }) => {
        const p = params as { threadId?: string; turn?: { id: string; status: string } }
        return (
          method === 'turn/completed' &&
          p.threadId === threadId &&
          p.turn?.id === id &&
          p.turn.status === status
        )
      })
    await wait(() => terminal(turn.turn.id, 'completed'))
    expect(calls).toBe(1)
    expect(JSON.stringify(requests[1])).toContain('fixture tool output')
    const interrupted = await client.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'synthetic interrupt', text_elements: [] }]
    })
    await wait(() => calls === 2)
    await client.request('turn/interrupt', { threadId, turnId: interrupted.turn.id })
    await wait(() => terminal(interrupted.turn.id, 'interrupted'))
    expect(interruptedSignal?.aborted).toBe(true)
    expect(requests).toHaveLength(3)
    const pending = client.request('thread/read', { threadId, includeTurns: true })
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'disposed',
      ambiguousDelivery: true
    })
    client.dispose()
    await rejected
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  },
  60000
)

it.skipIf(!enabled)(
  'uses typed service for isolated account, catalog, config and persisted thread reads',
  async () => {
    const { cwd, env, requests, errors } = await setupFixture(true)
    service = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
    const [status, catalog, config, threads] = await Promise.all([
      service.accountStatus(),
      service.models().catch(() => {
        throw new Error('isolated model catalog failed')
      }),
      service.effectiveConfig().catch(() => {
        throw new Error('isolated config read failed')
      }),
      service.listThreads({}).catch(() => {
        throw new Error('isolated thread list failed')
      })
    ])
    expect(status).toEqual({
      available: true,
      authenticated: false,
      authKind: null,
      requiresLogin: false
    })
    expect(Array.isArray(catalog)).toBe(true)
    expect(catalog.every((model) => Array.isArray(model.supportedReasoningEfforts))).toBe(true)
    expect(config).toMatchObject({
      model: 'mock-model',
      model_provider: 'fixture',
      sandbox_mode: 'read-only'
    })
    expect(threads.data).toEqual([])
    let terminal = false
    typedClient = new CodexClient({
      cwd,
      env,
      requestTimeoutMs: 15000,
      onNotification: (method) => {
        if (method === 'turn/completed') terminal = true
      }
    })
    await typedClient.start({
      clientInfo: { name: 'codex_m1b_root', title: null, version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    const { thread } = await typedClient.request('thread/start', {
      cwd,
      model: 'mock-model',
      modelProvider: 'fixture'
    })
    const read = await typedClient.request('thread/read', {
      threadId: thread.id,
      includeTurns: false
    })
    expect(read.thread.id).toBe(thread.id)
    // Native empty roots are not yet cold-readable. Persist a synthetic completed turn first.
    await typedClient.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'isolated persistence fixture', text_elements: [] }]
    })
    const deadline = Date.now() + 15000
    while (!terminal) {
      if (Date.now() > deadline) throw new Error('isolated persistence deadline')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect((await service.readThread({ threadId: thread.id, includeTurns: false })).thread.id).toBe(
      thread.id
    )
    // An unknown persisted ID must fail safely; the service never resumes it as a
    // fallback. Answered with the binary's own `-32600`, which is also what it
    // answers a REFUSED delete with (see codex-lifecycle) — the two are
    // indistinguishable on the wire.
    await expect(
      service.readThread({ threadId: '00000000-0000-0000-0000-000000000000', includeTurns: false })
    ).rejects.toThrow('Codex transport: rpc-error--32600')
    expect(
      (await typedClient.request('thread/read', { threadId: thread.id, includeTurns: false }))
        .thread.id
    ).toBe(thread.id)
    expect(requests).toHaveLength(1)
    expect(errors).toEqual([])
    // Disposal fails the in-flight read with the transport's OWN reason rather
    // than one flat code, which is what tells a caller "we tore this down" apart
    // from "the native read failed". The reason is `disposed` no matter how far
    // `client.start()` had got: past the `--version` probe the pending
    // `initialize` rejects with the close code, and inside the probe
    // `checkVersion` now re-raises the already-stamped closedError instead of
    // minting its own `version-check-failed`.
    const pending = service.readThread({ threadId: thread.id, includeTurns: false })
    service.dispose()
    await expect(pending).rejects.toThrow(/^Codex transport: disposed$/)
  },
  60000
)

it.skipIf(!enabled)(
  'auto mode rows the native guardian decision no approval request ever reaches',
  async () => {
    const { cwd, env, errors, requests } = await setupFixture(true, true, true, true)
    session = new CodexSession(
      'isolated-auto-review',
      null,
      cwd,
      { permissionMode: 'auto' },
      { env, requestTimeoutMs: 15000 }
    )
    await session.run(null)
    await session.run('Execute the isolated fixture command.')
    await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 30000 })
    // The reviewer replaced the client outright: nothing to approve, no card,
    // and — before this slice — no trace at all of why the command ran.
    expect(coreEvents.mock.calls.some(([channel]) => channel === 'session:approval-request')).toBe(
      false
    )
    expect(requests.some((request) => isGuardianRequest(request))).toBe(true)
    const rows = coreEvents.mock.calls
      .filter(([channel]) => channel === 'session:message')
      .map(
        ([, args]) => args[1] as { role: string; content: Array<{ type: string; text?: string }> }
      )
      .filter((message) => message.role === 'system')
      .flatMap((message) => message.content.map((block) => block.text ?? ''))
    expect(
      rows.some(
        (text) =>
          text.startsWith('Codex auto-review approved `printf fixture-approved > ') &&
          text.includes('(risk: low). Isolated fixture allow')
      ),
      `system rows: ${JSON.stringify(rows)}`
    ).toBe(true)
    expect(errors).toEqual([])
  },
  90000
)

it.skipIf(!enabled)(
  'steers a held prompt into the RUNNING turn and carries its id into native history',
  async () => {
    const { cwd, env, errors } = await setupFixture(true, true, true)
    const sent = vi.spyOn(CodexClient.prototype, 'request')
    try {
      session = new CodexSession('isolated-steer', null, cwd, {}, { env, requestTimeoutMs: 15000 })
      await session.run(null)
      await session.run('Execute the isolated fixture command.')
      // The approval card is a REAL mid-turn pause, which is what makes this a
      // same-turn steer rather than a next-turn prompt: the item is held while
      // the turn is unambiguously alive, and the command's `item/completed` is
      // the boundary that forwards it.
      await vi.waitFor(
        () =>
          expect(
            coreEvents.mock.calls.some(([channel]) => channel === 'session:approval-request')
          ).toBe(true),
        { timeout: 30000 }
      )
      session.enqueuePrompt('Answer with the word steered.')
      const itemId = session.queuedItems[0].itemId
      const steerId = `steer-${itemId}`
      expect(sent.mock.calls.some(([method]) => method === 'turn/steer')).toBe(false)
      const card = coreEvents.mock.calls.find(
        ([channel]) => channel === 'session:approval-request'
      )![1][1]
      session.resolveApproval(card.requestId, 'allow')
      await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 30000 })

      const steer = sent.mock.calls.find(([method]) => method === 'turn/steer')
      expect(steer, 'no turn/steer reached the binary').toBeDefined()
      console.log(JSON.stringify({ probe: 'turn-steer', params: steer![1] }))
      expect(steer![1]).toEqual({
        threadId: session.getSessionId(),
        expectedTurnId: expect.any(String),
        clientUserMessageId: steerId,
        input: [{ type: 'text', text: 'Answer with the word steered.', text_elements: [] }]
      })
      // Accepted on the RUNNING turn: never re-sent as a fresh one.
      expect(
        sent.mock.calls.filter(
          ([method, params]) =>
            method === 'turn/start' &&
            (params as { clientUserMessageId?: string }).clientUserMessageId === steerId
        )
      ).toEqual([])
      expect(session.queuedItems).toEqual([])
      expect(
        coreEvents.mock.calls
          .filter(([channel]) => channel === 'session:queue-changed')
          .flatMap(([, args]) => args[1].items)
          .filter((item: { itemId: string }) => item.itemId === itemId)
          .map((item: { state: string }) => item.state)
      ).toEqual(['queued', 'consumed'])

      // The native user item carries the steer's own id, so the synthesized
      // `steer-<itemId>` row is replaced by IDENTITY rather than by text.
      const native = session
        .getMessages()
        .find((message) => message.role === 'user' && message.replacesMessageId === steerId)
      expect(native, 'no native userMessage carried the steer clientId').toBeDefined()
      console.log(
        JSON.stringify({
          probe: 'steer-clientid',
          id: native!.id,
          clientId: native!.replacesMessageId
        })
      )
      expect(native!.content).toEqual([{ type: 'text', text: 'Answer with the word steered.' }])
      const history = await loadCodexHistory(session.getSessionId()!, { cwd, env })
      expect(
        history.messages.some((message) => message.id === native!.id && message.role === 'user'),
        `cold history lacks the steered user item: ${JSON.stringify(history.messages.map((m) => m.id))}`
      ).toBe(true)
      expect(errors).toEqual([])
    } finally {
      sent.mockRestore()
    }
  },
  90000
)

/** Every string anywhere inside one provider request's `input`, flattened. */
function inputTexts(request: Record<string, unknown>): string[] {
  const walk = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(walk)
        : value && typeof value === 'object'
          ? Object.values(value).flatMap(walk)
          : []
  return walk(request.input)
}

it.skipIf(!enabled)(
  'overrides a guardian denial and lands the approval in the model context before the next turn',
  async () => {
    const { cwd, env, errors, requests, verdict } = await setupFixture(true, true, true, true)
    verdict.current = JSON.stringify({
      risk_level: 'critical',
      user_authorization: 'unknown',
      outcome: 'deny',
      rationale: 'Isolated fixture deny'
    })
    const sent = vi.spyOn(CodexClient.prototype, 'request')
    try {
      session = new CodexSession(
        'isolated-guardian-override',
        null,
        cwd,
        { permissionMode: 'auto' },
        { env, requestTimeoutMs: 15000 }
      )
      await session.run(null)
      await session.run('Execute the isolated fixture command.')
      await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 30000 })
      // The reviewer declined it, so nothing ran and nothing landed — the
      // override offers a retry, not a replay of a half-done action.
      expect(existsSync(join(cwd, 'approval.txt'))).toBe(false)
      const card = coreEvents.mock.calls
        .filter(([channel]) => channel === 'session:approval-request')
        .map(([, args]) => args[1])
        .find((approval) => approval.codex?.guardianOverride)
      expect(card, 'no guardian override was offered for the denied command').toBeDefined()
      // The card hangs off the DECLINED item's own transcript row.
      expect(
        session
          .getMessages()
          .flatMap((message) => message.content)
          .some((block) => block.type === 'tool_use' && block.toolUseId === card.toolUseId)
      ).toBe(true)
      // The ORDER is the whole reason the offer waits for the declined item to
      // complete: the binary emits the review first, and every client drops a
      // pending approval when a `tool_result` for its `toolUseId` arrives, so a
      // card raised on the review would be deleted by its own denial.
      expect(
        coreEvents.mock.calls
          .filter(
            ([channel, args]) =>
              ['session:approval-request', 'session:tool-result'].includes(channel) &&
              args[1].toolUseId === card.toolUseId
          )
          .map(([channel]) => channel)
      ).toEqual(['session:tool-result', 'session:approval-request'])

      session.resolveApproval(card.requestId, 'allow')
      await vi.waitFor(() =>
        expect(
          session!
            .getMessages()
            .some((message) =>
              message.content.some(
                (block) => block.type === 'text' && block.text.startsWith('You approved ')
              )
            )
        ).toBe(true)
      )
      // This is the shape guard: the binary answers `invalid Guardian denial
      // event` to anything it cannot deserialize into its own snake_case
      // `GuardianAssessmentEvent`, and that would surface here.
      expect(
        coreEvents.mock.calls.filter(
          ([channel, args]) =>
            channel === 'session:error' && String(args[1]).includes('auto-review override')
        )
      ).toEqual([])
      const event = sent.mock.calls.find(
        ([method]) => method === 'thread/approveGuardianDeniedAction'
      )![1]
      console.log(JSON.stringify({ probe: 'guardian-override', params: event }))

      const before = requests.length
      await session.run('Retry the approved action.')
      await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 30000 })
      // `approve_guardian_denied_action` injects `{action, outcome: "allowed"}`
      // WITHOUT starting a turn, so the proof it arrived is the next turn's
      // request body carrying the fragment.
      const injected = requests
        .slice(before)
        .filter((request) => !isGuardianRequest(request))
        .flatMap(inputTexts)
      expect(
        injected.some((text) => text.includes('"outcome": "allowed"')),
        `no approved-action fragment in the next turn: ${JSON.stringify(injected).slice(0, 4000)}`
      ).toBe(true)
      expect(errors).toEqual([])
    } finally {
      sent.mockRestore()
    }
  },
  120000
)

/**
 * Is this request OFFERING the hosted tool, as opposed to merely replaying a
 * past call of it? Both carry the name, so neither a bare string search nor a
 * name match alone would answer it.
 *
 * The pinned binary offers dynamic tools two different ways depending on the
 * model: as an ordinary `{type:'function'|'custom', name, description,
 * parameters}` entry, OR — under the code-mode models this fixture's catalog
 * hands back — as a TypeScript declaration inside the `exec` tool's own
 * description (`### \`render_mermaid\`` followed by `declare const tools: {
 * render_mermaid(args: …) }`). Both count as advertised; a `function_call`
 * item replayed from history does not.
 */
function advertisesHostedTool(value: unknown, name = 'render_mermaid'): boolean {
  if (typeof value === 'string') return value.includes(`### \`${name}\``)
  if (Array.isArray(value)) return value.some((entry) => advertisesHostedTool(entry, name))
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if ((record.type === 'function' || record.type === 'custom') && record.name === name) return true
  return Object.values(record).some((entry) => advertisesHostedTool(entry, name))
}

it.skipIf(!enabled)(
  'runs a hosted tool over the dynamic-tool channel and keeps it across a resume',
  async () => {
    const { cwd, env, errors, requests } = await setupFixture(true, true, false, false, true)
    session = new CodexSession('isolated-hosted', null, cwd, {}, { env, requestTimeoutMs: 20000 })
    await session.run(null)
    await session.run('Render the fixture diagram.')
    await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 30000 })
    expect(errors).toEqual([])
    // The tools were declared on `thread/start`, so the model saw them.
    expect(requests.filter((request) => advertisesHostedTool(request)).length).toBeGreaterThan(0)
    // One transcript row for the call, one result, and the result is the real
    // mermaid handler's output — not a stub and not an error.
    const blocks = session
      .getMessages()
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_use' || block.type === 'tool_result')
    const call = blocks.find(
      (block) => block.type === 'tool_use' && block.toolName === 'render_mermaid'
    )
    expect(call).toBeDefined()
    const result = blocks.find(
      (block) =>
        block.type === 'tool_result' &&
        block.toolUseId === (call as { toolUseId: string }).toolUseId
    )
    expect(result).toMatchObject({
      isError: false,
      toolResult: expect.stringContaining('rendered successfully')
    })
    // …and the model was handed that same text on its next request.
    expect(JSON.stringify(requests)).toContain('rendered successfully')
    // No approval card: these three are auto-allowed by the shared engine, the
    // same rung pi's hosted tools take.
    expect(coreEvents.mock.calls.some(([channel]) => channel === 'session:approval-request')).toBe(
      false
    )

    // RESUME. `thread/resume` cannot carry `dynamicTools`; the rollout's
    // SessionMeta is what restores them, so this is the only honest way to
    // answer whether a resumed thread still has the hosted tools.
    const threadId = session.getSessionId()!
    session.dispose()
    const before = requests.length
    session = new CodexSession(
      'isolated-hosted-resume',
      null,
      cwd,
      { resumeSessionId: threadId },
      { env, requestTimeoutMs: 20000 }
    )
    await session.run(null)
    expect(session.getSessionId()).toBe(threadId)
    await session.run('Say something about the diagram.')
    await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 30000 })
    const resumed = requests.slice(before).filter((request) => !isGuardianRequest(request))
    expect(resumed.length).toBeGreaterThan(0)
    expect(resumed.some((request) => advertisesHostedTool(request))).toBe(true)
    expect(errors).toEqual([])
  },
  120000
)

/** Distinct turn ids, oldest first, off a session's own `codex:` message ids. */
function turnIds(messages: Array<{ id: string }>): string[] {
  const seen: string[] = []
  for (const message of messages) {
    if (!message.id.startsWith('codex:')) continue
    const turn = (JSON.parse(message.id.slice('codex:'.length)) as string[])[1]
    if (turn && !seen.includes(turn)) seen.push(turn)
  }
  return seen
}

it.skipIf(!enabled)(
  'branches a completed turn into its own thread the sidebar can still find',
  async () => {
    const { cwd, env, errors, requests } = await setupFixture(true, true)
    session = new CodexSession(
      'isolated-fork-source',
      null,
      cwd,
      {},
      { env, requestTimeoutMs: 20000 }
    )
    await session.run(null)
    const sourceId = session.getSessionId()!
    for (const prompt of ['first turn', 'second turn']) {
      await session.run(prompt)
      await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 30000 })
    }
    const turns = turnIds(session.getMessages())
    expect(turns).toHaveLength(2)
    const firstTurnMessage = session.getMessages().find((message) => message.id.includes(turns[0]))!

    // The anchor the renderer's branch button resolves: the turn that owns the
    // clicked row, not a JSONL line uuid.
    expect(await resolveCodexForkAnchor(sourceId, firstTurnMessage.id, { cwd, env })).toEqual({
      anchorUuid: turns[0]
    })
    expect(await resolveCodexForkAnchor(sourceId, 'a-claude-uuid', { cwd, env })).toEqual({
      anchorUuid: null,
      reason: 'not-a-codex-message'
    })

    session.dispose()
    const beforeFork = requests.length
    session = new CodexSession(
      'isolated-fork',
      null,
      cwd,
      { resumeSessionId: sourceId, resumeSessionAt: turns[0], forkSession: true },
      { env, requestTimeoutMs: 20000 }
    )
    await session.run(null)
    const forkId = session.getSessionId()!
    expect(forkId).not.toBe(sourceId)

    service = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
    const forkThread = (await service.readThread({ threadId: forkId, includeTurns: false })).thread
    const forkHistory = await service.history(forkId)
    const sourceHistory = await service.history(sourceId)
    const listed = (await service.listAllThreads()).map((thread) => thread.id)
    // `listCodexSessions` gates on `codexBinaryAvailable()`, which demands the
    // code-mode host BESIDE the binary. The fixture copies only `codex` (the
    // host is 62MB and nine other probes never touch this path), so place it
    // here, for this probe alone.
    copyFileSync(
      resolve('vendor/codex-cli/codex-code-mode-host'),
      join(directory!, 'vendor/codex-cli/codex-code-mode-host')
    )
    const sidebar = (await listCodexSessions({ cwd, env })).map((entry) => entry.sessionId)
    console.log(
      JSON.stringify({
        probe: 'session-fork',
        sourceId,
        anchor: turns[0],
        fork: {
          id: forkThread.id,
          forkedFromId: forkThread.forkedFromId,
          parentThreadId: forkThread.parentThreadId,
          historyTurns: forkHistory.turns.map((turn) => turn.id)
        },
        sourceTurns: sourceHistory.turns.map((turn) => turn.id),
        listed,
        sidebar
      })
    )
    // The fork's own lineage, and the field that would make it a native SUBAGENT
    // child instead — which `CodexSession.start` refuses to adopt.
    expect(forkThread.forkedFromId).toBe(sourceId)
    expect(forkThread.parentThreadId).toBeNull()
    // Copied THROUGH the anchor turn, and the source is untouched.
    expect(forkHistory.turns).toHaveLength(1)
    expect(sourceHistory.turns).toHaveLength(2)
    expect(forkHistory.turns[0].items.length).toBeGreaterThan(0)
    // `thread/list` never returns forks, so session_meta is the only way back to
    // this branch after a restart.
    expect(listed).toContain(sourceId)
    expect(listed).not.toContain(forkId)
    expect(sidebar).toContain(sourceId)
    expect(sidebar).toContain(forkId)

    // The canonical seed `create-session.ts` runs for every branch: the SOURCE
    // read back through the anchor turn. Without the cut it would show clients
    // the source's second turn above a thread that forked before it — and the
    // codex reader used to refuse an anchor outright, which fired the
    // "native context was not replaced" banner on every fork. Taken one hop
    // below `readSessionHistory` because that router hardcodes the real home;
    // `engine-history.test.ts` pins the hop itself.
    const seeded = await loadCodexHistory(sourceId, { cwd, env }, turns[0])
    expect(turnIds(seeded.messages)).toEqual([turns[0]])
    expect(turnIds((await loadCodexHistory(sourceId, { cwd, env })).messages)).toEqual(turns)

    // `thread/fork` has no `dynamicTools` field. The hosted tools survive anyway,
    // restored from the source rollout's SessionMeta — so the branch's FIRST
    // request to the model still advertises them.
    await session.run('branch turn')
    await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 30000 })
    const branched = requests.slice(beforeFork).filter((request) => !isGuardianRequest(request))
    expect(branched.length).toBeGreaterThan(0)
    expect(advertisesHostedTool(branched[0])).toBe(true)
    expect(errors).toEqual([])
  },
  180000
)
