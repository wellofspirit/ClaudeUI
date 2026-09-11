import { createServer } from 'node:http'
import {
  copyFileSync,
  existsSync,
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
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexAppServerClient } from '../../core/codex/CodexAppServerClient'
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'
import type { AskForApproval } from '../../core/codex/protocol/v2/AskForApproval'
import type { SandboxPolicy } from '../../core/codex/protocol/v2/SandboxPolicy'

/**
 * Native approval-surface probes against the pinned binary and a scripted
 * localhost Responses fixture. Evidence for replacing Codex's native policy
 * with ClaudeUI's shared permission model: which `(approvalPolicy,
 * sandboxPolicy)` pair actually routes a server→client approval request, what
 * the request carries, and what runs without one.
 *
 * Every assertion here pins an OBSERVED shape, not a desired one. Two
 * observations are load-bearing for reading the rest of the file:
 *
 *  1. THE CONTAINMENT SANDBOX HIDES CODEX'S OWN SANDBOX. macOS lets a process
 *     re-apply the SAME seatbelt profile but refuses a different one, however
 *     permissive either is (`sandbox_apply: Operation not permitted`, exit 71
 *     — pinned by the last test in this file). The fixture wraps every spawn in
 *     `sandbox-exec`, so any command Codex decides to run SANDBOXED dies at
 *     exit 71 before touching the filesystem, and only commands it runs
 *     UNSANDBOXED (approved, or under `dangerFullAccess`) execute for real.
 *     That makes the approval dimension measurable and the sandbox-enforcement
 *     dimension NOT measurable here — `EXIT_NESTED_SANDBOX` marks the spots.
 *  2. There is no `shell` tool and no `apply_patch` tool on the wire. The
 *     pinned binary offers `exec_command` + `write_stdin` (a `shell` call is
 *     answered `unsupported call: shell`), and file changes reach the
 *     `item/fileChange/requestApproval` path only because Codex intercepts an
 *     `apply_patch` heredoc INSIDE an `exec_command` payload.
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

/** `sandbox-exec` refusing to nest inside the containment profile. */
const EXIT_NESTED_SANDBOX = 71

const GRANULAR_ALL: AskForApproval = {
  granular: {
    sandbox_approval: true,
    rules: true,
    skill_approval: true,
    request_permissions: true,
    mcp_elicitations: true
  }
}

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

type Script = (request: Record<string, unknown>, index: number) => Record<string, unknown>
const done = (): Record<string, unknown> => ({
  type: 'message',
  id: 'msg-fixture',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'fixture complete' }]
})

type Fixture = {
  cwd: string
  outside: string
  env: NodeJS.ProcessEnv
  requests: Record<string, unknown>[]
  errors: string[]
  script: { current: Script }
}

/**
 * One disposable Codex installation: isolated `CODEX_HOME` holding a fake key,
 * a scripted localhost Responses provider, a containment profile that confines
 * every spawned process to the fixture directory, and `cwd` / `outside`
 * siblings so "inside the workspace" and "outside it" are both writable by the
 * CONTAINMENT profile and only differ to Codex.
 *
 * `features` is appended to the `[features]` table; `reviewer` is emitted as a
 * top-level `approvals_reviewer` line unless null (probe E needs it absent).
 */
async function setupFixture(
  options: { features?: string; reviewer?: string | null } = {}
): Promise<Fixture> {
  const installed = resolve('vendor/codex-cli/codex')
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.binarySha256
  )
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-policy-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  const outside = join(directory, 'outside')
  for (const name of [
    codexHome,
    cwd,
    outside,
    join(directory, 'tmp'),
    join(directory, 'vendor/codex-cli')
  ])
    mkdirSync(name, { recursive: true })
  copyFileSync(installed, join(directory, 'vendor/codex-cli/codex'))
  setHostPaths({ getAppPath: () => directory })
  const requests: Record<string, unknown>[] = []
  const errors: string[] = []
  const script = { current: done as Script }
  const server = createServer((req, res) => {
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
  const reviewer = options.reviewer === undefined ? 'user' : options.reviewer
  writeFileSync(
    join(codexHome, 'config.toml'),
    `model = "mock-model"
model_provider = "fixture"
approval_policy = "on-request"
${reviewer === null ? '' : `approvals_reviewer = "${reviewer}"`}
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
${options.features ?? ''}
`
  )
  writeFileSync(
    join(codexHome, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'codex-fixture-not-a-real-key' })
  )
  return {
    cwd,
    outside,
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
type ApprovalRequest = { method: string; params: Record<string, unknown> }
type Reply = (method: string, params: Record<string, unknown>) => unknown

type Root = {
  client: CodexAppServerClient
  notifications: Notification[]
  approvals: ApprovalRequest[]
}

async function root(fixture: Fixture, reply: Reply): Promise<Root> {
  const notifications: Notification[] = []
  const approvals: ApprovalRequest[] = []
  const client = new CodexAppServerClient({
    cwd: fixture.cwd,
    env: fixture.env,
    requestTimeoutMs: 30000,
    serverMethods: [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval'
    ],
    onServerRequest: async (method, params) => {
      approvals.push({ method, params: params as Record<string, unknown> })
      return reply(method, params as Record<string, unknown>)
    },
    onNotification: (method, params) =>
      notifications.push({ method, params: params as Record<string, unknown> })
  })
  clients.push(client)
  await client.start({
    clientInfo: { name: 'codex_policy_probe', title: null, version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  return { client, notifications, approvals }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 40000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Isolated Codex policy fixture deadline: ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function runTurn(
  active: Root,
  threadId: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const turn = await active.client.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'policy probe', text_elements: [] }],
    ...extra
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

/** A scripted step: one `exec_command` call the fixture model emits. */
type Step = { id: string; cmd: string; escalate?: boolean }

const patchStep = (id: string, path: string, body: string): Step => ({
  id,
  cmd: `apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: ${path}\n+${body}\n*** End Patch\nPATCH\n`
})

/** Script the fixture provider to emit `steps` in order, then a final message. */
function scriptSteps(fixture: Fixture, steps: Step[]): void {
  fixture.script.current = (_request, index) => {
    const step = steps[index]
    if (!step) return done()
    return {
      type: 'function_call',
      call_id: step.id,
      name: 'exec_command',
      arguments: JSON.stringify(
        step.escalate
          ? {
              cmd: step.cmd,
              sandbox_permissions: 'require_escalated',
              justification: 'Isolated fixture probe'
            }
          : { cmd: step.cmd }
      )
    }
  }
}

/** Exit code Codex reported back to the model for `callId`, or null. */
function exitCode(fixture: Fixture, callId: string): number | null {
  const output = (fixture.requests.at(-1)?.input as Array<Record<string, unknown>> | undefined)
    ?.filter((item) => item.type === 'function_call_output' && item.call_id === callId)
    .map((item) => String(item.output))
    .join('\n')
  if (!output) return null
  const codes = [...output.matchAll(/(?:Process exited with code|Exit code:) (-?\d+)/g)].map((m) =>
    Number(m[1])
  )
  return codes.length ? codes[codes.length - 1] : null
}

/** The approval request whose `itemId` is `callId`, reduced to the fields under review. */
function approvalFor(active: Root, callId: string): Record<string, unknown> | null {
  const hit = active.approvals.find(({ params }) => params.itemId === callId)
  if (!hit) return null
  const {
    kind,
    reason,
    availableDecisions,
    commandActions,
    proposedExecpolicyAmendment,
    grantRoot
  } = hit.params as Record<string, unknown>
  return {
    method: hit.method,
    kind: kind ?? null,
    reason: reason ?? null,
    availableDecisions: availableDecisions ?? null,
    commandActions: commandActions ?? null,
    proposedExecpolicyAmendment: proposedExecpolicyAmendment ?? null,
    grantRoot: grantRoot ?? null
  }
}

const COMMAND_DECISIONS = (amendment: string[]): unknown[] => [
  'accept',
  { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } },
  'cancel'
]

/**
 * The six actions the spike asks about, as one scripted turn.
 * Steps 4 and 5 are `apply_patch` heredocs, the only route to the native
 * file-change path in a build that offers no `apply_patch` tool.
 */
function matrixSteps(cwd: string, outside: string): Step[] {
  return [
    { id: 'read', cmd: 'ls' },
    { id: 'write-inside', cmd: `echo x > ${cwd}/inside.txt` },
    { id: 'write-outside', cmd: `echo x > ${outside}/outside.txt` },
    patchStep('patch-inside', `${cwd}/patched-inside.txt`, 'inside'),
    patchStep('patch-outside', `${outside}/patched-outside.txt`, 'outside'),
    { id: 'network', cmd: 'curl http://127.0.0.1:1/' }
  ]
}

type ComboRecord = {
  approvalPolicy: AskForApproval
  sandbox: string
  cwd: string
  outside: string
  steps: Array<{
    id: string
    approval: Record<string, unknown> | null
    exitCode: number | null
  }>
  artifacts: Record<string, boolean>
}

async function runCombo(
  approvalPolicy: AskForApproval,
  sandbox: (cwd: string) => SandboxPolicy,
  label: string
): Promise<ComboRecord> {
  const fixture = await setupFixture()
  const active = await root(fixture, (method) =>
    method === 'item/permissions/requestApproval'
      ? { permissions: {}, scope: 'turn' }
      : { decision: 'accept' }
  )
  const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
    cwd: fixture.cwd,
    model: 'mock-model',
    modelProvider: 'fixture',
    historyMode: 'paginated'
  })
  const steps = matrixSteps(fixture.cwd, fixture.outside)
  scriptSteps(fixture, steps)
  await runTurn(active, started.thread.id, {
    approvalPolicy,
    sandboxPolicy: sandbox(fixture.cwd)
  })
  const record: ComboRecord = {
    approvalPolicy,
    sandbox: label,
    cwd: fixture.cwd,
    outside: fixture.outside,
    steps: steps.map((step) => ({
      id: step.id,
      approval: approvalFor(active, step.id),
      exitCode: exitCode(fixture, step.id)
    })),
    artifacts: {
      'inside.txt': existsSync(join(fixture.cwd, 'inside.txt')),
      'outside.txt': existsSync(join(fixture.outside, 'outside.txt')),
      'patched-inside.txt': existsSync(join(fixture.cwd, 'patched-inside.txt')),
      'patched-outside.txt': existsSync(join(fixture.outside, 'patched-outside.txt'))
    }
  }
  console.log(JSON.stringify({ probe: 'matrix', ...record }))
  expect(fixture.errors).toEqual([])
  return record
}

const SANDBOXES: Array<[string, (cwd: string) => SandboxPolicy]> = [
  ['readOnly', () => ({ type: 'readOnly', networkAccess: false })],
  [
    'workspaceWrite',
    (cwd) => ({
      type: 'workspaceWrite',
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true
    })
  ],
  ['dangerFullAccess', () => ({ type: 'dangerFullAccess' })]
]

// ─────────────────────────────────────────────────────────────────────────────
// The matrix: one test per approvalPolicy, three sandboxes each.
// ─────────────────────────────────────────────────────────────────────────────

const RETRY = 'command failed; retry without sandbox?'
const ALL_LANDED = {
  'inside.txt': true,
  'outside.txt': true,
  'patched-inside.txt': true,
  'patched-outside.txt': true
}
const NONE_LANDED = {
  'inside.txt': false,
  'outside.txt': false,
  'patched-inside.txt': false,
  'patched-outside.txt': false
}
const methods = (record: ComboRecord): Array<string | null> =>
  record.steps.map((step) => (step.approval?.method as string | undefined) ?? null)
const reasons = (record: ComboRecord): Array<string | null> =>
  record.steps.map((step) => (step.approval?.reason as string | null | undefined) ?? null)

const COMMAND = 'item/commandExecution/requestApproval'
const FILE_CHANGE = 'item/fileChange/requestApproval'

it.skipIf(!enabled)(
  'probes `untrusted` across the three sandbox policies',
  async () => {
    for (const [label, sandbox] of SANDBOXES) {
      const record = await runCombo('untrusted', sandbox, label)
      // `untrusted` asks FIRST, for all six steps, under EVERY sandbox, and
      // with no `reason` — the decision is taken before anything runs, so the
      // sandbox policy changes nothing about whether we are asked.
      expect(methods(record)).toEqual([
        COMMAND,
        COMMAND,
        COMMAND,
        FILE_CHANGE,
        FILE_CHANGE,
        COMMAND
      ])
      expect(reasons(record)).toEqual([null, null, null, null, null, null])
      expect(record.steps[0].approval!.kind).toBe('command')
      expect(record.steps[0].approval!.availableDecisions).toEqual(COMMAND_DECISIONS(['ls']))
      // `decline` and `acceptForSession` are in the wire type but are NOT
      // advertised; `cancel` is the only non-accept option on offer.
      for (const step of record.steps) {
        const decisions = step.approval!.availableDecisions as unknown[] | null
        if (decisions) {
          expect(decisions).toContain('accept')
          expect(decisions).not.toContain('decline')
          expect(decisions).not.toContain('acceptForSession')
        }
      }
      // File-change requests carry no decisions, no kind and no `grantRoot` —
      // a client cannot offer "allow for session" on a patch at all.
      expect(record.steps[3].approval!.availableDecisions).toBeNull()
      expect(record.steps[3].approval!.kind).toBeNull()
      expect(record.steps[3].approval!.grantRoot).toBeNull()
      // The proposed amendment is argv, and any redirection drags the whole
      // `/bin/zsh -lc <string>` wrapper into it, so "remember this command"
      // would persist a rule that can never match a second time.
      expect(record.steps[1].approval!.proposedExecpolicyAmendment).toEqual([
        '/bin/zsh',
        '-lc',
        `echo x > ${record.cwd}/inside.txt`
      ])
      expect(record.steps[5].approval!.proposedExecpolicyAmendment).toEqual([
        'curl',
        'http://127.0.0.1:1/'
      ])
      // THE ONE THAT MATTERS: an accepted command runs UNSANDBOXED. `ls` exits
      // 0 instead of dying at the nested-seatbelt code, and every write lands
      // — inside AND outside the workspace — under `readOnly` exactly as under
      // `dangerFullAccess`. There is no "approve but keep it sandboxed".
      expect(record.steps[0].exitCode).toBe(0)
      expect(record.artifacts).toEqual(ALL_LANDED)
    }
  },
  240000
)

it.skipIf(!enabled)(
  'probes `on-request` across the three sandbox policies',
  async () => {
    for (const [label, sandbox] of SANDBOXES) {
      const record = await runCombo('on-request', sandbox, label)
      if (label === 'dangerFullAccess') {
        // Nothing to escalate from: not one of the six steps is reviewed, and
        // all of them land. `on-request` + `dangerFullAccess` is `never`.
        expect(methods(record)).toEqual([null, null, null, null, null, null])
        expect(record.artifacts).toEqual(ALL_LANDED)
        continue
      }
      // COMMANDS are never reviewed under `on-request`: the policy means "ask
      // when the MODEL asks", and this model never sets
      // `sandbox_permissions: require_escalated`. They run sandboxed and die at
      // the nested-seatbelt code, having asked nothing.
      expect(record.steps[0].approval).toBeNull()
      expect(record.steps[1].approval).toBeNull()
      expect(record.steps[2].approval).toBeNull()
      expect(record.steps[5].approval).toBeNull()
      expect(record.steps[0].exitCode).toBe(EXIT_NESTED_SANDBOX)
      expect(record.steps[1].exitCode).toBe(EXIT_NESTED_SANDBOX)
      expect(record.artifacts['inside.txt']).toBe(false)
      expect(record.artifacts['outside.txt']).toBe(false)
      // FILE CHANGES are reviewed, on a path with no decisions to offer, and
      // the `reason` says which of the two triggers fired:
      //   null  → asked UP FRONT because the target is not writable.
      //   RETRY → asked only AFTER a sandboxed attempt failed; in an
      //           uncontained environment that attempt would have SUCCEEDED and
      //           the patch would have applied silently.
      expect(record.steps[3].approval!.method).toBe(FILE_CHANGE)
      expect(record.steps[4].approval!.method).toBe(FILE_CHANGE)
      expect(record.steps[4].approval!.reason).toBeNull()
      expect(record.steps[3].approval!.reason).toBe(label === 'readOnly' ? null : RETRY)
      expect(record.artifacts['patched-inside.txt']).toBe(true)
      expect(record.artifacts['patched-outside.txt']).toBe(true)
    }
  },
  240000
)

it.skipIf(!enabled)(
  'probes `never` across the three sandbox policies',
  async () => {
    for (const [label, sandbox] of SANDBOXES) {
      const record = await runCombo('never', sandbox, label)
      // `never` routes NOTHING to the client, file changes included. It is the
      // only policy under which the file-change path stays silent.
      expect(methods(record)).toEqual([null, null, null, null, null, null])
      if (label === 'dangerFullAccess') {
        // Unmediated execution: writes outside the workspace land with no
        // approval request of any kind.
        expect(record.steps.map((step) => step.exitCode)).toEqual([0, 0, 0, 0, 0, 7])
        expect(record.artifacts).toEqual(ALL_LANDED)
      } else {
        // A sandbox failure is terminal rather than an escalation prompt.
        expect(record.steps[0].exitCode).toBe(EXIT_NESTED_SANDBOX)
        expect(record.artifacts).toEqual(NONE_LANDED)
      }
    }
  },
  240000
)

it.skipIf(!enabled)(
  'probes the `granular` policy with every flag set across the three sandbox policies',
  async () => {
    for (const [label, sandbox] of SANDBOXES) {
      const record = await runCombo(GRANULAR_ALL, sandbox, label)
      if (label === 'dangerFullAccess') {
        // Every granular flag on, and still nothing is reviewed: with no
        // sandbox there is no escalation to gate.
        expect(methods(record)).toEqual([null, null, null, null, null, null])
        expect(record.artifacts).toEqual(ALL_LANDED)
        continue
      }
      // All six steps are reviewed, but the commands are reviewed AFTER a
      // sandboxed attempt failed, never before — `reason` is the retry prompt
      // on every one of them. So `granular` is an escalation gate, not a
      // pre-execution review: it cannot be used to vet a command up front.
      expect(methods(record)).toEqual([
        COMMAND,
        COMMAND,
        COMMAND,
        FILE_CHANGE,
        FILE_CHANGE,
        COMMAND
      ])
      expect(record.steps[0].approval!.reason).toBe(RETRY)
      expect(record.steps[1].approval!.reason).toBe(RETRY)
      expect(record.steps[2].approval!.reason).toBe(RETRY)
      expect(record.steps[5].approval!.reason).toBe(RETRY)
      expect(record.steps[0].approval!.availableDecisions).toEqual(COMMAND_DECISIONS(['ls']))
      // Same split as `on-request` on the file-change path.
      expect(record.steps[3].approval!.reason).toBe(label === 'readOnly' ? null : RETRY)
      expect(record.steps[4].approval!.reason).toBeNull()
      // The accepted retry runs unsandboxed, so everything lands anyway.
      expect(record.steps[0].exitCode).toBe(0)
      expect(record.artifacts).toEqual(ALL_LANDED)
    }
  },
  240000
)

// ─────────────────────────────────────────────────────────────────────────────
// What `on-request` actually gates: a MODEL-initiated escalation.
// ─────────────────────────────────────────────────────────────────────────────

it.skipIf(!enabled)(
  'probes a model-initiated `require_escalated` under `on-request` and under `never`',
  async () => {
    const observed: Record<string, unknown> = {}
    for (const policy of ['on-request', 'never'] as const) {
      const fixture = await setupFixture()
      const active = await root(fixture, () => ({ decision: 'accept' }))
      const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
        cwd: fixture.cwd,
        model: 'mock-model',
        modelProvider: 'fixture',
        historyMode: 'paginated'
      })
      scriptSteps(fixture, [
        { id: 'esc', cmd: `echo x > ${fixture.outside}/escalated.txt`, escalate: true }
      ])
      await runTurn(active, started.thread.id, {
        approvalPolicy: policy,
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      })
      observed[policy] = {
        approval: approvalFor(active, 'esc'),
        exitCode: exitCode(fixture, 'esc'),
        output: (
          fixture.requests.at(-1)?.input as Array<Record<string, unknown>> | undefined
        )?.find((item) => item.type === 'function_call_output' && item.call_id === 'esc')?.output,
        left: existsSync(join(fixture.outside, 'escalated.txt'))
      }
      expect(fixture.errors).toEqual([])
    }
    console.log(JSON.stringify({ probe: 'escalation', observed }))
    // `on-request` gates exactly one thing: the model asking for it. The
    // model's `justification` arrives as the request's `reason` — the only
    // place a human-readable rationale shows up on this path — and accepting
    // runs the write OUTSIDE the workspace even though the sandbox is
    // `readOnly`, same as under `untrusted`.
    const onRequest = observed['on-request'] as Record<string, unknown>
    const approval = onRequest.approval as Record<string, unknown>
    expect(approval).not.toBeNull()
    expect(approval.method).toBe('item/commandExecution/requestApproval')
    expect(approval.reason).toBe('Isolated fixture probe')
    expect(onRequest.exitCode).toBe(0)
    expect(onRequest.left).toBe(true)
    // `never` refuses the same escalation itself. Nothing reaches the client,
    // nothing runs, and the model is told to stop asking — so `never` is a
    // hard local deny, not a silent "allow anyway".
    const never = observed['never'] as Record<string, unknown>
    expect(never.approval).toBeNull()
    expect(never.left).toBe(false)
    expect(never.output).toBe(
      'approval policy is Never; reject command — you cannot ask for escalated permissions if the approval policy is Never'
    )
  },
  180000
)

// ─────────────────────────────────────────────────────────────────────────────
// A. Codex's built-in trusted list under `untrusted`.
// ─────────────────────────────────────────────────────────────────────────────

it.skipIf(!enabled)(
  'probes which commands `untrusted` treats as trusted',
  async () => {
    const fixture = await setupFixture()
    const active = await root(fixture, () => ({ decision: 'accept' }))
    const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const steps: Step[] = [
      { id: 't-ls', cmd: 'ls' },
      { id: 't-cat', cmd: 'cat inside.txt' },
      { id: 't-pwd', cmd: 'pwd' },
      { id: 't-git', cmd: 'git status' },
      { id: 't-echo', cmd: 'echo hi' },
      { id: 't-rg', cmd: 'rg x .' }
    ]
    scriptSteps(fixture, steps)
    await runTurn(active, started.thread.id, {
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    })
    const observed = steps.map((step) => ({
      cmd: step.cmd,
      asked: approvalFor(active, step.id) !== null,
      commandActions: approvalFor(active, step.id)?.commandActions ?? null,
      amendment: approvalFor(active, step.id)?.proposedExecpolicyAmendment ?? null
    }))
    console.log(JSON.stringify({ probe: 'trusted-list', observed }))
    // NOT ONE of them is trusted. `untrusted` asks for `ls`, `pwd` and `echo`
    // as readily as for `git status`, so the pinned binary ships no built-in
    // allowlist that a permission model would have to account for.
    expect(observed.map((o) => o.asked)).toEqual([true, true, true, true, true, true])
    // Parsed intent IS on the request, and it is coarse: `pwd`, `git status`
    // and `echo hi` all arrive as `unknown`, so `commandActions` cannot be the
    // input to a read-vs-write classifier.
    expect(observed.map((o) => (o.commandActions as Array<{ type: string }>)[0].type)).toEqual([
      'listFiles',
      'read',
      'unknown',
      'unknown',
      'unknown',
      'search'
    ])
    // The proposed amendment is the whole argv, arguments included.
    expect(observed[3].amendment).toEqual(['git', 'status'])
    expect(observed[4].amendment).toEqual(['echo', 'hi'])
    expect(fixture.errors).toEqual([])
  },
  120000
)

// ─────────────────────────────────────────────────────────────────────────────
// `decline`, and D. the reach of `acceptForSession`.
// ─────────────────────────────────────────────────────────────────────────────

it.skipIf(!enabled)(
  'probes whether an unadvertised `decline` is honoured and leaves nothing behind',
  async () => {
    const fixture = await setupFixture()
    const active = await root(fixture, () => ({ decision: 'decline' }))
    const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const steps: Step[] = [
      { id: 'd-cmd', cmd: `echo x > ${fixture.cwd}/declined.txt` },
      patchStep('d-patch', `${fixture.cwd}/declined-patch.txt`, 'nope')
    ]
    scriptSteps(fixture, steps)
    await runTurn(active, started.thread.id, {
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    })
    const observed = {
      command: {
        asked: approvalFor(active, 'd-cmd') !== null,
        exitCode: exitCode(fixture, 'd-cmd'),
        left: existsSync(join(fixture.cwd, 'declined.txt'))
      },
      fileChange: {
        asked: approvalFor(active, 'd-patch') !== null,
        exitCode: exitCode(fixture, 'd-patch'),
        left: existsSync(join(fixture.cwd, 'declined-patch.txt'))
      }
    }
    console.log(JSON.stringify({ probe: 'decline', observed }))
    // `decline` is absent from `availableDecisions` on both paths, yet the
    // binary accepts it and nothing runs: no file, and no exit code reported
    // back to the model at all for the command.
    expect(observed.command.asked).toBe(true)
    expect(observed.command.left).toBe(false)
    expect(observed.command.exitCode).toBeNull()
    expect(observed.fileChange.asked).toBe(true)
    expect(observed.fileChange.left).toBe(false)
    expect(fixture.errors).toEqual([])
  },
  120000
)

it.skipIf(!enabled)(
  'probes how far `acceptForSession` suppresses later asks',
  async () => {
    const fixture = await setupFixture()
    // Accept-for-session on the FIRST request only; everything after gets a
    // plain accept, so a later ask is visible rather than suppressed by us.
    let first = true
    const active = await root(fixture, () => {
      const decision = first ? 'acceptForSession' : 'accept'
      first = false
      return { decision }
    })
    const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const steps: Step[] = [
      { id: 's-one-a', cmd: 'echo one' },
      { id: 's-one-b', cmd: 'echo one' },
      { id: 's-two', cmd: 'echo two' }
    ]
    scriptSteps(fixture, steps)
    await runTurn(active, started.thread.id, {
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    })
    const observed = steps.map((step) => ({
      cmd: step.cmd,
      asked: approvalFor(active, step.id) !== null,
      exitCode: exitCode(fixture, step.id)
    }))
    console.log(
      JSON.stringify({ probe: 'accept-for-session', observed, total: active.approvals.length })
    )
    // `acceptForSession` on `echo one` silences the REPEAT of that command and
    // nothing else: `echo two` is asked again. The grant is per-command, so a
    // UI that maps it to "allow everything for this session" would be wrong.
    expect(observed[0].asked).toBe(true)
    expect(observed[1].asked).toBe(false)
    expect(observed[2].asked).toBe(true)
    expect(observed[1].exitCode).toBe(0)
    expect(fixture.errors).toEqual([])
  },
  120000
)

// ─────────────────────────────────────────────────────────────────────────────
// E. Does `approvalsReviewer: 'user'` have to be set for requests to reach us?
// ─────────────────────────────────────────────────────────────────────────────

it.skipIf(!enabled)(
  'probes the default approvals reviewer with no `approvals_reviewer` in config',
  async () => {
    const fixture = await setupFixture({ reviewer: null })
    const active = await root(fixture, () => ({ decision: 'accept' }))
    const started = await active.client.request<{
      thread: { id: string }
      approvalPolicy: unknown
      approvalsReviewer: unknown
      sandbox: unknown
      activePermissionProfile: unknown
    }>('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    scriptSteps(fixture, [{ id: 'r-ls', cmd: 'ls' }])
    await runTurn(active, started.thread.id, {
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    })
    const observed = {
      approvalPolicy: started.approvalPolicy,
      approvalsReviewer: started.approvalsReviewer,
      sandbox: started.sandbox,
      activePermissionProfile: started.activePermissionProfile,
      asked: approvalFor(active, 'r-ls') !== null
    }
    console.log(JSON.stringify({ probe: 'reviewer-default', observed }))
    // `thread/start` reports the effective policy back, and the reviewer
    // defaults to `user` with the config line absent — requests reach the
    // client without setting it. `activePermissionProfile` stays null, so the
    // legacy `sandbox` field is the only provenance a client gets here.
    expect(observed.approvalsReviewer).toBe('user')
    expect(observed.approvalPolicy).toBe('on-request')
    expect(observed.sandbox).toEqual({ type: 'readOnly', networkAccess: false })
    expect(observed.activePermissionProfile).toBeNull()
    expect(observed.asked).toBe(true)
    expect(fixture.errors).toEqual([])
  },
  120000
)

// ─────────────────────────────────────────────────────────────────────────────
// F. `thread/settings/update` mid-thread.
// ─────────────────────────────────────────────────────────────────────────────

it.skipIf(!enabled)(
  'probes a mid-thread approvalPolicy and sandbox switch',
  async () => {
    const fixture = await setupFixture()
    const active = await root(fixture, () => ({ decision: 'accept' }))
    const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    const threadId = started.thread.id
    // Turn 1 under the thread's own on-request/read-only settings.
    scriptSteps(fixture, [{ id: 'f-before', cmd: 'ls' }])
    await runTurn(active, threadId)
    const before = { asked: approvalFor(active, 'f-before') !== null }

    const update = await active.client.request<Record<string, never>>('thread/settings/update', {
      threadId,
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'dangerFullAccess' }
    })
    // The notification is NOT ordered against the RPC reply — it lands shortly
    // after — so wait for it rather than snapshotting and concluding "none".
    await waitFor(
      () => active.notifications.some((n) => n.method === 'thread/settings/updated'),
      'thread/settings/updated'
    )
    const notified = active.notifications
      .filter((n) => n.method === 'thread/settings/updated')
      .map((n) => {
        const settings = n.params.threadSettings as Record<string, unknown>
        return {
          threadId: n.params.threadId,
          approvalPolicy: settings?.approvalPolicy,
          sandboxPolicy: settings?.sandboxPolicy,
          approvalsReviewer: settings?.approvalsReviewer,
          activePermissionProfile: settings?.activePermissionProfile
        }
      })

    // Turn 2 with NO per-turn override: it must inherit the update. Turn 1 has
    // already consumed two provider requests, so index off the current count.
    const baseline = fixture.requests.length
    fixture.script.current = (_request, index) =>
      index === baseline
        ? {
            type: 'function_call',
            call_id: 'f-after',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: `echo x > ${fixture.outside}/after.txt` })
          }
        : done()
    await runTurn(active, threadId)
    const after = {
      asked: approvalFor(active, 'f-after') !== null,
      exitCode: exitCode(fixture, 'f-after'),
      left: existsSync(join(fixture.outside, 'after.txt'))
    }
    console.log(
      JSON.stringify({
        probe: 'settings-update',
        update,
        notified,
        notificationMethods: [...new Set(active.notifications.map((n) => n.method))],
        before,
        after
      })
    )
    // The RPC answers with an EMPTY object; the applied settings come back
    // only on the out-of-band `thread/settings/updated` notification, which is
    // not ordered against the reply.
    expect(update).toEqual({})
    expect(notified).toEqual([
      {
        threadId,
        approvalPolicy: 'untrusted',
        sandboxPolicy: { type: 'dangerFullAccess' },
        approvalsReviewer: 'user',
        activePermissionProfile: null
      }
    ])
    // The next turn honours it: `on-request` asked nothing, `untrusted` asks.
    expect(before.asked).toBe(false)
    expect(after.asked).toBe(true)
    expect(after.left).toBe(true)
    expect(fixture.errors).toEqual([])
  },
  120000
)

// ─────────────────────────────────────────────────────────────────────────────
// The third approval method, and the tool that is the only way to reach it.
// ─────────────────────────────────────────────────────────────────────────────

it.skipIf(!enabled)(
  'probes `item/permissions/requestApproval` behind the under-development request_permissions tool',
  async () => {
    const fixture = await setupFixture({
      features: 'request_permissions_tool = true\nsuppress_unstable_features_warning = true'
    })
    const active = await root(fixture, () => ({
      permissions: { fileSystem: { write: [] } },
      scope: 'turn'
    }))
    const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    fixture.script.current = (_request, index) =>
      index === 0
        ? {
            type: 'function_call',
            call_id: 'perm',
            name: 'request_permissions',
            arguments: JSON.stringify({
              permissions: { file_system: { write: [fixture.outside] } },
              reason: 'Isolated fixture probe'
            })
          }
        : done()
    await runTurn(active, started.thread.id, {
      approvalPolicy: 'on-request',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [fixture.cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true
      }
    })
    const request = active.approvals.find(
      (a) => a.method === 'item/permissions/requestApproval'
    )?.params
    const toolNames = (
      (fixture.requests[0]?.tools as Array<{ name?: string }> | undefined) ?? []
    ).map((tool) => tool.name)
    console.log(
      JSON.stringify({
        probe: 'permissions-tool',
        toolNames,
        request: request
          ? {
              cwd: request.cwd,
              reason: request.reason,
              permissions: request.permissions,
              environmentId: request.environmentId
            }
          : null
      })
    )
    // The tool is absent by default and only appears with the
    // under-development `request_permissions_tool` feature on, which is the
    // only route to this third approval method.
    expect(toolNames).toContain('request_permissions')
    expect(request).toBeDefined()
    // The request states WHAT is wanted (a writable root) rather than offering
    // decisions: there is no `availableDecisions` here, and the reply is a
    // granted profile plus a scope, not an accept/decline.
    expect(request!.permissions).toEqual({
      fileSystem: {
        read: null,
        write: [fixture.outside],
        entries: [{ access: 'write', path: { type: 'path', path: fixture.outside } }]
      },
      network: null
    })
    expect(request!.reason).toBe('Isolated fixture probe')
    expect(request!.availableDecisions).toBeUndefined()
    expect(fixture.errors).toEqual([])
  },
  120000
)

// ─────────────────────────────────────────────────────────────────────────────
// The wire shape the rest of the file depends on.
// ─────────────────────────────────────────────────────────────────────────────

it.skipIf(!enabled)(
  'probes the exec tool surface and the absence of `shell` and `apply_patch`',
  async () => {
    const fixture = await setupFixture()
    const active = await root(fixture, () => ({ decision: 'accept' }))
    const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    fixture.script.current = (_request, index) =>
      index === 0
        ? {
            type: 'function_call',
            call_id: 'shell-attempt',
            name: 'shell',
            arguments: JSON.stringify({ command: ['ls'], workdir: fixture.cwd })
          }
        : done()
    await runTurn(active, started.thread.id, {
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' }
    })
    const toolNames = (
      (fixture.requests[0]?.tools as Array<{ name?: string }> | undefined) ?? []
    ).map((tool) => tool.name)
    const shellOutput = (
      fixture.requests.at(-1)?.input as Array<Record<string, unknown>> | undefined
    )?.find(
      (item) => item.type === 'function_call_output' && item.call_id === 'shell-attempt'
    )?.output
    console.log(
      JSON.stringify({
        probe: 'tool-surface',
        toolNames,
        requestCount: fixture.requests.length,
        shellOutput: shellOutput ?? null,
        lastInput: (fixture.requests.at(-1)?.input as Array<Record<string, unknown>> | undefined)
          ?.filter((item) => item.type === 'function_call_output')
          .map((item) => ({ call_id: item.call_id, output: item.output }))
      })
    )
    expect(toolNames).toEqual([
      'exec_command',
      'write_stdin',
      'request_user_input',
      'view_image',
      'multi_agent_v1',
      'get_goal',
      'create_goal',
      'update_goal'
    ])
    // No `shell`, and no `apply_patch`: file changes are only reachable as an
    // `apply_patch` heredoc inside `exec_command`, which is what every
    // `patchStep` above relies on.
    expect(toolNames).not.toContain('shell')
    expect(toolNames).not.toContain('apply_patch')
    expect(shellOutput).toBe('unsupported call: shell')
    expect(fixture.errors).toEqual([])
  },
  120000
)

it.skipIf(!enabled)(
  'pins that macOS refuses to nest a DIFFERENT seatbelt profile',
  () => {
    // The reason the sandbox-enforcement column of the matrix is unmeasurable
    // in this fixture, reduced to its smallest form and kept next to the
    // probes that inherit it. Re-applying the SAME profile is allowed; any
    // different profile is refused, however permissive either one is.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-nest-')))
    try {
      const open = join(directory, 'open.sb')
      const other = join(directory, 'other.sb')
      writeFileSync(open, '(version 1)\n(allow default)\n')
      writeFileSync(other, '(version 1)\n(allow default)\n(deny file-write*)\n')
      const nest = (inner: string): { status: number | null; stderr: string } => {
        const run = spawnSync(
          '/usr/bin/sandbox-exec',
          ['-f', open, '/usr/bin/sandbox-exec', '-f', inner, '/bin/echo', 'nested'],
          { encoding: 'utf8' }
        )
        return { status: run.status, stderr: run.stderr.trim() }
      }
      const same = nest(open)
      const different = nest(other)
      console.log(JSON.stringify({ probe: 'nested-sandbox', same, different }))
      expect(same.status).toBe(0)
      expect(different.status).toBe(EXIT_NESTED_SANDBOX)
      expect(different.stderr).toContain('sandbox_apply: Operation not permitted')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
  30000
)
