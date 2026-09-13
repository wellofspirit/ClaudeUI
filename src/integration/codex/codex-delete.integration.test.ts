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
import { CodexService } from '../../core/codex/CodexService'
import { CodexSession } from '../../core/codex/CodexSession'
import { listCodexSessions } from '../../core/codex/history'
import { buildCodexDeletePlan, codexDeletePlan, deleteCodexSubtree } from '../../core/codex/delete'
import { CodexTransportError } from '../../core/codex/CodexAppServerClient'
import { listCodexForks, registerCodexFork, setSessionMeta } from '../../core/services/db'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'

/**
 * Deleting a Codex session against the pinned binary (ADR-066 slice G).
 *
 * The fixture is a copy of `codex-app-server.integration.test.ts`'s — the same
 * isolated `CODEX_HOME`, the same scripted localhost Responses provider, the
 * same sandbox containment — because the delete walk needs REAL threads with
 * real rollout files and a real writer lock. Nothing here is a mock except the
 * database the walk prunes its rows from.
 *
 * What it pins:
 *  - the walk's leaf-first order against a real root → fork → fork-of-fork;
 *  - that stopping our own holder is enough, and that a holder we cannot stop
 *    ends the walk with everything above it untouched;
 *  - the CHILDREN question the slice G spec left open: a root that spawned a
 *    native collab agent deletes cleanly, because `thread/delete` expands the
 *    spawn subtree itself.
 */

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
const persistence = vi.hoisted(() => ({ close: () => {}, reset: () => {} }))
/** The isolated `session_meta` table these probes read their fork ids out of. */
const sessionMeta = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/db')>()
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  actual.runMigrations(db)
  persistence.close = () => db.close()
  // Every probe starts from an EMPTY registry: the module-level database
  // outlives each test, and a leftover fork row would silently join the next
  // probe's plan.
  persistence.reset = () => db.exec('DELETE FROM codex_forks')
  return {
    dispatchedCostsByRouting: () => [],
    // Reached only through cross-engine-dispatcher.ts's module singleton, which
    // CodexSession now imports (ADR-033 slice E). No dispatch in this file ever
    // gets far enough to record a row — the target is stubbed — so this exists
    // to keep the mock's export surface honest, not to be called.
    insertDispatchedUsage: vi.fn(),
    // Real rows, not spies: the fork registry `listCodexSessions` reads (and
    // the legacy session_meta sweep it adopts once) must be the real thing, or
    // a stubbed table would make this trivially pass. `setSessionMeta` and
    // friends take no db handle, so the isolated session_meta table is this map
    // rather than the in-memory database used for the overrides and the forks.
    setSessionMeta: (id: string, meta: unknown) => void sessionMeta.set(id, meta),
    getSessionMeta: (id: string) => sessionMeta.get(id),
    allSessionMeta: () => Object.fromEntries(sessionMeta),
    registerCodexFork: (id: string, from: string | null) => actual.registerCodexFork(id, from, db),
    deleteSessionMeta: (id: string) => void sessionMeta.delete(id),
    deleteCodexSessionOverrides: (id: string) => actual.deleteCodexSessionOverrides(id, db),
    listCodexForks: () => actual.listCodexForks(db),
    deleteCodexFork: (id: string) => actual.deleteCodexFork(id, db),
    codexForkSweepDone: () => actual.codexForkSweepDone(db),
    markCodexForkSweepDone: () => actual.markCodexForkSweepDone(db),
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
const clients: CodexAppServerClient[] = []
let service: CodexService | undefined
let session: CodexSession | undefined
let directory: string | undefined
let server: ReturnType<typeof createServer> | undefined
let websocket: WebSocketServer | undefined
afterEach(async () => {
  coreEvents.mockClear()
  sessionMeta.clear()
  persistence.reset()
  const survivors: number[] = []
  try {
    for (const held of clients.splice(0)) held.dispose()
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

/**
 * The hosted-tool call the fixture scripts on the agent's FIRST turn: `true` is
 * the `render_mermaid` default, or name the tool and its arguments outright
 * (slice E scripts `dispatch_agent` this way). `false` scripts no tool call.
 */
type ScriptedHostedTool = boolean | { name: string; arguments: Record<string, unknown> }

/**
 * The prompt the ROOT turn is driven with when the fixture scripts native
 * agents. A spawned child starts a FRESH thread seeded with the spawn message
 * only (no fork), so this string appears in the root's request bodies and in no
 * child's — which is the only reliable way to tell the two apart on one shared
 * provider, since both speak the same wire on the same socket.
 */
const ROOT_TURN_MARKER = 'fixture-root-turn-marker'
/** The `message` the scripted `spawn_agent` call hands its child. */
const CHILD_TASK_PROMPT = 'fixture child task'

async function setupFixture(
  plainResponse = false,
  nativeSession = false,
  nativeCommand = false,
  autoReview = false,
  hostedTool: ScriptedHostedTool = false,
  // Which native collaboration surface to script. It is chosen by the MODEL,
  // not by the `multi_agent_v2` feature flag — `Config::multi_agent_version_for_model`
  // consults the catalog entry's own `multi_agent_version` first — so `'v1'`
  // pins the one catalogued model that declares v1 and `'v2'` simply takes the
  // default model, which declares v2.
  nativeAgent: false | 'v1' | 'v2' = false
) {
  const scripted =
    hostedTool === true
      ? {
          name: 'render_mermaid',
          arguments: { source: 'graph TD; A-->B', title: 'Fixture diagram' }
        }
      : hostedTool || undefined
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
          // Native agents (slice F): the CHILD is a separate thread on this same
          // provider, so the root's own step index must count only the root's
          // requests — and the child must be answered too, or its turn never
          // ends and nothing reaches the parent's card.
          const body = JSON.stringify(request)
          const root = body.includes(ROOT_TURN_MARKER)
          const rootTurns = requests.filter(
            (entry) =>
              !isGuardianRequest(entry) &&
              entry.generate !== false &&
              JSON.stringify(entry).includes(ROOT_TURN_MARKER)
          ).length
          // The child id the core handed back as `spawn_agent`'s output, read
          // out of the root's own next request. JSON-in-JSON, so the quotes may
          // be escaped.
          const spawned = /agent_id\\?"\s*:\s*\\?"([0-9a-fA-F-]{8,})/.exec(body)?.[1]
          const nativeAgentItem =
            nativeAgent && request.generate !== false && !guardian
              ? !root
                ? {
                    type: 'message',
                    id: 'msg-child',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'fixture child complete' }]
                  }
                : rootTurns === 1
                  ? {
                      type: 'function_call',
                      call_id: 'fixture-spawn',
                      name: 'spawn_agent',
                      namespace: nativeAgent === 'v2' ? 'collaboration' : 'multi_agent_v1',
                      arguments: JSON.stringify(
                        nativeAgent === 'v2'
                          ? {
                              task_name: 'fixture_child',
                              message: CHILD_TASK_PROMPT,
                              // Without this the child FORKS the root's history
                              // and the marker below stops telling them apart —
                              // and the child would answer the root's prompt
                              // rather than its own task.
                              fork_turns: 'none'
                            }
                          : { message: CHILD_TASK_PROMPT }
                      )
                    }
                  : rootTurns === 2 && (nativeAgent === 'v2' || spawned)
                    ? {
                        type: 'function_call',
                        call_id: 'fixture-wait',
                        name: 'wait_agent',
                        namespace: nativeAgent === 'v2' ? 'collaboration' : 'multi_agent_v1',
                        arguments: JSON.stringify(
                          // v2's `wait_agent` waits for inter-agent ACTIVITY and
                          // names no targets; v1's waits for the agents it is
                          // given to reach a final status.
                          nativeAgent === 'v2'
                            ? { timeout_ms: 30000 }
                            : { targets: [spawned], timeout_ms: 30000 }
                        )
                      }
                    : undefined
              : undefined
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
                : nativeAgentItem
                  ? nativeAgentItem
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
                    : scripted && request.generate !== false && agentTurns === 1
                      ? {
                          type: 'function_call',
                          call_id: `fixture-${scripted.name}`,
                          name: scripted.name,
                          arguments: JSON.stringify(scripted.arguments)
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
    // `multi_agent_v1` vs `multi_agent_v2` is chosen by the MODEL, not by the
    // `multi_agent_v2` feature flag: `Config::multi_agent_version_for_model`
    // consults the catalog entry's own `multi_agent_version` before falling
    // back to the features, and the default (`gpt-6-astra`) declares v2. Pin
    // the one catalogued model that declares v1 so this probe exercises the
    // `collabAgentToolCall` surface it is about.
    `${nativeAgent === 'v1' ? 'model = "gpt-5.6-luna"' : nativeSession ? '' : 'model = "mock-model"'}
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
    rootPrompt: ROOT_TURN_MARKER,
    childPrompt: CHILD_TASK_PROMPT,
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

// ---------------------------------------------------------------------------
// Helpers (raw-client drives, copied from codex-lifecycle.integration.test.ts)
// ---------------------------------------------------------------------------

type Notification = { method: string; params: Record<string, unknown> }

/** A fresh app-server process with its own connection. Each one is a HOLDER. */
async function holder(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ client: CodexAppServerClient; notifications: Notification[] }> {
  const notifications: Notification[] = []
  const held = new CodexAppServerClient({
    cwd,
    env,
    requestTimeoutMs: 15000,
    onNotification: (method, params) =>
      notifications.push({ method, params: params as Record<string, unknown> })
  })
  clients.push(held)
  await held.start({
    clientInfo: { name: 'codex_delete_probe', title: null, version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  return { client: held, notifications }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Isolated Codex fixture deadline: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function runTurn(
  client: CodexAppServerClient,
  notifications: Notification[],
  threadId: string,
  text: string
): Promise<string> {
  const turn = await client.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }]
  })
  await waitFor(
    () =>
      notifications.some(
        ({ method, params }) =>
          method === 'turn/completed' &&
          params.threadId === threadId &&
          (params.turn as { id: string })?.id === turn.turn.id
      ),
    `turn ${text}`
  )
  return turn.turn.id
}

/**
 * `thread/read` is the only observable proof a TURN-LESS fork is gone: the
 * native listing does not carry one until it has run a turn of its own.
 */
async function readable(service: CodexService, threadId: string): Promise<string> {
  return service
    .readThread({ threadId, includeTurns: false })
    .then(() => 'ok')
    .catch((error: Error) => error.message)
}

/** The ONE refusal code the binary answers every lifecycle "no" with. */
const REFUSED = 'Codex transport: rpc-error--32600'

it.skipIf(!enabled)(
  'deletes a branched session leaf-first, stopping the holder it owns',
  async () => {
    const { cwd, env, errors } = await setupFixture(true)
    const root = await holder(cwd, env)
    const started = await root.client.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const rootId = started.thread.id
    const anchor = await runTurn(root.client, root.notifications, rootId, 'one')

    // root → forkA, forkB; forkA → forkA1. Registered exactly as CodexSession
    // registers a branch it mints (db v16), which is the only record of a fork
    // that exists — `thread/list` never returns one.
    const forker = await holder(cwd, env)
    const fork = async (threadId: string): Promise<string> => {
      const result = await forker.client.request<{ thread: { id: string } }>('thread/fork', {
        threadId,
        lastTurnId: anchor,
        cwd
      })
      registerCodexFork(result.thread.id, threadId)
      return result.thread.id
    }
    const forkA = await fork(rootId)
    const forkB = await fork(rootId)
    const forkA1 = await fork(forkA)
    forker.client.dispose()
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // forkB stays HELD by a live process, as a running ClaudeUI session would
    // hold it. Resuming it is what takes the writer lock.
    const live = await holder(cwd, env)
    await live.client.request('thread/resume', { threadId: forkB, cwd })

    service = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
    // The two threads a live ClaudeUI session would be holding: the root, and
    // the branch somebody opened. Both are refused until their process is gone.
    const holders = new Map([
      [rootId, root.client],
      [forkB, live.client]
    ])
    const plan = buildCodexDeletePlan(rootId, listCodexForks(), (id) => ({
      title: null,
      live: holders.has(id)
    }))
    // Depth first, then registry order: the fork-of-fork, its parent, the
    // sibling, the root. Any other order stops on the first node.
    expect(plan.order).toEqual([forkA1, forkA, forkB, rootId])

    const stopped: string[] = []
    const walked: string[] = []
    await deleteCodexSubtree(
      plan,
      {
        unwatch: (id) => walked.push(id),
        // What `SessionManager.cancel` does for a Codex session: dispose the
        // client, which signals the app-server process group. The writer lock
        // outlives that by up to `killGraceMs`, which is what the walk's retry
        // window is for — this walk would fail outright without it.
        stop: (id) => {
          stopped.push(id)
          holders.get(id)?.dispose()
        },
        removeSession: () => {}
      },
      { cwd, env }
    )

    expect(walked).toEqual(plan.order)
    expect(stopped).toEqual([forkB, rootId])
    // Every thread is gone: the root is off the native listing, and each fork —
    // which was never ON it — is refused by `thread/read`.
    expect((await service.listAllThreads()).map((thread) => thread.id)).toEqual([])
    for (const id of [forkA1, forkA, forkB, rootId])
      expect(await readable(service, id)).toBe(REFUSED)
    // ...and ClaudeUI has forgotten every branch it recorded.
    expect(listCodexForks()).toEqual([])
    expect(await listCodexSessions({ cwd, env })).toEqual([])
    expect(errors).toEqual([])
  },
  120000
)

it.skipIf(!enabled)(
  'stops non-destructively at a holder it cannot stop',
  async () => {
    const { cwd, env, errors } = await setupFixture(true)
    const root = await holder(cwd, env)
    const started = await root.client.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const rootId = started.thread.id
    const anchor = await runTurn(root.client, root.notifications, rootId, 'one')
    const forker = await holder(cwd, env)
    const forked = async (): Promise<string> => {
      const result = await forker.client.request<{ thread: { id: string } }>('thread/fork', {
        threadId: rootId,
        lastTurnId: anchor,
        cwd
      })
      registerCodexFork(result.thread.id, rootId)
      return result.thread.id
    }
    const doomed = await forked()
    const stubborn = await forked()
    forker.client.dispose()
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // A process ClaudeUI does not own holds `stubborn` — another window, a
    // terminal `codex`. Nothing the walk can stop, so the delete is refused.
    const outsider = await holder(cwd, env)
    await outsider.client.request('thread/resume', { threadId: stubborn, cwd })

    service = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
    const order = listCodexForks().map((fork) => fork.threadId)
    const plan = buildCodexDeletePlan(rootId, listCodexForks(), () => ({
      title: null,
      live: false
    }))
    expect(plan.order).toEqual([...order, rootId])

    await expect(
      deleteCodexSubtree(
        plan,
        { unwatch: () => {}, stop: () => {}, removeSession: () => {} },
        {
          cwd,
          env
        }
      )
    ).rejects.toThrow(new RegExp(`Codex refused to delete ${stubborn}`))

    // Everything BEFORE the refusal is gone; everything after it is untouched,
    // including the root — which the binary would refuse anyway while the
    // surviving fork references its history.
    expect(await readable(service, doomed)).toBe(REFUSED)
    expect(await readable(service, stubborn)).toBe('ok')
    expect(await readable(service, rootId)).toBe('ok')
    expect((await service.listAllThreads()).map((thread) => thread.id)).toEqual([rootId])
    // The refused branch keeps its registry row, so the sidebar still lists it.
    expect(listCodexForks().map((fork) => fork.threadId)).toEqual([stubborn])
    expect(errors).toEqual([])
  },
  120000
)

/**
 * THE CHILDREN PROBE the slice G spec left open.
 *
 * A spawned collab agent is a thread of its own with a `parentThreadId`, never
 * listed and never a session in ClaudeUI. The question was whether it blocks
 * its parent's delete the way a FORK does. It does not, and the reason is in
 * the source: `thread_delete.rs` expands the id through
 * `state_db_spawn_subtree_thread_ids` and deletes the descendants before the
 * root, in one request. So the plan contains forks and nothing else.
 */
it.skipIf(!enabled)(
  'deletes a root that spawned a native child, and takes the child with it',
  async () => {
    const { cwd, env, errors, rootPrompt } = await setupFixture(
      true,
      true,
      false,
      false,
      false,
      'v1'
    )
    session = new CodexSession(
      'isolated-delete-children',
      null,
      cwd,
      {},
      { env, requestTimeoutMs: 20000 }
    )
    await session.run(null)
    const rootId = session.getSessionId()!
    await session.run(rootPrompt)
    await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 60000 })
    const card = session
      .getMessages()
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_use' && block.toolName === 'collab:spawnAgent') as
      { toolInput?: Record<string, unknown> } | undefined
    const childId = (card?.toolInput?.receiverThreadIds as string[] | undefined)?.[0]
    expect(childId).toBeTruthy()
    session.dispose()
    session = undefined
    await new Promise((resolve) => setTimeout(resolve, 1500))

    service = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
    // The child is a real, readable thread before the delete...
    expect(await readable(service, childId!)).toBe('ok')
    const plan = buildCodexDeletePlan(rootId, listCodexForks(), () => ({
      title: null,
      live: false
    }))
    // ...and it is NOT in the plan: only forks are walked.
    expect(plan.order).toEqual([rootId])

    await deleteCodexSubtree(
      plan,
      { unwatch: () => {}, stop: () => {}, removeSession: () => {} },
      { cwd, env }
    )

    // One request removed both. A child left behind would be an orphan thread
    // nothing can ever reach again.
    expect(await readable(service, rootId)).toBe(REFUSED)
    expect(await readable(service, childId!)).toBe(REFUSED)
    expect((await service.listAllThreads()).map((thread) => thread.id)).toEqual([])
    expect(errors).toEqual([])
  },
  180000
)

// ---------------------------------------------------------------------------
// The registry is not the only source of truth a delete can afford to trust
// ---------------------------------------------------------------------------
//
// Found on the real app (2026-09-13): `codex_forks` held nothing but the
// adoption marker, so the plan for a branched root was the root ALONE and the
// native delete refused it — correctly, since both branches still referenced
// its history. The two probes below are that failure and its cause.

it.skipIf(!enabled)(
  'plans and deletes a branch that only session_meta knows about',
  async () => {
    const { cwd, env, errors } = await setupFixture(true)
    const root = await holder(cwd, env)
    const started = await root.client.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const rootId = started.thread.id
    const anchor = await runTurn(root.client, root.notifications, rootId, 'one')
    const forker = await holder(cwd, env)
    const forked = await forker.client.request<{ thread: { id: string } }>('thread/fork', {
      threadId: rootId,
      lastTurnId: anchor,
      cwd
    })
    const forkId = forked.thread.id
    // THE REAL-WORLD SHAPE: the branch has been used. That is what puts it in
    // `thread/list` — where the entry carries no `forkedFromId` — and it is why
    // the sweep that skipped listed ids never learned it was a branch.
    await runTurn(forker.client, forker.notifications, forkId, 'the branch does some work')
    forker.client.dispose()
    root.client.dispose()
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // The state a user was actually left in: the branch is in `session_meta`
    // (every Codex session is) and NOT in the fork registry.
    setSessionMeta(rootId, { engineId: 'codex' })
    setSessionMeta(forkId, { engineId: 'codex' })
    expect(listCodexForks()).toEqual([])

    service = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
    // Pinned here too, because the whole probe rests on it: the branch is
    // listed, and its list entry looks exactly like a root's.
    const listedThreads = await service.listAllThreads()
    expect(listedThreads.map((thread) => thread.id).sort()).toEqual([forkId, rootId].sort())
    expect(listedThreads.find((thread) => thread.id === forkId)?.forkedFromId ?? null).toBeNull()
    const plan = await codexDeletePlan(rootId, () => ({ title: null, live: false }), { cwd, env })
    // PRE-FIX this was `[rootId]` and the walk was refused on the first node.
    expect(plan.order).toEqual([forkId, rootId])
    // The sweep also REGISTERED what it found, so the sidebar has it back.
    expect(listCodexForks()).toEqual([{ threadId: forkId, forkedFromId: rootId }])

    await deleteCodexSubtree(
      plan,
      { unwatch: () => {}, stop: () => {}, removeSession: () => {} },
      { cwd, env }
    )
    expect(await readable(service, forkId)).toBe(REFUSED)
    expect(await readable(service, rootId)).toBe(REFUSED)
    expect(listCodexForks()).toEqual([])
    expect(errors).toEqual([])
  },
  120000
)

it.skipIf(!enabled)(
  'never drops a branch on a single `-32600` — the refusal has to survive a re-read',
  async () => {
    const { cwd, env, errors } = await setupFixture(true)
    const root = await holder(cwd, env)
    const started = await root.client.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const rootId = started.thread.id
    const anchor = await runTurn(root.client, root.notifications, rootId, 'one')
    const forker = await holder(cwd, env)
    const forked = await forker.client.request<{ thread: { id: string } }>('thread/fork', {
      threadId: rootId,
      lastTurnId: anchor,
      cwd
    })
    const forkId = forked.thread.id
    registerCodexFork(forkId, rootId)
    forker.client.dispose()
    root.client.dispose()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    setSessionMeta(rootId, { engineId: 'codex' })
    setSessionMeta(forkId, { engineId: 'codex' })

    // A REAL service whose first read of the branch is refused, as the machine
    // in the incident report refused two live forks on a fresh process. Every
    // later read is the binary's own answer.
    const real = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
    service = real
    let refusals = 1
    const flaky = Object.create(real) as CodexService
    flaky.readThread = async (params) => {
      if (params.threadId === forkId && refusals-- > 0)
        throw new CodexTransportError('rpc-error--32600')
      return real.readThread(params)
    }

    // `listCodexSessions` gates on `codexBinaryAvailable()`, which demands the
    // code-mode host BESIDE the binary. The fixture copies only `codex` (the
    // host is 62 MB and no other probe here needs it), so place it for this one.
    copyFileSync(
      resolve('vendor/codex-cli/codex-code-mode-host'),
      join(directory!, 'vendor/codex-cli/codex-code-mode-host')
    )
    const listed = await listCodexSessions({ cwd, env }, { service: flaky, confirmDelayMs: 50 })
    // PRE-FIX: the row was pruned here and the branch was gone from the sidebar
    // for good — the thread itself is untouched, so nothing could bring it back.
    expect(listed.map((info) => info.sessionId).sort()).toEqual([forkId, rootId].sort())
    expect(listCodexForks()).toEqual([{ threadId: forkId, forkedFromId: rootId }])
    expect(await readable(real, forkId)).toBe('ok')
    expect(errors).toEqual([])
  },
  120000
)

/**
 * Can the pinned binary be MADE to refuse a live thread transiently? This is the
 * shape the incident happened in: a fresh app-server, `thread/list`, then four
 * concurrent metadata reads of ids that list omits. Recorded rather than
 * asserted — a probe that cannot reproduce a race proves nothing about the
 * race, and failing the suite on that would be worse than useless.
 */
it.skipIf(!enabled)(
  'probes whether a cold app-server ever refuses a live fork',
  async () => {
    const { cwd, env, errors } = await setupFixture(true)
    const root = await holder(cwd, env)
    const started = await root.client.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const rootId = started.thread.id
    const anchor = await runTurn(root.client, root.notifications, rootId, 'one')
    const forker = await holder(cwd, env)
    const forks: string[] = []
    for (let index = 0; index < 4; index++) {
      const forked = await forker.client.request<{ thread: { id: string } }>('thread/fork', {
        threadId: index === 0 ? rootId : forks[index - 1],
        ...(index === 0 ? { lastTurnId: anchor } : {}),
        cwd
      })
      forks.push(forked.thread.id)
    }
    forker.client.dispose()
    root.client.dispose()
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const refusals: Array<{ attempt: number; threadId: string }> = []
    for (let attempt = 0; attempt < 6; attempt++) {
      // A FRESH service each round: `CodexService` releases its client when the
      // last read finishes, so every round is a cold app-server process.
      const cold = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
      try {
        await cold.listAllThreads()
        const answers = await Promise.all(
          forks.map((threadId) =>
            cold
              .readThread({ threadId, includeTurns: false })
              .then(() => null)
              .catch((error: Error) => (error.message === REFUSED ? threadId : null))
          )
        )
        for (const threadId of answers) if (threadId) refusals.push({ attempt, threadId })
      } finally {
        cold.dispose()
      }
    }
    console.log(JSON.stringify({ probe: 'transient-refusal', rounds: 6, refusals }))
    expect(errors).toEqual([])
  },
  180000
)
