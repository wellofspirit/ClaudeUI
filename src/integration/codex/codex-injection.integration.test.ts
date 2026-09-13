import { createServer } from 'node:http'
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
import { afterEach, expect, it, vi } from 'vitest'
import { CodexClient, CodexInjectionError } from '../../core/codex/CodexClient'
import { codexAuthHook, type CodexAuthSource } from '../../core/codex/codex-auth-hook'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'

/**
 * Slice 2a guard 8 — ChatGPT token INJECTION against the pinned binary
 * (ADR-068 §1).
 *
 * Everything the unit suite can only assert about our own code is proven here
 * against the real app-server: that it accepts an externally supplied token,
 * reports the resulting account as an ordinary `chatgpt` one, asks US to refresh
 * after a 401 with the workspace id as a hint, and refuses every native login
 * while external auth is active.
 *
 * NO REAL CREDENTIAL IS INVOLVED. The vault is never read — the hook runs off a
 * fake `CodexAuthSource` — and the access token is a JWT minted in this file
 * with an unsigned third segment, which the binary accepts because
 * `parse_chatgpt_jwt_claims` only base64-decodes the payload. The provider is
 * the same scripted localhost fixture the other Codex integrations use, reached
 * through a sandbox profile that blocks every other outbound address.
 */
/**
 * macOS wraps the binary in a seatbelt profile that allows only the fixture
 * port. Windows has no equivalent, so there the child runs unwrapped and the
 * isolation is the fixture's own: a replacement environment (no real
 * `USERPROFILE`, a temp `CODEX_HOME`), a config whose only provider is the
 * localhost fixture, and every network feature off. The Windows x64 binary is
 * pinned and shipped (`scripts/codex-digests.json`), so this is the one Codex
 * integration that runs on both supported hosts.
 */
const containment = vi.hoisted(() => ({ profile: '', pids: [] as number[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: ((command, args, options) => {
      const child =
        process.platform === 'darwin'
          ? original.spawn(
              '/usr/bin/sandbox-exec',
              ['-f', containment.profile, command, ...args],
              options
            )
          : original.spawn(command, args, options)
      if (child.pid) containment.pids.push(child.pid)
      return child
    }) as typeof original.spawn
  }
})

const enabled =
  process.env.CODEX_INTEGRATION === '1' &&
  ((process.platform === 'darwin' && process.arch === 'arm64') ||
    (process.platform === 'win32' && process.arch === 'x64'))

const WORKSPACE = 'ws-fixture-0001'
const EMAIL = 'fixture-owner@example.test'
const VAULT_ACCOUNT = 'acct-fixture'

/** An UNSIGNED, obviously synthetic ChatGPT-shaped JWT. Never a real token. */
function fakeJwt(suffix: string): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url').replace(/=+$/, '')
  return [
    part({ alg: 'none', typ: 'JWT' }),
    part({
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: EMAIL,
      'https://api.openai.com/auth': {
        chatgpt_account_id: WORKSPACE,
        chatgpt_plan_type: 'pro',
        chatgpt_user_id: 'user-fixture'
      }
    }),
    `unsigned-${suffix}`
  ].join('.')
}

const clients: CodexClient[] = []
let directory: string | undefined
let server: ReturnType<typeof createServer> | undefined

afterEach(async () => {
  const survivors: number[] = []
  try {
    for (const client of clients.splice(0)) client.dispose()
    await new Promise((done) => setTimeout(done, 1200))
    // POSIX kills the process GROUP (the seatbelt wrapper plus the binary);
    // Windows has no groups here, so the pid itself is what is checked.
    const target = (pid: number): number => (process.platform === 'win32' ? pid : -pid)
    for (const pid of containment.pids.splice(0)) {
      let alive = false
      try {
        process.kill(target(pid), 0)
        alive = true
      } catch {
        /* reaped */
      }
      if (alive) {
        survivors.push(pid)
        try {
          process.kill(target(pid), 'SIGKILL')
        } catch {
          /* reaped */
        }
      }
    }
  } finally {
    try {
      if (server) {
        const closed = new Promise<void>((done) => server!.close(() => done()))
        server.closeAllConnections()
        await closed
        server = undefined
      }
    } finally {
      setHostPaths(null)
      if (directory) rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  }
  expect(survivors, 'app-server groups survived bounded disposal').toEqual([])
})

interface Fixture {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Authorization headers the provider saw, in order. */
  authorizations: string[]
  errors: string[]
  /** The binary's own ancillary calls (`chatgpt_base_url` backend, `GET /v1/models`), answered 404. */
  backend: string[]
  /**
   * How the NEXT provider call is answered. The one addition to the shared
   * fixture shape: a scripted `401` is the only way to make the app-server ask
   * the host to refresh (`external_auth.rs`).
   */
  status: { next: number[] }
}

async function setupFixture(): Promise<Fixture> {
  const installed = resolve(
    'vendor/codex-cli',
    process.platform === 'win32' ? 'codex.exe' : 'codex'
  )
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.codexBinaries[
      `${process.platform}-${process.arch}` as keyof typeof provenance.codexBinaries
    ]
  )
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-injection-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, 'vendor/codex-cli')])
    mkdirSync(name, { recursive: true })
  // Both members: the locator refuses a `codex` without its code-mode host
  // beside it (protocol-codex/README.md), whatever the model in use.
  const exe = process.platform === 'win32' ? '.exe' : ''
  copyFileSync(installed, join(directory, 'vendor/codex-cli', `codex${exe}`))
  copyFileSync(
    resolve('vendor/codex-cli', `codex-code-mode-host${exe}`),
    join(directory, 'vendor/codex-cli', `codex-code-mode-host${exe}`)
  )
  setHostPaths({ getAppPath: () => directory! })
  const authorizations: string[] = []
  const errors: string[] = []
  const backend: string[] = []
  const status = { next: [] as number[] }
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 4_000_000) req.destroy()
    })
    req.on('error', () => {})
    req.on('end', () => {
      // `chatgpt_base_url` points HERE too, so the binary's own backend calls
      // (rate limits, models) land on the fixture instead of chatgpt.com — where
      // a fake token would earn a 401 and a refresh request the test did not
      // script (seen on the unsandboxed Windows run). Recorded, answered 404,
      // never counted as errors.
      // The catalog probe (`GET /v1/models`) is the binary's, not the turn's.
      if (
        req.url?.startsWith('/backend-api/') ||
        (req.method === 'GET' && req.url?.startsWith('/v1/models'))
      ) {
        backend.push(`${req.method} ${req.url}`)
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"fixture"}')
        return
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        errors.push(`unexpected provider request: ${req.method} ${req.url}`)
        res.writeHead(400).end()
        return
      }
      authorizations.push(String(req.headers.authorization ?? ''))
      const scripted = status.next.shift()
      if (scripted && scripted !== 200) {
        res.writeHead(scripted, { 'Content-Type': 'application/json' }).end('{"error":"scripted"}')
        return
      }
      const events = [
        { type: 'response.created', response: { id: 'resp-fixture' } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'msg-fixture',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'fixture complete' }]
          }
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-fixture',
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
          }
        }
      ]
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      res.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      )
    })
  })
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
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
    `model = "mock-model"
model_provider = "fixture"
chatgpt_base_url = "http://127.0.0.1:${port}/backend-api"
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
# TRUE, unlike the other Codex fixtures: the injected token must actually be
# attached to the provider call, and a 401 must be recoverable auth rather than
# an ordinary failure, or nothing would ever ask the host to refresh.
requires_openai_auth = true
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
  return {
    cwd,
    authorizations,
    errors,
    backend,
    status,
    env:
      process.platform === 'win32'
        ? {
            // A REPLACEMENT environment, never the inherited one: the real
            // `USERPROFILE` (and so the real `~/.codex`) is not reachable.
            USERPROFILE: home,
            HOME: home,
            APPDATA: join(home, 'AppData', 'Roaming'),
            LOCALAPPDATA: join(home, 'AppData', 'Local'),
            CODEX_HOME: codexHome,
            TEMP: join(directory, 'tmp'),
            TMP: join(directory, 'tmp'),
            SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
            ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
            PATH: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`,
            USERNAME: 'fixture',
            RUST_LOG: 'off'
          }
        : {
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

/** A vault stand-in holding ONE account whose access token rotates on demand. */
function fakeSource(): { source: CodexAuthSource; token: { value: string }; refreshes: number[] } {
  const token = { value: fakeJwt('one') }
  const refreshes: number[] = []
  return {
    token,
    refreshes,
    source: {
      injectionTokenFor: async (accountId, refreshMarginMs) => {
        if (accountId !== null && accountId !== VAULT_ACCOUNT) return null
        if (refreshMarginMs === 0) refreshes.push(Date.now())
        return {
          accessToken: token.value,
          chatgptAccountId: WORKSPACE,
          chatgptPlanType: 'pro',
          vaultAccountId: VAULT_ACCOUNT
        }
      },
      getStatus: async () => ({ accounts: [{ id: VAULT_ACCOUNT, accountId: WORKSPACE }] })
    }
  }
}

type Notification = { method: string; params: Record<string, unknown> }

async function injectedRoot(
  fixture: Fixture,
  source: CodexAuthSource,
  seen: Array<Record<string, unknown>>
): Promise<{ client: CodexClient; notifications: Notification[] }> {
  const notifications: Notification[] = []
  const hook = codexAuthHook({ source })
  const client = new CodexClient({
    cwd: fixture.cwd,
    env: fixture.env,
    requestTimeoutMs: 15000,
    serverMethods: ['account/chatgptAuthTokens/refresh'],
    onServerRequest: async (method, params) => {
      seen.push({ method, ...(params as Record<string, unknown>) })
      return hook.onRefreshRequest(params)
    },
    onNotification: (method, params) =>
      notifications.push({ method, params: params as Record<string, unknown> })
  })
  clients.push(client)
  await client.start(
    {
      clientInfo: { name: 'codex_injection_probe', title: null, version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    },
    hook
  )
  expect(hook.injectedAccountId).toBe(VAULT_ACCOUNT)
  return { client, notifications }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Isolated Codex fixture deadline: ${label}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

it.skipIf(!enabled)(
  'accepts an injected ChatGPT token, reports it as a chatgpt account, and refuses native login afterwards',
  async () => {
    const fixture = await setupFixture()
    const { source } = fakeSource()
    const { client } = await injectedRoot(fixture, source, [])

    const account = await client.request('account/read', { refreshToken: false })
    expect(account.account).toMatchObject({ type: 'chatgpt', email: EMAIL })

    // The whole point of external auth: while it is active the native flows are
    // refused, so nothing can quietly replace the identity the vault chose.
    await expect(
      client.request('account/login/start', { type: 'chatgptDeviceCode' })
    ).rejects.toMatchObject({ code: 'rpc-error--32600' })
    const refusal = await client
      .request('account/login/start', {
        type: 'chatgpt',
        codexStreamlinedLogin: false,
        useHostedLoginSuccessPage: false
      })
      .then(() => '')
      .catch((error: { nativeMessage?: string }) => error.nativeMessage ?? '')
    expect(refusal).toContain('External auth is active')

    // Nothing was written to the native auth store: the token is memory-only.
    expect(() =>
      readFileSync(join(fixture.env.CODEX_HOME as string, 'auth.json'), 'utf8')
    ).toThrow()
    expect(fixture.errors).toEqual([])
  },
  120000
)

it.skipIf(!enabled)(
  'answers the native refresh request after a 401 and completes the turn',
  async () => {
    const fixture = await setupFixture()
    const { source, token, refreshes } = fakeSource()
    const seen: Array<Record<string, unknown>> = []
    const { client, notifications } = await injectedRoot(fixture, source, seen)

    const started = await client.request('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      historyMode: 'paginated'
    })
    const threadId = started.thread.id

    // One 401, then the ordinary scripted answer.
    fixture.status.next = [401, 200]
    token.value = fakeJwt('rotated')
    const turn = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'hello', text_elements: [] }]
    })
    await waitFor(
      () =>
        notifications.some(
          ({ method, params }) =>
            method === 'turn/completed' &&
            params.threadId === threadId &&
            (params.turn as { id: string })?.id === turn.turn.id
        ),
      'turn after refresh'
    )

    // The host was asked, with the WORKSPACE id as the hint — which is what maps
    // back onto a vault account — and answered from the vault, not from Codex.
    expect(seen).toEqual([
      {
        method: 'account/chatgptAuthTokens/refresh',
        reason: 'unauthorized',
        previousAccountId: WORKSPACE
      }
    ])
    expect(refreshes).toHaveLength(1)
    // The first call carried the original token, the retry the rotated one.
    expect(fixture.authorizations[0]).toContain('unsigned-one')
    expect(fixture.authorizations.at(-1)).toContain('unsigned-rotated')
    expect(fixture.errors).toEqual([])
  },
  120000
)

it.skipIf(!enabled)(
  'records whether a user-level forced_chatgpt_workspace_id gates an injected token',
  async () => {
    const fixture = await setupFixture()
    writeFileSync(
      join(fixture.env.CODEX_HOME as string, 'config.toml'),
      `${readFileSync(join(fixture.env.CODEX_HOME as string, 'config.toml'), 'utf8')}
forced_chatgpt_workspace_id = "ws-somebody-else"
`
    )
    const { source } = fakeSource()
    const hook = codexAuthHook({ source })
    const client = new CodexClient({
      cwd: fixture.cwd,
      env: fixture.env,
      requestTimeoutMs: 15000
    })
    clients.push(client)
    const failure = await client
      .start(
        {
          clientInfo: { name: 'codex_injection_probe', title: null, version: '1' },
          capabilities: { experimentalApi: true, requestAttestation: false }
        },
        hook
      )
      .then(() => null)
      .catch((error: Error) => error)
    // FINDING (0.154.0, Windows x64 and the isolated fixture, 2026-09-13): a
    // USER-level `forced_chatgpt_workspace_id` does not gate an injected token —
    // the login is accepted and `account/read` reports the injected workspace.
    // `ManagedAuthPolicy::effective_chatgpt_workspaces` (config/src/auth_policy.rs)
    // reads as though it should, so either the app-server's AuthManager is built
    // before the user layer is applied or the gate only binds under a managed
    // `allowed_chatgpt_workspaces`. The refusal PATH is still real (the unit
    // guard drives it with a scripted native error) and stays wired; this test
    // pins the observed behaviour so a binary that starts enforcing it shows up
    // as a finding, not as a silent identity swap.
    if (failure) {
      expect(failure).toBeInstanceOf(CodexInjectionError)
      expect(failure.message).toContain('ws-somebody-else')
    } else {
      const account = await client.request('account/read', { refreshToken: false })
      expect(account.account).toMatchObject({ type: 'chatgpt', email: EMAIL })
    }
  },
  120000
)
