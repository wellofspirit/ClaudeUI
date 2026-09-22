import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
import {
  CodexAppServerClient,
  type CodexClientOptions
} from '../../core/codex/CodexAppServerClient'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'
import { codexIntegrationEnabled } from './integration-host'
import {
  FIXTURE_HOLD,
  fixtureAssistantMessage,
  startFixtureProvider,
  writeFixtureCodexHome,
  type FixtureOutputItem,
  type FixtureProvider,
  type FixtureTurn
} from './fixture-provider'

/**
 * H0 — the four host probes of [ADR-069](../../../docs/adr/adr-069_codex-host-per-home-and-account.md),
 * run against the pinned binary.
 *
 * ADR-069 moves ClaudeUI from one `codex app-server` per session plus a fresh
 * one-shot per read to ONE host process per (Codex home, injected account),
 * with sessions as threads on it. Four facts about the binary decide whether
 * that model is buildable, and none of them could be answered from the source
 * alone. This file answers them and stays in the repo as the host contract's
 * guard:
 *
 * - **P1** three threads on one stdio connection, concurrent turns, one scripted
 *   approval each: nothing crosses threads and no transport limit trips.
 * - **P2** `thread/resume` on a fresh host of a thread whose previous host was
 *   force-killed mid-turn.
 * - **P3** the writer lock in a LIVE host: is `thread/delete` from a second
 *   process refused while the first holds an idle thread, and is there a wire
 *   method that unloads a thread without exiting the process?
 * - **P4** graceful close: what ending stdin does to a host with an idle thread
 *   and to one with a running turn, and whether the next start on the same home
 *   initialises cleanly.
 *
 * EVERY assertion here states what the binary was OBSERVED to do (0.154.0), not
 * what the design would like: a surprising answer is a finding for the ADR, and
 * a probe that wished would hide it. Each `it` runs on its own fresh temp
 * `CODEX_HOME` so no probe inherits another's state databases or writer locks.
 *
 * NO CREDENTIAL AND NO NETWORK. The provider is the scripted localhost fixture
 * the sibling suites use, `chatgpt_base_url` and `GET /v1/models` point at it
 * and are answered 404, and `auth.json` holds an API key that authenticates
 * nothing — it only proves the child read the isolated home we gave it.
 */
/**
 * macOS wraps the binary in a seatbelt profile that allows only the fixture
 * port. Windows and Linux have no equivalent we use here, so there the child runs
 * unwrapped and the isolation is the fixture's own: a replacement environment (no
 * real `USERPROFILE`/`HOME`, a temp `CODEX_HOME`), a config whose only provider is
 * the localhost fixture, and every network feature off.
 *
 * It wraps P4's OWN child too, not only the transport's: {@link rawHost} spawns
 * through this same module, so the probe that ends a child's stdin runs under
 * the same containment and its pid joins the bounded cleanup below.
 *
 * NO test-only accessor was added to `CodexAppServerClient` for P4's stdin, and
 * none is needed — see {@link rawHost} for why the probe drives its own child.
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

const clients: CodexAppServerClient[] = []
const rawChildren: ChildProcessWithoutNullStreams[] = []
let directory: string | undefined
let provider: FixtureProvider | undefined

afterEach(async () => {
  const survivors: number[] = []
  try {
    for (const client of clients.splice(0)) client.dispose()
    for (const child of rawChildren.splice(0)) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
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
      // Ends any response a probe left held, then the server itself.
      await provider?.close()
      provider = undefined
    } finally {
      setHostPaths(null)
      if (directory) rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  }
  expect(survivors, 'app-server groups survived bounded disposal').toEqual([])
})

/**
 * What the probes script ON TOP of the shared fixture
 * (`src/integration/codex/fixture-provider.ts`, which owns the server, the
 * refusals, the SSE framing and the `config.toml` writer): the output item for
 * one model request, or {@link FIXTURE_HOLD} to leave that request open.
 *
 * Holding is how P2, P4 and P5b put a turn MID-FLIGHT — the only way to kill a
 * host, close its stdin, or delete its thread while the model is still talking.
 * It is the one thing the shared provider could not do before H0, and the
 * smallest hook that lets it (a sentinel a script may return) now lives THERE
 * rather than in a second copy of the server here.
 */
type Script = (turn: FixtureTurn) => FixtureOutputItem | typeof FIXTURE_HOLD

interface Fixture {
  cwd: string
  /** The isolated copy of the pinned binary these probes spawn. */
  binary: string
  env: NodeJS.ProcessEnv
  /** Every `POST /v1/responses` body, oldest first — the provider's own array. */
  requests: Record<string, unknown>[]
  /** Every request the fixture refused. A non-empty array IS a failure. */
  errors: string[]
  /** Swappable mid-probe: P2 and P4 stop holding once the first host is gone. */
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
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-host-probe-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, 'vendor/codex-cli')])
    mkdirSync(name, { recursive: true })
  const exe = process.platform === 'win32' ? '.exe' : ''
  const binary = join(directory, 'vendor/codex-cli', `codex${exe}`)
  copyFileSync(installed, binary)
  // Both members: the locator refuses a `codex` without its code-mode host
  // beside it (protocol-codex/README.md).
  copyFileSync(
    resolve('vendor/codex-cli', `codex-code-mode-host${exe}`),
    join(directory, 'vendor/codex-cli', `codex-code-mode-host${exe}`)
  )
  setHostPaths({ getAppPath: () => directory! })

  const script: { current: Script } = { current: () => fixtureAssistantMessage() }
  // The shared provider, with ONE indirection: the script is read per request
  // so a probe can swap it mid-run (P2 and P4 stop holding once their host is
  // gone) without a second server.
  provider = await startFixtureProvider({ script: (turn) => script.current(turn) })
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
  // The shared writer's fixture-provider variant, byte for byte what the
  // app-server suite runs on (guarded in `__tests__/fixture-provider.test.ts`):
  // `approval_policy = "on-request"` in the FILE because 0.154.0 refuses
  // `untrusted` there — {@link THREAD_POLICY} carries the policy under test per
  // thread and per turn — every network feature off, no retries, and NO
  // `auth.json`: `requires_openai_auth = false` means the child must send no
  // credential at all, which is exactly what the provider then asserts.
  writeFixtureCodexHome(codexHome, { port, model: 'mock-model', provider: 'fixture' })
  return {
    cwd,
    binary,
    requests: provider.requests,
    errors: provider.errors,
    script,
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

type Notification = { method: string; params: Record<string, unknown> }

/**
 * ClaudeUI's `default` mode as `codex-turn-policy.ts` spells it. `untrusted`
 * prompts for every command an exec-policy rule does not already allow, which
 * is what makes P1's approvals deterministic on every host.
 */
const THREAD_POLICY = {
  approvalPolicy: 'untrusted',
  sandbox: 'read-only',
  approvalsReviewer: 'user'
} as const

const INITIALIZE = {
  clientInfo: { name: 'codex_host_probe', title: null, version: '1' },
  capabilities: { experimentalApi: true, requestAttestation: false }
}

interface Host {
  client: CodexAppServerClient
  notifications: Notification[]
  /** Every server request seen, in arrival order. */
  serverRequests: Record<string, unknown>[]
  /** Transport errors delivered through `onDisconnect` — a limit trip lands here. */
  disconnects: string[]
}

/** One app-server through the PRODUCTION transport, on the fixture's home. */
async function host(
  fixture: Fixture,
  options: Partial<CodexClientOptions> = {},
  answer?: (method: string, params: Record<string, unknown>) => unknown
): Promise<Host> {
  const notifications: Notification[] = []
  const serverRequests: Record<string, unknown>[] = []
  const disconnects: string[] = []
  const client = new CodexAppServerClient({
    cwd: fixture.cwd,
    env: fixture.env,
    requestTimeoutMs: 30000,
    serverMethods: ['item/commandExecution/requestApproval'],
    onServerRequest: async (method, params) => {
      serverRequests.push({ method, ...(params as Record<string, unknown>) })
      return answer?.(method, params as Record<string, unknown>) ?? null
    },
    onNotification: (method, params) =>
      notifications.push({ method, params: (params ?? {}) as Record<string, unknown> }),
    onDisconnect: (error) => disconnects.push(error.code),
    ...options
  })
  clients.push(client)
  await client.start(INITIALIZE)
  return { client, notifications, serverRequests, disconnects }
}

async function startThread(active: Host, fixture: Fixture): Promise<string> {
  const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
    cwd: fixture.cwd,
    model: 'mock-model',
    historyMode: 'paginated',
    allowProviderModelFallback: false,
    ...THREAD_POLICY
  })
  return started.thread.id
}

async function startTurn(active: Host, threadId: string, text: string): Promise<string> {
  const turn = await active.client.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
    ...THREAD_POLICY
  })
  return turn.turn.id
}

function completed(notifications: Notification[], threadId: string, turnId?: string): boolean {
  return notifications.some(
    ({ method, params }) =>
      method === 'turn/completed' &&
      params.threadId === threadId &&
      (turnId === undefined || (params.turn as { id: string } | undefined)?.id === turnId)
  )
}

async function waitFor(predicate: () => boolean, label: string, ms = 60000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Isolated Codex fixture deadline: ${label}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

/**
 * Stop a host and wait for the OS to reap it, so the next probe measures NATIVE
 * behaviour rather than a race against the kill. `dispose()` signals and
 * escalates after `killGraceMs`; the wait is that budget plus margin — the same
 * 1500 ms `codex-lifecycle.integration.test.ts` uses.
 */
async function stopHolder(client: CodexAppServerClient): Promise<void> {
  client.dispose()
  await new Promise((done) => setTimeout(done, 1500))
}

/** The scripted `exec_command` that always needs an approval under {@link THREAD_POLICY}. */
const escalatedCommand = (tag: string): Record<string, unknown> => ({
  type: 'function_call',
  call_id: `call-${tag}`,
  name: 'exec_command',
  arguments: JSON.stringify({
    // Deliberately NOT a real program: the probe needs the approval REQUEST,
    // and a command no exec-policy rule can match is the one shape that asks on
    // every host. Whether it then runs is not what P1 measures.
    cmd: `codexui-host-probe-noop ${tag}`,
    sandbox_permissions: 'require_escalated',
    justification: 'Isolated fixture approval probe'
  })
})

// ---------------------------------------------------------------------------
// P1 — three threads, one connection.
// ---------------------------------------------------------------------------

it.skipIf(!enabled)(
  'P1: three concurrent threads on one connection keep their approvals, notifications and turns apart',
  async () => {
    const fixture = await setupFixture()
    const markers = ['probe-thread-alpha', 'probe-thread-beta', 'probe-thread-gamma']
    // Per-thread scripting on ONE shared provider: the turn's prompt marker
    // rides in every later request of that same thread's history, so counting
    // requests that carry it is the only reliable way to give each thread its
    // own step index while three turns interleave on one socket.
    fixture.script.current = ({ request, requests }) => {
      if (request.generate === false) return fixtureAssistantMessage()
      const body = JSON.stringify(request)
      const marker = markers.find((entry) => body.includes(entry))
      if (!marker) return fixtureAssistantMessage()
      const step = requests.filter(
        (entry) => entry.generate !== false && JSON.stringify(entry).includes(marker)
      ).length
      return step === 1 ? escalatedCommand(marker) : fixtureAssistantMessage()
    }

    const approvals: Record<string, unknown>[] = []
    const active = await host(fixture, {}, (_method, params) => {
      approvals.push(params)
      return { decision: 'accept' }
    })

    const threads: string[] = []
    for (const _marker of markers) threads.push(await startThread(active, fixture))
    expect(new Set(threads).size).toBe(3)

    // The same tick: three `turn/start` frames go out before any answer lands.
    const turns = await Promise.all(
      threads.map((threadId, index) => startTurn(active, threadId, markers[index]))
    )

    await waitFor(() => approvals.length === 3, 'three approval requests', 120000)
    await waitFor(
      () =>
        threads.every((threadId, index) => completed(active.notifications, threadId, turns[index])),
      'three completed turns',
      120000
    )

    // OBSERVED (0.154.0): one `item/commandExecution/requestApproval` per
    // thread, each stamped with ITS OWN threadId and turnId — three threads
    // share one stdio connection without their approvals crossing.
    expect(active.serverRequests.map((entry) => entry.method)).toEqual([
      'item/commandExecution/requestApproval',
      'item/commandExecution/requestApproval',
      'item/commandExecution/requestApproval'
    ])
    expect([...approvals.map((entry) => entry.threadId as string)].sort()).toEqual(
      [...threads].sort()
    )
    for (const approval of approvals) {
      const index = threads.indexOf(approval.threadId as string)
      expect(approval.turnId).toBe(turns[index])
    }

    // OBSERVED: exactly three `turn/completed`, one per thread, and answering an
    // approval completes THAT thread's turn and no other.
    const completions = active.notifications.filter(({ method }) => method === 'turn/completed')
    expect(completions).toHaveLength(3)
    expect([...completions.map(({ params }) => params.threadId as string)].sort()).toEqual(
      [...threads].sort()
    )

    // OBSERVED: no notification ever carries a threadId outside the three. (An
    // account-level notification such as `account/rateLimits/updated` carries
    // none at all, which is decision 8's premise and is allowed here.)
    const foreign = active.notifications.filter(
      ({ params }) =>
        typeof params.threadId === 'string' && !threads.includes(params.threadId as string)
    )
    expect(foreign).toEqual([])

    // OBSERVED: three streaming turns never trip a transport limit. The client
    // keeps its counters private, so the observable is that nothing was rejected
    // with `queue-limit`, `queue-limit-or-serialization` or `request-limit` and
    // the transport never disconnected.
    expect(active.disconnects).toEqual([])
    expect(fixture.errors).toEqual([])
  },
  180000
)

// ---------------------------------------------------------------------------
// P2 — resume after a force-killed host.
// ---------------------------------------------------------------------------

it.skipIf(!enabled)(
  'P2: a thread whose host was force-killed mid-turn reopens on a fresh host and takes a new turn',
  async () => {
    const fixture = await setupFixture()
    // The first turn NEVER gets an answer: the provider holds its response open
    // so the host dies with the model still talking.
    fixture.script.current = ({ request }) =>
      request.generate === false ? fixtureAssistantMessage() : FIXTURE_HOLD

    const first = await host(fixture)
    const threadId = await startThread(first, fixture)
    const interruptedTurn = await startTurn(first, threadId, 'turn interrupted by a host kill')
    await waitFor(() => fixture.requests.length >= 1, 'the provider holds the first turn')
    expect(completed(first.notifications, threadId, interruptedTurn)).toBe(false)

    // Today's kill: `dispose()` is `taskkill /F /T` on Windows and SIGTERM then
    // SIGKILL on POSIX, with stdin never ended — the death ADR-069 decision 6
    // replaces.
    await stopHolder(first.client)
    // Nothing holds the socket now; let the next turn answer normally.
    // No release needed: the held socket died with the process, and the shared
    // provider ends any survivor on close. Only the script has to stop holding.
    fixture.script.current = () => fixtureAssistantMessage()

    const second = await host(fixture)
    const resumed = await second.client.request<{
      thread: { id: string; turns: { id: string; status: string }[] }
    }>('thread/resume', { threadId, cwd: fixture.cwd, ...THREAD_POLICY })

    // OBSERVED (0.154.0): the thread reopens on a process that never started it.
    expect(resumed.thread.id).toBe(threadId)

    const read = await second.client.request<{
      thread: { id: string; turns: { id: string; status: string }[] }
    }>('thread/read', { threadId, includeTurns: true })
    // OBSERVED: the killed turn is neither lost nor left looking finished. Both
    // `thread/resume` and `thread/read` carry it back as the thread's only turn,
    // MARKED `interrupted` — the app-server reconstructs the state from the
    // rollout, which has the turn's start and no completion. ADR-069's "absent
    // or marked" is answered by "marked", so a resumed session can render the
    // dead turn honestly instead of having to hide it.
    const readTurn = read.thread.turns.find((turn) => turn.id === interruptedTurn)
    const resumedTurn = resumed.thread.turns.find((turn) => turn.id === interruptedTurn)
    expect(readTurn?.status).toBe('interrupted')
    expect(resumedTurn?.status).toBe('interrupted')

    // OBSERVED: a fresh turn on the resumed thread runs to completion.
    const nextTurn = await startTurn(second, threadId, 'turn after resume')
    await waitFor(
      () => completed(second.notifications, threadId, nextTurn),
      'the post-resume turn completes'
    )
    expect(fixture.errors).toEqual([])
  },
  180000
)

// ---------------------------------------------------------------------------
// P3 — the writer lock in a live host.
// ---------------------------------------------------------------------------

it.skipIf(!enabled)(
  'P3: a live host holds an idle thread against another process, and thread/unsubscribe does not release it',
  async () => {
    const fixture = await setupFixture()
    const holder = await host(fixture)
    const threadId = await startThread(holder, fixture)
    const turnId = await startTurn(holder, threadId, 'one completed turn, then idle')
    await waitFor(
      () => completed(holder.notifications, threadId, turnId),
      'the holder finishes its turn'
    )

    const other = await host(fixture)
    const deleteWhileHeld = await other.client
      .request('thread/delete', { threadId })
      .then(() => 'accepted')
      .catch((error: { code?: string }) => error.code ?? 'rejected')
    // OBSERVED (0.154.0): REFUSED. The thread store takes a per-thread writer
    // lock file (`$CODEX_HOME/thread-writer-locks/<id>.lock`) and the second
    // process gets "thread <id> already has an active writer", which the
    // transport surfaces as the same `-32600` every lifecycle refusal collapses
    // to. Being idle in a live host does not release it.
    expect(deleteWhileHeld).toBe('rpc-error--32600')

    // Is there a wire method that unloads a thread without exiting the process?
    // The generated narrow map (`src/core/codex/protocol/methods.ts`) has none —
    // but it is a SUBSET of the binary's surface, and the pinned source
    // (`app-server-protocol/src/protocol/common.rs`) does declare
    // `thread/unsubscribe` (plus `thread/archive`, which is a state change, not
    // an unload). So the question is what it actually releases.
    const unsubscribed = await holder.client
      .request<{ status: string }>('thread/unsubscribe', { threadId })
      .then((result) => result.status)
      .catch((error: { code?: string }) => error.code ?? 'rejected')
    // OBSERVED: `thread/unsubscribe` EXISTS and succeeds, answering
    // `unsubscribed` — it detaches this CONNECTION's notification subscription
    // (`thread_processor.rs::thread_unsubscribe_response_inner`).
    expect(unsubscribed).toBe('unsubscribed')

    const deleteAfterUnsubscribe = await other.client
      .request('thread/delete', { threadId })
      .then(() => 'accepted')
      .catch((error: { code?: string }) => error.code ?? 'rejected')
    // OBSERVED: STILL REFUSED. Unsubscribing drops the subscription but leaves
    // the thread LOADED in the host's thread manager, so the writer lock stays
    // held. There is no wire method that unloads a live thread: the lock is
    // released when the holding PROCESS exits.
    //
    // This is the fact ADR-069's "Consequences" flagged as open — delete cannot
    // wait for a session to stop once sessions stop owning processes, because
    // stopping a session no longer exits anything. H2 has to decide between
    // recycling the host for a delete and archiving instead.
    expect(deleteAfterUnsubscribe).toBe('rpc-error--32600')

    // And the same delete lands once the holder's PROCESS is gone — the lock is
    // process-scoped, exactly as `delete.ts` documents.
    await stopHolder(holder.client)
    await expect(other.client.request('thread/delete', { threadId })).resolves.toBeDefined()
    expect(fixture.errors).toEqual([])
  },
  180000
)

// ---------------------------------------------------------------------------
// P4 — graceful close.
// ---------------------------------------------------------------------------

interface RawHost {
  child: ChildProcessWithoutNullStreams
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  notifications: Notification[]
  /** Ends the child's stdin and starts the clock. */
  endStdin(): void
  /** Exit as the OS reported it, and the milliseconds since {@link endStdin}. */
  settled(ms: number): Promise<{ code: number | null; signal: string | null; ms: number | null }>
}

/**
 * An app-server driven by a HAND-ROLLED stdio client, used by P4 alone.
 *
 * `CodexAppServerClient` cannot measure this honestly. Its `dispose()` never
 * ends stdin (that is the change ADR-069 decision 6 asks for), and if a test
 * ends the child's stdin behind its back the transport sees the resulting
 * stdout EOF, calls `fail('stdout-closed')` and runs `terminate()` — a
 * `taskkill /F /T` on Windows, SIGTERM on POSIX — into the exact window where
 * the server is closing its sqlite files. The exit code and the "does the next
 * start initialise" answer would then be measuring OUR kill, not the binary's
 * graceful close. So P4 owns its child, and the production transport is used
 * for the half that matters to production: the NEXT start on the same home.
 *
 * The framing is the transport's own (`{id, method, params}` lines, and a bare
 * `{method:'initialized'}` notification), so this measures the same wire.
 */
async function rawHost(fixture: Fixture): Promise<RawHost> {
  const child = spawn(fixture.binary, ['app-server', '--listen', 'stdio://'], {
    cwd: fixture.cwd,
    env: fixture.env,
    stdio: 'pipe',
    windowsHide: true
  })
  rawChildren.push(child)
  const notifications: Notification[] = []
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >()
  let nextId = 0
  let buffer = ''
  let endedAt: number | undefined
  const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
    child.once('exit', (code, signal) => done({ code, signal }))
  )
  let exitAt: number | undefined
  void exited.then(() => {
    exitAt = Date.now()
  })
  child.stderr.resume()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof message.method === 'string' && message.id === undefined) {
        notifications.push({
          method: message.method,
          params: (message.params ?? {}) as Record<string, unknown>
        })
        continue
      }
      // A server REQUEST (it has both a method and an id) is answered "method
      // not found", the same refusal the transport gives an unregistered
      // method. P4 scripts nothing that needs an approval.
      if (typeof message.method === 'string') {
        child.stdin.write(
          JSON.stringify({ id: message.id, error: { code: -32601, message: 'Method not found' } }) +
            '\n'
        )
        continue
      }
      const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined
      if (!waiter) continue
      pending.delete(message.id as number)
      if ('error' in message) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    }
  })
  const request = <T>(method: string, params?: unknown): Promise<T> => {
    const id = nextId++
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`raw host request timed out: ${method}`))
      }, 30000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolvePromise(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  await request('initialize', INITIALIZE)
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
  return {
    child,
    request,
    notifications,
    endStdin: () => {
      endedAt = Date.now()
      child.stdin.end()
    },
    settled: async (ms) => {
      const outcome = await Promise.race([
        exited,
        new Promise<null>((done) => setTimeout(() => done(null), ms))
      ])
      if (!outcome) return { code: null, signal: null, ms: null }
      return {
        ...outcome,
        ms: endedAt === undefined ? null : (exitAt ?? Date.now()) - endedAt
      }
    }
  }
}

async function rawThread(raw: RawHost, fixture: Fixture): Promise<string> {
  const started = await raw.request<{ thread: { id: string } }>('thread/start', {
    cwd: fixture.cwd,
    model: 'mock-model',
    historyMode: 'paginated',
    allowProviderModelFallback: false,
    ...THREAD_POLICY
  })
  return started.thread.id
}

it.skipIf(!enabled)(
  'P4: ending stdin exits a host with an idle thread cleanly and the next start on the same home initialises',
  async () => {
    const fixture = await setupFixture()
    const raw = await rawHost(fixture)
    await rawThread(raw, fixture)

    raw.endStdin()
    const outcome = await raw.settled(30000)
    // OBSERVED (0.154.0): the stdio server treats its connection closing as the
    // end of the process (`single_client_mode` + `stdio_connection_closed`,
    // `app-server/src/lib.rs`) and exits 0, without a signal, in 13 ms on
    // Windows x64 — so ADR-069 decision 6's `killGraceMs` budget is never
    // actually spent on a healthy host.
    expect(outcome.code).toBe(0)
    expect(outcome.signal).toBe(null)
    expect(outcome.ms).not.toBeNull()
    expect(outcome.ms!).toBeLessThan(5000)

    // The half that matters to production: a host started IMMEDIATELY after a
    // graceful close on the same home initialises. A `stdout-closed`/exit-1 here
    // would mean the sqlite state runtime was left unusable — the F7/F8 death.
    const next = await host(fixture)
    await expect(next.client.request('thread/list', { limit: 5 })).resolves.toBeDefined()
    expect(next.disconnects).toEqual([])
    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'P4: ending stdin during a running turn still exits, and the next start on the same home initialises',
  async () => {
    const fixture = await setupFixture()
    // The turn never gets an answer, so the server is asked to close while a
    // model stream is open.
    fixture.script.current = ({ request }) =>
      request.generate === false ? fixtureAssistantMessage() : FIXTURE_HOLD

    const raw = await rawHost(fixture)
    const threadId = await rawThread(raw, fixture)
    await raw.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'turn running when stdin ends', text_elements: [] }],
      ...THREAD_POLICY
    })
    await waitFor(() => fixture.requests.length >= 1, 'the provider holds the running turn')

    raw.endStdin()
    const outcome = await raw.settled(45000)
    // OBSERVED (0.154.0): the server does NOT wait for the turn. It exits 0 in
    // tens of milliseconds — 29 ms on Windows x64 — not at the 10 s ceiling its
    // shutdown budget allows (`thread_processor.rs::shutdown_threads`
    // → `shutdown_all_threads_bounded(10s)`). A turn whose provider never
    // answers cannot pin a host open, so decision 6's graceful close needs no
    // "interrupt the turn first" step and no turn-length grace.
    expect(outcome.code).toBe(0)
    expect(outcome.signal).toBe(null)
    expect(outcome.ms).not.toBeNull()
    expect(outcome.ms!).toBeLessThan(5000)

    // No release needed: the held socket died with the process, and the shared
    // provider ends any survivor on close. Only the script has to stop holding.
    fixture.script.current = () => fixtureAssistantMessage()

    // Same as the idle case: the home is left usable.
    const next = await host(fixture)
    await expect(next.client.request('thread/list', { limit: 5 })).resolves.toBeDefined()
    expect(next.disconnects).toEqual([])
    expect(fixture.errors).toEqual([])
  },
  180000
)

// ---------------------------------------------------------------------------
// P5 — what the HOLDER itself can delete.
// ---------------------------------------------------------------------------

/**
 * P3 answered what a SECOND process may do while a host holds a thread:
 * nothing. P5 asks the question H2's delete rule actually turns on — what the
 * HOLDER may do — because under ADR-069 decision 2 the holder is the only
 * process there is. If the connection that loaded a thread can delete it, a
 * session delete stays one request and never needs the host recycled.
 */

/** Ids `thread/list` currently returns for this home, newest first. */
async function listedIds(active: Host): Promise<string[]> {
  const listed = await active.client.request<{ data: { id: string }[] }>('thread/list', {
    limit: 50
  })
  return listed.data.map((thread) => thread.id)
}

it.skipIf(!enabled)(
  'P5a: the holder deletes its own idle thread, and the id is gone from the home',
  async () => {
    const fixture = await setupFixture()
    const holder = await host(fixture)
    const threadId = await startThread(holder, fixture)
    const turnId = await startTurn(holder, threadId, 'one completed turn, then idle')
    await waitFor(
      () => completed(holder.notifications, threadId, turnId),
      'the holder finishes its turn'
    )
    expect(await listedIds(holder)).toContain(threadId)

    const deleted = await holder.client
      .request('thread/delete', { threadId })
      .then(() => 'accepted')
      .catch((error: { code?: string }) => error.code ?? 'rejected')
    // OBSERVED (0.154.0): ACCEPTED. The writer lock is per PROCESS, so the
    // connection that holds the thread is never refused by it — and
    // `thread_delete.rs` unloads the thread first (`prepare_thread_for_delete`
    // → `prepare_thread_for_removal`, which shuts the live conversation down)
    // before the store deletes it. A session delete under ADR-069 decision 2 is
    // therefore ONE request on the live host: no recycle, no second process.
    expect(deleted).toBe('accepted')

    // OBSERVED: really gone, not just unloaded — the id leaves `thread/list`,
    // `thread/read` refuses it, and `thread/resume` cannot bring it back.
    expect(await listedIds(holder)).not.toContain(threadId)
    const readAfter = await holder.client
      .request('thread/read', { threadId, includeTurns: false })
      .then(() => 'accepted')
      .catch((error: { code?: string }) => error.code ?? 'rejected')
    expect(readAfter).toBe('rpc-error--32600')
    const resumeAfter = await holder.client
      .request('thread/resume', { threadId, cwd: fixture.cwd, ...THREAD_POLICY })
      .then(() => 'accepted')
      .catch((error: { code?: string }) => error.code ?? 'rejected')
    expect(resumeAfter).toBe('rpc-error--32600')

    expect(holder.disconnects).toEqual([])
    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'P5b: the holder deletes a thread whose turn is still running, and the turn dies with it',
  async () => {
    const fixture = await setupFixture()
    // The turn never gets an answer, so the thread is RUNNING when the delete
    // arrives — the case a user hitting delete on a busy session produces.
    fixture.script.current = ({ request }) =>
      request.generate === false ? fixtureAssistantMessage() : FIXTURE_HOLD

    const holder = await host(fixture)
    const threadId = await startThread(holder, fixture)
    const turnId = await startTurn(holder, threadId, 'turn running when the delete arrives')
    await waitFor(() => fixture.requests.length >= 1, 'the provider holds the running turn')
    expect(completed(holder.notifications, threadId, turnId)).toBe(false)

    const deleted = await holder.client
      .request('thread/delete', { threadId })
      .then(() => 'accepted')
      .catch((error: { code?: string }) => error.code ?? 'rejected')
    // OBSERVED (0.154.0): ACCEPTED, and it INTERRUPTS. The delete is neither
    // refused for a busy thread nor made to wait for the turn: the handler
    // shuts the conversation down first (`prepare_thread_for_removal` →
    // `wait_for_thread_shutdown`) and only then deletes. So H2 needs no
    // "interrupt, wait, then delete" dance of its own.
    expect(deleted).toBe('accepted')
    expect(await listedIds(holder)).not.toContain(threadId)

    // OBSERVED, and the detail a caller must not miss: the killed turn is still
    // announced with `turn/completed`. That method is the TERMINAL ENVELOPE, not
    // a claim of success — the real outcome is `turn.status`, which here is
    // `interrupted`. Anything that reads the method alone (this file's own
    // {@link completed} helper included) would call a deleted turn finished.
    const terminal = holder.notifications.filter(
      ({ method, params }) => method === 'turn/completed' && params.threadId === threadId
    )
    expect(terminal).toHaveLength(1)
    const endedTurn = terminal[0].params.turn as { id: string; status: string }
    expect(endedTurn.id).toBe(turnId)
    expect(endedTurn.status).toBe('interrupted')

    expect(holder.disconnects).toEqual([])
    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'P5c: the holder cannot delete a source thread its own fork still references',
  async () => {
    const fixture = await setupFixture()
    const holder = await host(fixture)
    const sourceId = await startThread(holder, fixture)
    const turnId = await startTurn(holder, sourceId, 'the turn the fork is cut from')
    await waitFor(
      () => completed(holder.notifications, sourceId, turnId),
      'the source finishes its turn'
    )
    const forked = await holder.client.request<{ thread: { id: string } }>('thread/fork', {
      threadId: sourceId,
      cwd: fixture.cwd
    })
    expect(forked.thread.id).not.toBe(sourceId)

    const deleteSource = await holder.client
      .request('thread/delete', { threadId: sourceId })
      .then(() => 'accepted')
      .catch((error: { code?: string }) => error.code ?? 'rejected')
    // OBSERVED (0.154.0): REFUSED, `-32600`, from the HOLDER itself. The fork
    // refusal is about the rollout reference index
    // (`thread-store/.../delete_thread.rs::ensure_no_external_references`), not
    // about which process asks, so owning the thread buys nothing here: the
    // leaf-first subtree walk `delete.ts` already implements stays exactly as
    // it is under the host model.
    expect(deleteSource).toBe('rpc-error--32600')

    // And the shape of the fix is unchanged too: delete the fork, then the
    // source, leaf first.
    await expect(
      holder.client.request('thread/delete', { threadId: forked.thread.id })
    ).resolves.toBeDefined()
    await expect(
      holder.client.request('thread/delete', { threadId: sourceId })
    ).resolves.toBeDefined()
    expect(await listedIds(holder)).not.toContain(sourceId)

    expect(holder.disconnects).toEqual([])
    expect(fixture.errors).toEqual([])
  },
  180000
)
