/**
 * End-to-end proof that ClaudeUI's compiled execpolicy file changes what a real
 * Codex thread does with a real command.
 *
 * Everything upstream of this is unit-tested against strings; this is the only
 * place the claim "a Claude `Bash(...)` rule binds a Codex turn" is actually
 * observed. The file is written by the PRODUCTION writer (`syncCodexRulesFile`)
 * into a disposable `CODEX_HOME`, never the developer's own — `CODEX_HOME` is
 * passed explicitly and the fixture env hands the spawned binary the same path.
 *
 * Fixture shape is the auto-review probe's, trimmed to what a rule test needs:
 * a scripted localhost Responses provider, a `sandbox-exec` containment profile
 * confining every spawn to the fixture directory, and an isolated home. The
 * containment caveats documented there apply verbatim — most importantly, a
 * command Codex runs SANDBOXED dies at exit 71 because macOS refuses to nest
 * seatbelt profiles, so only "did the rule take this command out of the
 * approval flow" is asserted, never a sandboxed command's exit code.
 */

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
import { CodexAppServerClient } from '../../core/codex/CodexAppServerClient'
import { setHostPaths } from '../../core/host'
import { syncCodexRulesFile } from '../../core/codex/rules-sync'
import provenance from '../../core/codex/protocol/provenance.json'
import type { SandboxPolicy } from '../../core/codex/protocol/v2/SandboxPolicy'
import type { ClaudePermissions } from '../../shared/types'

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

const clients: CodexAppServerClient[] = []
const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  const survivors: number[] = []
  try {
    for (const client of clients.splice(0)) client.dispose()
    await new Promise((r) => setTimeout(r, 1200))
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
    setHostPaths(null)
    for (const teardown of teardowns.splice(0)) await teardown()
  }
  expect(survivors, 'app-server groups survived bounded disposal').toEqual([])
})

type ProviderRequest = Record<string, unknown>
type Step = { id: string; cmd: string }

type Fixture = {
  directory: string
  codexHome: string
  cwd: string
  env: NodeJS.ProcessEnv
  requests: ProviderRequest[]
  errors: string[]
  script: { current: (agentIndex: number) => Record<string, unknown> }
}

const done = (): Record<string, unknown> => ({
  type: 'message',
  id: 'msg-fixture',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'fixture complete' }]
})

async function setupFixture(): Promise<Fixture> {
  const installed = resolve('vendor/codex-cli/codex')
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.binarySha256
  )
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-rules-sync-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, 'vendor/codex-cli')])
    mkdirSync(name, { recursive: true })
  // BOTH binaries: `codexBinaryAvailable()` gates the rule sync on the
  // code-mode host sitting beside `codex`, so a fixture without it would make
  // the writer a silent no-op and the whole test vacuous.
  for (const name of ['codex', 'codex-code-mode-host'])
    copyFileSync(resolve('vendor/codex-cli', name), join(directory, 'vendor/codex-cli', name))
  setHostPaths({ getAppPath: () => directory })

  const requests: ProviderRequest[] = []
  const errors: string[] = []
  const script = { current: (() => done()) as (agentIndex: number) => Record<string, unknown> }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 8_000_000) req.destroy()
    })
    req.on('error', () => {})
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        errors.push(`unexpected provider request: ${req.method} ${req.url}`)
        res.writeHead(400).end()
        return
      }
      let parsed: ProviderRequest
      try {
        parsed = JSON.parse(body)
      } catch {
        errors.push('invalid provider JSON')
        res.writeHead(400).end()
        return
      }
      const agentIndex = requests.length
      requests.push(parsed)
      const events = [
        { type: 'response.created', response: { id: 'resp-fixture' } },
        { type: 'response.output_item.done', item: script.current(agentIndex) },
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
  teardowns.push(async () => {
    const closed = new Promise<void>((r) => server.close(() => r()))
    server.closeAllConnections()
    await closed
    rmSync(directory, { recursive: true, force: true })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
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
  writeFileSync(
    join(codexHome, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'codex-fixture-not-a-real-key' })
  )
  return {
    directory,
    codexHome,
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

const SERVER_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'item/tool/call',
  'mcpServer/elicitation/request',
  'currentTime/read',
  'attestation/generate',
  'applyPatchApproval',
  'execCommandApproval'
] as const

type Root = {
  client: CodexAppServerClient
  notifications: Array<{ method: string; params: Record<string, unknown> }>
  calls: Array<{ method: string; params: Record<string, unknown> }>
}

async function root(fixture: Fixture): Promise<Root> {
  const notifications: Root['notifications'] = []
  const calls: Root['calls'] = []
  const client = new CodexAppServerClient({
    cwd: fixture.cwd,
    env: fixture.env,
    requestTimeoutMs: 30000,
    serverMethods: SERVER_METHODS,
    onServerRequest: async (_method, params) => {
      calls.push({ method: _method, params: params as Record<string, unknown> })
      return { decision: 'accept' }
    },
    onNotification: (method, params) =>
      notifications.push({ method, params: params as Record<string, unknown> })
  })
  clients.push(client)
  await client.start({
    clientInfo: { name: 'codex_rules_sync_integration', title: null, version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  return { client, notifications, calls }
}

function scriptSteps(fixture: Fixture, steps: Step[]): void {
  fixture.script.current = (agentIndex) => {
    const step = steps[agentIndex]
    if (!step) return done()
    return {
      type: 'function_call',
      call_id: step.id,
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: step.cmd })
    }
  }
}

/**
 * `approval_policy = "untrusted"` is rejected in `config.toml` by this binary
 * ("no longer supported; remove this setting"), so the policy under test is
 * passed per turn — which is also how `CodexSession` sets it.
 */
const WORKSPACE_WRITE = (cwd: string): SandboxPolicy => ({
  type: 'workspaceWrite',
  writableRoots: [cwd],
  networkAccess: false,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true
})

async function runTurn(active: Root, threadId: string, cwd: string): Promise<void> {
  const turn = await active.client.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'rules probe', text_elements: [] }],
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandboxPolicy: WORKSPACE_WRITE(cwd)
  })
  const deadline = Date.now() + 60000
  while (
    !active.notifications.some(
      ({ method, params }) =>
        method === 'turn/completed' &&
        params.threadId === threadId &&
        (params.turn as { id: string })?.id === turn.turn.id
    )
  ) {
    if (Date.now() > deadline) throw new Error('Isolated Codex rules fixture deadline')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Everything Codex told the agent about `callId`, deduped across resends. */
function callOutput(fixture: Fixture, callId: string): string | null {
  const outputs = new Set(
    fixture.requests
      .flatMap((request) => (request.input as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((item) => item.type === 'function_call_output' && item.call_id === callId)
      .map((item) => String(item.output))
  )
  return outputs.size ? [...outputs].join('\n---\n') : null
}

const askedAbout = (active: Root): string[] =>
  active.calls.map((call) => String((call.params as { itemId?: string }).itemId))

const perms = (partial: Partial<ClaudePermissions>): ClaudePermissions => ({
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined,
  ...partial
})

/**
 * Drive one turn of `echo hi` then `ls` against a fixture whose rule file was
 * compiled from `permissions`. `ls` is the unruled control in the deny case and
 * the subject in the allow case.
 */
async function driveWith(permissions: ClaudePermissions) {
  const fixture = await setupFixture()
  const written = syncCodexRulesFile({ codexHome: fixture.codexHome, perms: permissions })
  expect(written.wrote, 'production writer wrote the rule file').toBe(true)
  expect(written.path).toBe(join(fixture.codexHome, 'rules', 'claudeui.rules'))
  const active = await root(fixture)
  const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
    cwd: fixture.cwd,
    model: 'mock-model',
    modelProvider: 'fixture',
    historyMode: 'paginated'
  })
  // Bare commands, no shell metacharacters: Codex strips its own `/bin/zsh -lc`
  // wrapper only for a simple command, and a bare-argv prefix rule matches
  // nothing otherwise (see the rules probe in the auto-review probe file).
  scriptSteps(fixture, [
    { id: 'rule-echo', cmd: 'echo hi' },
    { id: 'rule-ls', cmd: 'ls' }
  ])
  await runTurn(active, started.thread.id, fixture.cwd)
  expect(fixture.errors).toEqual([])
  return { fixture, active }
}

it.skipIf(!enabled)(
  'a compiled DENY rule blocks the command with no approval request',
  async () => {
    const { fixture, active } = await driveWith(perms({ deny: ['Bash(echo:*)'] }))

    // The rule took `echo hi` out of the approval flow entirely — it was never
    // asked about, and it never ran. Only the unruled `ls` reached the client.
    expect(askedAbout(active)).toEqual(['rule-ls'])
    // A rule carrying a `justification` REPLACES Codex's own "policy forbids
    // commands starting with `echo`" wording with that text, so what the model
    // (and the transcript) sees names the user's own rule. That is why the
    // compiler always emits one.
    expect(String(callOutput(fixture, 'rule-echo'))).toContain(
      "`/bin/zsh -lc 'echo hi'` rejected: ClaudeUI deny rule Bash(echo:*)"
    )
  },
  240000
)

it.skipIf(!enabled)(
  'a compiled ALLOW rule runs the command with no approval request',
  async () => {
    const { fixture, active } = await driveWith(perms({ allow: ['Bash(ls:*)'] }))

    // Mirror image: under `untrusted` every command is asked about, so `ls`
    // missing from the list is the rule at work. `echo hi` is the control.
    expect(askedAbout(active)).toEqual(['rule-echo'])
    expect(String(callOutput(fixture, 'rule-ls'))).not.toContain('policy forbids')
    expect(callOutput(fixture, 'rule-ls')).toMatch(/Process exited with code 0|Exit code: 0/)
  },
  240000
)
