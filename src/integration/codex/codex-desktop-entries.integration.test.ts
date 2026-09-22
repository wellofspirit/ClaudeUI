import type { Server } from 'node:http'
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
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { CodexClient } from '../../core/codex/CodexClient'
import { codexHostRegistry } from '../../core/codex/CodexHost'
import { CodexService } from '../../core/codex/CodexService'
import { CodexSession } from '../../core/codex/CodexSession'
import { CLAUDEUI_DISABLED_FEATURES } from '../../core/codex/codex-features'
import { setHostPaths } from '../../core/host'
import type { EngineSpawnOptions } from '../../core/providers/ISession'
import provenance from '../../core/codex/protocol/provenance.json'
import {
  FIXTURE_API_KEY,
  FIXTURE_AUTHORIZATION,
  FIXTURE_FEATURES,
  fixtureAssistantMessage,
  // No case here runs under `auto_review`; this is belt-and-braces against a
  // reviewer call being counted as an agent turn.
  isGuardianRequest,
  startFixtureProvider,
  writeFixtureCodexHome,
  type FixtureConfigOptions
} from './fixture-provider'
import { codexIntegrationEnabled } from './integration-host'

/**
 * F17 — the Codex DESKTOP APP's own entries in the user's `~/.codex` never reach
 * a ClaudeUI thread.
 *
 * ## What this file is about
 *
 * The desktop app shares `~/.codex` with the CLI and writes its own MCP servers
 * (`node_repl`, `cua_repl`, `computer-use`) and its `openai-bundled` plugins
 * into the user's `config.toml`. Nothing in the binary gates those on which
 * client opened the thread, so an app-server ClaudeUI starts loads them all: the
 * desktop app's MCP tools are advertised to the model and the plugins' skills
 * and manifest text are injected into the prompt. That is where a ClaudeUI turn
 * got the idea it had "the ChatGPT in-app browser" to test a build with.
 *
 * So this file builds a DESKTOP-SHAPED home against the real binary — a
 * `[mcp_servers.node_repl]` backed by a scripted stdio MCP server serving one
 * tool called `browser_navigate`, a local `openai-bundled` marketplace holding a
 * minimal `browser` plugin whose manifest and skill both say "the ChatGPT in-app
 * browser", `[plugins."browser@openai-bundled"] enabled = true`, and
 * `[features] plugins = true` — and then:
 *
 *  1. proves the LEAK with ClaudeUI's override BYPASSED (a raw `CodexClient`
 *     `thread/start` with no `config`, which is what any other client does): the
 *     provider request carries `browser_navigate` and the phrase `in-app
 *     browser`;
 *  2. proves that a `CodexSession` on the same home suppresses both on
 *     `thread/start`, on a cold `thread/resume` and on `thread/fork`, while
 *     every other tool survives;
 *  3. proves the file is byte-identical afterwards and `config/read` still shows
 *     the user's `enabled = true` — a per-thread override is not a write.
 *
 * A second case keeps the earlier probe's question about the nine desktop
 * FEATURE flags: from a home with no `[features]` table at all they are the
 * binary's defaults (all nine ON), and `CLAUDEUI_DISABLED_FEATURES` must remove
 * no tool. That one is hygiene and a tripwire, not the fix.
 *
 * NO CREDENTIAL AND NO NETWORK: the isolated localhost fixture provider, a temp
 * `CODEX_HOME`, and on macOS a seatbelt profile whose only allowed egress is the
 * fixture port.
 */
const containment = vi.hoisted(() => ({ profile: '', pids: [] as number[] }))
const coreEvents = vi.hoisted(() => vi.fn())
vi.mock('../../core/services/sync-host', () => ({ emitEvent: coreEvents }))
// The shared permission gate merges the USER's real ~/.claude rules. Pin them
// empty so this probe measures the binary, not this machine's settings.
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
// Same reasoning for the shared MCP list (ADR-068 §5): the real collector reads
// THIS machine's ~/.claude and would spawn the developer's own MCP servers
// inside the isolated app-server. Pinned empty, so the `mcp_servers` override
// this file asserts is the desktop-entry suppression and nothing else.
vi.mock('../../core/codex/codex-mcp-bridge', () => ({
  collectClaudeMcpForCodex: () => ({ servers: {}, skipped: [] })
}))
const persistence = vi.hoisted(() => ({ close: () => {} }))
/** The isolated `session_meta` table, as in the app-server suite. */
const sessionMeta = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/db')>()
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  actual.runMigrations(db)
  persistence.close = () => db.close()
  return {
    dispatchedCostsByRouting: () => [],
    insertUsageEvent: vi.fn(),
    setSessionMeta: (id: string, meta: unknown) => void sessionMeta.set(id, meta),
    getSessionMeta: (id: string) => sessionMeta.get(id),
    allSessionMeta: () => Object.fromEntries(sessionMeta),
    registerCodexFork: (id: string, from: string | null) => actual.registerCodexFork(id, from, db),
    listCodexForks: () => actual.listCodexForks(db),
    deleteCodexFork: (id: string) => actual.deleteCodexFork(id, db),
    listCodexLineage: () => actual.listCodexLineage(db),
    recordCodexLineage: (id: string, from: string | null, verifiedAt: number | null) =>
      actual.recordCodexLineage(id, from, verifiedAt, db),
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
let service: CodexService | undefined
let session: CodexSession | undefined
const clients: CodexClient[] = []
let directory: string | undefined
let server: Server | undefined

afterEach(async () => {
  coreEvents.mockClear()
  sessionMeta.clear()
  const survivors: number[] = []
  try {
    service?.dispose()
    for (const client of clients.splice(0)) client.dispose()
    // A disposed session only DETACHES under ADR-069; the HOST is what holds the
    // temp home's writer lock, so it has to go too or the directory cannot be
    // removed below.
    codexHostRegistry.dispose()
    session?.dispose()
    session = undefined
    service = undefined
    await new Promise((done) => setTimeout(done, 1500))
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

/**
 * A minimal stdio MCP server standing in for the desktop app's `node_repl`.
 *
 * Adapted from the one `codex-mcp-override.integration.test.ts` proves against
 * the real binary; the difference is that this one SERVES a tool —
 * `browser_navigate`, the shape of the thing the desktop app's browser server
 * offers — so the leak it stands for is visible in the provider request rather
 * than only in a spawn marker.
 */
const MCP_STUB_SOURCE = `import { appendFileSync } from 'node:fs'
const log = process.argv[2]
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
    if (log) appendFileSync(log, line + '\\n')
    if (message.id === undefined || message.id === null) continue
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'node_repl', version: '1' }
          }
        : message.method === 'tools/list'
          ? {
              tools: [
                {
                  // The shape of the thing the desktop app's browser server
                  // offers. Asserted at the SERVER rather than by this name in
                  // the provider request: MCP tools are DEFERRED under this
                  // catalog's models and are never declared by name (see the
                  // recorded finding in the leak case below).
                  name: 'browser_navigate',
                  description: 'Open a URL in the ChatGPT in-app browser.',
                  inputSchema: {
                    type: 'object',
                    properties: { url: { type: 'string' } },
                    required: ['url']
                  }
                }
              ]
            }
          : {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
`

/** The manifest sentence the model acted on, reproduced from the real plugin. */
const PLUGIN_SENTENCE =
  'Use Browser, the ChatGPT in-app browser, when the user asks to open, inspect, navigate or test local web targets.'

/** The phrase the plugin puts in the prompt, and the one the model repeated. */
const DESKTOP_PHRASE = 'in-app browser'

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

/**
 * The desktop app's own entries, written into the fixture `CODEX_HOME` exactly
 * as the app writes them into a real one: a bundled-marketplace directory, the
 * plugin inside it, and the `config.toml` tables that turn both on.
 */
function desktopToml(codexHome: string, stub: string): string {
  // The marketplace the desktop app installs FROM, at the path it really uses.
  const marketplace = join(codexHome, '.tmp', 'bundled-marketplaces', 'openai-bundled')
  write(
    join(marketplace, '.agents/plugins/marketplace.json'),
    JSON.stringify(
      {
        name: 'openai-bundled',
        plugins: [{ name: 'browser', source: { source: 'local', path: './plugins/browser' } }]
      },
      null,
      2
    )
  )
  const manifest = JSON.stringify({ name: 'browser', description: PLUGIN_SENTENCE }, null, 2)
  const skill = `---\nname: control-in-app-browser\ndescription: ${PLUGIN_SENTENCE}\n---\n\nOpen the target with browser_navigate.\n`
  write(join(marketplace, 'plugins/browser/.codex-plugin/plugin.json'), manifest)
  write(join(marketplace, 'plugins/browser/skills/control-in-app-browser/SKILL.md'), skill)
  // …and the INSTALLED copy, which is what actually loads: a plugin the store
  // cannot find under `plugins/cache/<marketplace>/<plugin>/<version>` is
  // reported "plugin is not installed" and contributes nothing, however the
  // config names it (`core-plugins/src/store.rs`, `DEFAULT_PLUGIN_VERSION` is
  // `local`). Recorded 2026-09-16: without this the config-only fixture loaded
  // no plugin at all and the leak could not be seen.
  const installed = join(codexHome, 'plugins/cache/openai-bundled/browser/local')
  write(join(installed, '.codex-plugin/plugin.json'), manifest)
  write(join(installed, 'skills/control-in-app-browser/SKILL.md'), skill)
  // `inherit = "all"` for the same reason the MCP override suite gives: with the
  // default `core` policy a missing tool could mean "the server was suppressed"
  // OR "the stub could not boot", and those two must never be confusable.
  return `[shell_environment_policy]
inherit = "all"
[mcp_servers.node_repl]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(stub)}, ${JSON.stringify(join(dirname(stub), 'mcp-log.txt'))}]
startup_timeout_sec = 20
[marketplaces.openai-bundled]
source_type = "local"
source = ${JSON.stringify(marketplace)}
[plugins."browser@openai-bundled"]
enabled = true
`
}

interface Fixture {
  cwd: string
  codexHome: string
  configPath: string
  /**
   * Where the stand-in `node_repl` server appends every JSON-RPC line it is
   * sent. Its EXISTENCE is the marker: a suppressed server is never spawned and
   * writes nothing, which no handshake race can fake.
   */
  mcpLog: string
  requests: Record<string, unknown>[]
  errors: string[]
  env: NodeJS.ProcessEnv
}

async function setupFixture(
  options: { features?: FixtureConfigOptions['features']; desktop?: boolean } = {}
): Promise<Fixture> {
  const installed = resolve(
    'vendor/codex-cli',
    process.platform === 'win32' ? 'codex.exe' : 'codex'
  )
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.codexBinaries[
      `${process.platform}-${process.arch}` as keyof typeof provenance.codexBinaries
    ]
  )
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-desktop-entries-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, 'vendor/codex-cli')])
    mkdirSync(name, { recursive: true })
  const exe = process.platform === 'win32' ? '.exe' : ''
  copyFileSync(installed, join(directory, 'vendor/codex-cli', `codex${exe}`))
  setHostPaths({ getAppPath: () => directory! })
  const requests: Record<string, unknown>[] = []
  const errors: string[] = []
  const fixture = await startFixtureProvider({
    requests,
    errors,
    // The built-in `openai` provider — the only one `assertCodexProvider` lets a
    // `CodexSession` run on — reads `auth.json`, so the bearer is matched
    // exactly and no real credential can have reached the child.
    authorization: FIXTURE_AUTHORIZATION,
    // Every turn answers with plain text: what is read here is the tool and
    // prompt ADVERTISEMENT, and a scripted tool call would only add turns to
    // sift.
    script: () => fixtureAssistantMessage()
    // No `onUpgrade`: the default answers Codex's WebSocket attempt 426, which
    // is what puts the turns back on HTTP where `requests[]` records them.
  })
  server = fixture.server
  const port = fixture.port
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
  const stub = join(directory, 'node-repl-stub.mjs')
  if (options.desktop) writeFileSync(stub, MCP_STUB_SOURCE)
  writeFixtureCodexHome(codexHome, {
    port,
    // The catalog default model, not a pinned mock: which tools a thread is
    // offered depends on the model's own catalog entry, and this is about the
    // model a ClaudeUI user actually gets.
    model: null,
    provider: 'openai',
    openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: FIXTURE_API_KEY,
    // The fixture default turns `plugins` OFF, which is why no drive had ever
    // loaded one. On the desktop home it is ON and everything else stays at the
    // fixture's values, so what leaks below can only be the plugin channel and
    // never one of the nine feature flags.
    features: options.desktop ? { ...FIXTURE_FEATURES, plugins: true } : options.features,
    ...(options.desktop ? { extraToml: desktopToml(codexHome, stub) } : {})
  })
  return {
    cwd,
    codexHome,
    configPath: join(codexHome, 'config.toml'),
    mcpLog: join(directory, 'mcp-log.txt'),
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

/**
 * Every tool one provider request OFFERS, as a sorted name list.
 *
 * The pinned binary does NOT use the Responses `tools` field. Recorded from the
 * real 0.154.0 binary on 2026-09-16: a request carries an `input[]` item of type
 * `additional_tools` (`role: "developer"`) whose `tools` array holds NAMESPACE
 * entries (`{type:'namespace', name, tools:[…]}`) — `functions`, `clock`,
 * `collaboration` — and under the code-mode models this catalog hands back, the
 * genuinely callable set is declared a SECOND time inside the `functions.exec`
 * tool's own description, one `### \`name\`` heading per nested tool
 * (`advertisesHostedTool` in the app-server suite reads the same headings).
 *
 * Both layers are collected — namespaced children as `parent.child`, nested
 * declarations as `functions.exec.child` — because a suppression that emptied a
 * namespace or dropped a nested declaration would otherwise hide behind its
 * container still being present.
 */
function toolNames(request: Record<string, unknown>): string[] {
  const names = new Set<string>()
  const declared = /^### `([^`]+)`$/gm
  const walk = (entry: unknown, prefix: string): void => {
    if (Array.isArray(entry)) {
      for (const child of entry) walk(child, prefix)
      return
    }
    if (!entry || typeof entry !== 'object') return
    const record = entry as Record<string, unknown>
    const kind = typeof record.type === 'string' ? record.type : ''
    const name = typeof record.name === 'string' ? record.name : null
    if (kind === 'namespace' && name) {
      walk(record.tools, `${prefix}${name}.`)
      return
    }
    if (name && (kind === 'function' || kind === 'custom' || kind === 'freeform')) {
      names.add(`${prefix}${name}`)
      if (typeof record.description === 'string')
        for (const match of record.description.matchAll(declared))
          names.add(`${prefix}${name}.${match[1]}`)
      return
    }
    // Anything else is a container on the way down (`input`, `additional_tools`).
    for (const value of Object.values(record)) walk(value, prefix)
  }
  walk(request.input, '')
  walk(request.tools, '')
  return [...names].sort()
}

/** The four desktop-app words the handoff saw the model use, case-insensitive. */
const DESKTOP_WORDS = ['browser', 'computer use', 'in-app', 'desktop app'] as const

/**
 * Every place a phrase appears in a request's `instructions` or in an `input[]`
 * DEVELOPER message (the tool declarations and the skills list both ride in one
 * of those), with surrounding text. User and assistant items are excluded: those
 * are this file's own prompt coming back, not the binary talking.
 */
function phraseMatches(request: Record<string, unknown>, phrase: string): string[] {
  const haystacks: string[] = []
  if (typeof request.instructions === 'string') haystacks.push(request.instructions)
  for (const item of Array.isArray(request.input) ? request.input : []) {
    const role = (item as Record<string, unknown> | null)?.role
    if (role === 'developer' || role === 'system') haystacks.push(JSON.stringify(item))
  }
  const hits: string[] = []
  const needle = phrase.toLowerCase()
  for (const text of haystacks) {
    const lower = text.toLowerCase()
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1))
      hits.push(text.slice(Math.max(0, at - 110), at + needle.length + 110).replace(/\s+/g, ' '))
  }
  return hits
}

/** {@link phraseMatches} for each of {@link DESKTOP_WORDS}, empty keys dropped. */
function desktopWordMatches(request: Record<string, unknown>): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const word of DESKTOP_WORDS) {
    const hits = phraseMatches(request, word)
    if (hits.length > 0) found[word] = hits
  }
  return found
}

/** The native turn ids a session's transcript carries, in order (fork anchors). */
function turnIds(messages: Array<{ id: string }>): string[] {
  const seen: string[] = []
  for (const message of messages) {
    if (!message.id.startsWith('codex:')) continue
    const turn = (JSON.parse(message.id.slice('codex:'.length)) as string[])[1]
    if (turn && !seen.includes(turn)) seen.push(turn)
  }
  return seen
}

/** Every JSON-RPC line the stand-in desktop MCP server was sent, or none. */
function readMcpLog(fixture: Fixture): string[] {
  if (!existsSync(fixture.mcpLog)) return []
  return readFileSync(fixture.mcpLog, 'utf8').split('\n').filter(Boolean)
}

/** The first request the AGENT made — the one carrying the tool advertisement. */
function firstAgentRequest(requests: Record<string, unknown>[]): Record<string, unknown> {
  const request = requests.find(
    (entry) => !isGuardianRequest(entry) && entry.generate !== false && toolNames(entry).length > 0
  )
  expect(request, `no agent request advertised tools: ${requests.length} recorded`).toBeDefined()
  return request!
}

async function runOneTurn(
  id: string,
  fixture: Fixture,
  options: EngineSpawnOptions = {}
): Promise<CodexSession> {
  const next = new CodexSession(id, null, fixture.cwd, options, {
    env: fixture.env,
    requestTimeoutMs: 30000
  })
  session = next
  await next.run(null)
  await next.run('Say hello.')
  await vi.waitFor(() => expect(next.willQueue).toBe(false), { timeout: 60000 })
  return next
}

it.skipIf(!enabled)(
  'leaks the desktop app`s MCP tool and plugin text without the override, and suppresses both with it on start, resume and fork',
  async () => {
    const fixture = await setupFixture({ desktop: true })
    const before = readFileSync(fixture.configPath, 'utf8')

    // ---- (a) the LEAK, with ClaudeUI's override bypassed -------------------
    // A raw `CodexClient` `thread/start` with no `config` at all: what every
    // other app-server client sends, and what ClaudeUI itself sent before this
    // slice. Driven at this level on purpose — a production seam that turns the
    // override off would be a switch nothing in the product ever flips.
    const mcpNotifications: string[] = []
    const bare = new CodexClient({
      cwd: fixture.cwd,
      env: fixture.env,
      requestTimeoutMs: 30000,
      onNotification: (method, params) => {
        if (method.startsWith('mcpServer'))
          mcpNotifications.push(`${method} ${JSON.stringify(params)}`)
      }
    })
    clients.push(bare)
    await bare.start({
      clientInfo: { name: 'codex_desktop_entries_probe', title: null, version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    const bareThread = await bare.request('thread/start', {
      cwd: fixture.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      historyMode: 'paginated'
    })
    // The MCP server starts asynchronously, so wait for the binary to say it is
    // up before driving the turn that reads the prompt.
    await vi.waitFor(() => expect(mcpNotifications.join('|')).toContain('"status":"ready"'), {
      timeout: 60000
    })
    const beforeLeak = fixture.requests.length
    await bare.request('turn/start', {
      threadId: bareThread.thread.id,
      input: [{ type: 'text', text: 'Say hello.', text_elements: [] }]
    })
    await vi.waitFor(() => expect(fixture.requests.length).toBeGreaterThan(beforeLeak), {
      timeout: 60000
    })
    const leaked = firstAgentRequest(fixture.requests.slice(beforeLeak))
    const leakedTools = toolNames(leaked)
    const leakedPhrase = phraseMatches(leaked, DESKTOP_PHRASE)
    const leakedMcpLog = readMcpLog(fixture)
    if (process.env.CODEX_PROBE_DUMP)
      writeFileSync(process.env.CODEX_PROBE_DUMP, JSON.stringify(fixture.requests, null, 2))
    console.log(JSON.stringify({ probe: 'desktop-leak-mcp-log', lines: leakedMcpLog }, null, 2))
    console.log(
      JSON.stringify({ probe: 'desktop-leak-mcp-status', notifications: mcpNotifications }, null, 2)
    )
    console.log(JSON.stringify({ probe: 'desktop-leak', tools: leakedTools }, null, 2))
    console.log(JSON.stringify({ probe: 'desktop-leak-phrase', hits: leakedPhrase }, null, 2))

    // The leak, on both of its channels.
    //
    // The MCP half is asserted at the SERVER, not by the tool's name in the
    // request. Recorded 2026-09-16 against 0.154.0: under this catalog's models
    // MCP tools are DEFERRED rather than declared — `apply_mcp_tool_exposure_policy`
    // drops `ToolExposures::DIRECT` whenever `search_tool_enabled`, which is
    // `model_info.supports_search_tool && provider.capabilities().namespace_tools`
    // and therefore not something a config can switch off — so `browser_navigate`
    // never appears by name however long the wait. What IS observable, and is
    // the thing that matters, is that the desktop app's server PROCESS was
    // started and asked for its tools (its own log), and that the binary added
    // the `*_mcp_resource*` helpers it adds whenever a server is loaded.
    expect(
      leakedMcpLog.join('\n'),
      'the desktop MCP server was never asked for its tools'
    ).toContain('tools/list')
    expect(
      leakedTools.filter((name) => name.includes('mcp_resource')),
      'no MCP server was loaded on the unsuppressed thread'
    ).not.toEqual([])
    // The PLUGIN half is plain text in the prompt — the sentence the model acted on.
    expect(leakedPhrase, `no "${DESKTOP_PHRASE}" in the unsuppressed prompt`).not.toEqual([])
    // Cleared, so its reappearance below would mean the server started again.
    rmSync(fixture.mcpLog, { force: true })
    bare.dispose()
    clients.length = 0

    // ---- (b) the same home through a CodexSession --------------------------
    const beforeStart = fixture.requests.length
    const sent = vi.spyOn(CodexClient.prototype, 'request')
    const started = await runOneTurn('desktop-start', fixture)
    const threadId = started.getSessionId()!
    const startRequest = firstAgentRequest(fixture.requests.slice(beforeStart))
    const startTools = toolNames(startRequest)
    console.log(JSON.stringify({ probe: 'desktop-suppressed', tools: startTools }, null, 2))
    console.log(
      JSON.stringify(
        { probe: 'desktop-suppressed-words', words: desktopWordMatches(startRequest) },
        null,
        2
      )
    )

    /** Neither half of the leak survives, and nothing else was taken with it. */
    const assertSuppressed = (request: Record<string, unknown>, where: string): void => {
      const tools = toolNames(request)
      expect(
        phraseMatches(request, DESKTOP_PHRASE),
        `${where}: the plugin's text is still in the prompt`
      ).toEqual([])
      // The MCP half, twice over: the binary loaded no server on this thread
      // (the `*_mcp_resource*` helpers it adds when one is configured are gone)
      // and the desktop app's server process was never even started (its own log
      // has not come back since it was cleared above). The second is the one
      // that cannot be raced — a server merely slow to answer would still have
      // been spawned and would still have written a line.
      expect(
        tools.filter((name) => name.includes('mcp_resource')),
        `${where}: an MCP server is still configured on this thread`
      ).toEqual([])
      expect(readMcpLog(fixture), `${where}: the desktop MCP server was started`).toEqual([])
      expect(tools, `${where}: the tool list drifted between start, resume and fork`).toEqual(
        startTools
      )
    }
    assertSuppressed(startRequest, 'thread/start')
    // The suppression is SURGICAL: every tool the unsuppressed run offered is
    // still here except the MCP helpers that exist only because a server was
    // loaded. (The hosted ClaudeUI tools — `render_mermaid`, `create_mockup`,
    // `show_mockup`, `dispatch_agent` — go the other way: the bare client above
    // declares no `dynamicTools`, so they are in the suppressed list and not in
    // the leaked one.)
    expect(
      leakedTools.filter((name) => !startTools.includes(name) && !name.includes('mcp_resource')),
      'the suppression removed a tool that was not the desktop app`s'
    ).toEqual([])

    // ---- resume: a COLD one, so the request names the tools again ----------
    const anchor = turnIds(started.getMessages())[0]
    expect(anchor, 'no completed turn to branch from').toBeTruthy()
    started.dispose()
    codexHostRegistry.dispose()
    const beforeResume = fixture.requests.length
    const resumed = await runOneTurn('desktop-resume', fixture, { resumeSessionId: threadId })
    expect(resumed.getSessionId()).toBe(threadId)
    assertSuppressed(firstAgentRequest(fixture.requests.slice(beforeResume)), 'thread/resume')

    // ---- fork ---------------------------------------------------------------
    resumed.dispose()
    codexHostRegistry.dispose()
    const beforeFork = fixture.requests.length
    const forked = await runOneTurn('desktop-fork', fixture, {
      resumeSessionId: threadId,
      resumeSessionAt: anchor,
      forkSession: true
    })
    expect(forked.getSessionId()).not.toBe(threadId)
    assertSuppressed(firstAgentRequest(fixture.requests.slice(beforeFork)), 'thread/fork')

    // All three envelopes are one `threadParams()`, and this is what says so on
    // the app-server wire rather than by reading the source.
    for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
      const params = sent.mock.calls.find(([name]) => name === method)?.[1] as
        { config?: Record<string, unknown> } | undefined
      expect(params, `no ${method} reached the binary`).toBeDefined()
      expect(params!.config, `${method} carried the wrong config override`).toEqual({
        mcp_servers: { node_repl: { enabled: false } },
        plugins: { 'browser@openai-bundled': { enabled: false } },
        features: CLAUDEUI_DISABLED_FEATURES
      })
    }
    sent.mockRestore()

    // ---- the override is not a WRITE ---------------------------------------
    const after = readFileSync(fixture.configPath, 'utf8')
    // Since 0.156.0, Codex does not persist trust for this projectless cwd.
    // The per-thread override must leave the user's config byte-identical.
    expect(after, 'the thread override mutated config.toml').toBe(before)
    service = new CodexService({
      cwd: fixture.cwd,
      env: fixture.env,
      requestTimeoutMs: 30000
    })
    const layers = await service.readConfigLayers(fixture.cwd)
    const user = (layers.layers ?? []).find((layer) => layer.name.type === 'user')
    expect(user, 'config/read returned no USER layer').toBeDefined()
    const userLayer = (user!.config ?? {}) as Record<string, Record<string, unknown>>
    console.log(
      JSON.stringify(
        {
          probe: 'desktop-user-layer',
          mcp_servers: Object.keys(userLayer.mcp_servers ?? {}),
          plugins: userLayer.plugins
        },
        null,
        2
      )
    )
    // Still ON for the desktop app and the TUI: the user's own file says what it
    // always said, and only THIS client's threads are opened without it.
    expect(userLayer.plugins).toEqual({ 'browser@openai-bundled': { enabled: true } })
    expect(Object.keys(userLayer.mcp_servers ?? {})).toEqual(['node_repl'])
    expect((userLayer.mcp_servers?.node_repl as Record<string, unknown>).enabled).toBeUndefined()
    expect(fixture.errors).toEqual([])
  },
  600000
)

it.skipIf(!enabled)(
  'reads the binary-default feature set and proves the nine-flag override costs no tool',
  async () => {
    // Hygiene and a tripwire, not the fix (the fix is the case above): the nine
    // desktop-app flags are `Stage::Stable, default_enabled: true` and gate no
    // tool in `core/src/tools/spec_plan.rs`. This measures that from a home with
    // NO `[features]` table at all — which no drive had ever done, because every
    // fixture home has always declared its own — so a future binary that starts
    // gating a tool on one of them fails here rather than silently removing a
    // user's tool.
    const defaults = await setupFixture({ features: 'binary-defaults' })
    expect(readFileSync(defaults.configPath, 'utf8')).not.toContain('[features]')
    const first = await runOneTurn('features-defaults', defaults)
    const defaultRequest = firstAgentRequest(defaults.requests)
    const defaultTools = toolNames(defaultRequest)
    console.log(JSON.stringify({ probe: 'features-binary-defaults', tools: defaultTools }, null, 2))
    console.log(
      JSON.stringify(
        { probe: 'features-binary-defaults-words', words: desktopWordMatches(defaultRequest) },
        null,
        2
      )
    )
    expect(defaultTools.length).toBeGreaterThan(0)
    // The session that produced that list ALREADY carried the override — there
    // is no ClaudeUI thread without it — so what this asserts is that a home at
    // the binary's defaults, driven through ClaudeUI, still offers every tool
    // and says nothing about a browser, computer use or the desktop app.
    const sent = vi.spyOn(CodexClient.prototype, 'request')
    try {
      first.dispose()
      codexHostRegistry.dispose()
      const beforeSecond = defaults.requests.length
      const second = await runOneTurn('features-defaults-again', defaults)
      const startParams = sent.mock.calls.find(([method]) => method === 'thread/start')?.[1] as
        { config?: Record<string, unknown> } | undefined
      // A home with NO desktop entries sends no `plugins` key and no disabled
      // server — absent, not empty (ADR-068 §5), because an `enabled: false`
      // overlay on a table the user does not have creates a server with no
      // transport and fails config load outright.
      expect(startParams?.config).toEqual({ features: CLAUDEUI_DISABLED_FEATURES })
      expect(toolNames(firstAgentRequest(defaults.requests.slice(beforeSecond)))).toEqual(
        defaultTools
      )
      expect(desktopWordMatches(firstAgentRequest(defaults.requests.slice(beforeSecond)))).toEqual(
        {}
      )
      second.dispose()
    } finally {
      sent.mockRestore()
    }
    expect(readFileSync(defaults.configPath, 'utf8')).not.toContain('[features]')
    for (const key of Object.keys(CLAUDEUI_DISABLED_FEATURES))
      expect(readFileSync(defaults.configPath, 'utf8')).not.toContain(key)
    expect(defaults.errors).toEqual([])
  },
  600000
)
