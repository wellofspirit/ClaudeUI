/**
 * GATED end-to-end passkeys walk through a REAL browser (ADR-052 /
 * `docs/architecture/security.md`).
 *
 * Everything the unit and component suites have to fake, this file uses for
 * real: a real app instance (windowless, its own DB), a real
 * `tailscale serve` HTTPS origin on the tailnet, real Microsoft Edge, the real
 * built web client from `out/web`, and real WebAuthn ceremonies performed by
 * the browser's own credential manager. The single stand-in is the
 * authenticator HARDWARE — a CDP virtual authenticator instead of Windows Hello
 * — because a headless run has no finger to present. Everything downstream of
 * `navigator.credentials` (COSE keys, real signatures over real server-minted
 * challenges, `@simplewebauthn/server` verification) is the production path.
 *
 * WHY IT EXISTS. The passkey stack has ~2 400 lines of unit/component coverage,
 * and all of it stops at the same boundary: no test in the default suites has
 * ever run a ceremony in a browser, over the serve proxy, against the origin
 * the RP ID is derived from. The enroll-intent bug (d213439) is the proof —
 * every unit test passed while the first-device link was unusable on the only
 * origin it can be used from, because ambient tailnet identity preempted it at
 * CONNECTION time, which is a fact no in-process test could observe.
 *
 * ── GATING ──────────────────────────────────────────────────────────────────
 *
 * Two independent gates, deliberately:
 *
 *  1. LOCATION — `src/integration/**`, so the `integration` vitest project is
 *     the only one that even collects it. `bun run test` (unit + component +
 *     e2e) and `bun run test:ci` (+ git) cannot reach this file at all. That is
 *     structural, not a runtime skip.
 *  2. ENV — `CLAUDEUI_PASSKEYS_WALK=1`, mirroring the `OPENCODE_INTEGRATION_TESTS`
 *     convention, so even `bun run test:integration` skips it. Every heavy
 *     import (playwright, the app graph) is DYNAMIC and inside `beforeAll`, so
 *     a skipped run costs nothing.
 *
 * Requirements when the gate is on: Tailscale up with HTTPS certs on this
 * tailnet, Microsoft Edge installed, network, and a built web client
 * (`out/web`, i.e. `bun run build:web` at least once for the current client).
 *
 *   CLAUDEUI_PASSKEYS_WALK=1 bunx vitest run --project integration \
 *     src/integration/passkeys/passkeys-browser-walk.integration.test.ts
 *
 * Env knobs: `CLAUDEUI_WALK_HOST` (tailnet DNS name), `CLAUDEUI_WALK_HTTPS_PORT`
 * (default 8443 — 443 is REFUSED, see below), `CLAUDEUI_WALK_HEADED=1`.
 *
 * ── ISOLATION (read before changing anything here) ──────────────────────────
 *
 * This runs on a machine where the operator's OWN ClaudeUI is live and serving
 * the tailnet on 443. The walk must be invisible to it:
 *
 *  - **Its own DB.** Under vitest `better-sqlite3` is aliased to a node:sqlite
 *    shim that maps every path to `:memory:`, so the instance's credentials,
 *    policy and audit log exist only in this process. The operator's
 *    `operational.db` is never opened.
 *  - **Its own `$HOME`.** Redirected to a temp dir before the app graph loads
 *    (the same trick `windowless-boot.e2e.test.ts` uses), and `app.getPath()`
 *    points inside it — so no config, log or session file of the operator's is
 *    read or written. The temp dir is removed with `fs.rm` in teardown.
 *  - **A different serve port.** The pinned HTTPS port is 8443 and this file
 *    REFUSES to run against 443 (`expect(HTTPS_PORT).not.toBe(443)`). WebAuthn
 *    RP IDs ignore the port, so 8443 binds the same RP ID as the operator's
 *    443 — the ceremony is identical, the listener is not shared.
 *  - **The 443 entry is snapshotted and re-checked in teardown.** Nothing here
 *    ever names it: `enableServe`/`disableServe` are targeted at the pinned
 *    port only, and `tailscale serve reset` is never issued by any code path.
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import type { Browser } from 'playwright'
import type { CoreBoot } from '../../main/boot-core'
import type { TestIpcBridge } from '../../test/bridges/test-ipc-bridge'
import type { TailscaleManager, ServeOccupancy } from '../../main/services/tailscale-manager'
import type { WebauthnCredential, RemoteConfig, RemoteStatus } from '../../shared/types'
import type { AuditLogRow } from '../../main/services/db'
import {
  closeWalkPage,
  exportCredentials,
  hasTestId,
  launchEdge,
  openWalkPage,
  shot,
  waitForSurface,
  waitForTestId,
  type VirtualCredential,
  type WalkPage
} from '../../test/helpers/passkey-walk-browser'

const SKIP = process.env.CLAUDEUI_PASSKEYS_WALK !== '1'

/** The tailnet name whose cert the browser will validate — also the RP ID. */
const TAILNET_HOST = process.env.CLAUDEUI_WALK_HOST ?? 'pc.baboon-luma.ts.net'
/** NEVER 443 while another instance may own it (see the isolation note). */
const HTTPS_PORT = Number(process.env.CLAUDEUI_WALK_HTTPS_PORT ?? 8443)
const TAILNET_ORIGIN = `https://${TAILNET_HOST}:${HTTPS_PORT}`
/**
 * Budget for "the whole renderer App booted and rendered its empty state" —
 * a WS handshake, a `sync-full`, a ~1.2 MB chunk fetch and a React mount, over
 * a real (if local) network. Generous, but not so generous that a failing run
 * costs ten minutes before it says why.
 */
const APP_SURFACE_TIMEOUT_MS = 75_000
/** Break-glass credential for THIS instance's in-memory DB only. */
const WALK_PASSWORD = 'walk-break-glass-4f21a9'

// ---------------------------------------------------------------------------
// Hermetic environment. `vi.hoisted` runs before the (dynamic) app imports so
// the HOME redirect is in place for every `path.join(os.homedir(), …)` computed
// at module load. Skipped runs redirect nothing — this file shares a worker
// with the other integration suites.
// ---------------------------------------------------------------------------

const { tempHome, priorHome } = vi.hoisted(() => {
  const empty = {
    tempHome: '',
    priorHome: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  }
  if (process.env.CLAUDEUI_PASSKEYS_WALK !== '1') return empty
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-passkey-walk-'))
  const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  return { tempHome: home, priorHome: prior }
})

// The electron shim, with two overrides that matter here:
//  - `getAppPath()` must be the repo root, because `RemoteServer.getWebClientDir()`
//    resolves `<appPath>/out/web` — the REAL built web client is the thing under
//    test, and the shim's default (`/test/app`) would serve the "not built yet"
//    placeholder instead;
//  - `getPath()` lands inside the temp HOME, so nothing writes next to the
//    operator's data.
vi.mock('electron', async () => {
  const shim = await import('../../test/stubs/electron-shim')
  const path = await import('node:path')
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const app = {
    ...shim.app,
    getAppPath: () => repoRoot,
    getPath: (name: string) => path.join(process.env.HOME || repoRoot, `electron-${name}`)
  }
  return { ...shim, app, default: { ...shim.default, app } }
})

// The engine: never spawned. A walk about authentication must not depend on a
// coding agent being installed. The handle answers the discovery calls the web
// client makes on mount (`session:get-models` / `get-engine-models`) with empty
// lists rather than `undefined` — otherwise every page load prints two
// dispatcher errors that have nothing to do with what is being verified.
vi.mock('../../main/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/sdk')>()
  return {
    ...actual,
    query: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      initializationResult: (): Promise<never> => new Promise<never>(() => {}),
      interrupt: async (): Promise<void> => {},
      supportedModels: async (): Promise<unknown[]> => [],
      supportedCommands: async (): Promise<unknown[]> => [],
      supportedAgents: async (): Promise<unknown[]> => []
    })),
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-walk'
  }
})

// Leaf services that would spawn subprocesses, poll the network, or download a
// binary. Same list (and same reasons) as `windowless-boot.e2e.test.ts`.
// `tailscale-manager` is pointedly NOT here: the serve proxy is the point.
vi.mock('../../main/services/usage-fetcher', () => ({
  usageFetcher: {
    setSessionGetter: vi.fn(),
    setIntervalSecs: vi.fn(),
    startPolling: vi.fn(),
    fetch: vi.fn(async () => null),
    updateFromRateLimitEvent: vi.fn()
  }
}))
vi.mock('../../main/services/service-session', () => ({
  serviceSession: {
    getUsage: vi.fn(async () => null),
    getControlHandle: vi.fn(async () => null),
    stop: vi.fn()
  }
}))
vi.mock('../../main/services/block-usage', () => ({
  blockUsageService: {
    setDebounceSecs: vi.fn(),
    startWatching: vi.fn(),
    recalculate: vi.fn(async () => ({ blocks: [] })),
    getData: vi.fn(() => null),
    setAccountFilter: vi.fn()
  }
}))
vi.mock('../../main/auth/vault/CredentialSync', () => ({
  credentialSync: {
    configure: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    getStatus: vi.fn(() => ({ connected: false }))
  }
}))
vi.mock('../../main/shared-providers', () => ({
  sharedProviderService: {
    syncAll: vi.fn(async () => {}),
    listDefinitions: vi.fn(() => []),
    listStatuses: vi.fn(async () => []),
    listProviderModels: vi.fn(async () => []),
    saveDefinition: vi.fn(async () => {}),
    removeDefinition: vi.fn(async () => {}),
    setRouteEnabled: vi.fn(async () => {}),
    setApiKey: vi.fn(async () => {}),
    syncProvider: vi.fn(async () => {}),
    disconnectProvider: vi.fn(async () => {}),
    setRouteDefaultModel: vi.fn(async () => {})
  }
}))
vi.mock('../../main/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    isBinaryAvailable: vi.fn(() => false),
    setCallerSessionLookup: vi.fn(),
    setDispatchAgent: vi.fn(),
    dispose: vi.fn()
  }
}))
vi.mock('../../main/opencode/model-discovery', () => ({
  discoverOpencodeModels: vi.fn(async () => []),
  invalidateOpencodeModelCache: vi.fn(),
  discoverOpencodeProviderCatalog: vi.fn(async () => []),
  getOpencodeProviderModels: vi.fn(async () => []),
  resolveOpencodeSpawnModel: vi.fn(async (m?: string) => m)
}))
vi.mock('../../main/pi/model-discovery', () => ({
  discoverPiModels: vi.fn(async () => []),
  getPiModelCatalogGroups: vi.fn(async () => []),
  invalidatePiModelCache: vi.fn(),
  resolvePiSpawnModel: vi.fn(async (m?: string) => m),
  getPiModelCatalog: vi.fn(async () => []),
  effortLevelsFromModel: vi.fn(() => [])
}))
vi.mock('../../main/pi/pi-locate', () => ({
  piBinaryAvailable: vi.fn(() => false),
  locatePiBinary: vi.fn(() => null)
}))
vi.mock('../../main/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: {
    dispatch: vi.fn(),
    resolveApproval: vi.fn(() => false),
    disposeFor: vi.fn(),
    stopDispatch: vi.fn(() => false)
  },
  crossEngineDispatchAvailable: (): boolean => false,
  XENG_REQUEST_PREFIX: 'xeng:'
}))
vi.mock('../../main/services/voice-capture', () => ({
  startRecording: vi.fn(() => false),
  stopRecording: vi.fn()
}))
vi.mock('../../main/services/voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../../main/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../main/services/subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../../main/services/usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
// Ships a CloudFlare download path; RemoteServer constructs one unconditionally.
vi.mock('../../main/services/tunnel-manager', () => ({
  TunnelManager: class {
    setStatusHandler(): void {}
    getStatus(): { state: 'stopped'; url: null; error: null } {
      return { state: 'stopped', url: null, error: null }
    }
    async start(): Promise<void> {}
    stop(): void {}
  }
}))

// ---------------------------------------------------------------------------
// Shared state across the ordered steps (this file is ONE flow).
// ---------------------------------------------------------------------------

let core: CoreBoot
let bridge: TestIpcBridge
let tailscale: TailscaleManager
let browser: Browser
let localPort = 0
/** The tailnet owner login `tailscale serve` attaches to proxied requests. */
let ownerLogin = ''

/** The operator's 443 entry as found — re-asserted in teardown. */
let foreignServeEntries: ServeOccupancy[] = []
/** True once this run has claimed the pinned port and owes a cleanup. */
let serveClaimed = false

/** Pages, kept module-level so teardown closes them whatever failed. */
let enrollPage: WalkPage | null = null
let loginPage: WalkPage | null = null
let breakGlassPage: WalkPage | null = null
let offTailnetPage: WalkPage | null = null
let offLoopbackPage: WalkPage | null = null

/** Credential exported from the enrolling authenticator (step 1 → step 3). */
let enrolledCredentials: VirtualCredential[] = []

/** Evidence lines, printed at the end so the run's own log IS the report. */
const evidence: string[] = []
function note(line: string): void {
  evidence.push(line)
  console.log(`    ▸ ${line}`)
}

// --- thin typed wrappers over the desktop IPC surface ----------------------

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return bridge.ipcRenderer.invoke(channel, ...args) as Promise<T>
}
const getConfig = (): Promise<RemoteConfig> => invoke<RemoteConfig>('remote:get-config')
const setConfig = (partial: Record<string, unknown>): Promise<RemoteConfig> =>
  invoke<RemoteConfig>('remote:set-config', partial)
const listCredentials = (): Promise<WebauthnCredential[]> =>
  invoke<WebauthnCredential[]>('webauthn:credentials')
const status = (): RemoteStatus => core.remoteServer.getStatus()

/** Audit rows on one channel, newest-first (the repo's own ordering). */
let auditLogReader: (opts: { limit: number }) => AuditLogRow[]
function auditRows(channel: string): AuditLogRow[] {
  return auditLogReader({ limit: 500 }).filter((r) => r.channel === channel)
}

// --- ADR-054 tier scene (step 7) -------------------------------------------

/**
 * Budget for the mutation window to go stale on its own.
 *
 * `stepUpMutationIdleMinutes` has a ONE-MINUTE floor (`boot-core.ts` validates
 * 1–1440), so the walk waits out the real thing rather than a stub — the point
 * of this scene is that the shipped bundle raises the prompt on a real lapse.
 * The slack over 60 s is for the server's clock, not the client's.
 */
const MUTATION_WINDOW_LAPSE_MS = 100_000

/**
 * The SERVER's view of the sole remaining client's mutation deadline.
 *
 * Reaches into a private map, which is exactly what makes it worth having:
 * "the prompt did not appear" has two very different causes — the gate is
 * broken, or the window was never stale — and only the server can tell them
 * apart. Step 7 closes every other tab first so "the sole client" is a fact.
 * Returns null when there is not exactly one.
 */
function actorMutationDeadline(): number | null {
  const clients = (
    core.remoteServer as unknown as {
      clients: Map<unknown, { connection: { mutationExpiresAt?: number | null } }>
    }
  ).clients
  if (clients.size !== 1) return null
  for (const client of clients.values()) return client.connection.mutationExpiresAt ?? null
  return null
}

/**
 * Wait for that deadline to pass, and REPORT what happened if it does not.
 *
 * "The prompt never appeared" has two very different causes — the gate is
 * broken, or the window was never stale — and a bare timeout cannot tell them
 * apart. The samples make the second case name itself: a deadline that keeps
 * moving means something is refreshing it, which would be a defect in the
 * refresh discipline (only ACTING may slide the window), and a client count
 * that leaves 1 means the tab reconnected under the probe.
 */
async function awaitMutationWindowLapse(): Promise<void> {
  const started = Date.now()
  const samples: string[] = []
  for (;;) {
    const deadline = actorMutationDeadline()
    const elapsed = Date.now() - started
    if (deadline !== null && deadline <= Date.now()) return
    if (elapsed > MUTATION_WINDOW_LAPSE_MS) {
      throw new Error(
        `the mutation window never lapsed in ${Math.round(elapsed / 1000)}s — samples ` +
          `(elapsed s / clients / seconds until deadline): ${samples.join(', ')}`
      )
    }
    if (elapsed % 5_000 < 250) {
      samples.push(
        `${Math.round(elapsed / 1000)}s/${status().connectedClients}/${
          deadline === null ? 'n-a' : Math.round((deadline - Date.now()) / 1000)
        }`
      )
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * The strong tier's session budget for step 7c, INJECTED (see there): the
 * configurable floor is one hour, and a walk cannot wait one. Long enough for a
 * ceremony plus the app chunk, short enough that the cut lands inside the step.
 */
const SHORT_SESSION_MAX_AGE_MS = 45_000

/**
 * The subset of `window.api` step 7 drives. Declared as a local shape rather
 * than imported: the callback is serialized into the PAGE, where the renderer's
 * `ClaudeAPI` type does not exist.
 */
interface WalkPageApi {
  authcfgApply(patch: Record<string, unknown>): Promise<{ ok: boolean }>
  authcfgEnd(): Promise<{ ok: boolean }>
  /** The UNLOCK ceremony: a step-up carrying the `settings` intent. */
  terminalStepUpPasskey(intent?: string): Promise<Record<string, unknown>>
  loadSettings(): Promise<unknown>
  saveSettings(settings: unknown): Promise<void>
  terminalAvailability(): Promise<Record<string, unknown>>
}

/** Run `fn` against the page's live `window.api`. */
function evalOnPage<T>(wp: WalkPage, fn: (api: WalkPageApi) => Promise<T> | T): Promise<T> {
  return wp.page.evaluate(
    (source) =>
      (new Function(`return (${source})`)() as (api: WalkPageApi) => Promise<T>)(
        (window as unknown as { api: WalkPageApi }).api
      ),
    fn.toString()
  ) as Promise<T>
}

/**
 * Get `loginPage` back into the app.
 *
 * Step 7 crosses several auth-surface changes and one deliberate session cut,
 * and each of them puts this tab back on the one-tap screen. The MODE matters
 * and is not guessable from the DOM: for a beat after a 4009 the socket is gone
 * but the app subtree is still mounted, so "is SessionView present?" answers YES
 * for a tab that is about to be thrown out and will then sit on the one-tap
 * screen forever with nobody to press it. So a caller that KNOWS a disconnect
 * was just triggered says so, and this waits for the sign-in screen rather than
 * racing it.
 */
async function signInOnLoginPage(
  label: string,
  mode: 'after-disconnect' | 'tolerant' = 'after-disconnect'
): Promise<void> {
  const page = loginPage!.page
  if (mode === 'tolerant' && (await hasTestId(page, 'SessionView'))) return
  await waitForTestId(page, 'PasskeyLogin', 60_000)
  await page.locator('[data-testid="PasskeyLogin.submit"]').click()
  await waitForSurface(loginPage!, 'SessionView', {
    timeoutMs: APP_SURFACE_TIMEOUT_MS,
    label
  })
}

/** Poll until `predicate` holds — network timing, so generous and interval-based. */
async function until(label: string, predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('E2E (gated): passkeys browser walk over tailscale serve', () => {
  beforeAll(async () => {
    // ── Step 0a: isolation preconditions, BEFORE anything mutates the machine ──
    expect(HTTPS_PORT, 'the walk must never claim the port a live instance serves on').not.toBe(443)
    expect(tempHome, 'the hermetic HOME redirect must be active').toContain(
      'claudeui-passkey-walk-'
    )
    const { existsSync } = await import('node:fs')
    const nodePath = await import('node:path')
    const webIndex = nodePath.resolve(__dirname, '..', '..', '..', 'out', 'web', 'index.html')
    expect(
      existsSync(webIndex),
      `built web client missing at ${webIndex} — run bun run build:web`
    ).toBe(true)

    const { TailscaleManager: Manager } = await import('../../main/services/tailscale-manager')
    tailscale = new Manager()
    const detection = await tailscale.detect()
    expect(detection.state, `tailscale not ready: ${JSON.stringify(detection)}`).toBe('ok')
    expect(detection.state === 'ok' && detection.dnsName).toBe(TAILNET_HOST)
    // The login the identity headers will carry — asserted against later
    // rather than hard-coded, since it is this machine's tailnet owner.
    ownerLogin = (detection.state === 'ok' && detection.ownerLogin) || ''
    expect(ownerLogin, 'tailnet identity needs a known owner login').not.toBe('')

    // Snapshot the serve table as found. Everything NOT on the pinned port is
    // somebody else's and must survive this run byte-for-byte.
    const before = await tailscale.getServeStatus()
    foreignServeEntries = before.occupied.filter((o) => o.httpsPort !== HTTPS_PORT)
    note(
      `serve table as found: ${before.occupied
        .map((o) => `${o.httpsPort}→${o.target}`)
        .join(', ')} (foreign, must be preserved: ${
        foreignServeEntries.map((o) => `${o.httpsPort}→${o.target}`).join(', ') || 'none'
      })`
    )

    // ── Step 0b: boot an isolated instance ──────────────────────────────────
    const { TestIpcBridge: Bridge } = await import('../../test/bridges/test-ipc-bridge')
    const { setIpcBridge } = await import('../../test/stubs/electron-shim')
    bridge = new Bridge()
    setIpcBridge(bridge)

    const db = await import('../../main/services/db')
    auditLogReader = db.listAuditLog
    // The persisted config the production start path reads. Random loopback
    // port (0), loopback bind, TLS mode on, pinned to the walk's HTTPS port.
    db.setRemoteConfig({
      port: 0,
      bindHost: '127.0.0.1',
      autostart: false,
      tlsMode: 1,
      tlsHttpsPort: HTTPS_PORT,
      authPolicy: null,
      passwordBreakGlass: true,
      passkeyTailnetExempt: false
    })
    expect(
      db.countWebauthnCredentials(),
      'the walk instance must start with zero credentials'
    ).toBe(0)

    const { bootCore } = await import('../../main/boot-core')
    core = bootCore({ remoteAccessDisabled: false })

    // Break-glass credential — provisioned through the same desktop channel the
    // Settings pane uses, into THIS instance's in-memory DB.
    await invoke('remote:set-password', WALK_PASSWORD)

    // ── Step 0c: start + claim the pinned port ──────────────────────────────
    await invoke('remote:start')
    localPort = status().port ?? 0
    expect(localPort).toBeGreaterThan(0)
    note(`instance listening on 127.0.0.1:${localPort} (loopback only, TLS mode)`)

    // The first attempt is expected to REFUSE the port when a foreign handler
    // holds it — that refusal is ADR-042's whole point, so assert it rather
    // than paper over it, then take the port the way the operator's banner does.
    const afterStart = status()
    if (afterStart.tls?.url === null) {
      note(
        `serve claim refused as designed: ${afterStart.tls?.serveError?.reason} — force-reserving`
      )
      await invoke('remote:force-reserve')
    }
    serveClaimed = true
    const tls = status().tls
    expect(tls?.httpsPort).toBe(HTTPS_PORT)
    expect(tls?.url).toBe(TAILNET_ORIGIN)
    note(`tailscale serve up: ${tls?.url} → http://127.0.0.1:${localPort}`)

    // The claim must not have touched anyone else's entry.
    const nowOccupied = (await tailscale.getServeStatus()).occupied
    for (const foreign of foreignServeEntries) {
      const still = nowOccupied.find((o) => o.httpsPort === foreign.httpsPort)
      expect(still?.target, `serve entry on ${foreign.httpsPort} changed`).toBe(foreign.target)
    }

    browser = await launchEdge()
    note(`Edge launched (${browser.version()})`)
  }, 300_000)

  afterAll(async () => {
    // Always, in this order: browser first (its pages hold sockets), then the
    // instance, then the serve entry, then the temp HOME.
    for (const wp of [enrollPage, loginPage, breakGlassPage, offTailnetPage, offLoopbackPage]) {
      await closeWalkPage(wp)
    }
    await browser?.close().catch(() => {})

    try {
      await core?.remoteServer.stop()
      const { getSessionManager } = await import('../../main/ipc/session.ipc')
      getSessionManager()?.cancelAll()
      core?.automationManager.stopAll()
    } catch {
      /* teardown is best-effort past this point */
    }

    // `stop()` fires a best-effort `disableServe` we do not await; do it
    // explicitly and VERIFY, because leaving a live handler pointed at a dead
    // loopback port is exactly the orphan this walk had to force its way past.
    if (serveClaimed && tailscale) {
      try {
        await tailscale.disableServe(HTTPS_PORT)
        const after = (await tailscale.getServeStatus()).occupied
        const mine = after.find((o) => o.httpsPort === HTTPS_PORT)
        console.log(
          `    ▸ teardown: port ${HTTPS_PORT} ${mine ? `STILL OCCUPIED by ${mine.target}` : 'removed'}; ` +
            `table now: ${after.map((o) => `${o.httpsPort}→${o.target}`).join(', ') || 'empty'}`
        )
        for (const foreign of foreignServeEntries) {
          const still = after.find((o) => o.httpsPort === foreign.httpsPort)
          if (still?.target !== foreign.target) {
            console.error(
              `    ▸ FOREIGN SERVE ENTRY CHANGED on ${foreign.httpsPort}: ${foreign.target} → ${still?.target ?? 'gone'}`
            )
          }
        }
      } catch (err) {
        console.error(
          `    ▸ teardown: could not remove serve entry on ${HTTPS_PORT}: ${String(err)}`
        )
      }
    }

    if (priorHome.HOME === undefined) delete process.env.HOME
    else process.env.HOME = priorHome.HOME
    if (priorHome.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = priorHome.USERPROFILE
    // fs.rm, never a shell `rm -rf`.
    if (tempHome) nodeFs.rmSync(tempHome, { recursive: true, force: true })

    console.log(['', '=== WALK EVIDENCE ===', ...evidence.map((l) => `  · ${l}`), ''].join('\n'))
  }, 120_000)

  // -------------------------------------------------------------------------

  it('1. enrolls the FIRST device from a #enroll= link', async () => {
    // Minting is an `admin` desktop verb — a password connection under
    // effective-`legacy` deliberately cannot do it (security.md §Enrollment:
    // "the first device requires the desktop path, BY CONSTRUCTION").
    const minted = await invoke<{ token: string; expiresAt: number; url: string }>(
      'webauthn:mint-enroll-token'
    )
    expect(minted.url).toBe(`${TAILNET_ORIGIN}/remote#enroll=${minted.token}`)
    note(
      `enroll link minted at the tailnet origin (token in the FRAGMENT): ${TAILNET_ORIGIN}/remote#enroll=<32B>`
    )

    enrollPage = await openWalkPage(browser, { virtualAuthenticator: true })
    await enrollPage.page.goto(minted.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    // The enrollment screen — NOT the app, and not a password form. Reaching it
    // at all is what d213439 fixed: ambient tailnet identity used to accept this
    // socket before the client could present the link.
    await waitForTestId(enrollPage.page, 'EnrollDevice')
    const shot1 = await shot(enrollPage.page, '01-enroll-screen')
    note(`step 1: EnrollDevice rendered at the tailnet origin → ${shot1}`)

    await enrollPage.page.locator('[data-testid="EnrollDevice.nickname"]').fill('Walk Edge')
    await enrollPage.page.locator('[data-testid="EnrollDevice.submit"]').click()

    // Registration + the upgrade assertion on the SAME socket, then the app.
    // `SessionView` is the renderer's own shell: reaching it proves the
    // socket carries a real `sync-full`, i.e. the enroll-only connection was
    // upgraded rather than merely not-refused.
    await waitForSurface(enrollPage, 'SessionView', {
      timeoutMs: APP_SURFACE_TIMEOUT_MS,
      label: 'step1-app-surface'
    })
    const shot2 = await shot(enrollPage.page, '02-enrolled-connected')
    note(`step 1: ceremony completed and the app surface rendered → ${shot2}`)

    // Server-side: exactly one credential, named, and marked synced (the virtual
    // authenticator reports backup eligibility, exercising the "Synced" badge).
    const creds = await listCredentials()
    expect(creds).toHaveLength(1)
    expect(creds[0].nickname).toBe('Walk Edge')
    note(
      `step 1: webauthn:credentials → 1 row {nickname:"${creds[0].nickname}", backedUp:${creds[0].backedUp}, credId:${creds[0].credId.slice(0, 12)}…}`
    )

    // The socket stayed up and is now a `webauthn` connection. REGRESSION
    // GUARD: `handleEnrollUpgrade` upgrades IN PLACE, and it must name the
    // connection after the credential exactly as the handshake path's
    // `accept('webauthn', label)` does — a `null` here left the desktop's
    // connected-clients row blank for a device that had just enrolled, which is
    // the one moment the operator is watching it.
    await until('the enrolled client to be counted', () => status().connectedClients >= 1)
    expect(status().clientLogins).toContain('Walk Edge')
    note(
      `step 1: 1 live client, RemoteStatus.clientLogins=${JSON.stringify(status().clientLogins)} — the in-place upgrade carries the credential label`
    )

    // The audit trail reads as ONE thread: link burned → assertion → policy move.
    expect(auditRows('auth:enroll-token').filter((r) => r.outcome === 'ok')).toHaveLength(1)
    const asserts = auditRows('auth:webauthn-assert').filter((r) => r.outcome === 'ok')
    expect(asserts.length).toBeGreaterThanOrEqual(1)
    // `credentialLabel(nickname, credId)` — the nickname the browser sent.
    expect(asserts[0].label).toBe('Walk Edge')
    expect(asserts[0].method).toBe('webauthn')
    note(
      `step 1: audit → auth:enroll-token(ok) then auth:webauthn-assert(ok, method=webauthn, label="${asserts[0].label}") on one connection id`
    )

    // The spent secret is gone from the address bar (a reload must not re-present it).
    expect(enrollPage.page.url()).not.toContain('enroll=')
    expect(enrollPage.page.url().startsWith(`${TAILNET_ORIGIN}/remote`)).toBe(true)
    note(`step 1: #enroll= stripped from the URL → ${enrollPage.page.url()}`)
  }, 240_000)

  it('2. flips AUTO to passkey-always and audits the move', async () => {
    const config = await getConfig()
    // Nobody WROTE a policy — the column is still NULL. That is the whole design
    // of AUTO (security.md §Policy modes).
    expect(config.authPolicy).toBeNull()
    expect(config.effectiveAuthPolicy).toBe('passkey-always')
    expect(config.credentialCount).toBe(1)
    note(
      `step 2: policy column still NULL (AUTO), effective = ${config.effectiveAuthPolicy} with ${config.credentialCount} credential`
    )

    const policyRows = auditRows('auth:policy-change')
    expect(policyRows).toHaveLength(1)
    expect(policyRows[0]).toMatchObject({ capability: 'admin', kind: 'command', outcome: 'ok' })
    // The ACTOR is the enrollment socket, not the desktop: the row names who did it.
    expect(policyRows[0].method).toBe('enroll-token')
    note(
      `step 2: audit auth:policy-change ×1 {method:${policyRows[0].method}, label:"${policyRows[0].label}", capability:${policyRows[0].capability}}`
    )
  }, 60_000)

  it('3. signs a NEW tab in with one tap (never an auto-fired ceremony)', async () => {
    // Same browser profile, same passkey — in a NEW TAB. A CDP virtual
    // authenticator is scoped to the page that created it (a second page with
    // none falls through to the real Windows platform authenticator and hangs),
    // so the key is transplanted with `getCredentials`/`addCredential`. What the
    // browser then does is a genuine assertion: the private key is the one the
    // registration produced, and the signature is verified by the real server.
    enrolledCredentials = await exportCredentials(enrollPage!)
    expect(enrolledCredentials).toHaveLength(1)
    expect(enrolledCredentials[0].rpId).toBe(TAILNET_HOST)
    expect(enrolledCredentials[0].isResidentCredential).toBe(true)
    note(
      `step 3: the enrolling authenticator holds 1 DISCOVERABLE credential bound to rpId=${TAILNET_HOST}; transplanting it into a new tab`
    )

    loginPage = await openWalkPage(browser, {
      context: enrollPage!.context,
      virtualAuthenticator: true,
      seed: enrolledCredentials
    })
    const assertsBefore = auditRows('auth:webauthn-assert').length

    await loginPage.page.goto(`${TAILNET_ORIGIN}/remote`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    })

    // Ambient tailnet identity is present on this request (serve attaches it),
    // and under `passkey-always` it does NOT skip the ceremony.
    await waitForTestId(loginPage.page, 'PasskeyLogin')
    const shot3 = await shot(loginPage.page, '03-one-tap-login')
    note(
      `step 3: PasskeyLogin one-tap screen at a bare /remote (tailnet identity did NOT bypass) → ${shot3}`
    )

    // NOT auto-fired: no assertion has been verified while the page sat there.
    await new Promise((r) => setTimeout(r, 1_500))
    expect(auditRows('auth:webauthn-assert').length).toBe(assertsBefore)
    expect(await hasTestId(loginPage.page, 'SessionView')).toBe(false)
    note('step 3: after 1.5s on the screen, zero new assertions — the ceremony waits for the tap')

    await loginPage.page.locator('[data-testid="PasskeyLogin.submit"]').click()
    await waitForSurface(loginPage, 'SessionView', {
      timeoutMs: APP_SURFACE_TIMEOUT_MS,
      label: 'step3-app-surface'
    })
    const shot4 = await shot(loginPage.page, '04-one-tap-connected')
    expect(auditRows('auth:webauthn-assert').length).toBe(assertsBefore + 1)
    // The HANDSHAKE path names the connection after the credential too — both
    // sockets (step 1's upgraded one and this one) now read as "Walk Edge".
    expect(status().clientLogins.filter((l) => l === 'Walk Edge')).toHaveLength(2)
    note(
      `step 3: one tap → assertion verified → app surface (audit +1 auth:webauthn-assert; clientLogins now ${JSON.stringify(status().clientLogins)}) → ${shot4}`
    )
  }, 240_000)

  it('4. break-glass password signs in AT THE TAILNET ORIGIN', async () => {
    // A device with NO authenticator at all — the passkey path is impossible
    // here, which is the situation break-glass exists for, and the phone whose
    // authenticator died is the operator's whole recovery story.
    breakGlassPage = await openWalkPage(browser, { virtualAuthenticator: false })

    // 4a. The tailnet origin — the one that matters, and the one that used to
    // have no way through. REGRESSION GUARD: `decideAuthEntry` must remember the
    // password params on the `tailnet` route, or the one-tap screen renders with
    // `onUsePassword` undefined and a lost authenticator is a dead end here
    // (security.md §origin × method matrix promises break-glass on this row).
    await breakGlassPage.page.goto(`${TAILNET_ORIGIN}/remote`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    })
    await waitForTestId(breakGlassPage.page, 'PasskeyLogin')
    expect(
      await hasTestId(breakGlassPage.page, 'PasskeyLogin.usePassword'),
      'the tailnet origin must offer the break-glass password fallback'
    ).toBe(true)
    const shot5 = await shot(breakGlassPage.page, '05-breakglass-tailnet-origin')
    note(`step 4a: the tailnet one-tap screen offers "use password instead" → ${shot5}`)

    await breakGlassPage.page.locator('[data-testid="PasskeyLogin.usePassword"]').click()
    await waitForTestId(breakGlassPage.page, 'PasswordLogin')
    const shot6 = await shot(breakGlassPage.page, '06-breakglass-password-form')
    note(`step 4a: password form reached at ${TAILNET_ORIGIN} → ${shot6}`)

    await breakGlassPage.page.locator('[data-testid="PasswordLogin.input"]').fill(WALK_PASSWORD)
    await breakGlassPage.page.locator('[data-testid="PasswordLogin.submit"]').click()
    // scrypt runs in the browser, then the proof goes up.
    await waitForSurface(breakGlassPage, 'SessionView', {
      timeoutMs: APP_SURFACE_TIMEOUT_MS,
      label: 'step4-app-surface'
    })
    const shot7 = await shot(breakGlassPage.page, '07-breakglass-connected')
    note(
      `step 4a: break-glass password accepted at the tailnet origin under passkey-always (breakGlass=true) → ${shot7}`
    )

    // The inline self-enroll offer only renders for `authMethod === 'password'`,
    // so its presence is the CLIENT's own report that this connection is a
    // password one and not, say, an ambient tailnet accept.
    expect(
      await hasTestId(breakGlassPage.page, 'EnrollPrompt'),
      'a password connection under a passkey mode must be offered inline self-enroll'
    ).toBe(true)
    note('step 4a: inline self-enroll offered — the connection is `password`, not ambient identity')

    // 4b. `localhost` is the OTHER WebAuthn-capable origin
    // (`resolveWebauthnOrigin`), and a direct loopback request carries no serve
    // identity headers — a different discovery route (`passkey` by
    // advertisement, not `tailnet`) to the same affordance. Kept because it is
    // the only coverage of that origin and that route, and it costs ~1 s; the
    // sign-in itself is not repeated, since 4a already proved the server accepts
    // the proof on a WebAuthn-capable origin.
    const loopbackOrigin = `http://localhost:${localPort}`
    await breakGlassPage.page.goto(`${loopbackOrigin}/remote`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    })
    await waitForTestId(breakGlassPage.page, 'PasskeyLogin')
    await breakGlassPage.page.locator('[data-testid="PasskeyLogin.usePassword"]').click()
    await waitForTestId(breakGlassPage.page, 'PasswordLogin')
    note(`step 4b: the same fallback is reachable at the loopback origin ${loopbackOrigin}`)

    // Closed BEFORE the 4009 leg: turning break-glass off would strand it on a
    // form the server will no longer accept, which is correct behaviour but not
    // what step 5 is measuring.
    await closeWalkPage(breakGlassPage)
    breakGlassPage = null
  }, 300_000)

  it('5. a break-glass flip drops live clients (4009) and they re-authenticate', async () => {
    const policyRowsBefore = auditRows('auth:policy-change').length
    const assertsBefore = auditRows('auth:webauthn-assert').length
    await until('the passkey client to be connected', () => status().connectedClients >= 1)

    // NOT the policy mode: the break-glass toggle is precisely the auth-surface
    // field an earlier implementation left unaudited and un-disconnected.
    const after = await setConfig({ passwordBreakGlass: false })
    expect(after.passwordBreakGlass).toBe(false)

    // (a) every live socket is gone…
    await until('all remote clients to be dropped', () => status().connectedClients === 0, 20_000)
    note('step 5: passwordBreakGlass true→false dropped every live client (server sends 4009)')

    // (b) …and the client treats it as "reconnect and re-decide": the fresh
    // handshake owes a ceremony again, so the one-tap screen comes back.
    await waitForTestId(loginPage!.page, 'PasskeyLogin', 60_000)
    const shot8 = await shot(loginPage!.page, '08-4009-reauth-required')
    note(`step 5: the connected page recovered onto the one-tap screen, not an error → ${shot8}`)

    await loginPage!.page.locator('[data-testid="PasskeyLogin.submit"]').click()
    await waitForSurface(loginPage!, 'SessionView', {
      timeoutMs: APP_SURFACE_TIMEOUT_MS,
      label: 'step5-app-surface'
    })
    const shot9 = await shot(loginPage!.page, '09-4009-recovered')
    expect(auditRows('auth:webauthn-assert').length).toBeGreaterThan(assertsBefore)
    expect(auditRows('auth:policy-change').length).toBe(policyRowsBefore + 1)
    note(`step 5: re-authenticated with a fresh ceremony; audit auth:policy-change +1 → ${shot9}`)

    // Restore, and let the resulting second 4009 settle before step 6.
    await setConfig({ passwordBreakGlass: true })
    await waitForTestId(loginPage!.page, 'PasskeyLogin', 60_000)
  }, 300_000)

  it('6. off-mode warns EVERY connected client with a non-dismissible banner', async () => {
    // Set directly: the typed `disable remote authentication` confirmation is
    // desktop UI (`RemotePasskeySettings.tsx`, covered by its component test),
    // not the server contract this walk is about.
    const off = await setConfig({ authPolicy: 'off' })
    expect(off.effectiveAuthPolicy).toBe('off')
    note('step 6: policy set to off (master switch) via the desktop-only remote:set-config')

    // 6a. The tailnet origin, no credential of any kind — i.e. the owner's own
    // phone, which `tailscale serve` identifies at CONNECTION time. REGRESSION
    // GUARD: this connection is admitted as `tailnet-identity`, never `none`, so
    // a banner keyed on the method alone would leave the single most important
    // client unwarned. `auth-response.authDisabled` is what must carry it
    // (security.md §Policy modes, hard requirement 2: "every connected web
    // client").
    offTailnetPage = await openWalkPage(browser, { virtualAuthenticator: false })
    await offTailnetPage.page.goto(`${TAILNET_ORIGIN}/remote`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    })
    await waitForSurface(offTailnetPage, 'SessionView', {
      timeoutMs: APP_SURFACE_TIMEOUT_MS,
      label: 'step6a-app-surface'
    })
    await waitForSurface(offTailnetPage, 'NoAuthBanner', {
      timeoutMs: 15_000,
      label: 'step6a-banner'
    })
    // …and it really was the ambient-identity path: the server named this
    // connection after the tailnet owner, which only `accept('tailnet-identity')`
    // does.
    expect(status().clientLogins).toContain(ownerLogin)
    const shotA = await shot(offTailnetPage.page, '10-off-mode-tailnet-origin')
    note(
      `step 6a: a TAILNET-IDENTIFIED client under off (login = the node owner, not "none") renders NoAuthBanner → ${shotA}`
    )

    // 6b. A connection the server admits as `none` — the older signal, kept as
    // the compatibility path in `RemoteConnection.isAuthDisabled`.
    offLoopbackPage = await openWalkPage(browser, { virtualAuthenticator: false })
    await offLoopbackPage.page.goto(`http://localhost:${localPort}/remote`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    })
    // Discovery still advertises a passkey here (a credential exists and
    // localhost is capable), so the client waits on the one tap; the tap only
    // connects — under `off` the server accepts the bare auth frame outright.
    await waitForTestId(offLoopbackPage.page, 'PasskeyLogin')
    await offLoopbackPage.page.locator('[data-testid="PasskeyLogin.submit"]').click()
    const banner = await waitForSurface(offLoopbackPage, 'NoAuthBanner', {
      timeoutMs: APP_SURFACE_TIMEOUT_MS,
      label: 'step6b-banner'
    })
    const shotB = await shot(offLoopbackPage.page, '11-off-mode-banner')
    note(`step 6b: NoAuthBanner rendered for a method="none" connection → ${shotB}`)

    // Non-dismissible: no control of any kind inside the banner.
    const controls = await banner.locator('button, [role="button"], a, input').count()
    expect(controls).toBe(0)
    expect((await banner.textContent()) ?? '').toContain('Remote authentication is OFF')
    note('step 6b: the banner contains zero interactive elements (no dismiss control)')

    // Restore AUTO. `null` is meaningful here (not "leave alone").
    const restored = await setConfig({ authPolicy: null })
    expect(restored.authPolicy).toBeNull()
    expect(restored.effectiveAuthPolicy).toBe('passkey-always')
    note('step 6: policy restored to AUTO → passkey-always')
  }, 300_000)

  /**
   * ADR-054 — the step-up TIERS, end to end in the browser.
   *
   * Everything the tier suites prove against a socket, this proves against the
   * shipped bundle: the generic prompt really appears for a NON-terminal
   * mutation, the settings verbs really are reachable from the web, the strong
   * tier's session cut really lands as an explained sign-in rather than an
   * unexplained one, and tier `off` really costs nothing.
   */
  it('7. step-up tiers: strong gates a mutation, 4010 is explained, off gates nothing', async () => {
    // Retire the tabs the earlier steps opened. Three reasons, all of them
    // about making this step's assertions unambiguous: the freshness probe
    // below has to be able to name ONE connection, 7c's session cut has to be
    // observable on the tab under test rather than raced by four reconnecting
    // ones, and every extra client is extra ceremony traffic in the audit log.
    for (const wp of [breakGlassPage, offTailnetPage, offLoopbackPage]) await closeWalkPage(wp)
    breakGlassPage = null
    offTailnetPage = null
    offLoopbackPage = null

    // Shorten the mutation window to its 1-minute FLOOR before signing back in.
    // The order matters: the DIAL is part of the auth surface, so this write
    // sweeps every live client with a 4009 — the fix for F1, and the reason the
    // sign-in comes AFTER it rather than before. (It also has to be short before
    // the tier is armed, or 7b would idle for an hour waiting for a proof to go
    // stale.)
    //
    // The terminal toggle stays OFF through 7a–7c, deliberately: that is the
    // DEFAULT, and it is the configuration in which the ceremony used to be
    // refused outright ("Remote terminal is turned off", `retryable: false`) —
    // locking the operator out of the very settings surface this scene drives.
    // Every prompt below therefore runs on a server offering no shell at all.
    await setConfig({ stepUpMutationIdleMinutes: 1, allowTerminal: false })

    // Step 6 left the tab on the one-tap screen (its 4009), and the dial write
    // above put it back there if it had recovered in between. Get back in.
    await signInOnLoginPage('step7-resume')
    await until('exactly one client to remain connected', () => status().connectedClients === 1)

    // ── 7a: the SETTINGS-EDITING SESSION, from the browser ─────────────────
    //
    // The 2026-08-16 amendment: administering is a bounded MODE, not an ambient
    // capability. A freshly-armed passkey session — which under the old rule
    // could write settings for the next hour without another thought — is
    // refused until the editor is deliberately unlocked.
    const lockedAttempt = await evalOnPage<string>(loginPage!, async (api) => {
      try {
        await api.authcfgApply({ stepUpTier: 'strong' })
        return 'ok'
      } catch (err) {
        return `err:${err instanceof Error ? err.message : String(err)}`
      }
    })
    expect(
      lockedAttempt,
      'a signed-in session must not be able to write settings without unlocking'
    ).toContain('needs-settings-session')
    expect((await getConfig()).stepUpTier).not.toBe('strong')
    // …and the generic step-up gate did NOT quietly cure it: no ceremony ran.
    expect(await hasTestId(loginPage!.page, 'StepUpOverlay')).toBe(false)
    note('step 7a: authcfg:apply refused with needs-settings-session — the editor was locked')

    // The UNLOCK: the same ceremony the terminal uses, carrying the settings
    // intent. One real WebAuthn assertion through the virtual authenticator.
    const unlocked = await evalOnPage<Record<string, unknown>>(loginPage!, (api) =>
      api.terminalStepUpPasskey('settings')
    )
    expect(unlocked).toMatchObject({ ok: true })
    expect(
      unlocked.settingsSessionExpiresAt as number,
      'the editor ticks from the SERVER deadline'
    ).toBeGreaterThan(Date.now())

    // …and now the batch lands: one apply, carrying everything at once,
    // including the DIALS the old model kept desktop-only.
    const applied = await evalOnPage<string>(loginPage!, async (api) => {
      try {
        await api.authcfgApply({ stepUpTier: 'strong', sessionMaxAgeHours: 5 })
        return 'ok'
      } catch (err) {
        return `err:${err instanceof Error ? err.message : String(err)}`
      }
    })
    expect(applied).toBe('ok')
    const afterApply = await getConfig()
    expect(afterApply.stepUpTier).toBe('strong')
    expect(afterApply.sessionMaxAgeHours, 'the dials are web-editable now').toBe(5)
    const shotTier = await shot(loginPage!.page, '12-settings-session-apply')
    note(`step 7a: unlock ceremony → one authcfg:apply (tier + dial) from the BROWSER → ${shotTier}`)

    // Closing the editor is the operator's action, not only the TTL's.
    await evalOnPage(loginPage!, (api) => api.authcfgEnd())
    const afterEnd = await evalOnPage<string>(loginPage!, async (api) => {
      try {
        await api.authcfgApply({ stepUpTier: 'medium' })
        return 'ok'
      } catch (err) {
        return `err:${err instanceof Error ? err.message : String(err)}`
      }
    })
    expect(afterEnd, 'authcfg:end really closes the mode').toContain('needs-settings-session')
    expect((await getConfig()).stepUpTier).toBe('strong')
    note('step 7a: authcfg:end closed the session — the next write is refused again')

    // The apply is an auth-surface change: everyone but the actor is dropped,
    // and the actor is re-snapshotted IN PLACE — so this tab is deliberately
    // still signed in, and the tolerant mode is the right one.
    await signInOnLoginPage('step7a-after-tier', 'tolerant')
    expect(status().connectedClients, 'the actor is spared its own 4009').toBe(1)

    // ── 7b: the SAME mutation, allowed while fresh and gated once stale ────
    //
    // `config:save-settings` is a `command` outside the shell and outside the
    // settings namespace — exactly the class that was free under `medium` and is
    // gated under `strong`. Written back unchanged, so the assertion is about
    // the gate and not about the payload.
    const saveSettingsUnchanged = (): Promise<string> =>
      evalOnPage<string>(loginPage!, async (api) => {
        try {
          await api.saveSettings(await api.loadSettings())
          return 'ok'
        } catch (err) {
          return `err:${err instanceof Error ? err.message : String(err)}`
        }
      })

    // First pass: still inside the window, so it goes straight through — the
    // strong tier gates STALENESS, not the verb. It also re-stamps the window
    // with the shortened budget: the tier write a moment ago refreshed using the
    // policy snapshot this connection was ADMITTED under (60 minutes), because
    // the freshness gate necessarily runs before the handler that re-snapshots
    // it. Anything else here would idle for an hour.
    expect(await saveSettingsUnchanged()).toBe('ok')
    expect(await hasTestId(loginPage!.page, 'StepUpOverlay')).toBe(false)

    // The premise is asserted, not assumed: wait until the SERVER says this
    // connection's mutation window has actually gone stale. A fixed sleep would
    // turn "something quietly refreshed the window" — the exact failure the
    // refresh discipline exists to prevent — into a mysterious missing prompt
    // instead of a named finding.
    await awaitMutationWindowLapse()
    note('step 7b: the mutation window lapsed on idle — no read or keepalive slid it')

    const mutation = saveSettingsUnchanged()
    // The GENERIC prompt — not the terminal's. Nothing about this call site
    // knows what a step-up is; the gate on the invoke path is what raised it.
    await waitForTestId(loginPage!.page, 'StepUpOverlay', 60_000)
    const shotPrompt = await shot(loginPage!.page, '13-generic-step-up-prompt')
    note(`step 7b: a chat/config mutation past the idle window raised the generic prompt → ${shotPrompt}`)
    await loginPage!.page.locator('[data-testid="StepUpPrompt.passkey"]').click()
    // …and the ORIGINAL call completes, once, behind it. Note what this also
    // proves about the gate's shape: the first attempt is REFUSED immediately
    // (so its 30-second invoke timer never runs while a human hunts for a
    // fingerprint), and the retry starts a fresh one.
    await expect(mutation).resolves.toBe('ok')
    await waitForTestId(loginPage!.page, 'SessionView', 30_000)
    note('step 7b: the ceremony completed and the original invoke was retried to success')

    // ── 7c: the strong tier's session cut (4010) ───────────────────────────
    // The max-age floor is one HOUR, so the budget is injected through the
    // server's own timeouts seam instead — the same field the tier suites use.
    // Test-only reach into a private field, deliberately and locally: the
    // alternative is an env var that would be a production backdoor.
    const timeouts = (core.remoteServer as unknown as { timeouts: { sessionMaxAgeMs?: number } })
      .timeouts
    timeouts.sessionMaxAgeMs = SHORT_SESSION_MAX_AGE_MS
    // The budget is armed AT ACCEPT, so a fresh handshake is needed for it to
    // apply; a break-glass flip is the cheapest auth-surface change that
    // produces one.
    await setConfig({ passwordBreakGlass: false })
    // Tap in, but do NOT wait for the app surface first: the budget starts at
    // accept, and a cut that lands mid-boot is a legitimate outcome of a
    // deliberately tiny one. What must hold either way is that the client
    // EXPLAINS it.
    await waitForTestId(loginPage!.page, 'PasskeyLogin', 60_000)
    await loginPage!.page.locator('[data-testid="PasskeyLogin.submit"]').click()
    // …and the socket is cut on its own budget, sync stream included.
    await waitForTestId(loginPage!.page, 'SessionExpiredNotice', 120_000)
    const shotExpired = await shot(loginPage!.page, '14-session-expired-notice')
    note(`step 7c: the 4010 cut landed as an EXPLAINED sign-in, not a failure overlay → ${shotExpired}`)
    // A reconnect, never a credential rejection: the recovery is the ordinary
    // one-tap screen with the notice above it.
    await waitForTestId(loginPage!.page, 'PasskeyLogin', 30_000)
    expect(auditRows('auth:session-expired').length).toBeGreaterThan(0)

    // Restore a real budget before signing back in, or the next socket dies too.
    timeouts.sessionMaxAgeMs = undefined
    await setConfig({ passwordBreakGlass: true })
    await signInOnLoginPage('step7c-recovered')

    // ── 7d: tier `off` gates nothing post-login ────────────────────────────
    // The terminal toggle comes ON here and only here: this is the one
    // assertion about a SHELL, and the toggle is a different gate from the tier
    // (capability arming, not a freshness claim).
    await setConfig({ stepUpTier: 'off', allowTerminal: true })
    await signInOnLoginPage('step7d-tier-off')
    const availability = await evalOnPage<Record<string, unknown>>(loginPage!, (api) =>
      api.terminalAvailability()
    )
    // Armed by the tier-`off` capability waiver at accept: the terminal is open
    // for both watching and acting with no ceremony anywhere in this scene.
    expect(availability).toMatchObject({
      allowed: true,
      granted: true,
      needsStepUp: false,
      readsAllowed: true
    })
    expect(await hasTestId(loginPage!.page, 'StepUpOverlay')).toBe(false)
    const shotOff = await shot(loginPage!.page, '15-tier-off-no-prompts')
    note(`step 7d: under tier off the terminal is granted at accept, zero prompts → ${shotOff}`)

    // ── 7e: restore the default posture ────────────────────────────────────
    await setConfig({
      stepUpTier: 'medium',
      stepUpMutationIdleMinutes: 60,
      sessionMaxAgeHours: 4,
      allowTerminal: false
    })
    const restored = await getConfig()
    expect(restored.stepUpTier).toBe('medium')
    expect(restored.effectiveStepUpTier).toBe('medium')
    note('step 7e: tier restored to medium, terminal toggle back off')
  }, 600_000)

  it('8. leaves the machine as it was found', async () => {
    // The teardown proper runs in afterAll (it must run even when a step above
    // throws); this asserts the parts that are observable while the instance is
    // still up — i.e. that nothing outside the pinned port was ever touched.
    const occupied = (await tailscale.getServeStatus()).occupied
    for (const foreign of foreignServeEntries) {
      const still = occupied.find((o) => o.httpsPort === foreign.httpsPort)
      expect(still?.target, `foreign serve entry on ${foreign.httpsPort} must be untouched`).toBe(
        foreign.target
      )
    }
    const mine = occupied.find((o) => o.httpsPort === HTTPS_PORT)
    expect(mine?.target).toBe(`http://127.0.0.1:${localPort}`)
    note(
      `step 8: serve table before teardown → ${occupied.map((o) => `${o.httpsPort}→${o.target}`).join(', ')}`
    )
  }, 60_000)
})
