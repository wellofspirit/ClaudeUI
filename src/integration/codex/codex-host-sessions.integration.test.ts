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
import { WebSocketServer } from 'ws'
import { CodexSession } from '../../core/codex/CodexSession'
import { CodexHostRegistry } from '../../core/codex/CodexHost'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'
import { codexIntegrationEnabled } from './integration-host'
import {
  FIXTURE_AUTHORIZATION,
  FIXTURE_API_KEY,
  FIXTURE_COMPLETED,
  fixtureAssistantMessage,
  startFixtureProvider,
  writeFixtureCodexHome,
  type FixtureOutputItem,
  type FixtureProvider
} from './fixture-provider'
import type { PendingApproval, SessionStatus } from '../../shared/types'

/**
 * H2 — SESSIONS AS THREADS ON A HOST, against the pinned binary
 * ([ADR-069](../../../docs/adr/adr-069_codex-host-per-home-and-account.md) §2).
 *
 * H0's P1 proved the binary keeps three threads apart on ONE stdio connection.
 * This suite proves the SESSION LAYER does: two real `CodexSession`s that never
 * spawn a process of their own, sharing one `codex app-server`, each running its
 * own turn with its own scripted approval. What it guards, in the order the
 * tests run:
 *
 *  - one host for two sessions, and nothing crossing between them — each
 *    session's approval card carries its own thread, answering one completes
 *    exactly that session's turn, and neither transcript holds the other's text;
 *  - disposing one session mid-turn leaves the other one running on the same
 *    process (before ADR-069 that dispose was a `taskkill`, so the question
 *    could not even be asked);
 *  - a host DEATH is the opencode server's death (ADR-045): every session on it
 *    goes `disconnected` with one error line each;
 *  - a session resumed after that death reopens its thread on a fresh host and
 *    the killed turn is there, marked `interrupted` — P2's answer through the
 *    session layer, which is what makes a `disconnected` Codex session
 *    renderable rather than a hole.
 *
 * NO CREDENTIAL AND NO NETWORK. The provider is the scripted localhost fixture
 * the sibling suites use; `auth.json` holds an API key that authenticates
 * nothing, and the vault is never reached — every session here is built without
 * an auth hook, so its host asks for no identity at all.
 */

/**
 * macOS wraps the binary in a seatbelt profile that allows only the fixture
 * port; Windows and Linux rely on the fixture's own isolation (a replacement
 * environment, a temp `CODEX_HOME`, a localhost-only provider, every network
 * feature off), exactly as the sibling probe suites do.
 *
 * Which child is the APP-SERVER is recorded here too, because one test has to
 * kill it the way a crash would — from the outside, without the transport being
 * asked politely first.
 */
const containment = vi.hoisted(() => ({
  profile: '',
  pids: [] as number[],
  appServers: [] as number[]
}))
const coreEvents = vi.hoisted(() => vi.fn())
vi.mock('../../core/services/sync-host', () => ({ emitEvent: coreEvents }))
// The shared permission gate merges the USER's real ~/.claude rules; pinned
// empty so the approvals below are the mode base, not this machine's settings.
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
// Same reasoning for the inherited MCP list (ADR-068 §5): the real collector
// reads this machine's ~/.claude and would spawn the developer's own servers
// inside the isolated app-server.
vi.mock('../../core/codex/codex-mcp-bridge', () => ({
  collectClaudeMcpForCodex: () => ({ servers: {}, skipped: [] })
}))
/** Session metadata and overrides, in memory: no Electron `app`, no user data. */
const overrides = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../../core/services/db', () => ({
  dispatchedCostsByRouting: () => [],
  insertUsageEvent: vi.fn(),
  setSessionMeta: vi.fn(),
  registerCodexFork: vi.fn(),
  getCodexSessionOverrides: (id: string) => overrides.get(id),
  hasCodexSessionOverrides: (id: string) => overrides.has(id),
  ensureCodexSessionOverrides: (id: string) => {
    if (!overrides.has(id)) overrides.set(id, {})
  },
  setCodexSessionOverrides: (id: string, settings: unknown) =>
    overrides.set(id, structuredClone(settings))
}))
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
      if (child.pid) {
        containment.pids.push(child.pid)
        if ((args as string[]).includes('app-server')) containment.appServers.push(child.pid)
      }
      return child
    }) as typeof original.spawn
  }
})

const enabled = codexIntegrationEnabled

const registries: CodexHostRegistry[] = []
const sessions: CodexSession[] = []
let directory: string | undefined
let provider: FixtureProvider | undefined
let websocket: WebSocketServer | undefined
/** Sockets a HELD turn was left open on, closed with the provider. */
const openSockets = new Set<{ close: () => void }>()

afterEach(async () => {
  const survivors: number[] = []
  try {
    for (const session of sessions.splice(0)) session.dispose()
    // The hosts are what own processes now, so this is the whole teardown.
    for (const registry of registries.splice(0)) registry.dispose()
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
    containment.appServers.length = 0
  } finally {
    try {
      for (const socket of openSockets) socket.close()
      openSockets.clear()
      websocket?.close()
      websocket = undefined
      await provider?.close()
      provider = undefined
    } finally {
      setHostPaths(null)
      overrides.clear()
      coreEvents.mockClear()
      if (directory) rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  }
  expect(survivors, 'app-server groups survived bounded disposal').toEqual([])
})

/**
 * One model request's scripted answer, or HOLD to leave the turn mid-flight.
 *
 * The wire is a WEBSOCKET, not HTTP: a ClaudeUI SESSION refuses any
 * `model_provider` but the built-in `openai` one (`assertCodexProvider`), and
 * that provider advertises websockets, so this is the transport Codex actually
 * uses here — the same one `codex-app-server.integration.test.ts`'s
 * native-session probes speak. Holding is therefore not answering the socket:
 * the turn stays open until the app-server dies or this file closes it.
 */
const HOLD = Symbol('hold')
type Script = (turn: {
  request: Record<string, unknown>
  requests: Record<string, unknown>[]
}) => FixtureOutputItem | typeof HOLD

interface Fixture {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Every request the fixture refused. A non-empty array IS a failure. */
  errors: string[]
  /** Every model request, oldest first — the websocket caller pushes here too. */
  requests: Record<string, unknown>[]
  /** Swappable mid-test. */
  script: { current: Script }
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
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-host-sessions-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, 'vendor/codex-cli')])
    mkdirSync(name, { recursive: true })
  const exe = process.platform === 'win32' ? '.exe' : ''
  copyFileSync(installed, join(directory, 'vendor/codex-cli', `codex${exe}`))
  // Both members: the locator refuses a `codex` without its code-mode host.
  copyFileSync(
    resolve('vendor/codex-cli', `codex-code-mode-host${exe}`),
    join(directory, 'vendor/codex-cli', `codex-code-mode-host${exe}`)
  )
  setHostPaths({ getAppPath: () => directory! })

  const script: { current: Script } = { current: () => fixtureAssistantMessage() }
  const requests: Record<string, unknown>[] = []
  const errors: string[] = []
  websocket = new WebSocketServer({ noServer: true, maxPayload: 4_000_000 })
  provider = await startFixtureProvider({
    requests,
    errors,
    authorization: FIXTURE_AUTHORIZATION,
    onUpgrade: (req, socket, head) => {
      if (req.url !== '/v1/responses' || req.headers.authorization !== FIXTURE_AUTHORIZATION) {
        errors.push('unexpected websocket upgrade')
        socket.destroy()
        return
      }
      websocket!.handleUpgrade(req, socket, head, (connection) => {
        openSockets.add(connection)
        connection.on('close', () => openSockets.delete(connection))
        connection.on('message', (data) => {
          const request = JSON.parse(data.toString()) as Record<string, unknown>
          requests.push(request)
          const item = script.current({ request, requests })
          // A held turn is one this socket never answers.
          if (item === HOLD) return
          for (const event of [
            { type: 'response.created', response: { id: 'resp-fixture' } },
            { type: 'response.output_item.done', item },
            FIXTURE_COMPLETED
          ])
            connection.send(JSON.stringify(event))
        })
      })
    },
    script: (turn) => {
      const item = script.current(turn)
      // The HTTP path is only reached if the provider ever declines the
      // websocket wire; holding there is not something these tests need.
      return item === HOLD ? fixtureAssistantMessage() : item
    }
  })
  const port = provider.port
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
  // `provider: 'openai'` with `openai_base_url` pointed at the fixture: a
  // SESSION refuses any other `model_provider` (`assertCodexProvider`), and the
  // built-in provider cannot be redeclared in `[model_providers]`.
  writeFixtureCodexHome(codexHome, {
    port,
    model: null,
    provider: 'openai',
    openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: FIXTURE_API_KEY
  })
  return {
    cwd,
    errors,
    requests,
    script,
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

/** Every payload one session emitted on one channel, oldest first. */
function emitted<T>(routingId: string, channel: string): T[] {
  return coreEvents.mock.calls
    .filter((call) => call[0] === channel && (call[1] as [string, unknown])[0] === routingId)
    .map((call) => (call[1] as [string, T])[1])
}

function newSession(
  routingId: string,
  registry: CodexHostRegistry,
  fixture: Fixture
): CodexSession {
  const session = new CodexSession(
    routingId,
    null,
    fixture.cwd,
    {},
    { env: fixture.env, requestTimeoutMs: 30000 },
    registry
  )
  sessions.push(session)
  return session
}

function registry(): CodexHostRegistry {
  // A LOCAL registry, never the module singleton: these tests assert how many
  // hosts exist, and a singleton shared with the rest of the run could not
  // answer that honestly.
  const built = new CodexHostRegistry()
  registries.push(built)
  return built
}

async function waitFor(predicate: () => boolean, label: string, ms = 60000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Isolated Codex fixture deadline: ${label}`)
    await new Promise((done) => setTimeout(done, 25))
  }
}

/** The scripted `exec_command` that always needs an approval under `untrusted`. */
const escalatedCommand = (tag: string): FixtureOutputItem => ({
  type: 'function_call',
  call_id: `call-${tag}`,
  name: 'exec_command',
  arguments: JSON.stringify({
    // Deliberately not a real program: what is under test is the approval
    // REQUEST and which session it reaches, never what the command does.
    cmd: `codexui-host-session-noop ${tag}`,
    sandbox_permissions: 'require_escalated',
    justification: 'Isolated fixture approval probe'
  })
})

/**
 * Per-session scripting on ONE shared provider: the prompt's marker rides in
 * every later request of that thread's history, so counting the requests that
 * carry it is the only reliable way to give each session its own step index
 * while two turns interleave on one socket (the same trick H0's P1 uses).
 */
function markerScript(markers: string[]): Script {
  return ({ request, requests }) => {
    if (request.generate === false) return fixtureAssistantMessage()
    const body = JSON.stringify(request)
    const marker = markers.find((entry) => body.includes(entry))
    if (!marker) return fixtureAssistantMessage()
    const step = requests.filter(
      (entry) => entry.generate !== false && JSON.stringify(entry).includes(marker)
    ).length
    return step === 1 ? escalatedCommand(marker) : fixtureAssistantMessage(`done ${marker}`)
  }
}

const statuses = (routingId: string): SessionStatus[] =>
  emitted<SessionStatus>(routingId, 'session:status')
const state = (routingId: string): string | undefined => statuses(routingId).at(-1)?.state
const cards = (routingId: string): PendingApproval[] =>
  emitted<PendingApproval>(routingId, 'session:approval-request')
const texts = (session: CodexSession): string[] =>
  session
    .getMessages()
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))

it.skipIf(!enabled)(
  'two sessions share ONE app-server and keep their turns, approvals and transcripts apart',
  async () => {
    const fixture = await setupFixture()
    const hosts = registry()
    const markers = ['host-session-alpha', 'host-session-beta']
    fixture.script.current = markerScript(markers)

    const alpha = newSession('routing-alpha', hosts, fixture)
    const beta = newSession('routing-beta', hosts, fixture)
    await Promise.all([alpha.run(null), beta.run(null)])

    // The whole point of ADR-069 §2: two sessions, one process.
    expect(hosts.size).toBe(1)
    expect(alpha.getSessionId()).toBeTruthy()
    expect(beta.getSessionId()).not.toBe(alpha.getSessionId())
    expect(containment.appServers).toHaveLength(1)

    await Promise.all([
      alpha.run(`Run the command. ${markers[0]}`),
      beta.run(`Run the command. ${markers[1]}`)
    ])
    await waitFor(
      () => cards('routing-alpha').length === 1 && cards('routing-beta').length === 1,
      'both approvals'
    )

    // Each card belongs to its OWN thread: the demultiplexer routed by
    // `threadId`, and the card's `toolUseId` encodes the thread it came from.
    expect(cards('routing-alpha')[0]!.toolUseId).toContain(alpha.getSessionId()!)
    expect(cards('routing-beta')[0]!.toolUseId).toContain(beta.getSessionId()!)
    expect(cards('routing-alpha')[0]!.toolUseId).not.toContain(beta.getSessionId()!)

    // Answering ONE completes exactly that session's turn.
    alpha.resolveApproval(cards('routing-alpha')[0]!.requestId, 'allow')
    await waitFor(() => !alpha.willQueue, 'alpha turn end')
    expect(beta.willQueue).toBe(true)

    beta.resolveApproval(cards('routing-beta')[0]!.requestId, 'allow')
    await waitFor(() => !beta.willQueue, 'beta turn end')

    expect(texts(alpha).join(' ')).toContain(markers[0])
    expect(texts(alpha).join(' ')).not.toContain(markers[1])
    expect(texts(beta).join(' ')).toContain(markers[1])
    expect(texts(beta).join(' ')).not.toContain(markers[0])
    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'disposing one session mid-turn leaves the other one running on the same host',
  async () => {
    const fixture = await setupFixture()
    const hosts = registry()
    const markers = ['host-session-doomed', 'host-session-survivor']
    // The doomed session's turn is held OPEN by the provider, so it really is
    // mid-flight when it is disposed; the survivor's answers normally.
    fixture.script.current = ({ request, requests }) => {
      const body = JSON.stringify(request)
      if (body.includes(markers[0])) return HOLD
      return markerScript([markers[1]])({ request, requests })
    }

    const doomed = newSession('routing-doomed', hosts, fixture)
    const survivor = newSession('routing-survivor', hosts, fixture)
    await Promise.all([doomed.run(null), survivor.run(null)])
    expect(hosts.size).toBe(1)

    await doomed.run(`Think about this. ${markers[0]}`)
    await survivor.run(`Run the command. ${markers[1]}`)
    await waitFor(() => cards('routing-survivor').length === 1, 'survivor approval')

    doomed.dispose()
    expect(state('routing-doomed')).toBe('disconnected')
    // No process died with it: the host is still there, and the survivor's turn
    // answers on the very same connection.
    expect(hosts.size).toBe(1)
    expect(containment.appServers).toHaveLength(1)

    survivor.resolveApproval(cards('routing-survivor')[0]!.requestId, 'allow')
    await waitFor(() => !survivor.willQueue, 'survivor turn end')
    expect(texts(survivor).join(' ')).toContain(markers[1])
    expect(state('routing-survivor')).toBe('idle')
    expect(emitted('routing-survivor', 'session:error')).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'a host death disconnects every session on it, and a resume brings back the interrupted turn',
  async () => {
    const fixture = await setupFixture()
    const hosts = registry()
    const markers = ['host-death-alpha', 'host-death-beta']
    // The FIRST turn of each session completes and the SECOND is held open, so
    // both are genuinely mid-flight when the app-server is killed under them —
    // and each thread has a rollout on disk to be resumed from. (Killing a
    // thread that has only just been started leaves its rollout file empty, and
    // the binary then refuses the resume outright: `rollout at … is empty`.
    // Observed here, and worth knowing — it is the shape of a crash in the first
    // second of a session's life, which no resume can recover.)
    fixture.script.current = ({ request, requests }) => {
      if (request.generate === false) return fixtureAssistantMessage()
      const body = JSON.stringify(request)
      const marker = markers.find((entry) => body.includes(entry))
      if (!marker) return fixtureAssistantMessage()
      const step = requests.filter(
        (entry) => entry.generate !== false && JSON.stringify(entry).includes(marker)
      ).length
      return step === 1 ? fixtureAssistantMessage(`first ${marker}`) : HOLD
    }

    const alpha = newSession('routing-death-alpha', hosts, fixture)
    const beta = newSession('routing-death-beta', hosts, fixture)
    await Promise.all([alpha.run(null), beta.run(null)])
    const threadId = alpha.getSessionId()!
    expect(hosts.size).toBe(1)
    await Promise.all([
      alpha.run(`Say something. ${markers[0]}`),
      beta.run(`Say something. ${markers[1]}`)
    ])
    await waitFor(() => !alpha.willQueue && !beta.willQueue, 'first turns')
    // The second turn of each session is the one that dies mid-flight.
    await Promise.all([
      alpha.run(`Think about this. ${markers[0]}`),
      beta.run(`Think about this. ${markers[1]}`)
    ])
    await waitFor(
      () => fixture.requests.filter((entry) => entry.generate !== false).length >= 4,
      'both second turns in flight'
    )

    // A CRASH, not a teardown: the process is killed from the outside, so the
    // transport learns about it the way it learns about a real death.
    process.kill(containment.appServers.at(-1)!, 'SIGKILL')

    await waitFor(
      () =>
        state('routing-death-alpha') === 'disconnected' &&
        state('routing-death-beta') === 'disconnected',
      'both sessions disconnected'
    )
    // ADR-045's contract, unchanged from the renderer's side: one error line per
    // session, and the status that says the engine is gone.
    for (const routingId of ['routing-death-alpha', 'routing-death-beta'])
      expect(emitted<string>(routingId, 'session:error')).toHaveLength(1)
    expect(hosts.size).toBe(0)

    // The killed process's WRITER LOCK outlives it by a moment — a stale lock
    // makes the next process's `thread/resume` answer `-32600 already has an
    // active writer` (upstream's `thread_resume.rs` shows the same refusal for a
    // LIVE holder) — so the resume waits the same 1500 ms the sibling suites'
    // `stopHolder` waits after a kill. In the product that wait is the human's:
    // the resume happens on their next prompt, not in the same millisecond as
    // the crash.
    await new Promise((done) => setTimeout(done, 1500))

    // The next prompt is a RESUME on a fresh host — the recovery ADR-069 §5
    // names, and P2's answer through the session layer.
    fixture.script.current = () => fixtureAssistantMessage('resumed answer')
    const resumed = new CodexSession(
      'routing-death-resumed',
      null,
      fixture.cwd,
      { resumeSessionId: threadId },
      { env: fixture.env, requestTimeoutMs: 30000 },
      hosts
    )
    sessions.push(resumed)
    await resumed.run('Say something new.')
    await waitFor(() => !resumed.willQueue, 'resumed turn end')
    expect(resumed.getSessionId()).toBe(threadId)
    expect(texts(resumed).join(' ')).toContain('resumed answer')
    expect(hosts.size).toBe(1)

    // The killed turn is not a hole: it is on disk, marked interrupted.
    const handle = await hosts.acquire({ cwd: fixture.cwd, env: fixture.env, label: 'delete' })
    try {
      const read = await handle.request('thread/read', { threadId, includeTurns: true })
      expect(read.thread.turns?.some((turn) => turn.status === 'interrupted')).toBe(true)
    } finally {
      handle.release()
    }
  },
  180000
)
