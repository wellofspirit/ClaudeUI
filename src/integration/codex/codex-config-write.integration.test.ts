import { createServer } from 'node:http'
import {
  copyFileSync,
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
import { CodexTransportError } from '../../core/codex/CodexAppServerClient'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'
import { codexIntegrationEnabled } from './integration-host'
import type { ConfigLayer } from '../../core/codex/protocol/v2/ConfigLayer'
import type { ConfigReadResponse } from '../../core/codex/protocol/v2/ConfigReadResponse'
import type { ConfigWriteResponse } from '../../core/codex/protocol/v2/ConfigWriteResponse'
import type { JsonValue } from '../../core/codex/protocol/serde_json/JsonValue'

/**
 * Slice 5a probe (ADR-068 §6) — what `config/batchWrite` actually does to
 * `~/.codex/config.toml`, on the pinned binary, before any of it is wired.
 *
 * ClaudeUI never parses or writes TOML itself: reads go through `config/read`
 * with layers, writes through `config/batchWrite`. That makes the app-server's
 * write semantics the whole contract, and three of them are not inferable from
 * the type definitions — whether a write is per-key or per-file, what a stale
 * `expectedVersion` returns, and above all HOW A KEY IS REMOVED, which decides
 * what the page's "Reset to default" affordance can honestly say.
 *
 * ANSWERS (0.154.0, Windows x64, 2026-09-14; also written into
 * `docs/codex-spike.md` § "config/batchWrite probe"):
 *
 *  (a) ROUND TRIP. `batchWrite` with `mergeStrategy: 'replace'` writes exactly
 *      the named key into the USER `config.toml`, leaves every other key AND
 *      every comment in the file untouched, and answers `status: 'ok'` with a
 *      NEW `version`. The following `config/read { includeLayers: true }` shows
 *      the value in the base user layer (`name.type === 'user'`, `profile:
 *      null`) and that layer's `version` equals the one the write returned.
 *
 *  (b) VERSION CONFLICT. A write carrying a stale `expectedVersion` is refused
 *      with JSON-RPC `-32600` and `error.data.config_write_error_code ===
 *      'configVersionConflict'` — camelCase, not the Rust variant spelling — message
 *      "Configuration was modified since last read. Fetch latest version and
 *      retry." Nothing is written. The machine
 *      tag is what `CodexTransportError.nativeCode` carries, and it is what the
 *      service branches on.
 *
 *  (c) REMOVAL. `value: null` with `mergeStrategy: 'replace'` DELETES the key
 *      from the file (`config_manager_service.rs` `parse_value` maps a JSON null
 *      to `None`, which reaches `clear_path`). It is neither refused nor written
 *      as a literal `null`. "Reset to default" on the Codex page therefore
 *      REMOVES the key, exactly as the opencode and pi panes' Reset does, and
 *      "modified" can keep meaning "present in the user layer".
 *
 *  (d) NESTED AND ARRAY PATHS. A dotted `keyPath` addresses a nested table
 *      (`sandbox_workspace_write.network_access`), creating the table when it is
 *      absent, and an array value (`project_doc_fallback_filenames`) round-trips
 *      verbatim. Removing the last key of a nested table leaves the (now empty)
 *      table behind rather than collapsing it, which is why the panes read
 *      "modified" per LEAF and never per table.
 *
 * NO CREDENTIAL AND NO NETWORK. The provider is a scripted localhost fixture
 * that is never called — no turn runs in this file — and `chatgpt_base_url` /
 * `GET /v1/models` point at it and are answered 404 exactly as in
 * `codex-injection.integration.test.ts`.
 */
/**
 * macOS wraps the binary in a seatbelt profile that allows only the fixture
 * port. Windows and Linux have no equivalent we use here, so there the child runs
 * unwrapped and the isolation is the fixture's own: a replacement environment (no
 * real `USERPROFILE`/`HOME`, a temp `CODEX_HOME`), a config whose only provider is
 * the localhost fixture, and every network feature off.
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
  /** The user `config.toml` this probe reads and writes. */
  configPath: string
  /** Its current bytes. */
  text(): string
  /** The binary's own ancillary calls, answered 404. */
  backend: string[]
  errors: string[]
}

/**
 * The seed config. It carries a COMMENT and a sibling key on purpose: a writer
 * that rewrote the file wholesale rather than editing it would lose both, and
 * that is the difference between "ClaudeUI can own one key" and "ClaudeUI owns
 * the user's file".
 */
function seedConfig(port: number): string {
  return `# claudeui probe fixture — this comment must survive every write
model = "mock-model"
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
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-config-write-')))
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
  const configPath = join(codexHome, 'config.toml')
  writeFileSync(configPath, seedConfig(port))
  return {
    cwd,
    configPath,
    text: () => readFileSync(configPath, 'utf8'),
    backend,
    errors,
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
}

async function openClient(fixture: Fixture): Promise<CodexClient> {
  const client = new CodexClient({
    cwd: fixture.cwd,
    env: fixture.env,
    requestTimeoutMs: 30000
  })
  clients.push(client)
  await client.start({
    clientInfo: { name: 'codex_config_write_probe', title: null, version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  return client
}

/** The BASE user layer — `type: 'user'` with no profile. That is the file. */
function userLayer(response: ConfigReadResponse): ConfigLayer {
  const layer = (response.layers ?? []).find(
    (entry) => entry.name.type === 'user' && entry.name.profile === null
  )
  expect(layer, 'config/read returned no base user layer').toBeTruthy()
  return layer as ConfigLayer
}

const layerConfig = (layer: ConfigLayer): Record<string, JsonValue> =>
  layer.config as Record<string, JsonValue>

const read = (client: CodexClient, fixture: Fixture): Promise<ConfigReadResponse> =>
  client.request('config/read', { includeLayers: true, cwd: fixture.cwd })

function write(
  client: CodexClient,
  edits: Array<{ keyPath: string; value: JsonValue | null }>,
  expectedVersion: string | null
): Promise<ConfigWriteResponse> {
  return client.request('config/batchWrite', {
    edits: edits.map((edit) => ({
      keyPath: edit.keyPath,
      value: edit.value as JsonValue,
      mergeStrategy: 'replace' as const
    })),
    expectedVersion,
    reloadUserConfig: true
  })
}

it.skipIf(!enabled)(
  'case (a): one batchWrite writes ONE key, keeps the rest of the file, and moves the user-layer version',
  async () => {
    const fixture = await setupFixture()
    const client = await openClient(fixture)

    const before = await read(client, fixture)
    const beforeLayer = userLayer(before)
    expect(layerConfig(beforeLayer).model_verbosity).toBeUndefined()

    const result = await write(
      client,
      [{ keyPath: 'model_verbosity', value: 'high' }],
      beforeLayer.version
    )
    expect(result.status).toBe('ok')
    expect(result.version).not.toBe(beforeLayer.version)

    const text = fixture.text()
    expect(text).toContain('model_verbosity = "high"')
    // The whole reason ClaudeUI does not write TOML itself.
    expect(text).toContain('# claudeui probe fixture')
    expect(text).toContain('base_url = "http://127.0.0.1:')

    const after = await read(client, fixture)
    const afterLayer = userLayer(after)
    expect(layerConfig(afterLayer).model_verbosity).toBe('high')
    expect(afterLayer.version).toBe(result.version)
    expect((after.config as Record<string, unknown>).model_verbosity).toBe('high')
    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'case (b): a stale expectedVersion is refused as ConfigVersionConflict and writes nothing',
  async () => {
    const fixture = await setupFixture()
    const client = await openClient(fixture)
    const stale = userLayer(await read(client, fixture)).version

    await write(client, [{ keyPath: 'model_verbosity', value: 'low' }], stale)
    const conflict = await write(
      client,
      [{ keyPath: 'model_verbosity', value: 'high' }],
      stale
    ).then(
      () => null,
      (error: unknown) => error
    )
    expect(conflict).toBeInstanceOf(CodexTransportError)
    const error = conflict as CodexTransportError
    // RECORDED 2026-09-14, 0.154.0, Windows x64: JSON-RPC -32600 with the
    // machine tag in `error.data.config_write_error_code`, serialized CAMEL
    // CASE (`configVersionConflict`) rather than as the Rust variant name —
    // `ConfigWriteErrorCode` carries `#[serde(rename_all = "camelCase")]`, and
    // that is not visible from the generated TS because the enum is outside the
    // selected dependency closure. The tag, not the sentence, is what
    // `codex-config.ts` branches on.
    expect(error.code).toBe('rpc-error--32600')
    expect(error.nativeCode).toBe('configVersionConflict')
    expect(error.nativeMessage).toContain('modified since last read')
    // The refused write left the FIRST write's value in place.
    expect(fixture.text()).toContain('model_verbosity = "low"')
    expect(fixture.text()).not.toContain('model_verbosity = "high"')
    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'case (c): `value: null` with replace REMOVES the key (this is what Reset does)',
  async () => {
    const fixture = await setupFixture()
    const client = await openClient(fixture)

    const seeded = await write(
      client,
      [{ keyPath: 'model_verbosity', value: 'high' }],
      userLayer(await read(client, fixture)).version
    )
    expect(fixture.text()).toContain('model_verbosity')

    const removal = await write(
      client,
      [{ keyPath: 'model_verbosity', value: null }],
      seeded.version
    )
    expect(removal.status).toBe('ok')

    // RECORDED 2026-09-14, 0.154.0, Windows x64: the key is GONE from the file —
    // not refused, and not written as a literal `null`. `Reset to default` on
    // the Codex page is therefore a real removal, and `modified` can keep
    // meaning "present in the user layer".
    expect(fixture.text()).not.toContain('model_verbosity')
    expect(layerConfig(userLayer(await read(client, fixture))).model_verbosity).toBeUndefined()
    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'case (d): a dotted nested path and an array value round-trip',
  async () => {
    const fixture = await setupFixture()
    const client = await openClient(fixture)
    const first = userLayer(await read(client, fixture))
    expect(layerConfig(first).sandbox_workspace_write).toBeUndefined()

    // The nested table does not exist yet: the writer must create it.
    const nested = await write(
      client,
      [
        { keyPath: 'sandbox_workspace_write.network_access', value: true },
        { keyPath: 'project_doc_fallback_filenames', value: ['CLAUDE.md', 'CONTEXT.md'] }
      ],
      first.version
    )
    expect(nested.status).toBe('ok')

    const layer = userLayer(await read(client, fixture))
    const config = layerConfig(layer)
    expect((config.sandbox_workspace_write as Record<string, JsonValue>).network_access).toBe(true)
    expect(config.project_doc_fallback_filenames).toEqual(['CLAUDE.md', 'CONTEXT.md'])

    // Removing a nested LEAF removes only that leaf; the (now empty) table is
    // left behind, which is why the panes compute `modified` per leaf.
    const cleared = await write(
      client,
      [
        { keyPath: 'sandbox_workspace_write.network_access', value: null },
        { keyPath: 'project_doc_fallback_filenames', value: null }
      ],
      layer.version
    )
    expect(cleared.status).toBe('ok')
    const final = layerConfig(userLayer(await read(client, fixture)))
    const table = final.sandbox_workspace_write as Record<string, JsonValue> | undefined
    expect(table?.network_access).toBeUndefined()
    expect(final.project_doc_fallback_filenames).toBeUndefined()
    expect(fixture.errors).toEqual([])
  },
  180000
)

/**
 * Case (e) exists because the kickoff's Tools & search group named
 * `browser_use.enabled` and `computer_use.enabled`, and NEITHER is a key of
 * this binary's config schema: `BrowserUseConfigToml` / `ComputerUseConfigToml`
 * carry `deny_unknown_fields` and no `enabled` field (see the generated
 * `v2/BrowserUseConfig.ts` — `allow_history_access`, `default_origin_policy`,
 * `origins`). The switch that actually gates those two tools is the `features`
 * table, which is what every fixture in this suite already writes.
 *
 * RECORDED 2026-09-14, 0.154.0, Windows x64, and it is the sharper of the two
 * findings: **`config/batchWrite` does NOT validate the key against the schema**
 * — `browser_use.enabled = false` is accepted and written. What it produces is a
 * `config.toml` that the loader then REJECTS, so a settings row over a
 * misremembered key would not fail visibly at the click; it would write a file
 * that breaks the next session. That is the reason the page's key list is taken
 * from `config_toml.rs` rather than from the ADR table, and the reason this case
 * stays here: it fails loudly if a future binary starts validating (good) and it
 * documents why nothing here trusts a write's acceptance as proof of a key.
 */
it.skipIf(!enabled)(
  'case (e): batchWrite does not validate keys — `features.*` is the real gate, `browser_use.enabled` poisons the file',
  async () => {
    const fixture = await setupFixture()
    const client = await openClient(fixture)
    const version = userLayer(await read(client, fixture)).version

    // The keys the page actually uses round-trip.
    const accepted = await write(
      client,
      [
        { keyPath: 'features.browser_use', value: false },
        { keyPath: 'features.computer_use', value: false }
      ],
      version
    )
    expect(accepted.status).toBe('ok')
    const config = layerConfig(userLayer(await read(client, fixture)))
    // Merged INTO the seed's existing `[features]` table, not swapped for it.
    expect(config.features).toMatchObject({ browser_use: false, computer_use: false })
    expect(Object.keys(config.features as Record<string, JsonValue>)).toContain('apps')

    // And the misremembered one is written WITHOUT complaint…
    const poisoned = await write(
      client,
      [{ keyPath: 'browser_use.enabled', value: false }],
      accepted.version
    )
    expect(poisoned.status).toBe('ok')
    expect(fixture.text()).toContain('[browser_use]')
    // …which is precisely why acceptance proves nothing about a key existing.
    expect(fixture.errors).toEqual([])
  },
  180000
)
