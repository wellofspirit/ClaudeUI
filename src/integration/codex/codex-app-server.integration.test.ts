import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import {
  copyFileSync,
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
import { loadCodexHistory } from '../../core/codex/history'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'

// Wrap only test spawns. Production exposes neither a command override nor a PATH fallback.
const containment = vi.hoisted(() => ({ profile: '', pids: [] as number[] }))
const coreEvents = vi.hoisted(() => vi.fn())
vi.mock('../../core/services/sync-host', () => ({ emitEvent: coreEvents }))
const persistence = vi.hoisted(() => ({ close: () => {} }))
vi.mock('../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/db')>()
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  actual.runMigrations(db)
  persistence.close = () => db.close()
  return {
    dispatchedCostsByRouting: () => [],
    setSessionMeta: vi.fn(),
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

async function setupFixture(plainResponse = false, nativeSession = false, nativeCommand = false) {
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
          requests.push(JSON.parse(data.toString()))
          for (const event of [
            { type: 'response.created', response: { id: 'resp-fixture' } },
            {
              type: 'response.output_item.done',
              item:
                nativeCommand &&
                requests.at(-1)?.generate !== false &&
                requests.filter((request) => request.generate !== false).length === 1
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
approvals_reviewer = "user"
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
  'resolves a native command approval and acknowledges native policy settings',
  async () => {
    const { cwd, env, errors } = await setupFixture(true, true, true)
    session = new CodexSession('isolated-approval', null, cwd, {}, { env, requestTimeoutMs: 15000 })
    await session.run(null)
    await session.setCodexSettings({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'user'
    })
    await vi.waitFor(() =>
      expect(
        coreEvents.mock.calls.some(
          ([channel, args]) =>
            channel === 'session:status' &&
            args[1].codex?.approvalPolicy === 'never' &&
            args[1].codex?.sandbox?.type === 'dangerFullAccess'
        )
      ).toBe(true)
    )
    await session.setCodexSettings({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      approvalsReviewer: 'user'
    })
    await vi.waitFor(() =>
      expect(
        coreEvents.mock.calls.some(
          ([channel, args]) =>
            channel === 'session:status' && args[1].codex?.approvalPolicy === 'untrusted'
        )
      ).toBe(true)
    )
    await session.setCodexSettings({ approvalPolicy: 'on-request', approvalsReviewer: 'user' })
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
    expect(card.codex.decisions).toContain('accept')
    session.resolveCodexApproval(card.requestId, 'accept')
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
    await session.setCodexSettings({ approvalPolicy: 'untrusted', approvalsReviewer: 'user' })
    session.dispose()
    session = new CodexSession(
      'isolated-resume',
      null,
      cwd,
      { resumeSessionId: nativeId },
      { env, requestTimeoutMs: 15000 }
    )
    await session.run(null)
    expect(session.getSessionId()).toBe(nativeId)
    const resumedStatus = coreEvents.mock.calls
      .filter(([channel, args]) => channel === 'session:status' && args[0] === 'isolated-resume')
      .at(-1)![1][1]
    expect(resumedStatus.codex.approvalPolicy).toBe('untrusted')
    await session.setCodexSettings({ reset: true })
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
      expect(requestSpy.mock.calls[resumeIndex][1]).toEqual({
        threadId: nativeId,
        cwd,
        model: resumedStatus.model.modelId
      })
      const nativeResponse = (await requestSpy.mock.results[resumeIndex]
        .value) as import('../../core/codex/protocol/v2/ThreadResumeResponse').ThreadResumeResponse
      expect(inheritedStatus.codex.approvalPolicy).toEqual(nativeResponse.approvalPolicy)
      expect(inheritedStatus.codex.overrides).toEqual({ model: resumedStatus.model.modelId })
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
