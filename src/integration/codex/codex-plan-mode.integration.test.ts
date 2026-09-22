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
import { setHostPaths } from '../../core/host'
import provenance from '../../core/codex/protocol/provenance.json'
import { codexIntegrationEnabled } from './integration-host'
import { codexCollaborationMode, codexTurnPolicy } from '../../core/codex/codex-turn-policy'
import {
  fixtureAssistantMessage,
  fixturePlanMessage,
  fixtureWebSearchItem,
  isGuardianRequest,
  startFixtureProvider,
  writeFixtureCodexHome,
  type FixtureProvider,
  type FixtureProviderOptions
} from './fixture-provider'

/**
 * F20 — native plan mode, against the PINNED binary.
 *
 * The claim this file exists to settle: a `plan` thread item — the one the
 * `ExitPlanModeCard` renders — is produced ONLY when the turn ran under
 * `collaborationMode.mode === 'plan'`. Before F20, ClaudeUI's plan mode sent
 * `approvalPolicy: untrusted` + a read-only sandbox and NO collaboration mode,
 * so no ClaudeUI thread had ever carried one however the model answered.
 *
 * Both halves are driven here, on one scripted answer that is byte-identical
 * between them (`<proposed_plan>…</proposed_plan>`): the plan-mode turn must
 * yield an `item/completed` of type `plan`, and the default-mode turn must yield
 * none — the same text arriving as an ordinary `agentMessage`.
 *
 * The turn payload is built by the SAME functions `CodexSession` uses
 * (`codexTurnPolicy` / `codexCollaborationMode`), so a change to either is
 * caught here rather than only in the unit guards.
 *
 * NO CREDENTIAL AND NO NETWORK: the provider is the shared localhost fixture,
 * the home is a temp `CODEX_HOME`, and on macOS the child is wrapped in a
 * seatbelt profile that allows only the fixture port.
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

const PLAN_BODY = '## Step one\n\n- Map the item kinds\n- Add the bodies'

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
      if (directory) rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  }
  expect(survivors, 'app-server groups survived bounded disposal').toEqual([])
})

interface Fixture {
  cwd: string
  env: NodeJS.ProcessEnv
  requests: Record<string, unknown>[]
  errors: string[]
  /** The model every request in this fixture runs on; null means the catalog default. */
  model: string | null
}

async function setupFixture(
  script: FixtureProviderOptions['script'] = ({ request }) =>
    isGuardianRequest(request)
      ? fixtureAssistantMessage('{}', 'msg-guardian')
      : fixturePlanMessage(PLAN_BODY),
  /**
   * `null` takes the catalog DEFAULT model instead of the uncatalogued
   * `mock-model`. It matters for `view_image`, which refuses outright unless the
   * model declares the image input modality
   * (`core/src/tools/handlers/view_image.rs`) — and an uncatalogued model gets
   * fallback metadata that does not.
   */
  model: string | null = 'mock-model'
): Promise<Fixture> {
  const installed = resolve(
    'vendor/codex-cli',
    process.platform === 'win32' ? 'codex.exe' : 'codex'
  )
  expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(
    provenance.codexBinaries[
      `${process.platform}-${process.arch}` as keyof typeof provenance.codexBinaries
    ]
  )
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-plan-mode-')))
  const home = join(directory, 'home')
  const codexHome = join(home, '.codex')
  const cwd = join(directory, 'cwd')
  for (const name of [codexHome, cwd, join(directory, 'tmp'), join(directory, 'vendor/codex-cli')])
    mkdirSync(name, { recursive: true })
  const exe = process.platform === 'win32' ? '.exe' : ''
  copyFileSync(installed, join(directory, 'vendor/codex-cli', `codex${exe}`))
  copyFileSync(
    resolve('vendor/codex-cli', `codex-code-mode-host${exe}`),
    join(directory, 'vendor/codex-cli', `codex-code-mode-host${exe}`)
  )
  setHostPaths({ getAppPath: () => directory! })

  const requests: Record<string, unknown>[] = []
  const errors: string[] = []
  provider = await startFixtureProvider({
    requests,
    errors,
    // The `fixture` provider declares `requires_openai_auth = false`, so the
    // child sends NO bearer at all — `undefined` here asserts its absence,
    // which is the proof it read the isolated home rather than a real one.
    authorization: undefined,
    script
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
    model,
    provider: 'fixture',
    apiKey: null
  })
  return {
    cwd,
    requests,
    errors,
    model,
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

type Notification = { method: string; params: Record<string, unknown> }

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 60000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Isolated Codex fixture deadline: ${label}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

/** Start a thread and run ONE turn under `mode`, returning every notification. */
async function runTurnInMode(fixture: Fixture, mode: 'plan' | 'default'): Promise<Notification[]> {
  const notifications: Notification[] = []
  const client = new CodexClient({
    cwd: fixture.cwd,
    env: fixture.env,
    requestTimeoutMs: 30000,
    onNotification: (method, params) =>
      notifications.push({ method, params: params as Record<string, unknown> })
  })
  clients.push(client)
  await client.start({
    clientInfo: { name: 'codex_plan_mode_probe', title: null, version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  const policy = codexTurnPolicy(mode)
  const started = await client.request('thread/start', {
    cwd: fixture.cwd,
    ...(fixture.model !== null ? { model: fixture.model } : {}),
    historyMode: 'paginated',
    allowProviderModelFallback: false,
    approvalPolicy: policy.approvalPolicy,
    approvalsReviewer: policy.approvalsReviewer,
    sandbox: mode === 'plan' ? 'read-only' : 'workspace-write'
  })
  const threadId = started.thread.id
  const turn = await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'propose a plan', text_elements: [] }],
    ...policy,
    // EXACTLY what CodexSession sends — one function, two callers.
    collaborationMode: codexCollaborationMode(mode, fixture.model ?? started.model)
  })
  await waitFor(
    () =>
      notifications.some(
        ({ method, params }) =>
          method === 'turn/completed' &&
          params.threadId === threadId &&
          (params.turn as { id: string })?.id === turn.turn.id
      ),
    `turn ${turn.turn.id} in ${mode} mode`
  )
  return notifications
}

/** The completed thread items of one run, by type. */
const completedItems = (notifications: Notification[]): { type: string; text?: string }[] =>
  notifications
    .filter(({ method }) => method === 'item/completed')
    .map(({ params }) => params.item as { type: string; text?: string })

it.skipIf(!enabled)(
  'a plan-mode turn yields a `plan` thread item and a default-mode turn does not',
  async () => {
    const fixture = await setupFixture()

    const planned = completedItems(await runTurnInMode(fixture, 'plan'))
    const plans = planned.filter((item) => item.type === 'plan')
    expect(plans, 'plan mode produced no plan item').toHaveLength(1)
    expect(plans[0].text).toContain('Map the item kinds')
    // The tags themselves never reach the transcript as prose.
    expect(plans[0].text).not.toContain('<proposed_plan>')

    const plain = completedItems(await runTurnInMode(fixture, 'default'))
    expect(
      plain.filter((item) => item.type === 'plan'),
      'default mode produced a plan item'
    ).toEqual([])
    // The same scripted text still arrived — as an ordinary agent message.
    expect(plain.some((item) => item.type === 'agentMessage')).toBe(true)

    expect(fixture.errors).toEqual([])
  },
  180000
)

it.skipIf(!enabled)(
  'the --web-search fixture item becomes a webSearch thread item',
  async () => {
    // The verifier drives the app with `--web-search`, so the flag's wire shape
    // is pinned against the binary here rather than only in the mapper's unit
    // fixtures. A `web_search_call` carries NO structured results on the
    // Responses wire (`protocol/src/models.rs` `ResponseItem::WebSearchCall` has
    // `id`, `status` and `action` and nothing else) — `WebSearchItem.results` is
    // filled out-of-band by the standalone web-search extension — so the card's
    // result ROWS are covered by the mapper guards and cannot be probed here.
    //
    // `--view-image` is deliberately NOT probed alongside it. The flag works and
    // the item is produced, but `view_image` resolves the path through Codex's
    // own fs sandbox helper, which spawns a NESTED `sandbox-exec` — and this
    // suite already wraps the child in one, so the inner call dies with
    // "sandbox_apply: Operation not permitted" and the tool answers "unable to
    // locate image" whatever the path is. The verifier's drive runs the real app
    // with no such wrapper and is where that flag is exercised; the read itself
    // is covered by `codex-image-view.test.ts`.
    let step = 0
    const fixture = await setupFixture(({ request }) => {
      if (isGuardianRequest(request)) return fixtureAssistantMessage('{}', 'msg-guardian')
      step += 1
      return step === 1
        ? fixtureWebSearchItem('electron 38 contextIsolation')
        : fixtureAssistantMessage()
    })

    const items = completedItems(await runTurnInMode(fixture, 'default')) as {
      type: string
      query?: string
      action?: { type: string }
    }[]
    const search = items.find((item) => item.type === 'webSearch')
    expect(search, 'no webSearch item').toBeDefined()
    expect(search!.query).toBe('electron 38 contextIsolation')
    expect(search!.action).toMatchObject({ type: 'search' })
    expect(fixture.errors).toEqual([])
  },
  180000
)
