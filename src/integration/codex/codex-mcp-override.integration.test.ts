import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexClient } from '../../core/codex/CodexClient'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'
import type { JsonValue } from '../../core/codex/protocol/serde_json/JsonValue'

/**
 * Slice 4 guard 4 — does `thread/start.config.mcp_servers` reach Codex's MCP
 * launcher, and does it MERGE with or REPLACE the `config.toml` table
 * (ADR-068 §5)?
 *
 * The first half was already answered by the spike (`docs/codex-spike.md`
 * § "Per-thread MCP override probe"): the override is honoured. What this file
 * adds — and what decides the delivery form of the bridge — is the second half:
 * a NATIVE `[mcp_servers.native]` in `config.toml` alongside an override, in
 * both the nested (`{ mcp_servers: { probe } }`) and the dotted
 * (`{ "mcp_servers.probe": … }`) key form.
 *
 * ANSWER (0.154.0, Windows x64, 2026-09-14; also written into
 * `docs/codex-spike.md`): the override MERGES, in BOTH key forms. With
 * `[mcp_servers.native]` in `config.toml`, a thread started with either
 * `{ mcp_servers: { probe } }` or `{ "mcp_servers.probe": … }` spawned `native`
 * AND `probe`. Nothing in the user's table is dropped either way.
 *
 * Slice 4's bridge therefore sends the NESTED form — the one the spike already
 * proved end to end, one key instead of one per server, and the JSON is the
 * `config.toml` table shape verbatim. The dotted case stays here as the other
 * half of the recorded answer: if a future binary makes the nested form
 * replace, this file says so on the next run rather than silently dropping a
 * user's native servers.
 *
 * NO CREDENTIAL AND NO NETWORK. The provider is a scripted localhost fixture
 * that is never called (no turn runs here); `chatgpt_base_url` and
 * `GET /v1/models` point at it and are answered 404 exactly as in
 * `codex-injection.integration.test.ts`. The "MCP server" is a stub written into
 * the temp directory that appends its own name to a marker file the moment it is
 * spawned and then answers the MCP `initialize` / `tools/list` handshake with an
 * empty tool list, so a spawn is observable without a startup timeout.
 */
/**
 * macOS wraps the binary in a seatbelt profile that allows only the fixture
 * port; the stub's marker file lives under the profile's one writable subpath.
 * Windows has no equivalent, so there the child runs unwrapped and the isolation
 * is the fixture's own: a replacement environment (no real `USERPROFILE`, a temp
 * `CODEX_HOME`), a config whose only provider is the localhost fixture, and
 * every network feature off.
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

/**
 * A minimal stdio MCP server. It records the fact of its own spawn, then speaks
 * just enough of the protocol to finish Codex's handshake — the spike's stub did
 * not, and `mcpServerStatus/list` blocked on it for the full startup timeout.
 */
const STUB_SOURCE = `import { appendFileSync } from 'node:fs'

const [marker, name] = process.argv.slice(2)
appendFileSync(marker, name + '\\n')

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let index = buffer.indexOf('\\n'); index >= 0; index = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id === undefined || message.id === null) continue
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name, version: '1' }
          }
        : message.method === 'tools/list'
          ? { tools: [] }
          : {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  }
})
// Codex holds stdin open for the life of the server; a CLOSED stdin means
// nobody is speaking MCP, which is how the self-check below gets its exit.
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
`

const clients: CodexClient[] = []
let directory: string | undefined
let server: ReturnType<typeof createServer> | undefined

afterEach(async () => {
  const survivors: number[] = []
  try {
    for (const client of clients.splice(0)) client.dispose()
    await new Promise((done) => setTimeout(done, 1200))
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
  stub: string
  marker: string
  /** Names of every stub that has been spawned so far, in spawn order. */
  markers(): string[]
  /** The binary's own ancillary calls, answered 404. */
  backend: string[]
  errors: string[]
}

/** One stdio `mcp_servers` entry in Codex's own JSON shape. */
function stdioEntry(fixture: Fixture, name: string): JsonValue {
  return { command: process.execPath, args: [fixture.stub, fixture.marker, name] }
}

async function setupFixture(options: { native?: boolean } = {}): Promise<Fixture> {
  const installed = resolve(
    'vendor/codex-cli',
    process.platform === 'win32' ? 'codex.exe' : 'codex'
  )
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.codexBinaries[
      `${process.platform}-${process.arch}` as keyof typeof provenance.codexBinaries
    ]
  )
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-mcp-override-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, 'vendor/codex-cli')])
    mkdirSync(name, { recursive: true })
  const exe = process.platform === 'win32' ? '.exe' : ''
  copyFileSync(installed, join(directory, 'vendor/codex-cli', `codex${exe}`))
  copyFileSync(
    resolve('vendor/codex-cli', `codex-code-mode-host${exe}`),
    join(directory, 'vendor/codex-cli', `codex-code-mode-host${exe}`)
  )
  setHostPaths({ getAppPath: () => directory! })

  const stub = join(directory, 'mcp-stub.mjs')
  writeFileSync(stub, STUB_SOURCE)
  const marker = join(directory, 'mcp-marker.txt')

  const backend: string[] = []
  const errors: string[] = []
  server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('error', () => {})
    req.on('end', () => {
      if (
        req.url?.startsWith('/backend-api/') ||
        (req.method === 'GET' && req.url?.startsWith('/v1/models'))
      ) {
        backend.push(`${req.method} ${req.url}`)
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"fixture"}')
        return
      }
      // No turn runs in this file, so the provider must never be asked to
      // complete one; anything else is a finding, not traffic to ignore.
      errors.push(`unexpected provider request: ${req.method} ${req.url}`)
      res.writeHead(400).end()
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
  const fixture: Fixture = {
    cwd,
    stub,
    marker,
    backend,
    errors,
    markers: () =>
      existsSync(marker)
        ? readFileSync(marker, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        : [],
    env:
      process.platform === 'win32'
        ? {
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
  // `inherit = "all"` so the stub's runtime gets the same environment the
  // self-check below proves it can start under; with the default `core` policy a
  // missing marker could mean "the override was ignored" OR "the stub could not
  // boot", and those must not be confusable.
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
[shell_environment_policy]
inherit = "all"
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
${
  options.native
    ? `[mcp_servers.native]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(stub)}, ${JSON.stringify(marker)}, "native"]
`
    : ''
}`
  )
  return fixture
}

/**
 * Proves the marker mechanism itself under the child's own environment, so a
 * missing marker later can only mean "not spawned" and never "could not boot".
 * `spawnSync` is the untouched original — only `spawn` is wrapped above — and an
 * empty `input` closes stdin, which is the stub's exit.
 */
function selfCheck(fixture: Fixture): void {
  const result = spawnSync(process.execPath, [fixture.stub, fixture.marker, 'selfcheck'], {
    env: fixture.env,
    input: '',
    timeout: 20000
  })
  expect(
    result.error,
    `the MCP stub could not be started: ${result.error?.message}`
  ).toBeUndefined()
  expect(fixture.markers()).toEqual(['selfcheck'])
}

type Notification = { method: string; params: unknown }

async function openClient(
  fixture: Fixture
): Promise<{ client: CodexClient; notifications: Notification[] }> {
  const notifications: Notification[] = []
  const client = new CodexClient({
    cwd: fixture.cwd,
    env: fixture.env,
    requestTimeoutMs: 30000,
    onNotification: (method, params) => notifications.push({ method, params })
  })
  clients.push(client)
  await client.start({
    clientInfo: { name: 'codex_mcp_override_probe', title: null, version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  return { client, notifications }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Isolated Codex fixture deadline: ${label}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

/** A bounded window for a NEGATIVE assertion: nothing more was spawned. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 4000))

const mcpNotifications = (notifications: Notification[]): string[] =>
  notifications.map(({ method }) => method).filter((method) => method.startsWith('mcpServer'))

it.skipIf(!enabled)(
  'case (a): a thread with no config override spawns nothing; the override spawns its server',
  async () => {
    const fixture = await setupFixture()
    selfCheck(fixture)

    const control = await openClient(fixture)
    await control.client.request('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      historyMode: 'paginated'
    })
    await settle()
    expect(fixture.markers()).toEqual(['selfcheck'])
    expect(mcpNotifications(control.notifications)).toEqual([])

    const overridden = await openClient(fixture)
    await overridden.client.request('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      historyMode: 'paginated',
      config: { mcp_servers: { probe: stdioEntry(fixture, 'probe') } }
    })
    await waitFor(
      () => fixture.markers().includes('probe'),
      'the override stub was spawned by the thread'
    )
    expect(mcpNotifications(overridden.notifications).length).toBeGreaterThan(0)
    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'case (b): a NESTED mcp_servers override merges into the config.toml table',
  async () => {
    const fixture = await setupFixture({ native: true })
    selfCheck(fixture)

    const { client } = await openClient(fixture)
    // Nothing is spawned by the handshake alone: MCP servers are a THREAD's,
    // which is what makes the two tables comparable at all.
    expect(fixture.markers()).toEqual(['selfcheck'])

    await client.request('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      historyMode: 'paginated',
      config: { mcp_servers: { probe: stdioEntry(fixture, 'probe') } }
    })
    await waitFor(() => fixture.markers().includes('probe'), 'the override stub was spawned')
    await waitFor(() => fixture.markers().includes('native'), 'the native stub was ALSO spawned')
    await settle()

    // RECORDED 2026-09-14, 0.154.0, Windows x64: BOTH. A nested `mcp_servers`
    // table in the per-thread override is UPSERTED per key into the user's
    // table, not swapped for it — which is what makes this the form Slice 4's
    // bridge sends (ADR-068 §5's "native entries keep working alongside").
    expect([...fixture.markers()].sort()).toEqual(['native', 'probe', 'selfcheck'])
    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'case (c): a DOTTED "mcp_servers.<name>" override merges into the config.toml table',
  async () => {
    const fixture = await setupFixture({ native: true })
    selfCheck(fixture)

    const { client } = await openClient(fixture)
    expect(fixture.markers()).toEqual(['selfcheck'])

    await client.request('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      historyMode: 'paginated',
      config: { 'mcp_servers.probe': stdioEntry(fixture, 'probe') }
    })
    await waitFor(() => fixture.markers().includes('probe'), 'the override stub was spawned')
    await waitFor(() => fixture.markers().includes('native'), 'the native stub was ALSO spawned')
    await settle()

    // RECORDED 2026-09-14, 0.154.0, Windows x64: BOTH, exactly as the nested
    // form. The dotted key path is not needed to preserve the native table, so
    // the bridge does not use it; this case pins that the two forms agree.
    expect([...fixture.markers()].sort()).toEqual(['native', 'probe', 'selfcheck'])
    expect(fixture.errors).toEqual([])
  },
  180000
)
