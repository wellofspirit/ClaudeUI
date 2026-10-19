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
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexClient } from '../../core/codex/CodexClient'
import { codexDynamicToolSpecs } from '../../core/codex/codex-hosted-tools'
import { codexCollaborationMode, codexTurnPolicy } from '../../core/codex/codex-turn-policy'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'
import { SESSION_TOOL_NAMES, sessionToolsGuidance } from '../../shared/session-tools-description'
import {
  FIXTURE_CODEX_DIR,
  codexIntegrationEnabled,
  releaseFixtureCodex,
  storeCodexPath,
  useFixtureCodex
} from './integration-host'
import {
  fixtureAssistantMessage,
  isGuardianRequest,
  startFixtureProvider,
  writeFixtureCodexHome,
  type FixtureProvider
} from './fixture-provider'

/**
 * The session tools' wire (slice 2), against the PINNED binary: the nine specs
 * `codexDynamicToolSpecs(false, true)` builds are accepted by `thread/start`, offered
 * to the model, and a call comes back to the client as an `item/tool/call` server
 * request carrying the model's arguments; `developerInstructions` are accepted on
 * start and the probe records whether the model is shown them.
 *
 * The call is answered by the probe itself (the session's gate and service have
 * their own suites). NO CREDENTIAL AND NO NETWORK: the provider is the shared
 * localhost fixture, the home is a temp `CODEX_HOME`, and on macOS the child is
 * wrapped in a seatbelt profile that allows only the fixture port.
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
let provider: FixtureProvider | undefined

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
      await provider?.close()
      provider = undefined
    } finally {
      setHostPaths(null)
      releaseFixtureCodex()
      if (directory) rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  }
  expect(survivors, 'app-server groups survived bounded disposal').toEqual([])
})

/** Is this request OFFERING `name`, rather than replaying a past call of it? (as codex-app-server's helper) */
function advertises(value: unknown, name: string): boolean {
  if (typeof value === 'string') return value.includes(`### \`${name}\``)
  if (Array.isArray(value)) return value.some((entry) => advertises(entry, name))
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if ((record.type === 'function' || record.type === 'custom') && record.name === name) return true
  return Object.values(record).some((entry) => advertises(entry, name))
}

it.skipIf(!enabled)(
  'accepts the nine session tool specs, offers them to the model, and hands a call back as item/tool/call',
  async () => {
    const installed = storeCodexPath(process.platform === 'win32' ? 'codex.exe' : 'codex')
    expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
      provenance.codexBinaries[
        `${process.platform}-${process.arch}` as keyof typeof provenance.codexBinaries
      ]
    )
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-session-tools-')))
    const home = join(directory, 'home')
    const codexHome = join(home, '.codex')
    const cwd = join(directory, 'cwd')
    for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, FIXTURE_CODEX_DIR)])
      mkdirSync(name, { recursive: true })
    const exe = process.platform === 'win32' ? '.exe' : ''
    copyFileSync(installed, join(directory, FIXTURE_CODEX_DIR, `codex${exe}`))
    copyFileSync(
      storeCodexPath(`codex-code-mode-host${exe}`),
      join(directory, FIXTURE_CODEX_DIR, `codex-code-mode-host${exe}`)
    )
    setHostPaths({ getAppPath: () => directory! })
    useFixtureCodex(directory)

    const requests: Record<string, unknown>[] = []
    const errors: string[] = []
    provider = await startFixtureProvider({
      requests,
      errors,
      authorization: undefined,
      // Step one of the agent's turn calls the tool; step two answers.
      script: ({ request, requests: seen }) =>
        isGuardianRequest(request)
          ? fixtureAssistantMessage('{}', 'msg-guardian')
          : seen.filter((entry) => !isGuardianRequest(entry)).length === 1
            ? {
                type: 'function_call',
                call_id: 'call-session-list',
                name: 'session_list',
                arguments: JSON.stringify({ scope: 'linked' })
              }
            : fixtureAssistantMessage()
    })
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
(allow network-outbound (remote ip "localhost:${provider.port}"))
`
    )
    writeFixtureCodexHome(codexHome, {
      port: provider.port,
      model: 'mock-model',
      provider: 'fixture',
      apiKey: null
    })
    const env: NodeJS.ProcessEnv =
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

    const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
    const toolCalls: Array<Record<string, unknown>> = []
    const client = new CodexClient({
      cwd,
      env,
      requestTimeoutMs: 30000,
      serverMethods: ['item/tool/call'],
      onServerRequest: async (method, params) => {
        toolCalls.push({ method, ...(params as Record<string, unknown>) })
        return {
          contentItems: [{ type: 'inputText', text: 'ref s-abc123 · Fix the flaky test' }],
          success: true
        }
      },
      onNotification: (method, params) =>
        notifications.push({ method, params: params as Record<string, unknown> })
    })
    clients.push(client)
    await client.start({
      clientInfo: { name: 'codex_session_tools_probe', title: null, version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    const started = await client.request('thread/start', {
      cwd,
      model: 'mock-model',
      historyMode: 'paginated',
      allowProviderModelFallback: false,
      dynamicTools: codexDynamicToolSpecs(false, true),
      developerInstructions: sessionToolsGuidance({ toolPrefix: '' })
    })
    const threadId = started.thread.id
    const turn = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'List my sessions.', text_elements: [] }],
      // What CodexSession sends every turn (one function, two callers): the policy and the
      // collaboration mode, whose `developer_instructions: null` is what could displace
      // the thread-level instructions.
      ...codexTurnPolicy('default'),
      collaborationMode: codexCollaborationMode('default', 'mock-model')
    })
    const deadline = Date.now() + 60000
    while (
      !notifications.some(
        ({ method, params }) =>
          method === 'turn/completed' &&
          params.threadId === threadId &&
          (params.turn as { id: string })?.id === turn.turn.id
      )
    ) {
      if (Date.now() > deadline) throw new Error('Isolated Codex fixture deadline: turn')
      await new Promise((done) => setTimeout(done, 20))
    }

    expect(errors).toEqual([])
    // Every spec was accepted (a bad name or schema fails thread/start) and offered to the model.
    const agentRequests = requests.filter((request) => !isGuardianRequest(request))
    for (const name of SESSION_TOOL_NAMES)
      expect(
        agentRequests.some((request) => advertises(request, name)),
        `${name} was not offered`
      ).toBe(true)
    // The call came back to the client as the dynamic-tool server request, bare name, arguments intact.
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({
      method: 'item/tool/call',
      threadId,
      namespace: null,
      tool: 'session_list',
      arguments: { scope: 'linked' }
    })
    // …and the answer reached the model on its next request.
    expect(JSON.stringify(agentRequests)).toContain('Fix the flaky test')
    // Whether the thread-level instructions survive the per-turn collaboration mode: recorded, not
    // asserted (it is a bonus carrier, the descriptions are the primary one).
    const guidance = sessionToolsGuidance({ toolPrefix: '' }).slice(0, 60)
    console.log(
      JSON.stringify({
        probe: 'session-tools-developer-instructions',
        reachedModel: JSON.stringify(agentRequests).includes(guidance)
      })
    )
  },
  180000
)
