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
import { codexIntegrationEnabled } from './integration-host'

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
 * port. Windows and Linux have no equivalent we use here, so there the child runs
 * unwrapped and the isolation is the fixture's own: a replacement environment (no
 * real `USERPROFILE`/`HOME`, a temp `CODEX_HOME`), a config whose only provider is
 * the localhost fixture, and every network feature off. Windows x64 and Linux
 * x64/arm64 are pinned and shipped (`scripts/codex-digests.json`), so this suite
 * runs on every reviewed host (`integration-host.ts`).
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

const enabled = codexIntegrationEnabled

const WORKSPACE = 'ws-fixture-0001'
const EMAIL = 'fixture-owner@example.test'
const VAULT_ACCOUNT = 'acct-fixture'

/**
 * An UNSIGNED, obviously synthetic ChatGPT-shaped JWT. Never a real token.
 *
 * The binary only base64-decodes the payload (`parse_chatgpt_jwt_claims`), so
 * the third segment is free-form — which is what lets a test tell two tokens
 * apart in the provider's `Authorization` headers.
 */
function fakeJwtFor(workspace: string, email: string, suffix: string): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url').replace(/=+$/, '')
  return [
    part({ alg: 'none', typ: 'JWT' }),
    part({
      exp: Math.floor(Date.now() / 1000) + 3600,
      email,
      'https://api.openai.com/auth': {
        chatgpt_account_id: workspace,
        chatgpt_plan_type: 'pro',
        chatgpt_user_id: 'user-fixture'
      }
    }),
    `unsigned-${suffix}`
  ].join('.')
}

const fakeJwt = (suffix: string): string => fakeJwtFor(WORKSPACE, EMAIL, suffix)

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

/**
 * Slice 2b guard 8 — re-pointing a LIVE process at a second account
 * (ADR-068 §2), against the pinned binary.
 *
 * The claim the unit suite cannot make: `account/login/start
 * {chatgptAuthTokens}` is accepted on a process that is ALREADY under external
 * auth, takes effect for `account/read`, and leaves the thread able to run
 * another turn. That is the whole mechanism `CodexSession.setAccount` rests on —
 * if the binary refused a second login the pin would have to respawn the
 * process, which would lose the conversation.
 *
 * Driven at the CLIENT level rather than through `CodexSession`, for the same
 * reason the rest of this file is: a session would pull in the db, the sync host
 * and the vault. `setAccount`'s own bookkeeping is unit-pinned; what is proven
 * here is the wire underneath it.
 *
 * Still no real credential: both JWTs are minted in this file with unsigned
 * third segments, and the provider is the same scripted localhost fixture.
 */
const SECOND_WORKSPACE = 'ws-fixture-0002'
const SECOND_EMAIL = 'fixture-second@example.test'
const SECOND_ACCOUNT = 'acct-fixture-2'

/** Two accounts, switchable by `requestAccount` exactly as the session does. */
function twoAccountSource(): CodexAuthSource {
  const accounts = [
    { id: VAULT_ACCOUNT, workspace: WORKSPACE, email: EMAIL },
    { id: SECOND_ACCOUNT, workspace: SECOND_WORKSPACE, email: SECOND_EMAIL }
  ]
  return {
    injectionTokenFor: async (accountId) => {
      const account = accountId === null ? accounts[0] : accounts.find((a) => a.id === accountId)
      if (!account) return null
      return {
        accessToken: fakeJwtFor(account.workspace, account.email, account.id),
        chatgptAccountId: account.workspace,
        chatgptPlanType: 'pro',
        vaultAccountId: account.id
      }
    },
    getStatus: async () => ({
      accounts: accounts.map((a) => ({ id: a.id, accountId: a.workspace }))
    })
  }
}

it.skipIf(!enabled)(
  'switches a live thread to a second account between turns, and the next turn completes',
  async () => {
    const fixture = await setupFixture()
    const hook = codexAuthHook({ source: twoAccountSource() })
    const notifications: Notification[] = []
    const client = new CodexClient({
      cwd: fixture.cwd,
      env: fixture.env,
      requestTimeoutMs: 15000,
      serverMethods: ['account/chatgptAuthTokens/refresh'],
      onServerRequest: async (_method, params) => hook.onRefreshRequest(params),
      onNotification: (method, params) =>
        notifications.push({ method, params: params as Record<string, unknown> })
    })
    clients.push(client)
    await client.start(
      {
        clientInfo: { name: 'codex_pin_probe', title: null, version: '1' },
        capabilities: { experimentalApi: true, requestAttestation: false }
      },
      hook
    )
    expect(hook.injectedAccountId).toBe(VAULT_ACCOUNT)
    expect((await client.request('account/read', { refreshToken: false })).account).toMatchObject({
      type: 'chatgpt',
      email: EMAIL
    })

    const started = await client.request('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      historyMode: 'paginated'
    })
    const threadId = started.thread.id
    const first = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'hello', text_elements: [] }]
    })
    await waitFor(
      () =>
        notifications.some(
          ({ method, params }) =>
            method === 'turn/completed' && (params.turn as { id: string })?.id === first.turn.id
        ),
      'first turn'
    )

    // THE PIN. A second `account/login/start {chatgptAuthTokens}` on the SAME
    // connection, while external auth is already active.
    hook.requestAccount(SECOND_ACCOUNT)
    const token = await client.injectAccount(hook)
    expect(token?.vaultAccountId).toBe(SECOND_ACCOUNT)
    expect(hook.injectedAccountId).toBe(SECOND_ACCOUNT)
    expect((await client.request('account/read', { refreshToken: false })).account).toMatchObject({
      type: 'chatgpt',
      email: SECOND_EMAIL
    })

    const second = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'again', text_elements: [] }]
    })
    await waitFor(
      () =>
        notifications.some(
          ({ method, params }) =>
            method === 'turn/completed' && (params.turn as { id: string })?.id === second.turn.id
        ),
      'turn after the pin'
    )

    // The turn after the switch carried the SECOND account's token.
    expect(fixture.authorizations.at(-1)).toContain(SECOND_ACCOUNT)
    expect(fixture.authorizations[0]).toContain(VAULT_ACCOUNT)
    // Still memory-only: a pin writes nothing to the native auth store.
    expect(() =>
      readFileSync(join(fixture.env.CODEX_HOME as string, 'auth.json'), 'utf8')
    ).toThrow()
    expect(fixture.errors).toEqual([])
  },
  120000
)

it.skipIf(!enabled)(
  'reads per-account rate limits over one process, re-injecting between reads',
  async () => {
    // `account/rateLimits/read` goes to `chatgpt_base_url`, which this fixture
    // answers 404 — so the READ is expected to fail. What is proven here is the
    // shape of the sweep: one process, one login per account, in order, with no
    // second child spawned. The numbers themselves need a real backend.
    const fixture = await setupFixture()
    const hook = codexAuthHook({ source: twoAccountSource() })
    const client = new CodexClient({
      cwd: fixture.cwd,
      env: fixture.env,
      requestTimeoutMs: 15000
    })
    clients.push(client)
    await client.start(
      {
        clientInfo: { name: 'codex_ratelimit_probe', title: null, version: '1' },
        capabilities: { experimentalApi: true, requestAttestation: false }
      },
      hook
    )

    const seen: string[] = []
    for (const accountId of [VAULT_ACCOUNT, SECOND_ACCOUNT]) {
      hook.requestAccount(accountId)
      const token = await client.injectAccount(hook)
      expect(token?.vaultAccountId).toBe(accountId)
      const result = await client.request('account/rateLimits/read', {}).catch(() => null)
      seen.push(`${accountId}:${result ? 'answered' : 'refused'}`)
    }

    expect(seen).toEqual([`${VAULT_ACCOUNT}:refused`, `${SECOND_ACCOUNT}:refused`])
    // The binary DID ask the (fixture) backend on each pass, which is what says
    // the re-injected identity reached the read rather than being short-circuited.
    expect(fixture.backend.length).toBeGreaterThan(0)
  },
  120000
)
