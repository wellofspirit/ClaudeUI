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
import { CodexService } from '../../core/codex/CodexService'
import { CodexSession } from '../../core/codex/CodexSession'
import { loadCodexHistory } from '../../core/codex/history'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'

/**
 * DOES AN INTERRUPTED HOSTED-TOOL CALL SURVIVE INTO COLD HISTORY? NO — pinned
 * against Codex 0.154.0 on 2026-09-13. See the assertions at the bottom. LIVE,
 * the call is answered by ClaudeUI itself: the binary sends nothing, so the
 * core synthesizes the failed result the card needs (`finishTurn` ->
 * `failUnresolvedHostedCalls`), which is the other half of what is pinned here.
 *
 * An M2-era probe found an interrupted dynamic tool call absent from both the
 * immediate and the cold native history, and the integration spec kept a
 * "presentation supplement" (ClaudeUI storing the unresolved call itself) open
 * against that finding. Slice C then made the mapper handle `dynamicToolCall`
 * items and the core complete an interrupted call as a `failed` item with a
 * cancellation text — so the finding predates the code and had to be re-taken
 * against the pinned binary before anything is built on it.
 *
 * The fixture is the hosted-tool one from
 * `codex-app-server.integration.test.ts` (isolated `CODEX_HOME`, scripted
 * localhost Responses provider over a websocket, sandbox containment), trimmed
 * to the one shape this asks about: the model calls `render_mermaid`, the
 * handler HANGS, and the turn is interrupted while the call is in flight. The
 * hang is the only mock — `createMermaidServer` is replaced by a handler that
 * never settles and ignores the abort signal, which is the worst case (a
 * handler that resolves on abort would answer the call and prove nothing).
 *
 * This test PINS WHAT THE BINARY DOES. It asserts the live transcript and the
 * cold read against each other and logs both, so a future binary that changes
 * its mind fails here rather than silently changing the UI.
 */

// Wrap only test spawns. Production exposes neither a command override nor a PATH fallback.
const containment = vi.hoisted(() => ({ profile: '', pids: [] as number[] }))
const coreEvents = vi.hoisted(() => vi.fn())
vi.mock('../../core/services/sync-host', () => ({ emitEvent: coreEvents }))
// The shared permission gate merges the USER's real ~/.claude rules. Pin them
// empty so this probe measures the mode base, not this machine's settings.
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

/**
 * The hosted tool that never finishes.
 *
 * `codex-hosted-tools.ts` memoizes one mermaid server per process and looks the
 * tool up by name, so replacing the factory is enough. The handler ignores
 * `extra.signal` on purpose: the question is what the BINARY records for a call
 * that is still outstanding when the turn ends, and a handler that gave up on
 * abort would answer the request and remove the very case being probed.
 */
const hostedTool = vi.hoisted(() => ({ called: 0 }))
vi.mock('../../core/services/mermaid-tool', () => ({
  createMermaidServer: () => ({
    tools: [
      {
        name: 'render_mermaid',
        handler: async () => {
          hostedTool.called++
          return new Promise(() => {})
        }
      }
    ]
  })
}))

const persistence = vi.hoisted(() => ({ close: () => {} }))
/** The isolated `session_meta` table the session writes through. */
const sessionMeta = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../../core/services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/db')>()
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  actual.runMigrations(db)
  persistence.close = () => db.close()
  return {
    dispatchedCostsByRouting: () => [],
    insertDispatchedUsage: vi.fn(),
    setSessionMeta: (id: string, meta: unknown) => void sessionMeta.set(id, meta),
    getSessionMeta: (id: string) => sessionMeta.get(id),
    allSessionMeta: () => Object.fromEntries(sessionMeta),
    deleteSessionMeta: (id: string) => void sessionMeta.delete(id),
    registerCodexFork: (id: string, from: string | null) => actual.registerCodexFork(id, from, db),
    listCodexForks: () => actual.listCodexForks(db),
    listCodexLineage: () => actual.listCodexLineage(db),
    recordCodexLineage: (id: string, from: string | null, verifiedAt: number | null) =>
      actual.recordCodexLineage(id, from, verifiedAt, db),
    deleteCodexFork: (id: string) => actual.deleteCodexFork(id, db),
    deleteCodexSessionOverrides: (id: string) => actual.deleteCodexSessionOverrides(id, db),
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
let service: CodexService | undefined
let session: CodexSession | undefined
let directory: string | undefined
let server: ReturnType<typeof createServer> | undefined
let websocket: WebSocketServer | undefined
afterEach(async () => {
  coreEvents.mockClear()
  hostedTool.called = 0
  sessionMeta.clear()
  const survivors: number[] = []
  try {
    service?.dispose()
    session?.dispose()
    session = undefined
    service = undefined
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
 * The hosted-tool fixture, copied down from
 * `codex-app-server.integration.test.ts`'s `setupFixture(true, true, false,
 * false, true)`: a real catalog model over a websocket provider that answers
 * the first agent turn with a `render_mermaid` call and everything after it
 * with a plain message.
 */
async function setupHostedToolFixture(): Promise<{
  cwd: string
  env: NodeJS.ProcessEnv
  errors: string[]
  requests: Record<string, unknown>[]
}> {
  const installed = resolve('vendor/codex-cli/codex')
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.binarySha256
  )
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-interrupt-integration-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, 'vendor/codex-cli')])
    mkdirSync(name, { recursive: true })
  copyFileSync(installed, join(directory, 'vendor/codex-cli/codex'))
  // Catalog models are `tool_mode: code_mode_only`, so the host has to be beside
  // the binary for a real model to call a tool at all.
  copyFileSync(
    resolve('vendor/codex-cli/codex-code-mode-host'),
    join(directory, 'vendor/codex-cli/codex-code-mode-host')
  )
  setHostPaths({ getAppPath: () => directory! })
  const requests: Record<string, unknown>[] = []
  const errors: string[] = []
  const completed = {
    type: 'response.completed',
    response: {
      id: 'resp-fixture',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    }
  }
  server = createServer((req, res) => {
    errors.push(`unexpected provider request: ${req.method} ${req.url}`)
    res.writeHead(400).end()
  })
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
        const agentTurns = requests.filter((entry) => entry.generate !== false).length
        const item =
          request.generate !== false && agentTurns === 1
            ? {
                type: 'function_call',
                call_id: 'fixture-render_mermaid',
                name: 'render_mermaid',
                arguments: JSON.stringify({
                  source: 'graph TD; A-->B',
                  title: 'Fixture diagram'
                })
              }
            : {
                type: 'message',
                id: 'msg-fixture',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'fixture complete' }]
              }
        for (const event of [
          { type: 'response.created', response: { id: 'resp-fixture' } },
          { type: 'response.output_item.done', item },
          completed
        ])
          connection.send(JSON.stringify(event))
      })
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
    `model_provider = "openai"
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
    JSON.stringify({ OPENAI_API_KEY: 'codex-fixture-not-a-real-key' })
  )
  return {
    cwd,
    errors,
    requests,
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

/** Every tool_use / tool_result block in a transcript, flattened. */
function toolBlocks(
  messages: Array<{ content: Array<Record<string, unknown>> }>
): Array<Record<string, unknown>> {
  return messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'tool_use' || block.type === 'tool_result')
}

it.skipIf(!enabled)(
  'answers an interrupted hosted-tool call itself: synthesized result live, no item in cold history',
  async () => {
    const { cwd, env, errors } = await setupHostedToolFixture()
    session = new CodexSession(
      'isolated-interrupt',
      null,
      cwd,
      {},
      { env, requestTimeoutMs: 20000 }
    )
    await session.run(null)
    const threadId = session.getSessionId()!
    // Not awaited: the turn cannot end until the hanging call is cut short, and
    // a rejected run must not surface as an unhandled rejection.
    const turn = session.run('Render the fixture diagram.').catch(() => {})

    // The call is IN FLIGHT: the binary has asked ClaudeUI to run the tool and
    // the handler is hanging, so there is a tool_use row and no result.
    await vi.waitFor(() => expect(hostedTool.called).toBe(1), { timeout: 60000 })
    const live = () => toolBlocks(session!.getMessages())
    await vi.waitFor(
      () =>
        expect(
          live().some((block) => block.type === 'tool_use' && block.toolName === 'render_mermaid')
        ).toBe(true),
      { timeout: 30000 }
    )
    const callId = live().find((block) => block.type === 'tool_use')!.toolUseId as string
    expect(live().filter((block) => block.type === 'tool_result')).toEqual([])

    await session.interrupt()
    await vi.waitFor(() => expect(session!.willQueue).toBe(false), { timeout: 60000 })
    await turn

    const liveBlocks = live()
    const liveResult = liveBlocks.find(
      (block) => block.type === 'tool_result' && block.toolUseId === callId
    )
    console.log(
      JSON.stringify({
        probe: 'interrupted-hosted-tool-live',
        callId,
        blocks: liveBlocks.map((block) => ({
          type: block.type,
          toolName: block.toolName,
          toolResult: block.toolResult,
          isError: block.isError
        }))
      })
    )

    // COLD: the same thread read back through the engine-history path, on a
    // fresh app-server process, with no live session anywhere.
    session.dispose()
    session = undefined
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const history = await loadCodexHistory(threadId, { cwd, env })
    const coldBlocks = toolBlocks(history.messages)
    const coldCall = coldBlocks.find(
      (block) => block.type === 'tool_use' && block.toolUseId === callId
    )
    const coldResult = coldBlocks.find(
      (block) => block.type === 'tool_result' && block.toolUseId === callId
    )
    service = new CodexService({ cwd, env, requestTimeoutMs: 15000 })
    const raw = await service.history(threadId)
    console.log(
      JSON.stringify({
        probe: 'interrupted-hosted-tool-cold',
        turns: raw.turns.map((turn) => ({
          id: turn.id,
          status: turn.status,
          items: turn.items.map((item) => ({
            type: item.type,
            ...(item.type === 'dynamicToolCall'
              ? {
                  tool: item.tool,
                  status: item.status,
                  success: item.success,
                  contentItems: item.contentItems
                }
              : {})
          }))
        })),
        blocks: coldBlocks.map((block) => ({
          type: block.type,
          toolName: block.toolName,
          toolResult: block.toolResult,
          isError: block.isError
        })),
        warnings: history.warnings
      })
    )

    // THE ANSWER, 2026-09-13, against pinned Codex 0.154.0. The M2 finding
    // about the BINARY stands, and slice C did not change it:
    //
    //  - The binary never completes a `dynamicToolCall` that is still
    //    outstanding when the turn is interrupted, so the mapper (which only
    //    emits a `tool_result` for a COMPLETED item) has nothing to emit and
    //    `finishTurn`'s authoritative replay of `turn.items` has nothing to
    //    replay.
    //  - COLD: the interrupted turn's items are `["userMessage"]`. The
    //    `dynamicToolCall` item is not in the rollout at all, so no read of any
    //    kind can bring it back.
    //
    // What CHANGED is what ClaudeUI does with that: leaving the card a bare
    // `tool_use` left it spinning for good, so the core now tombstones every
    // unresolved hosted call when the turn ends interrupted, with cli.js's own
    // wording for a tool call Esc cut short. That is a LIVE record only — the
    // durable one would have to be ClaudeUI's own (the spec's "presentation
    // supplement"), which is deliberately NOT built, so a restart still shows
    // nothing but the incompleteness warning below.
    expect(liveBlocks.map((block) => block.type)).toEqual(['tool_use', 'tool_result'])
    expect(liveBlocks[0]).toMatchObject({ toolName: 'render_mermaid', toolUseId: callId })
    expect(liveResult, 'the interrupted call was left without a result after all').toEqual({
      type: 'tool_result',
      toolUseId: callId,
      toolResult: '[Request interrupted by user for tool use]',
      isError: true
    })
    expect(raw.turns).toHaveLength(1)
    expect(raw.turns[0].status).toBe('interrupted')
    expect(raw.turns[0].items.map((item) => item.type)).toEqual(['userMessage'])
    expect(coldCall, 'the interrupted call reached cold history after all').toBeUndefined()
    expect(coldResult).toBeUndefined()
    expect(coldBlocks).toEqual([])
    // The one thing the user does get: the turn is interrupted, so the cold
    // read is flagged as possibly missing work.
    expect(history.warnings[0]).toContain('unresolved work')
    expect(errors).toEqual([])
  },
  180000
)
