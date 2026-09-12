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
import type { ApprovalsReviewer } from '../../core/codex/protocol/v2/ApprovalsReviewer'
import type { SandboxPolicy } from '../../core/codex/protocol/v2/SandboxPolicy'

/**
 * Probes of Codex's NATIVE approval reviewer (`approvalsReviewer: "auto_review"`
 * and `"guardian_subagent"`), of whether that reviewer honours a rule set, and
 * of how toolless a judge thread can be made. Sibling of
 * `codex-policy-probe.integration.test.ts`, which probes the `(approvalPolicy,
 * sandboxPolicy)` matrix under the default `"user"` reviewer; its containment
 * caveats apply here verbatim.
 *
 * Every assertion pins an OBSERVED value. Five observations are load-bearing for
 * reading the rest of the file:
 *
 *  1. THE CONTAINMENT SANDBOX HIDES CODEX'S OWN SANDBOX. macOS refuses to nest a
 *     DIFFERENT seatbelt profile (`sandbox_apply: Operation not permitted`, exit
 *     71 — pinned by the last test of the policy probe). Every spawn here is
 *     wrapped in `sandbox-exec`, so whatever Codex runs SANDBOXED dies at exit 71
 *     and only what it runs UNSANDBOXED executes for real.
 *  2. AUTO-REVIEW ONLY ROUTES UNDER `on-request` AND `granular`
 *     (`core/src/guardian/review.rs` `routes_approval_policy_to_guardian`), so
 *     `untrusted` bypasses it entirely. The auto-review probes use the catalog
 *     slug `gpt-5.6-luna` against the fixture provider, because its metadata
 *     ships the `auto_review.policy_template` the reviewer is prompted with; a
 *     model with no catalog entry gets the bundled template instead and still
 *     works, which one probe pins.
 *  3. The reviewer is a SECOND MODEL SESSION against the SAME provider, so its
 *     requests interleave with the agent's on the fixture server. The step script
 *     is indexed by AGENT requests only and the reviewer is told apart by the
 *     policy template's first line appearing anywhere in the request body.
 *  4. Catalog models here are `tool_mode: "code_mode_only"`, so their requests
 *     carry no `instructions` and no top-level `tools`; the tool surface arrives
 *     as an `additional_tools` developer item inside `input`, and the reviewer's
 *     own prompt arrives as a developer message rather than in `instructions`.
 *     The Q3 tool-surface probes therefore stay on `mock-model`, which uses the
 *     classic shape.
 *  5. These probes read the auto-review wire surface as RAW JSON-RPC on purpose.
 *     `item/autoApprovalReview/started`, `item/autoApprovalReview/completed` and
 *     `guardianWarning` now have generated `protocol/v2/*.ts` types (the adapter
 *     rows the completed ones; see the auto-mode test in
 *     `codex-app-server.integration.test.ts`), but reading the raw params is
 *     what lets a probe observe a field the generator did not carry over.
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

/** A catalog slug whose metadata ships an `auto_review.policy_template`. */
const REVIEWED_MODEL = 'gpt-5.6-luna'

/** First line of that template; the only reliable way to spot a reviewer call. */
const REVIEWER_MARKER = 'You are judging one planned coding-agent action.'

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
type Script = (request: ProviderRequest, agentIndex: number) => Record<string, unknown>
const done = (): Record<string, unknown> => ({
  type: 'message',
  id: 'msg-fixture',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'fixture complete' }]
})

type Fixture = {
  directory: string
  codexHome: string
  cwd: string
  outside: string
  env: NodeJS.ProcessEnv
  /** Every provider request, agent and reviewer alike, in arrival order. */
  requests: ProviderRequest[]
  errors: string[]
  script: { current: Script }
  /** Final-message text the fixture answers reviewer requests with. */
  verdict: { current: string }
}

const isReviewer = (request: ProviderRequest): boolean =>
  JSON.stringify(request).includes(REVIEWER_MARKER)
const agentRequests = (fixture: Fixture): ProviderRequest[] =>
  fixture.requests.filter((request) => !isReviewer(request))
const reviewerRequests = (fixture: Fixture): ProviderRequest[] =>
  fixture.requests.filter(isReviewer)

/**
 * One disposable Codex installation: isolated `CODEX_HOME` holding a fake key, a
 * scripted localhost Responses provider, a containment profile confining every
 * spawn to the fixture directory, and `cwd` / `outside` siblings that differ only
 * to Codex.
 *
 * `features` is appended to the `[features]` table and `extraConfig` after it,
 * so both must hold bare keys only unless `extraConfig` opens its own table
 * first. `topLevelConfig` is spliced in before the first table instead, which is
 * the only place a bare top-level key can go.
 */
async function setupFixture(
  options: {
    features?: string
    reviewer?: ApprovalsReviewer
    extraConfig?: string
    topLevelConfig?: string
    model?: string
  } = {}
): Promise<Fixture> {
  const installed = resolve('vendor/codex-cli/codex')
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.binarySha256
  )
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-review-')))
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
  const requests: ProviderRequest[] = []
  const errors: string[] = []
  const script = { current: done as Script }
  const verdict = { current: '{"outcome":"allow"}' }
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
      const reviewer = isReviewer(parsed)
      const agentIndex = requests.filter((request) => !isReviewer(request)).length
      requests.push(parsed)
      const item = reviewer
        ? {
            type: 'message',
            id: 'msg-reviewer',
            role: 'assistant',
            content: [{ type: 'output_text', text: verdict.current }]
          }
        : script.current(parsed, agentIndex)
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
    `model = "${options.model ?? 'mock-model'}"
model_provider = "fixture"
approval_policy = "on-request"
approvals_reviewer = "${options.reviewer ?? 'user'}"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"
${options.topLevelConfig ?? ''}
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
${options.extraConfig ?? ''}
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
    outside,
    requests,
    errors,
    script,
    verdict,
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
type ServerCall = { method: string; params: Record<string, unknown> }

type Root = {
  client: CodexAppServerClient
  notifications: Notification[]
  /** Every server→client REQUEST dispatched, not only approvals. */
  calls: ServerCall[]
}

/**
 * Deliberately wider than the three approval methods. An unlisted server method
 * is answered `-32601` and recorded nowhere, so a reviewer that rerouted its
 * question through some other request would be invisible. Listing everything the
 * binary can ask a client makes "nothing arrived" a real observation.
 */
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

async function root(
  fixture: Fixture,
  reply: (method: string, params: Record<string, unknown>) => unknown
): Promise<Root> {
  const notifications: Notification[] = []
  const calls: ServerCall[] = []
  const client = new CodexAppServerClient({
    cwd: fixture.cwd,
    env: fixture.env,
    requestTimeoutMs: 30000,
    serverMethods: SERVER_METHODS,
    onServerRequest: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> })
      return reply(method, params as Record<string, unknown>)
    },
    onNotification: (method, params) =>
      notifications.push({ method, params: params as Record<string, unknown> })
  })
  clients.push(client)
  await client.start({
    clientInfo: { name: 'codex_auto_review_probe', title: null, version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  return { client, notifications, calls }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 60000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Isolated Codex review fixture deadline: ${label}`)
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
    input: [{ type: 'text', text: 'review probe', text_elements: [] }],
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

/** A scripted step: one `exec_command` call the fixture agent emits. */
type Step = { id: string; cmd: string; escalate?: boolean }

const patchStep = (id: string, path: string, body: string): Step => ({
  id,
  cmd: `apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: ${path}\n+${body}\n*** End Patch\nPATCH\n`
})

/** Script the fixture agent to emit `steps` in order, then a final message. */
function scriptSteps(fixture: Fixture, steps: Step[]): void {
  fixture.script.current = (_request, agentIndex) => {
    const step = steps[agentIndex]
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

/** Everything Codex told the agent about `callId`, deduped across resends. */
function callOutput(fixture: Fixture, callId: string): string | null {
  const outputs = new Set(
    agentRequests(fixture)
      .flatMap((request) => (request.input as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((item) => item.type === 'function_call_output' && item.call_id === callId)
      .map((item) => String(item.output))
  )
  return outputs.size ? [...outputs].join('\n---\n') : null
}

/** Exit code Codex reported back to the agent for `callId`, or null. */
function exitCode(fixture: Fixture, callId: string): number | null {
  const output = callOutput(fixture, callId)
  if (!output) return null
  const codes = [...output.matchAll(/(?:Process exited with code|Exit code:) (-?\d+)/g)].map(
    (match) => Number(match[1])
  )
  return codes.length ? codes[codes.length - 1] : null
}

const itemTypes = (active: Root): string[] => [
  ...new Set(
    active.notifications
      .filter(({ method }) => method === 'item/started' || method === 'item/completed')
      .map(({ params }) => String((params.item as { type?: string } | undefined)?.type))
  )
]

/** Tool names a code-mode request advertises inside its `additional_tools` item. */
function additionalToolNames(request: ProviderRequest): string[] {
  return ((request.input as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((item) => item.type === 'additional_tools')
    .flatMap((item) => (item.tools as Array<Record<string, unknown>> | undefined) ?? [])
    .flatMap((tool) =>
      tool.type === 'namespace'
        ? ((tool.tools as Array<{ name?: string }> | undefined) ?? []).map(
            (nested) => `${String(tool.name)}.${String(nested.name)}`
          )
        : [String(tool.name)]
    )
}

/** Message items of a request as `{role, text}`, tool declarations omitted. */
function messages(request: ProviderRequest): Array<{ role: unknown; text: string }> {
  return ((request.input as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((item) => item.type === 'message')
    .map((item) => ({
      role: item.role,
      text: ((item.content as Array<Record<string, unknown>> | undefined) ?? [])
        .map((part) => String(part.text ?? ''))
        .join('')
    }))
}

/**
 * Four steps that are DETERMINISTICALLY gated under `on-request`, per the policy
 * probe: one model-initiated `require_escalated` command, and three
 * `apply_patch` heredocs.
 *
 * A plain (non-escalated) command is deliberately absent. `granular` only
 * reviews a command AFTER a sandboxed attempt fails, and the containment
 * profile's exit-71 failure is not always classified as a sandbox denial, so
 * WHICH plain commands get reviewed varies run to run. See the `granular` probe.
 */
const MATRIX = (cwd: string, outside: string): Step[] => [
  { id: 'esc', cmd: `echo x > ${outside}/escalated.txt`, escalate: true },
  patchStep('patch-inside', `${cwd}/patched-inside.txt`, 'inside'),
  patchStep('patch-outside', `${outside}/patched-outside.txt`, 'outside'),
  patchStep('patch-second', `${cwd}/patched-second.txt`, 'second')
]

const ARTIFACT_NAMES = [
  'escalated.txt',
  'patched-inside.txt',
  'patched-outside.txt',
  'patched-second.txt'
] as const

const WORKSPACE_WRITE = (cwd: string): SandboxPolicy => ({
  type: 'workspaceWrite',
  writableRoots: [cwd],
  networkAccess: false,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true
})

const GRANULAR_ALL: AskForApproval = {
  granular: {
    sandbox_approval: true,
    rules: true,
    skill_approval: true,
    request_permissions: true,
    mcp_elicitations: true
  }
}

type Review = {
  method: string
  reviewId: unknown
  targetItemId: unknown
  decisionSource: unknown
  status: unknown
  riskLevel: unknown
  userAuthorization: unknown
  rationale: unknown
  actionType: unknown
}

type ReviewRecord = {
  reviewer: ApprovalsReviewer
  model: string
  approvalPolicy: AskForApproval
  verdict: string
  clientCalls: Array<{ method: string; itemId: unknown }>
  notificationMethods: string[]
  itemTypes: string[]
  reviews: Review[]
  warnings: Array<{ method: string; message: unknown }>
  reviewerRequestCount: number
  reviewerModels: string[]
  steps: Array<{ id: string; exitCode: number | null; output: string | null }>
  artifacts: Record<string, boolean>
}

const reviews = (active: Root): Review[] =>
  active.notifications
    .filter(({ method }) => method.startsWith('item/autoApprovalReview/'))
    .map(({ method, params }) => {
      const review = params.review as Record<string, unknown> | undefined
      return {
        method,
        reviewId: params.reviewId,
        targetItemId: params.targetItemId,
        decisionSource: params.decisionSource ?? null,
        status: review?.status ?? null,
        riskLevel: review?.riskLevel ?? null,
        userAuthorization: review?.userAuthorization ?? null,
        rationale: review?.rationale ?? null,
        actionType: (params.action as { type?: string } | undefined)?.type ?? null
      }
    })

/** One scripted five-step turn under `reviewer` + `approvalPolicy` + workspaceWrite. */
async function runReview(
  reviewer: ApprovalsReviewer,
  verdict: string,
  options: { model?: string; approvalPolicy?: AskForApproval } = {}
): Promise<{ record: ReviewRecord; fixture: Fixture; active: Root }> {
  const model = options.model ?? REVIEWED_MODEL
  const approvalPolicy = options.approvalPolicy ?? 'on-request'
  const fixture = await setupFixture({ reviewer, model })
  fixture.verdict.current = verdict
  const active = await root(fixture, (method) =>
    method === 'item/permissions/requestApproval'
      ? { permissions: {}, scope: 'turn' }
      : { decision: 'accept' }
  )
  const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
    cwd: fixture.cwd,
    model,
    modelProvider: 'fixture',
    historyMode: 'paginated'
  })
  const steps = MATRIX(fixture.cwd, fixture.outside)
  scriptSteps(fixture, steps)
  await runTurn(active, started.thread.id, {
    approvalPolicy,
    approvalsReviewer: reviewer,
    sandboxPolicy: WORKSPACE_WRITE(fixture.cwd)
  })
  const record: ReviewRecord = {
    reviewer,
    model,
    approvalPolicy,
    verdict,
    clientCalls: active.calls.map(({ method, params }) => ({ method, itemId: params.itemId })),
    notificationMethods: [...new Set(active.notifications.map(({ method }) => method))],
    itemTypes: itemTypes(active),
    reviews: reviews(active),
    warnings: active.notifications
      .filter(({ method }) => /warning/i.test(method))
      .map(({ method, params }) => ({ method, message: params.message })),
    reviewerRequestCount: reviewerRequests(fixture).length,
    reviewerModels: [...new Set(reviewerRequests(fixture).map((request) => String(request.model)))],
    steps: steps.map((step) => ({
      id: step.id,
      exitCode: exitCode(fixture, step.id),
      output: callOutput(fixture, step.id)
    })),
    artifacts: {
      'escalated.txt': existsSync(join(fixture.outside, 'escalated.txt')),
      'patched-inside.txt': existsSync(join(fixture.cwd, 'patched-inside.txt')),
      'patched-outside.txt': existsSync(join(fixture.outside, 'patched-outside.txt')),
      'patched-second.txt': existsSync(join(fixture.cwd, 'patched-second.txt'))
    }
  }
  console.log(JSON.stringify({ probe: 'auto-review', ...record }))
  expect(fixture.errors).toEqual([])
  return { record, fixture, active }
}

const ALL_LANDED = Object.fromEntries(ARTIFACT_NAMES.map((name) => [name, true]))
const NONE_LANDED = Object.fromEntries(ARTIFACT_NAMES.map((name) => [name, false]))

// ─────────────────────────────────────────────────────────────────────────────
// Q1. What `approvalsReviewer` does on the wire.
// ─────────────────────────────────────────────────────────────────────────────

const completedReviews = (record: ReviewRecord): Review[] =>
  record.reviews.filter(({ method }) => method.endsWith('/completed'))

it.skipIf(!enabled)(
  'probes `auto_review` on a model with no catalog metadata',
  async () => {
    const { record, fixture } = await runReview('auto_review', '{"outcome":"allow"}', {
      model: 'mock-model'
    })
    console.log(
      JSON.stringify({
        probe: 'auto-review-fallback-template',
        reviewerModels: record.reviewerModels,
        instructions: reviewerRequests(fixture)[0]?.instructions ?? null,
        messages: messages(reviewerRequests(fixture)[0] ?? {})
      })
    )
    // The reviewer still runs: a model with no catalog entry gets the BUNDLED
    // policy template, so `auto_review` does not depend on catalog metadata and
    // works against a third-party provider's model.
    expect(record.clientCalls).toEqual([])
    expect(record.reviewerRequestCount).toBe(4)
    // But it does NOT run on the requested model. The reviewer's model is
    // `codex-auto-review` when the offline catalog lists it, else the ACTIVE
    // model's RESOLVED slug — and an unknown slug resolves to the fallback
    // metadata's slug, which is a real OpenAI model id the fixture provider was
    // never asked to serve. A client cannot assume the reviewer stays on the
    // model it selected.
    expect(record.reviewerModels).toEqual([REVIEWED_MODEL])
    expect(completedReviews(record)).toHaveLength(4)
    for (const review of completedReviews(record)) expect(review.status).toBe('approved')
    expect(record.artifacts).toEqual(ALL_LANDED)
    // The fallback-metadata warning is the only difference from the catalog
    // model, so a client cannot tell from the wire which template was used.
    expect(record.warnings.filter(({ method }) => method === 'warning')).toContainEqual({
      method: 'warning',
      message:
        'Model metadata for `mock-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.'
    })
  },
  240000
)

it.skipIf(!enabled)(
  'probes that `untrusted` bypasses `auto_review` even on a reviewed model',
  async () => {
    const { record } = await runReview('auto_review', '{"outcome":"allow"}', {
      approvalPolicy: 'untrusted'
    })
    // `untrusted` asks the CLIENT first, for all four steps, and never consults
    // the reviewer. The two settings do not compose: "review everything before
    // it runs" and "review it automatically" are mutually exclusive here.
    expect(record.reviewerRequestCount).toBe(0)
    expect(record.reviews).toEqual([])
    expect(record.clientCalls).toHaveLength(4)
  },
  240000
)

it.skipIf(!enabled)(
  'probes `auto_review` allowing every gated step under `on-request`',
  async () => {
    const { record, fixture } = await runReview('auto_review', '{"outcome":"allow"}')
    const reviewer = reviewerRequests(fixture)[0]!
    console.log(
      JSON.stringify({
        probe: 'auto-review-prompt',
        model: reviewer.model,
        keys: Object.keys(reviewer),
        instructions: reviewer.instructions ?? null,
        toolChoice: reviewer.tool_choice ?? null,
        reasoning: reviewer.reasoning ?? null,
        clientMetadata: reviewer.client_metadata ?? null,
        additionalToolNames: additionalToolNames(reviewer),
        messages: messages(reviewer)
      })
    )
    // Every gated step is reviewed, NOTHING reaches the client, and an `allow`
    // verdict runs the action unsandboxed — the escalated outside-workspace
    // write included. The reviewer is a full substitute for the human, with the
    // same all-or-nothing grant the `user` reviewer gets.
    expect(record.clientCalls).toEqual([])
    expect(record.reviews.map((review) => review.targetItemId)).toEqual([
      'esc',
      'esc',
      'patch-inside',
      'patch-inside',
      'patch-outside',
      'patch-outside',
      'patch-second',
      'patch-second'
    ])
    expect(completedReviews(record)).toHaveLength(4)
    for (const review of completedReviews(record)) {
      expect(review.status).toBe('approved')
      expect(review.decisionSource).toBe('agent')
      expect(review.rationale).toBe('Auto-review returned a low-risk allow decision.')
      expect(review.riskLevel).toBe('low')
    }
    // `action.type` is the only classification a client gets, and it is the
    // same two-way split as the approval methods it replaces.
    expect(record.reviews.map((review) => review.actionType)).toEqual([
      'command',
      'command',
      'applyPatch',
      'applyPatch',
      'applyPatch',
      'applyPatch',
      'applyPatch',
      'applyPatch'
    ])
    // One provider call per review, on the SAME provider as the agent — so a
    // client pointing Codex at its own provider pays for the reviews too. The
    // slug is the active model's here only because the offline catalog does not
    // list `codex-auto-review`; see the no-catalog-metadata probe.
    expect(record.reviewerRequestCount).toBe(4)
    expect(record.reviewerModels).toEqual([REVIEWED_MODEL])
    expect(record.artifacts).toEqual(ALL_LANDED)
    // EVERY decision raises a `guardianWarning`, approvals included. The
    // channel is a decision log, not an error channel, so a client cannot treat
    // its arrival as a problem. (`warning` is filtered out: the code-mode host
    // warning this fixture provokes does not arrive on every run.)
    expect(record.warnings.filter(({ method }) => method === 'guardianWarning')).toEqual(
      completedReviews(record).map(() => ({
        method: 'guardianWarning',
        message:
          'Automatic approval review approved (risk: low, authorization: unknown): Auto-review returned a low-risk allow decision.'
      }))
    )
  },
  240000
)

it.skipIf(!enabled)(
  'probes `auto_review` denying every gated step under `on-request`',
  async () => {
    const { record } = await runReview(
      'auto_review',
      JSON.stringify({
        risk_level: 'critical',
        user_authorization: 'unknown',
        outcome: 'deny',
        rationale: 'Isolated fixture deny'
      })
    )
    // The verdict CONTROLS execution: nothing ran, nothing landed, and no
    // approval request reached the client. The reviewer is an authority, not an
    // advisory layer.
    expect(record.clientCalls).toEqual([])
    expect(record.artifacts).toEqual(NONE_LANDED)
    // THREE of the four steps were reviewed, not four. A CIRCUIT BREAKER fires
    // on the third consecutive denial and interrupts the turn.
    const completed = completedReviews(record)
    expect(completed).toHaveLength(3)
    for (const review of completed) {
      expect(review.status).toBe('denied')
      expect(review.riskLevel).toBe('critical')
      expect(review.userAuthorization).toBe('unknown')
      expect(review.rationale).toBe('Isolated fixture deny')
    }
    // A denial surfaces twice: on the review item, and on an out-of-band
    // `guardianWarning` with no generated protocol type. The breaker uses the
    // same channel, so a client that ignores `guardianWarning` cannot tell an
    // interrupted turn from a finished one.
    expect(record.warnings.filter((warning) => /denied/.test(String(warning.message)))).toEqual(
      completed.map(() => ({
        method: 'guardianWarning',
        message:
          'Automatic approval review denied (risk: critical, authorization: unknown): Isolated fixture deny'
      }))
    )
    expect(record.warnings.filter(({ method }) => method === 'guardianWarning').at(-1)).toEqual({
      method: 'guardianWarning',
      message:
        'Automatic approval review rejected too many approval requests for this turn (3 consecutive, 3 in the last 50 reviews); interrupting the turn.'
    })
    // The model is told, and told not to work around it. There is no exit code:
    // the process was never created.
    expect(record.steps[0].output).toContain('This action was rejected due to unacceptable risk.')
    expect(record.steps[0].output).toContain('Isolated fixture deny')
    expect(record.steps[0].output).toContain(
      'The agent must not attempt to achieve the same outcome via workaround'
    )
    expect(record.steps[0].exitCode).toBeNull()
  },
  240000
)

it.skipIf(!enabled)(
  'probes an unparseable reviewer verdict',
  async () => {
    const { record } = await runReview('auto_review', 'looks fine to me')
    // Fail closed, with the parse failure standing in for a rationale, after
    // THREE provider attempts per review. A reviewer outage is a hard deny.
    const completed = completedReviews(record)
    expect(completed).toHaveLength(4)
    expect(record.reviewerRequestCount).toBe(12)
    for (const review of completed) {
      expect(review.status).toBe('denied')
      expect(review.riskLevel).toBe('high')
      expect(review.rationale).toBe(
        'Automatic approval review failed: guardian assessment was not valid JSON'
      )
    }
    expect(record.artifacts).toEqual(NONE_LANDED)
    // AND the circuit breaker does NOT fire, though four consecutive actions
    // were refused. It counts reviewer DENY verdicts, not review failures, so a
    // broken reviewer blocks every action of a turn to the end without the
    // interrupt three genuine denials trigger.
    expect(record.warnings.map((warning) => warning.message)).not.toContain(
      'Automatic approval review rejected too many approval requests for this turn (3 consecutive, 3 in the last 50 reviews); interrupting the turn.'
    )
  },
  240000
)

it.skipIf(!enabled)(
  'probes `guardian_subagent` against the same turn',
  async () => {
    const { record } = await runReview('guardian_subagent', '{"outcome":"allow"}')
    // Indistinguishable from `auto_review`: same notifications, same four
    // reviews, same artifacts. The generated TS union has three members but the
    // binary has two variants — `guardian_subagent` is a serde ALIAS of
    // `auto_review`, so it is a legacy spelling, not a third reviewer.
    expect(record.clientCalls).toEqual([])
    expect(record.reviewerRequestCount).toBe(4)
    expect(record.reviewerModels).toEqual([REVIEWED_MODEL])
    expect(completedReviews(record)).toHaveLength(4)
    for (const review of completedReviews(record)) expect(review.status).toBe('approved')
    expect(record.artifacts).toEqual(ALL_LANDED)
  },
  240000
)

it.skipIf(!enabled)(
  'probes `auto_review` under `granular` with every flag set',
  async () => {
    const { record } = await runReview('auto_review', '{"outcome":"allow"}', {
      approvalPolicy: GRANULAR_ALL
    })
    // `granular` adds the plain-command escalation path on top of what
    // `on-request` gates. The four steps here are all already gated, so the
    // reviewer sees the same four and the client still sees nothing: the
    // reviewer inherits WHICH actions are gated from `approvalPolicy` and only
    // changes WHO decides.
    //
    // The extra commands `granular` would also review are NOT probed, because
    // it reviews a plain command only after a sandboxed attempt fails, and the
    // containment profile's exit-71 failure is not reliably classified as a
    // sandbox denial — a repeat run reviews a different subset. That is a
    // fixture limit, not a Codex behaviour.
    expect(record.clientCalls).toEqual([])
    expect(completedReviews(record).map((review) => review.targetItemId)).toEqual([
      'esc',
      'patch-inside',
      'patch-outside',
      'patch-second'
    ])
    for (const review of completedReviews(record)) expect(review.status).toBe('approved')
    expect(record.artifacts).toEqual(ALL_LANDED)
  },
  240000
)

// ─────────────────────────────────────────────────────────────────────────────
// Q2. Does the native reviewer honour any rule set?
//
// The mechanism, from the pinned source: `core/src/exec_policy.rs`
// `load_exec_policy` walks the config layers low-to-high and parses every
// `*.rules` file in `<layer config folder>/rules/` (`RULES_DIR_NAME`), so
// `$CODEX_HOME/rules/*.rules` (user layer) and `<project>/.codex/rules/*.rules`
// (project layer) are both rule sources. Files are Starlark; `prefix_rule` is
// defined in `execpolicy/src/parser.rs`. The enterprise-managed
// `requirements.toml` `[rules] prefix_rules` table is a separate, TOML-shaped
// mirror of the same builtin (`config/src/requirements_exec_policy.rs`).
// `Decision::{Forbidden,Prompt,Allow}` map to `ExecApprovalRequirement::
// {Forbidden,NeedsApproval,Skip}` in `exec_policy.rs`, and a `Prompt` is turned
// into `Forbidden` when the approval policy rejects prompts. These probes are
// the runtime confirmation.
// ─────────────────────────────────────────────────────────────────────────────

const FORBID_ECHO = 'prefix_rule(pattern=["echo"], decision="forbidden")\n'
const ALLOW_ECHO = 'prefix_rule(pattern=["echo"], decision="allow")\n'
const PROMPT_ECHO = 'prefix_rule(pattern=["echo"], decision="prompt")\n'

type RuleVariant = {
  label: string
  /** Where the `.rules` file goes, relative to the fixture directory. */
  where: 'userLayer' | 'projectLayer' | 'codexHomeRoot'
  body: string
  reviewer: ApprovalsReviewer
  approvalPolicy: AskForApproval
  /** Mark `cwd` a trusted project, which is what enables the project layer. */
  trustProject?: boolean
}

const RULE_VARIANTS: RuleVariant[] = [
  {
    label: 'userLayerForbid',
    where: 'userLayer',
    body: FORBID_ECHO,
    reviewer: 'user',
    approvalPolicy: 'untrusted'
  },
  {
    label: 'projectLayerForbidUntrusted',
    where: 'projectLayer',
    body: FORBID_ECHO,
    reviewer: 'user',
    approvalPolicy: 'untrusted'
  },
  {
    label: 'projectLayerForbidTrusted',
    where: 'projectLayer',
    body: FORBID_ECHO,
    reviewer: 'user',
    approvalPolicy: 'untrusted',
    trustProject: true
  },
  {
    label: 'codexHomeRootForbid',
    where: 'codexHomeRoot',
    body: FORBID_ECHO,
    reviewer: 'user',
    approvalPolicy: 'untrusted'
  },
  {
    label: 'userLayerAllow',
    where: 'userLayer',
    body: ALLOW_ECHO,
    reviewer: 'user',
    approvalPolicy: 'untrusted'
  },
  {
    label: 'userLayerForbidUnderAutoReview',
    where: 'userLayer',
    body: FORBID_ECHO,
    reviewer: 'auto_review',
    approvalPolicy: 'on-request'
  },
  {
    label: 'userLayerPromptUnderAutoReview',
    where: 'userLayer',
    body: PROMPT_ECHO,
    reviewer: 'auto_review',
    approvalPolicy: 'on-request'
  },
  {
    label: 'userLayerPromptUnderGranularRulesOff',
    where: 'userLayer',
    body: PROMPT_ECHO,
    reviewer: 'user',
    approvalPolicy: {
      granular: {
        sandbox_approval: true,
        rules: false,
        skill_approval: true,
        request_permissions: true,
        mcp_elicitations: true
      }
    }
  }
]

it.skipIf(!enabled)(
  'probes where an execpolicy rule set loads from and what a rule decision does',
  async () => {
    const observed: Array<Record<string, unknown>> = []
    for (const variant of RULE_VARIANTS) {
      const fixture = await setupFixture({ reviewer: variant.reviewer, model: REVIEWED_MODEL })
      if (variant.trustProject)
        writeFileSync(
          join(fixture.codexHome, 'config.toml'),
          `${readFileSync(join(fixture.codexHome, 'config.toml'), 'utf8')}
[projects."${fixture.cwd}"]
trust_level = "trusted"
`
        )
      const target = {
        userLayer: join(fixture.codexHome, 'rules'),
        projectLayer: join(fixture.cwd, '.codex', 'rules'),
        // The control: the same file one directory too high.
        codexHomeRoot: fixture.codexHome
      }[variant.where]
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'fixture.rules'), variant.body)
      const active = await root(fixture, () => ({ decision: 'accept' }))
      const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
        cwd: fixture.cwd,
        model: REVIEWED_MODEL,
        modelProvider: 'fixture',
        historyMode: 'paginated'
      })
      // A BARE `echo hi`, not a redirection. Codex wraps a command containing
      // shell metacharacters in `/bin/zsh -lc <string>`, and a `prefix_rule`
      // pattern of `["echo"]` then matches nothing — the policy probe pins that
      // an amendment for a redirection is `["/bin/zsh", "-lc", …]`. `ls` is the
      // unruled control in the same turn.
      scriptSteps(fixture, [
        { id: 'rule-echo', cmd: 'echo hi' },
        { id: 'rule-ls', cmd: 'ls' }
      ])
      await runTurn(active, started.thread.id, {
        approvalPolicy: variant.approvalPolicy,
        approvalsReviewer: variant.reviewer,
        sandboxPolicy: WORKSPACE_WRITE(fixture.cwd)
      })
      observed.push({
        label: variant.label,
        clientCalls: active.calls.map(({ method, params }) => ({ method, itemId: params.itemId })),
        reviews: reviews(active)
          .filter(({ method }) => method.endsWith('/completed'))
          .map(({ targetItemId, status }) => ({ targetItemId, status })),
        reviewerRequestCount: reviewerRequests(fixture).length,
        echoOutput: callOutput(fixture, 'rule-echo'),
        echoExitCode: exitCode(fixture, 'rule-echo'),
        lsExitCode: exitCode(fixture, 'rule-ls'),
        warnings: active.notifications
          .filter(({ method }) => /warning/i.test(method))
          .map(({ params }) => params.message)
      })
      expect(fixture.errors).toEqual([])
      for (const client of clients.splice(0)) client.dispose()
    }
    console.log(JSON.stringify({ probe: 'rules', observed }))
    const at = (label: string): Record<string, unknown> => {
      const hit = observed.find((variant) => variant.label === label)
      expect(hit, label).toBeDefined()
      return hit!
    }
    // Whether an APPROVED command then runs sandboxed is racy in this fixture —
    // the policy probe's `untrusted` test flakes on exactly that exit code at
    // HEAD — so these assertions read "was the command blocked BY THE RULE",
    // never its exit code.
    const ruleBlocked = (label: string): boolean =>
      /rejected: policy forbids|AskForApproval::Granular\.rules is false/.test(
        String(at(label).echoOutput)
      )

    // A `forbidden` rule in the USER layer (`$CODEX_HOME/rules/*.rules`) blocks
    // the command before any approval: no request reaches the client for it and
    // nothing runs. The PROJECT layer (`<cwd>/.codex/rules/*.rules`) behaves
    // identically, but ONLY once the project is trusted — see below.
    for (const label of ['userLayerForbid', 'projectLayerForbidTrusted']) {
      expect(at(label).echoExitCode, label).toBeNull()
      // Codex parses INSIDE its own `/bin/zsh -lc` wrapper, so a bare-argv rule
      // matches a command it never sees as bare argv.
      expect(String(at(label).echoOutput), label).toContain(
        "`/bin/zsh -lc 'echo hi'` rejected: policy forbids commands starting with `echo`"
      )
      // Only the UNMATCHED `ls` is asked about — the rule took the other one
      // out of the approval flow rather than pre-denying it there.
      expect(
        (at(label).clientCalls as Array<{ itemId: string }>).map((call) => call.itemId),
        label
      ).toEqual(['rule-ls'])
    }
    // The project layer is DISABLED until the project is trusted, and a
    // disabled layer contributes no rules: the identical rule file had no
    // effect at all, and `echo hi` was asked about and ran. So a repo cannot
    // impose rules on a client that has not trusted it.
    expect(
      (at('projectLayerForbidUntrusted').clientCalls as Array<{ itemId: string }>).map(
        (call) => call.itemId
      )
    ).toEqual(['rule-echo', 'rule-ls'])
    expect(at('projectLayerForbidUntrusted').echoExitCode).toBe(0)

    // The control: `rules` must be a DIRECTORY under the layer's config folder.
    // The same file at the root of `CODEX_HOME` is ignored and `echo hi` is
    // asked about, then runs.
    expect(
      (at('codexHomeRootForbid').clientCalls as Array<{ itemId: string }>).map(
        (call) => call.itemId
      )
    ).toEqual(['rule-echo', 'rule-ls'])
    expect(at('codexHomeRootForbid').echoExitCode).toBe(0)

    // An `allow` rule is the mirror image: `echo hi` is NOT asked about and
    // still runs, so a rule file widens permissions as readily as it narrows
    // them. `ls` in the same turn is still asked.
    expect(
      (at('userLayerAllow').clientCalls as Array<{ itemId: string }>).map((call) => call.itemId)
    ).toEqual(['rule-ls'])
    expect(at('userLayerAllow').echoExitCode).toBe(0)

    // THE ANSWER TO Q2: the rule decides BEFORE the reviewer. Under
    // `auto_review`, a `forbidden` rule blocks `echo hi` with no review at all,
    // and a `prompt` rule routes it TO the reviewer, which approved it here and
    // ran it unsandboxed. The reviewer cannot override a `forbidden` rule
    // because it is never asked.
    expect(at('userLayerForbidUnderAutoReview').reviews).toEqual([])
    expect(at('userLayerForbidUnderAutoReview').reviewerRequestCount).toBe(0)
    expect(String(at('userLayerForbidUnderAutoReview').echoOutput)).toContain(
      'policy forbids commands starting with `echo`'
    )
    expect(at('userLayerPromptUnderAutoReview').reviews).toEqual([
      { targetItemId: 'rule-echo', status: 'approved' }
    ])
    expect(at('userLayerPromptUnderAutoReview').reviewerRequestCount).toBe(1)
    expect(ruleBlocked('userLayerPromptUnderAutoReview')).toBe(false)
    // The unruled `ls` was neither reviewed nor asked about in that turn: a
    // plain command under `on-request` is not gated, so the rule is what pulled
    // `echo` into the review.
    expect(at('userLayerPromptUnderAutoReview').clientCalls).toEqual([])

    // And `granular.rules: false` turns a `prompt` rule into a local deny
    // rather than skipping it: the flag suppresses the ASK, not the RULE.
    expect(
      (at('userLayerPromptUnderGranularRulesOff').clientCalls as Array<{ itemId: string }>).map(
        (call) => call.itemId
      )
    ).not.toContain('rule-echo')
    expect(String(at('userLayerPromptUnderGranularRulesOff').echoOutput)).toContain(
      'approval required by policy rule, but AskForApproval::Granular.rules is false'
    )
  },
  480000
)

it.skipIf(!enabled)(
  'probes that `[rules]` in `config.toml` and a stray `requirements.toml` are not rule sources',
  async () => {
    // The TOML rule table belongs to the enterprise-managed requirements layer,
    // which is only loaded from `<mdm>/requirements.toml` and
    // `<enterprise-managed>/requirements.toml`. These are the writable places a
    // client might reach for instead.
    const rulesToml = `[rules]
prefix_rules = [{ decision = "forbidden", pattern = [{ token = "echo" }], justification = "fixture forbids echo" }]
`
    const fixture = await setupFixture({ extraConfig: rulesToml })
    writeFileSync(join(fixture.codexHome, 'requirements.toml'), rulesToml)
    mkdirSync(join(fixture.cwd, '.codex'), { recursive: true })
    writeFileSync(join(fixture.cwd, '.codex', 'requirements.toml'), rulesToml)
    const active = await root(fixture, () => ({ decision: 'accept' }))
    const config = await active.client.request<{
      config: Record<string, unknown>
      layers: Array<Record<string, unknown>> | null
    }>('config/read', { includeLayers: true, cwd: fixture.cwd })
    const requirements = await active.client.request<Record<string, unknown>>(
      'configRequirements/read',
      {}
    )
    const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated'
    })
    scriptSteps(fixture, [{ id: 'toml-echo', cmd: 'echo hi' }])
    await runTurn(active, started.thread.id, {
      approvalPolicy: 'untrusted',
      sandboxPolicy: WORKSPACE_WRITE(fixture.cwd)
    })
    const observed = {
      effectiveConfigRules: config.config.rules ?? null,
      configKeysMatchingRulePolicyTool: Object.keys(config.config).filter((key) =>
        /rule|polic|exec|tool|feature|shell|review|permission/i.test(key)
      ),
      layers: (config.layers ?? []).map((layer) => ({
        source: (layer.name as { type?: string } | undefined)?.type,
        file: String(
          (layer.name as { file?: string } | undefined)?.file ??
            (layer.name as { dotCodexFolder?: string } | undefined)?.dotCodexFolder ??
            ''
        ).replace(fixture.directory, '<fixture>'),
        keys: Object.keys((layer.config as Record<string, unknown> | null) ?? {})
      })),
      requirementsKeysSet: Object.entries(requirements)
        .filter(([, value]) => value !== null)
        .map(([key]) => key),
      requirementsHasRulesField: Object.keys(requirements).includes('rules'),
      echoAsked: active.calls.length,
      echoExitCode: exitCode(fixture, 'toml-echo')
    }
    console.log(JSON.stringify({ probe: 'rules-toml', observed }))
    // The `[rules]` table survives into the user layer's RAW config and is
    // dropped from the effective config: an unknown key, not a rule set.
    expect(observed.effectiveConfigRules).toBeNull()
    expect(observed.layers.map((layer) => layer.source)).toEqual(['project', 'user', 'system'])
    expect(observed.layers.find((layer) => layer.source === 'user')!.keys).toContain('rules')
    // `configRequirements/read` has no `rules` field at all, so a client cannot
    // even read back an enterprise rule set, let alone set one.
    expect(observed.requirementsHasRulesField).toBe(false)
    expect(observed.requirementsKeysSet).toEqual([])
    // And `echo hi` is asked about and runs, exactly as with no file at all.
    expect(observed.echoAsked).toBe(1)
    expect(observed.echoExitCode).toBe(0)
  },
  240000
)

it.skipIf(!enabled)(
  'probes the execpolicy rule DSL out of process',
  async () => {
    // `codex execpolicy check --rules <path> <argv>` is the only place the rule
    // language is directly observable, and it is the same parser the session
    // uses. Pinned here so a bump that changes the DSL is caught.
    const fixture = await setupFixture()
    const starlark = join(fixture.directory, 'fixture.rules')
    writeFileSync(starlark, FORBID_ECHO)
    const binary = join(fixture.directory, 'vendor/codex-cli/codex')
    const run = (...argv: string[]): { status: number | null; stdout: string } => {
      const result = spawnSync(binary, ['execpolicy', 'check', '--rules', starlark, ...argv], {
        encoding: 'utf8',
        env: fixture.env
      })
      return { status: result.status, stdout: result.stdout.trim() }
    }
    const observed = { echo: run('echo', 'hi'), ls: run('ls') }
    console.log(JSON.stringify({ probe: 'execpolicy-cli', observed }))
    expect(observed.echo.status).toBe(0)
    expect(JSON.parse(observed.echo.stdout)).toEqual({
      matchedRules: [{ prefixRuleMatch: { matchedPrefix: ['echo'], decision: 'forbidden' } }],
      decision: 'forbidden'
    })
    // An unmatched command has no decision of its own: the rule set is a filter
    // over the approval flow, not a replacement for it.
    expect(JSON.parse(observed.ls.stdout).decision).not.toBe('forbidden')
  },
  120000
)

// ─────────────────────────────────────────────────────────────────────────────
// Q3. Can a judge thread be made toolless?
//
// The mechanism, from the pinned source: `core/src/tools/spec_plan.rs` gates the
// exec tool on `Feature::ShellTool && Feature::UnifiedExec` (and `UnifiedExecTty`
// for the tty variant), and `view_image` on `Feature::ViewImage`. So the
// `[features]` table, and the per-thread `config` override that layers onto it,
// are the tool switches. `[tools]` entries are structs rather than booleans
// (`ToolsToml`), which is why the boolean form fails config load.
// ─────────────────────────────────────────────────────────────────────────────

const JUDGE_INSTRUCTIONS = 'You are a judge. Answer PASS or FAIL and nothing else.'

type JudgeVariant = {
  label: string
  features?: string
  extraConfig?: string
  topLevelConfig?: string
  start?: Record<string, unknown>
}

const JUDGE_VARIANTS: JudgeVariant[] = [
  { label: 'baseline' },
  { label: 'dynamicToolsEmpty', start: { dynamicTools: [] } },
  {
    label: 'threadConfigFeaturesOff',
    start: {
      config: {
        features: {
          unified_exec: false,
          unified_exec_tty: false,
          shell_tool: false,
          view_image: false,
          multi_agent: false,
          goals: false,
          sleep_tool: false
        }
      }
    }
  },
  {
    label: 'configTomlFeaturesOff',
    features: `unified_exec = false
unified_exec_tty = false
shell_tool = false
view_image = false
multi_agent = false
goals = false
sleep_tool = false`
  },
  {
    label: 'configTomlFeaturesOffPlusToolsOff',
    features: `unified_exec = false
unified_exec_tty = false
shell_tool = false
view_image = false
multi_agent = false
goals = false
sleep_tool = false`,
    // `[tools]` entries are structs, not booleans: `tools.update_plan = false`
    // fails config load with `invalid type: boolean false, expected struct
    // UpdatePlanToolConfig`, and the app-server answers `thread/start` -32600.
    extraConfig: `[tools]
experimental_request_user_input = false
update_plan = false`
  },
  {
    label: 'configTomlFeaturesOffPlusToolStructsOff',
    features: `unified_exec = false
unified_exec_tty = false
shell_tool = false
view_image = false
multi_agent = false
goals = false
sleep_tool = false`,
    extraConfig: `[tools.experimental_request_user_input]
enabled = false
[tools.update_plan]
enabled = false`
  },
  // `config/read` lists `experimental_use_unified_exec_tool` as a real config
  // key, the closest thing to an exec-tool switch on the surface.
  { label: 'unifiedExecToolOff', topLevelConfig: 'experimental_use_unified_exec_tool = false' }
]

it.skipIf(!enabled)(
  'probes how toolless an ephemeral judge thread can be made',
  async () => {
    const observed: Array<Record<string, unknown>> = []
    for (const variant of JUDGE_VARIANTS) {
      const fixture = await setupFixture({
        features: variant.features,
        extraConfig: variant.extraConfig,
        topLevelConfig: variant.topLevelConfig
      })
      const active = await root(fixture, () => ({ decision: 'accept' }))
      // A rejected `thread/start` is itself an answer about the variant, so it
      // is recorded rather than failing the probe.
      let threadId: string | null = null
      let startError: string | null = null
      try {
        const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
          cwd: fixture.cwd,
          model: 'mock-model',
          modelProvider: 'fixture',
          historyMode: 'paginated',
          ephemeral: true,
          baseInstructions: JUDGE_INSTRUCTIONS,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          ...(variant.start ?? {})
        })
        threadId = started.thread.id
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error)
      }
      if (threadId) {
        fixture.script.current = (_request, agentIndex) =>
          agentIndex === 0
            ? {
                type: 'function_call',
                call_id: 'judge-ls',
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'ls' })
              }
            : done()
        await runTurn(active, threadId, {
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false }
        })
      }
      const first = fixture.requests[0] ?? {}
      const instructions = String(first.instructions ?? '')
      observed.push({
        label: variant.label,
        startError,
        toolNames: ((first.tools as Array<{ name?: string }> | undefined) ?? []).map(
          (tool) => tool.name
        ),
        instructionsLength: instructions.length,
        instructionsEqualsBase: instructions === JUDGE_INSTRUCTIONS,
        lsOutput: callOutput(fixture, 'judge-ls'),
        lsExitCode: exitCode(fixture, 'judge-ls'),
        warnings: active.notifications
          .filter(({ method }) => /warning/i.test(method))
          .map(({ params }) => params.message)
      })
      expect(fixture.errors).toEqual([])
      for (const client of clients.splice(0)) client.dispose()
    }
    console.log(JSON.stringify({ probe: 'judge-tools', observed }))
    const byLabel = new Map(observed.map((variant) => [variant.label, variant]))
    const at = (label: string): Record<string, unknown> => byLabel.get(label)!

    // `baseInstructions` REPLACES Codex's defaults rather than prefixing them:
    // wherever a thread starts, the whole `instructions` field is the fixed
    // prompt, byte for byte (54 chars), not a prefix of a longer one.
    for (const variant of observed) {
      if (variant.startError) continue
      expect(variant.instructionsEqualsBase).toBe(true)
      expect(variant.instructionsLength).toBe(JUDGE_INSTRUCTIONS.length)
    }

    // The default surface for an `ephemeral` + `never` + readOnly thread. The
    // goal tools are gone because `[features] goals` is off, so the baseline is
    // already narrower than the policy probe's eight-tool list.
    expect(at('baseline').toolNames).toEqual([
      'exec_command',
      'write_stdin',
      'request_user_input',
      'view_image',
      'multi_agent_v1'
    ])
    expect(at('baseline').lsExitCode).toBe(EXIT_NESTED_SANDBOX)

    // `dynamicTools: []` changes NOTHING — it clears hosted client tools, not
    // built-ins, so it is not a way to disarm a judge.
    expect(at('dynamicToolsEmpty').toolNames).toEqual(at('baseline').toolNames)
    expect(at('dynamicToolsEmpty').lsExitCode).toBe(EXIT_NESTED_SANDBOX)

    // THE ANSWER: feature flags DO reach the tool surface. Turning off
    // `unified_exec`, `unified_exec_tty`, `shell_tool`, `view_image`,
    // `multi_agent` and `sleep_tool` leaves `request_user_input` alone, and the
    // model's `exec_command` call is refused as an unknown tool rather than
    // sandboxed. Both delivery routes work identically: a `[features]` table in
    // `config.toml`, and a per-thread `config` override on `thread/start` —
    // which is what a judge thread would use, since it needs no global change.
    for (const label of ['threadConfigFeaturesOff', 'configTomlFeaturesOff']) {
      expect(at(label).toolNames).toEqual(['request_user_input'])
      expect(at(label).lsOutput).toBe('unsupported call: exec_command')
      expect(at(label).lsExitCode).toBeNull()
    }

    // `experimental_use_unified_exec_tool = false` is NOT an exec switch: the
    // tool list is unchanged and `ls` still runs.
    expect(at('unifiedExecToolOff').toolNames).toEqual(at('baseline').toolNames)
    expect(at('unifiedExecToolOff').lsExitCode).toBe(EXIT_NESTED_SANDBOX)

    // `[tools]` entries are structs. A boolean fails config load and the
    // app-server rejects `thread/start` with a bare `-32600`, carrying no hint
    // of which key was wrong.
    expect(at('configTomlFeaturesOffPlusToolsOff').startError).toBe(
      'Codex transport: rpc-error--32600'
    )
    expect(at('configTomlFeaturesOffPlusToolsOff').toolNames).toEqual([])
    // With the struct form, `request_user_input` goes too: a FULLY empty tool
    // array is reachable.
    expect(at('configTomlFeaturesOffPlusToolStructsOff').startError).toBeNull()
    expect(at('configTomlFeaturesOffPlusToolStructsOff').toolNames).toEqual([])
    expect(at('configTomlFeaturesOffPlusToolStructsOff').lsOutput).toBe(
      'unsupported call: exec_command'
    )
  },
  480000
)

it.skipIf(!enabled)(
  'probes the default instructions a thread gets without `baseInstructions`',
  async () => {
    const fixture = await setupFixture()
    const active = await root(fixture, () => ({ decision: 'accept' }))
    const started = await active.client.request<{ thread: { id: string } }>('thread/start', {
      cwd: fixture.cwd,
      model: 'mock-model',
      modelProvider: 'fixture',
      historyMode: 'paginated',
      ephemeral: true
    })
    fixture.script.current = () => done()
    await runTurn(active, started.thread.id, {
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    })
    const instructions = String(fixture.requests[0]?.instructions ?? '')
    const observed = {
      length: instructions.length,
      head: instructions.slice(0, 400),
      mentionsJudge: instructions.includes(JUDGE_INSTRUCTIONS),
      toolNames: ((fixture.requests[0]?.tools as Array<{ name?: string }> | undefined) ?? []).map(
        (tool) => tool.name
      ),
      developerMessages: messages(fixture.requests[0] ?? {}).filter(
        ({ role }) => role === 'developer'
      )
    }
    console.log(JSON.stringify({ probe: 'default-instructions', observed }))
    // The baseline is a multi-kilobyte Codex prompt. Setting `baseInstructions`
    // in the previous probe cut it to the fixed string, which is what makes
    // "replaced, not prefixed" a measurement rather than an inference.
    expect(observed.length).toBeGreaterThan(2000)
    expect(observed.mentionsJudge).toBe(false)
    expect(observed.toolNames).toContain('exec_command')
    expect(fixture.errors).toEqual([])
  },
  180000
)
