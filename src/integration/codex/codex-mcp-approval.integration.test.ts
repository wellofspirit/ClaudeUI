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
import {
  MCP_ELICITATION_ACCEPT,
  MCP_ELICITATION_DECLINE,
  mcpRuleToolName,
  readMcpToolApproval
} from '../../core/codex/mcp-elicitation'
import recorded from '../../core/codex/__tests__/fixtures/mcp-tool-approval-elicitation.json'

/**
 * Slice 4b guard 6 — the MCP tool approval, end to end against the pinned
 * binary.
 *
 * Slice 4 shipped the inherited `.mcp.json` servers and the first live call came
 * back "user rejected MCP tool call": Codex has no
 * `item/mcpToolCall/requestApproval`, it sends the server request
 * `mcpServer/elicitation/request` instead, ClaudeUI did not register that
 * method, and `core/src/mcp_tool_call.rs` reads the transport's "Method not
 * found" as a rejection. This file pins BOTH halves of the fix: the exact shape
 * of the request (recorded into
 * `__tests__/fixtures/mcp-tool-approval-elicitation.json`, which the unit guards
 * replay) and the fact that the accept body ClaudeUI sends really runs the tool.
 *
 * NO CREDENTIAL AND NO NETWORK. The provider is the scripted localhost fixture
 * the sibling files use; `chatgpt_base_url` and `GET /v1/models` point at it and
 * are answered 404. The "MCP server" is a stub written into the temp directory
 * that offers one `ping` tool and answers `tools/call` with a recognisable
 * string.
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

const SERVER_NAME = 'verify-stub'
const TOOL_NAME = 'ping'
const TOOL_REPLY = 'pong-from-mcp'

/**
 * A minimal stdio MCP server offering ONE tool. It records its own spawn and
 * every `tools/call` in the marker file, so "the tool ran" and "the tool did not
 * run" are both observable from outside the app-server.
 *
 * The tool declares NO annotations on purpose: `requires_mcp_tool_approval`
 * reads a missing `destructiveHint` as destructive, so an un-annotated tool is
 * the case that always reaches the approval path.
 */
const STUB_SOURCE = `import { appendFileSync } from 'node:fs'

const [marker, name] = process.argv.slice(2)
appendFileSync(marker, 'spawn:' + name + '\\n')

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
    let result = {}
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name, version: '1' }
      }
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: ${JSON.stringify(TOOL_NAME)},
            description: 'Answer with a fixed string.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
          }
        ]
      }
    else if (message.method === 'tools/call') {
      appendFileSync(marker, 'call:' + (message.params && message.params.name) + '\\n')
      result = { content: [{ type: 'text', text: ${JSON.stringify(TOOL_REPLY)} }], isError: false }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  }
})
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

/** One scripted model turn: what the provider emits for request `index`. */
type Script = (request: Record<string, unknown>, index: number) => Record<string, unknown>

interface Fixture {
  cwd: string
  env: NodeJS.ProcessEnv
  stub: string
  marker: string
  /** Every marker line so far: `spawn:<name>` and `call:<tool>`. */
  markers(): string[]
  /** Every `POST /v1/responses` body, oldest first. */
  requests: Record<string, unknown>[]
  /** The binary's own ancillary calls, answered 404. */
  backend: string[]
  errors: string[]
  script: { current: Script }
}

const finalMessage = (text: string): Record<string, unknown> => ({
  type: 'message',
  id: 'msg-fixture',
  role: 'assistant',
  content: [{ type: 'output_text', text }]
})

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
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-mcp-approval-')))
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

  const requests: Record<string, unknown>[] = []
  const backend: string[] = []
  const errors: string[] = []
  const script: { current: Script } = { current: () => finalMessage('fixture complete') }
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 4_000_000) req.destroy()
    })
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
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        errors.push(`unexpected provider request: ${req.method} ${req.url}`)
        res.writeHead(400).end()
        return
      }
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(body)
      } catch {
        errors.push('invalid provider JSON')
        res.writeHead(400).end()
        return
      }
      requests.push(parsed)
      const events = [
        { type: 'response.created', response: { id: 'resp-fixture' } },
        { type: 'response.output_item.done', item: script.current(parsed, requests.length - 1) },
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
  // `untrusted` is what ClaudeUI's default/acceptEdits modes map to (ADR-067),
  // and the one policy that asks BEFORE an MCP tool runs — but it is REFUSED in
  // `config.toml` by 0.154.0 ("approval_policy = \"untrusted\" is no longer
  // supported; remove this setting"), which is exactly why ClaudeUI sends it per
  // thread and per turn instead. The file therefore carries the default and the
  // requests carry the policy under test. `inherit = "all"` so the stub's
  // runtime gets the environment the self-check proves it starts under.
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
`
  )
  writeFileSync(
    join(codexHome, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'codex-fixture-not-a-real-key' })
  )
  return {
    cwd,
    stub,
    marker,
    requests,
    backend,
    errors,
    script,
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
}

/**
 * Proves the marker mechanism under the child's own environment, so a missing
 * marker later can only mean "not spawned" and never "could not boot".
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
  expect(fixture.markers()).toEqual(['spawn:selfcheck'])
}

type Notification = { method: string; params: Record<string, unknown> }
type Active = {
  client: CodexClient
  notifications: Notification[]
  elicitations: Record<string, unknown>[]
}

async function openClient(
  fixture: Fixture,
  answer: (params: Record<string, unknown>) => unknown
): Promise<Active> {
  const notifications: Notification[] = []
  const elicitations: Record<string, unknown>[] = []
  const client = new CodexClient({
    cwd: fixture.cwd,
    env: fixture.env,
    requestTimeoutMs: 30000,
    serverMethods: ['mcpServer/elicitation/request'],
    onServerRequest: async (_method, params) => {
      elicitations.push(params as Record<string, unknown>)
      return answer(params as Record<string, unknown>)
    },
    onNotification: (method, params) =>
      notifications.push({ method, params: params as Record<string, unknown> })
  })
  clients.push(client)
  await client.start({
    clientInfo: { name: 'codex_mcp_approval_probe', title: null, version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  return { client, notifications, elicitations }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 60000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Isolated Codex fixture deadline: ${label}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

/**
 * ClaudeUI's `default` mode, exactly as `codex-turn-policy.ts` spells it — the
 * policy is carried per thread and per turn precisely because `untrusted` is
 * refused in `config.toml`.
 */
const THREAD_POLICY = {
  approvalPolicy: 'untrusted',
  sandbox: 'workspace-write',
  approvalsReviewer: 'user'
} as const

/** One stdio `mcp_servers` entry in Codex's own JSON shape. */
const stdioEntry = (fixture: Fixture): JsonValue => ({
  command: process.execPath,
  args: [fixture.stub, fixture.marker, SERVER_NAME]
})

/**
 * The wire call Codex expects for the stub's tool, read off the `tools` array of
 * the model request rather than guessed: the model-side naming of an MCP tool is
 * the binary's business, and scripting a wrong one would fail as "tool not
 * available" long before the approval path.
 *
 * RECORDED (0.154.0, Windows x64, 2026-09-14): an MCP server reaches the model
 * as a Responses-API NAMESPACE, not as one flattened function name —
 * `{ type: "namespace", name: "mcp__verify_stub", tools: [{ type: "function",
 * name: "ping", … }] }` — and the server name is sanitised into the namespace
 * (`verify-stub` → `verify_stub`). The elicitation's `serverName` is the
 * UNSANITISED name, which is the one a Claude `mcp__<server>__<tool>` rule is
 * written against, so the gate uses that and never this.
 */
function mcpToolCall(request: Record<string, unknown>): { namespace: string; name: string } {
  const tools = (request.tools ?? []) as Record<string, unknown>[]
  const namespace = tools.find(
    (tool) => tool.type === 'namespace' && String(tool.name ?? '').startsWith('mcp__')
  )
  const inner = ((namespace?.tools ?? []) as Record<string, unknown>[]).find(
    (tool) => tool.name === TOOL_NAME
  )
  if (!namespace || !inner)
    throw new Error(`fixture: no MCP tool in ${JSON.stringify(tools.map((t) => t.name))}`)
  return { namespace: String(namespace.name), name: String(inner.name) }
}

/** Everything one model request carries back from the tool call. */
const inputText = (request: Record<string, unknown> | undefined): string =>
  JSON.stringify((request?.input ?? []) as unknown[])

/** Script: call the stub's tool once, then finish. */
function scriptOneCall(fixture: Fixture): void {
  fixture.script.current = (request, index) => {
    if (index > 0) return finalMessage('fixture complete')
    return {
      type: 'function_call',
      call_id: 'call-mcp-1',
      ...mcpToolCall(request),
      arguments: '{}'
    }
  }
}

async function startThread(
  fixture: Fixture,
  answer: (params: Record<string, unknown>) => unknown
): Promise<Active & { threadId: string }> {
  const opened = await openClient(fixture, answer)
  const started = await opened.client.request('thread/start', {
    cwd: fixture.cwd,
    model: 'mock-model',
    historyMode: 'paginated',
    allowProviderModelFallback: false,
    ...THREAD_POLICY,
    config: { mcp_servers: { [SERVER_NAME]: stdioEntry(fixture) } }
  })
  await waitFor(() => fixture.markers().includes(`spawn:${SERVER_NAME}`), 'the stub was spawned')
  return { ...opened, threadId: started.thread.id }
}

async function runTurn(active: Active, threadId: string): Promise<void> {
  const turn = await active.client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'call the ping tool', text_elements: [] }],
    ...THREAD_POLICY
  })
  await waitFor(
    () =>
      active.notifications.some(
        ({ method, params }) =>
          method === 'turn/completed' &&
          params.threadId === threadId &&
          (params.turn as { id: string })?.id === turn.turn.id
      ),
    `turn ${turn.turn.id}`
  )
}

/** The recorded shape, with the two ids only this run knows blanked. */
const shape = (params: Record<string, unknown>): Record<string, unknown> => ({
  ...params,
  threadId: '<threadId>',
  turnId: '<turnId>'
})

it.skipIf(!enabled)(
  'accepting the MCP approval elicitation runs the tool and completes the turn',
  async () => {
    const fixture = await setupFixture()
    selfCheck(fixture)
    scriptOneCall(fixture)

    const active = await startThread(fixture, () => MCP_ELICITATION_ACCEPT)
    await runTurn(active, active.threadId)

    // (1) Codex asked exactly once, over `mcpServer/elicitation/request`.
    expect(active.elicitations).toHaveLength(1)
    const params = active.elicitations[0]
    // (2) The RECORDED shape — what the unit guards replay. A binary that
    // changes the form's fields, its `_meta` keys or its message fails here
    // rather than silently degrading the gate to a server-wide scope.
    expect(shape(params)).toEqual(recorded)
    // (3) It reads as the tool approval, in Claude's rule vocabulary.
    const approval = readMcpToolApproval(params)
    expect(approval).toEqual({ server: SERVER_NAME, tool: TOOL_NAME, params: {} })
    expect(mcpRuleToolName(approval!.server, approval!.tool)).toBe(
      `mcp__${SERVER_NAME}__${TOOL_NAME}`
    )
    // (4) The accept body really approves: the stub's `tools/call` ran and its
    // answer reached the model.
    expect(fixture.markers()).toContain(`call:${TOOL_NAME}`)
    expect(inputText(fixture.requests.at(-1))).toContain(TOOL_REPLY)
    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'declining the MCP approval elicitation stops the tool and tells the model',
  async () => {
    const fixture = await setupFixture()
    selfCheck(fixture)
    scriptOneCall(fixture)

    const active = await startThread(fixture, () => MCP_ELICITATION_DECLINE)
    await runTurn(active, active.threadId)

    expect(active.elicitations).toHaveLength(1)
    expect(fixture.markers()).not.toContain(`call:${TOOL_NAME}`)
    // `parse_mcp_tool_approval_elicitation_response` maps decline to
    // `ReviewDecision::denied("user rejected MCP tool call")`, and the core hands
    // that rejection to the model as the tool's result.
    expect(inputText(fixture.requests.at(-1))).toContain('user rejected MCP tool call')
    expect(fixture.errors).toEqual([])
  },
  180000
)
