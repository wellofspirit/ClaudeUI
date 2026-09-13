import { createServer, type ServerResponse } from 'node:http'
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
import {
  CrossEngineDispatcher,
  type DispatchContext,
  type DispatcherDeps,
  type SpawnCodexTargetFn
} from '../../core/services/cross-engine-dispatcher'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'
import type { DispatchedUsageRow } from '../../core/services/db'

/**
 * Codex as a cross-engine dispatch TARGET, against the REAL pinned binary and a
 * scripted localhost Responses fixture (ADR-033 slice H).
 *
 * NOTHING about Codex is stubbed here. The real `CrossEngineDispatcher` runs
 * its real `createCodexTarget`/`driveCodexTurn`/`settleCodexTurn` path against
 * a real `codex app-server` child: `thread/start` really opens a thread,
 * `turn/start` really runs a turn, the real `mapCodexItem` pipeline turns real
 * notifications into the caller's subagent events, and `turn/interrupt` really
 * ends one. The CALLER is the only fake — a plain `DispatchContext` object
 * standing in for whatever session would host `dispatch_agent`.
 *
 * `spawnCodexTarget` IS injected, for ONE reason: the target's child needs the
 * isolated `env` (an in-tmpdir CODEX_HOME + the fixture provider) that keeps
 * this test off the user's real Codex install and off the network. The
 * injected function forwards every option the dispatcher built — cwd, the
 * four server methods, and all three callbacks — VERBATIM, and adds only
 * `env`; the assertion below pins that, so the seam cannot quietly become a
 * stub. `CODEX_HOME` is set to a directory under the disposable tmpdir and
 * `~/.codex` is never read or written.
 *
 * Gated: CODEX_INTEGRATION=1 on darwin/arm64 (the only platform with binary
 * provenance). Every spawn is wrapped in a deny-by-default seatbelt profile, so
 * a command the model decides to run cannot escape the tmpdir — the same
 * containment the other probes in this directory use.
 *
 * Run manually:
 *   CODEX_INTEGRATION=1 bun run test:integration src/integration/codex
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

const ROUTING_ID = 'routing-codex-dispatch-target-integration'

const dispatchers: CrossEngineDispatcher[] = []
let directory: string | undefined
let server: ReturnType<typeof createServer> | undefined
const held: ServerResponse[] = []

afterEach(async () => {
  const survivors: number[] = []
  try {
    for (const dispatcher of dispatchers.splice(0)) dispatcher.disposeFor(ROUTING_ID)
    for (const response of held.splice(0)) response.end()
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

/** One scripted provider reply, or `'hold'` to leave the stream open forever. */
type Script = (request: Record<string, unknown>, index: number) => Record<string, unknown> | 'hold'

const message = (text: string): Record<string, unknown> => ({
  type: 'message',
  id: 'msg-fixture',
  role: 'assistant',
  content: [{ type: 'output_text', text }]
})

async function setupFixture(): Promise<{
  cwd: string
  env: NodeJS.ProcessEnv
  requests: Record<string, unknown>[]
  script: { current: Script }
}> {
  const installed = resolve('vendor/codex-cli/codex')
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.binarySha256
  )
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-dispatch-target-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, 'vendor/codex-cli')])
    mkdirSync(name, { recursive: true })
  copyFileSync(installed, join(directory, 'vendor/codex-cli/codex'))
  setHostPaths({ getAppPath: () => directory! })

  const requests: Record<string, unknown>[] = []
  const script = { current: (() => message('fixture complete')) as Script }
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 4_000_000) req.destroy()
    })
    req.on('error', () => {})
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.writeHead(400).end()
        return
      }
      const parsed = JSON.parse(body) as Record<string, unknown>
      requests.push(parsed)
      const item = script.current(parsed, requests.length - 1)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      if (item === 'hold') {
        // The turn stays in flight until something interrupts it.
        res.write(
          `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-fixture' } })}\n\n`
        )
        held.push(res)
        return
      }
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
      res.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      )
    })
  })
  // The BUILT-IN `openai` provider advertises `supports_websockets: true` and
  // config cannot override a built-in provider's fields (model-provider-info's
  // `merge_configured_model_providers` keeps the built-in), so the first thing
  // Codex tries is a Responses-over-WebSocket upgrade. Refusing it cleanly with
  // a 426 is what makes the client fall back to plain HTTP streaming, which is
  // the transport this fixture actually speaks.
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n')
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
  // The provider is named `openai` deliberately: `assertCodexProvider` (which
  // the dispatch target runs against `config/read`, exactly as CodexSession
  // does) refuses anything else, so a fixture under any other name could not
  // exercise the real code path at all. Its base_url still points at the
  // loopback fixture above — no credential, no network.
  writeFileSync(
    join(codexHome, 'config.toml'),
    `model = "gpt-6-astra"
model_provider = "openai"
openai_base_url = "http://127.0.0.1:${port}/v1"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"
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
    JSON.stringify({ OPENAI_API_KEY: 'fixture-placeholder-not-a-credential' })
  )
  return {
    cwd,
    requests,
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

function makeDispatcher(
  env: NodeJS.ProcessEnv,
  usage: Array<Omit<DispatchedUsageRow, 'id'>>,
  forwarded: Array<Parameters<SpawnCodexTargetFn>[0]>
): CrossEngineDispatcher {
  const spawnCodexTarget: SpawnCodexTargetFn = async (opts) => {
    forwarded.push(opts)
    // Everything the dispatcher built is passed through untouched; only `env`
    // is added, and only to keep the child off the real Codex install.
    return new CodexClient({ ...opts, env, requestTimeoutMs: 30_000 })
  }
  const deps: DispatcherDeps = {
    // The opencode-direction deps are structurally required but never invoked
    // dispatching engine:'codex' — throwing stubs make that loud if it ever
    // stops being true.
    serverManager: {
      acquire: async () => {
        throw new Error('serverManager.acquire must never run for engine: "codex"')
      },
      release: () => {
        throw new Error('serverManager.release must never run for engine: "codex"')
      }
    },
    makeClient: () => {
      throw new Error('makeClient must never run for engine: "codex"')
    },
    // No model/allowlist configured: the target resolves the fixture's own
    // config model, which is the ordinary no-config-needed path.
    loadEngineConfig: () => ({}),
    spawnCodexTarget,
    dispatchTimeoutMs: 45_000,
    codexAbortSettleGraceMs: 5_000,
    // A no-op rather than the real better-sqlite3 insert: this vitest context
    // has no Electron `app` for a userData path, and the point here is the ROW
    // the dispatcher builds, not the table it lands in.
    recordDispatchedUsage: (row) => usage.push(row)
  }
  const dispatcher = new CrossEngineDispatcher(deps)
  dispatchers.push(dispatcher)
  return dispatcher
}

it.runIf(enabled)(
  'a real dispatch into Codex runs a turn, returns its text, records usage, and continues the same thread',
  async () => {
    const fixture = await setupFixture()
    const usage: Array<Omit<DispatchedUsageRow, 'id'>> = []
    const forwarded: Array<Parameters<SpawnCodexTargetFn>[0]> = []
    const dispatcher = makeDispatcher(fixture.env, usage, forwarded)
    const emitted: Array<{ channel: string; data: unknown }> = []
    const ctx: DispatchContext = {
      fromEngine: 'claude',
      fromRoutingId: ROUTING_ID,
      cwd: fixture.cwd,
      autonomyMode: 'default',
      emit: (channel, data) => emitted.push({ channel, data }),
      toolUseId: 'toolu_dispatch_integration'
    }

    fixture.script.current = (_request, index) =>
      message(index === 0 ? 'first answer' : 'second answer')

    const first = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'Reply with exactly: first answer' },
      ctx
    )
    expect(first.isError, `dispatch failed: ${first.text}`).toBeFalsy()
    expect(first.text).toBe('first answer')
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/)

    // The seam is a pass-through, not a stub.
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]!.cwd).toBe(fixture.cwd)
    expect(forwarded[0]!.serverMethods).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
      'item/permissions/requestApproval'
    ])

    // The turn's text reached the caller's subagent channel too.
    expect(
      emitted.some(
        (entry) =>
          entry.channel === 'session:subagent-message' &&
          JSON.stringify(entry.data).includes('first answer')
      )
    ).toBe(true)
    const notification = emitted.find((entry) => entry.channel === 'session:task-notification')!
    expect((notification.data as { status: string }).status).toBe('completed')

    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      fromRoutingId: ROUTING_ID,
      fromEngine: 'claude',
      targetEngine: 'codex',
      targetModel: 'gpt-6-astra',
      targetSessionId: first.sessionId,
      toolUseId: 'toolu_dispatch_integration'
    })
    expect(usage[0]!.totalTokens).toBeGreaterThan(0)
    // `gpt-6-astra` IS in shared/pricing.ts, so the row carries the API-rate
    // equivalent — a positive number, not the `null` an unpriced model gets.
    expect(usage[0]!.costUsd).toBeGreaterThan(0)

    // Continuation: the SAME thread, one more turn, no second thread.
    const second = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'Reply with exactly: second answer', sessionId: first.sessionId },
      ctx
    )
    expect(second.isError, `continuation failed: ${second.text}`).toBeFalsy()
    expect(second.text).toBe('second answer')
    expect(second.sessionId).toBe(first.sessionId)
    expect(forwarded).toHaveLength(1)
    expect(usage).toHaveLength(2)
    // The second provider request carries the first turn's context — proof the
    // thread, not just the process, was reused.
    expect(JSON.stringify(fixture.requests[1])).toContain('first answer')
  },
  120_000
)

it.runIf(enabled)(
  'a stop mid-turn really interrupts the native turn',
  async () => {
    const fixture = await setupFixture()
    const usage: Array<Omit<DispatchedUsageRow, 'id'>> = []
    const forwarded: Array<Parameters<SpawnCodexTargetFn>[0]> = []
    const dispatcher = makeDispatcher(fixture.env, usage, forwarded)
    const ctx: DispatchContext = {
      fromEngine: 'claude',
      fromRoutingId: ROUTING_ID,
      cwd: fixture.cwd,
      autonomyMode: 'default',
      emit: () => {},
      toolUseId: 'toolu_dispatch_stop'
    }

    // The provider opens the stream and never finishes it, so the turn stays in
    // flight until `turn/interrupt` ends it.
    fixture.script.current = () => 'hold'

    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'run forever' }, ctx)
    // Wait until the turn is genuinely running on the binary before stopping it.
    const deadline = Date.now() + 30_000
    while (fixture.requests.length === 0) {
      if (Date.now() > deadline) throw new Error('the fixture provider was never called')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(dispatcher.stopDispatch('toolu_dispatch_stop', ROUTING_ID)).toBe(true)

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toBe('Dispatch stopped by user.')
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    // A stopped turn records no usage row (ADR-033 M4-B).
    expect(usage).toHaveLength(0)
  },
  120_000
)
