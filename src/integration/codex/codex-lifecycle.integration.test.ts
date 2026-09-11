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
import {
  CodexAppServerClient,
  type CodexClientOptions
} from '../../core/codex/CodexAppServerClient'
import { CodexService } from '../../core/codex/CodexService'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'

/**
 * Native lifecycle probes against the pinned binary and a scripted localhost
 * Responses fixture. These establish the behaviors the M3 adapter relies on:
 * zero-turn root visibility, fork anchors, delete/archive semantics, and
 * dynamic-tool definition persistence across resume/fork. No credentials, no
 * real provider, all writes confined to a disposable directory.
 */
const containment = vi.hoisted(() => ({ profile: '', pids: [] as number[] }))
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

/**
 * The ONE JSON-RPC error the pinned binary answers every lifecycle refusal with:
 * `-32600` (Invalid Request), for "another process holds this thread", for "this
 * thread still has a descendant fork", and for "no such thread" alike.
 *
 * That collapse is itself a finding the M3 delete design has to plan around — a
 * caller cannot tell a retryable refusal from a permanent one — and it is only
 * visible at all because `CodexService.read()` now rethrows transport codes
 * instead of flattening them to `service-read-failed`.
 *
 * PINNED rather than pattern-matched: a native bump that changes how the binary
 * says no must surface in the probe that exists to record it, not as a mystery
 * error in the UI.
 */
const REFUSED = 'Codex transport: rpc-error--32600'
const clients: CodexAppServerClient[] = []
const services: CodexService[] = []
let directory: string | undefined
let server: ReturnType<typeof createServer> | undefined

afterEach(async () => {
  const survivors: number[] = []
  try {
    for (const client of clients.splice(0)) client.dispose()
    for (const service of services.splice(0)) service.dispose()
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

type Script = (request: Record<string, unknown>, index: number) => Record<string, unknown>
const message = (text: string): Record<string, unknown> => ({
  type: 'message',
  id: 'msg-fixture',
  role: 'assistant',
  content: [{ type: 'output_text', text }]
})
const call = (name: string, callId: string, args: unknown): Record<string, unknown> => ({
  type: 'function_call',
  call_id: callId,
  name,
  arguments: JSON.stringify(args)
})

async function setupFixture(): Promise<{
  cwd: string
  env: NodeJS.ProcessEnv
  requests: Record<string, unknown>[]
  errors: string[]
  script: { current: Script }
}> {
  const installed = resolve('vendor/codex-cli/codex')
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.binarySha256
  )
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-m3-lifecycle-')))
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
  const script = { current: ((): Record<string, unknown> => message('fixture complete')) as Script }
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 4_000_000) req.destroy()
    })
    req.on('error', () => {})
    req.on('end', () => {
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
      const item = script.current(parsed, requests.length - 1)
      const events = [
        { type: 'response.created', response: { id: 'resp-fixture' } },
        { type: 'response.output_item.done', item },
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
    `model = "mock-model"
model_provider = "fixture"
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
  return {
    cwd,
    requests,
    errors,
    script,
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

type Notification = { method: string; params: Record<string, unknown> }
async function root(
  cwd: string,
  env: NodeJS.ProcessEnv,
  onServerRequest?: CodexClientOptions['onServerRequest']
): Promise<{ client: CodexAppServerClient; notifications: Notification[] }> {
  const notifications: Notification[] = []
  const client = new CodexAppServerClient({
    cwd,
    env,
    requestTimeoutMs: 15000,
    serverMethods: ['item/tool/call'],
    onServerRequest,
    onNotification: (method, params) =>
      notifications.push({ method, params: params as Record<string, unknown> })
  })
  clients.push(client)
  await client.start({
    clientInfo: { name: 'codex_m3_probe', title: null, version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  return { client, notifications }
}

/**
 * Stop a root process and wait for the OS to reap it, so the next probe measures
 * NATIVE behavior rather than a race against `SIGTERM`/`SIGKILL`.
 *
 * `dispose()` signals the group and escalates after `killGraceMs` (1000 ms by
 * default, which is what `root()` gets); the wait is that budget plus margin.
 * Deliberately a fixed wait and a SINGLE later attempt rather than a retry
 * loop — a delete that only lands on the third try is a finding, and a loop
 * would swallow it.
 */
async function stopHolder(client: CodexAppServerClient): Promise<void> {
  client.dispose()
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Isolated Codex fixture deadline: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function terminal(notifications: Notification[], threadId: string, turnId: string): boolean {
  return notifications.some(
    ({ method, params }) =>
      method === 'turn/completed' &&
      params.threadId === threadId &&
      (params.turn as { id: string })?.id === turnId
  )
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
  await waitFor(() => terminal(notifications, threadId, turn.turn.id), `turn ${text}`)
  return turn.turn.id
}

const dynamicTools = [
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

function toolNames(request: Record<string, unknown>): string[] {
  return ((request.tools as Array<{ name?: string }> | undefined) ?? [])
    .map((tool) => tool.name ?? '')
    .filter(Boolean)
}

it.skipIf(!enabled)(
  'probes zero-turn root visibility, cold read and resume',
  async () => {
    const { cwd, env, errors } = await setupFixture()
    const first = await root(cwd, env)
    const started = await first.client.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const threadId = started.thread.id
    const service = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
    services.push(service)
    const listedWhileLive = (await service.listAllThreads()).some((t) => t.id === threadId)
    const readWhileLive = await service
      .readThread({ threadId, includeTurns: false })
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    first.client.dispose()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const listedCold = (await service.listAllThreads()).some((t) => t.id === threadId)
    const readCold = await service
      .readThread({ threadId, includeTurns: false })
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const second = await root(cwd, env)
    const resumed = await second.client
      .request<{ thread: { id: string; turns: unknown[] } }>('thread/resume', { threadId, cwd })
      .then((r) => ({ ok: true as const, id: r.thread.id, turns: r.thread.turns.length }))
      .catch((error: Error) => ({ ok: false as const, error: error.message }))
    // Recorded for the report: which of these the pinned binary supports for a
    // root that never ran a turn.
    console.log(
      JSON.stringify({
        probe: 'zero-turn',
        listedWhileLive,
        readWhileLive,
        listedCold,
        readCold,
        resumed
      })
    )
    if (resumed.ok) {
      expect(resumed.id).toBe(threadId)
      await runTurn(second.client, second.notifications, threadId, 'first turn after cold resume')
      expect((await service.readThread({ threadId, includeTurns: false })).thread.id).toBe(threadId)
      expect((await service.listAllThreads()).some((t) => t.id === threadId)).toBe(true)
    }
    expect(errors).toEqual([])
  },
  60000
)

it.skipIf(!enabled)(
  'probes completed-turn fork anchors, source preservation, delete and archive semantics',
  async () => {
    const { cwd, env, errors, script } = await setupFixture()
    let counter = 0
    script.current = () => message(`answer ${++counter}`)
    const source = await root(cwd, env)
    const started = await source.client.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const sourceId = started.thread.id
    const turnOne = await runTurn(source.client, source.notifications, sourceId, 'one')
    const turnTwo = await runTurn(source.client, source.notifications, sourceId, 'two')
    const service = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
    services.push(service)
    const forker = await root(cwd, env)
    const byLast = await forker.client.request<{
      thread: { id: string; forkedFromId: string | null; turns: Array<{ id: string }> }
    }>('thread/fork', { threadId: sourceId, lastTurnId: turnOne, cwd })
    const byBefore = await forker.client.request<{
      thread: { id: string; forkedFromId: string | null; turns: Array<{ id: string }> }
    }>('thread/fork', { threadId: sourceId, beforeTurnId: turnTwo, cwd })
    const inProgressFork = await forker.client
      .request('thread/fork', { threadId: sourceId, lastTurnId: 'not-a-turn', cwd })
      .then(() => 'accepted')
      .catch((error: Error) => error.message)
    const sourceHistory = await service.history(sourceId)
    const lastHistory = await service.history(byLast.thread.id)
    const beforeHistory = await service.history(byBefore.thread.id)
    console.log(
      JSON.stringify({
        probe: 'fork',
        byLast: {
          id: byLast.thread.id,
          forkedFromId: byLast.thread.forkedFromId,
          responseTurns: byLast.thread.turns.map((t) => t.id),
          historyTurns: lastHistory.turns.map((t) => t.id)
        },
        byBefore: {
          id: byBefore.thread.id,
          forkedFromId: byBefore.thread.forkedFromId,
          historyTurns: beforeHistory.turns.map((t) => t.id)
        },
        inProgressFork,
        sourceTurns: sourceHistory.turns.map((t) => t.id)
      })
    )
    expect(byLast.thread.id).not.toBe(sourceId)
    expect(byBefore.thread.id).not.toBe(sourceId)
    expect(sourceHistory.turns.map((t) => t.id)).toEqual([turnOne, turnTwo])
    expect(lastHistory.turns).toHaveLength(1)
    expect(beforeHistory.turns).toHaveLength(1)
    // Forks copy the turn content; whether native IDs are preserved is recorded above.
    expect(lastHistory.turns[0].items.length).toBeGreaterThan(0)

    // ── Delete / archive while the owning root process still holds the thread ──
    //
    // `CodexService.deleteThread` states the contract as "callers must stop the
    // owning root process first". These two probes are what that sentence is
    // MADE of: both forks live in `forker`'s process, so both verbs are refused
    // while it runs, and the refusal is the native RPC error (visible now that
    // `read()` no longer collapses every transport code into one).
    const listBeforeDelete = (await service.listAllThreads()).map((t) => t.id)
    const deleteLoadedFork = await service
      .deleteThread(byLast.thread.id)
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const archiveLoadedFork = await service
      .archiveThread(byBefore.thread.id)
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    // A refusal must change NOTHING (the listing is unmoved — see finding 1
    // below for why it never held the forks in the first place).
    const listWhileLoaded = (await service.listAllThreads()).map((t) => t.id)

    // Stop the holder, then delete the same fork for real.
    await stopHolder(forker.client)
    const deleteUnloadedFork = await service
      .deleteThread(byLast.thread.id)
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const listAfterForkDelete = (await service.listAllThreads()).map((t) => t.id)
    const readDeletedFork = await service
      .readThread({ threadId: byLast.thread.id, includeTurns: false })
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const sourceAfterForkDelete = await service
      .readThread({ threadId: sourceId, includeTurns: false })
      .then(() => 'ok')
      .catch((error: Error) => error.message)

    // The SOURCE, still held by its own root process and still the parent of a
    // surviving fork. Refused for the same reason, and the live thread keeps
    // accepting turns afterwards — the refusal is not a half-delete.
    const deleteLoadedSource = await service
      .deleteThread(sourceId)
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const sourceTurnAfterDelete = await runTurn(
      source.client,
      source.notifications,
      sourceId,
      'after delete'
    )
      .then(() => 'accepted')
      .catch((error: Error) => error.message)
    await stopHolder(source.client)
    const deleteUnloadedSource = await service
      .deleteThread(sourceId)
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const listAfterSourceDelete = (await service.listAllThreads()).map((t) => t.id)
    const readDeletedSource = await service
      .readThread({ threadId: sourceId, includeTurns: false })
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const descendantAfterSourceDelete = await service
      .readThread({ threadId: byBefore.thread.id, includeTurns: false })
      .then(() => 'ok')
      .catch((error: Error) => error.message)

    // Archive, now that nothing holds the remaining fork.
    const archiveUnloadedFork = await service
      .archiveThread(byBefore.thread.id)
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const listAfterArchive = (await service.listAllThreads()).map((t) => t.id)
    const archivedListed = (await service.listThreads({ archived: true, limit: 100 })).data.map(
      (t) => t.id
    )
    const readArchived = await service
      .readThread({ threadId: byBefore.thread.id, includeTurns: false })
      .then(() => 'ok')
      .catch((error: Error) => error.message)

    // DISCRIMINATOR probe: is the source refusal about the descendant?
    const deleteSourceAfterArchive = await service
      .deleteThread(sourceId)
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const deleteArchivedDescendant = await service
      .deleteThread(byBefore.thread.id)
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const deleteSourceAfterDescendantDeleted = await service
      .deleteThread(sourceId)
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    const listAtEnd = (await service.listAllThreads()).map((t) => t.id)
    const readSourceAtEnd = await service
      .readThread({ threadId: sourceId, includeTurns: false })
      .then(() => 'ok')
      .catch((error: Error) => error.message)
    console.log(
      JSON.stringify({
        probe: 'delete',
        listBeforeDelete,
        deleteLoadedFork,
        archiveLoadedFork,
        listWhileLoaded,
        deleteUnloadedFork,
        listAfterForkDelete,
        readDeletedFork,
        sourceAfterForkDelete,
        deleteLoadedSource,
        sourceTurnAfterDelete,
        deleteUnloadedSource,
        listAfterSourceDelete,
        readDeletedSource,
        descendantAfterSourceDelete,
        archiveUnloadedFork,
        listAfterArchive,
        archivedListed,
        readArchived,
        deleteSourceAfterArchive,
        deleteArchivedDescendant,
        deleteSourceAfterDescendantDeleted,
        listAtEnd,
        readSourceAtEnd
      })
    )
    // ── What the pinned binary actually does ────────────────────────────
    //
    // 1. FORKS ARE NEVER LISTED. `thread/list` returns only the source root, in
    //    both `archived: false` and `archived: true` — so "the row disappeared"
    //    is no proof of deletion for a fork, and a sidebar built on
    //    `listAllThreads()` cannot show forks at all.
    expect(listBeforeDelete).toEqual([sourceId])
    // 2. Delete AND archive are refused while the owning root process holds the
    //    thread — the contract `CodexService.deleteThread` documents — and the
    //    refusal moves nothing.
    expect(deleteLoadedFork).toBe(REFUSED)
    expect(archiveLoadedFork).toBe(REFUSED)
    expect(listWhileLoaded).toEqual([sourceId])
    // 3. Stop the holder and the same delete lands. `thread/read` is the only
    //    observable proof for a fork, and the SOURCE is untouched by it.
    expect(deleteUnloadedFork).toBe('ok')
    expect(readDeletedFork).toBe(REFUSED)
    expect(sourceAfterForkDelete).toBe('ok')
    // 4. The source is refused while held, and the refusal is INERT: the live
    //    thread keeps accepting turns afterwards, so this is not a half-delete.
    expect(deleteLoadedSource).toBe(REFUSED)
    expect(sourceTurnAfterDelete).toBe('accepted')
    // 5. THE ONE THAT MATTERS FOR M3: stopping the holder is NOT sufficient. A
    //    thread with a surviving descendant fork stays undeletable, and nothing
    //    about it changes — still listed, still readable, descendant intact.
    expect(deleteUnloadedSource).toBe(REFUSED)
    expect(listAfterSourceDelete).toEqual([sourceId])
    expect(readDeletedSource).toBe('ok')
    expect(descendantAfterSourceDelete).toBe('ok')
    // 6. Archive retains the native data: the thread still reads. It adds no row
    //    to the archived listing either, because forks are never listed (1).
    expect(archiveUnloadedFork).toBe('ok')
    expect(listAfterArchive).toEqual([sourceId])
    expect(archivedListed).toEqual([])
    expect(readArchived).toBe('ok')
    // 7. And ARCHIVING the descendant does not lift (5) — only DELETING it does.
    //    So a native delete of a forked thread is a whole-subtree operation,
    //    leaf-first, which is the design constraint this probe exists to pin.
    expect(deleteSourceAfterArchive).toBe(REFUSED)
    expect(deleteArchivedDescendant).toBe('ok')
    expect(deleteSourceAfterDescendantDeleted).toBe('ok')
    expect(listAtEnd).toEqual([])
    expect(readSourceAtEnd).toBe(REFUSED)
    expect(errors).toEqual([])
  },
  90000
)

it.skipIf(!enabled)(
  'probes dynamic-tool definition persistence across resume, empty-list resume and fork',
  async () => {
    const { cwd, env, errors, script, requests } = await setupFixture()
    script.current = (_request, index) =>
      index === 0 ? call('fixture_echo', 'call-0', { value: 'synthetic' }) : message('done')
    const calls: string[] = []
    const handler = async (_method: string, params: unknown): Promise<unknown> => {
      calls.push((params as { callId: string }).callId)
      return { contentItems: [{ type: 'inputText', text: 'fixture tool output' }], success: true }
    }
    const first = await root(cwd, env, handler)
    const started = await first.client.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated',
      dynamicTools
    })
    const threadId = started.thread.id
    await runTurn(first.client, first.notifications, threadId, 'call the tool')
    expect(calls).toEqual(['call-0'])
    first.client.dispose()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const second = await root(cwd, env, handler)
    await second.client.request('thread/resume', { threadId, cwd })
    const requestsBeforeResumeTurn = requests.length
    await runTurn(second.client, second.notifications, threadId, 'after plain resume')
    const plainResumeTools = toolNames(requests[requestsBeforeResumeTurn])
    second.client.dispose()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const third = await root(cwd, env, handler)
    const emptyListResume = await third.client
      .request<{ thread: { id: string } }>('thread/resume', { threadId, cwd, dynamicTools: [] })
      .then(() => 'accepted')
      .catch((error: Error) => error.message)
    let emptyListResumeTools: string[] | null = null
    if (emptyListResume === 'accepted') {
      const before = requests.length
      await runTurn(third.client, third.notifications, threadId, 'after empty-list resume')
      emptyListResumeTools = toolNames(requests[before])
    } else {
      await third.client.request('thread/resume', { threadId, cwd })
    }
    const fork = await third.client.request<{ thread: { id: string } }>('thread/fork', {
      threadId,
      cwd
    })
    const beforeFork = requests.length
    await runTurn(third.client, third.notifications, fork.thread.id, 'fork turn')
    const forkTools = toolNames(requests[beforeFork])
    const forkWithTools = await third.client
      .request('thread/fork', { threadId, cwd, dynamicTools: [] })
      .then(() => 'accepted')
      .catch((error: Error) => error.message)
    console.log(
      JSON.stringify({
        probe: 'dynamic-tools',
        plainResumeTools,
        emptyListResume,
        emptyListResumeTools,
        forkTools,
        forkWithTools
      })
    )
    expect(plainResumeTools).toContain('fixture_echo')
    expect(errors).toEqual([])
  },
  90000
)
