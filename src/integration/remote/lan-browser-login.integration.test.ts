/**
 * E2E (gated): the LAN link, opened by a REAL BROWSER at a REAL LAN address.
 *
 * The one thing every other layer of the ADR-056 suite cannot see. `src/e2e/
 * flows/lan-channel-admission.e2e.test.ts` drives the same server over the same
 * handshake and passes — but its client is Node's `ws` plus Node's WebCrypto,
 * and Node has `crypto.subtle` unconditionally. A phone does not: a plain-HTTP
 * LAN origin (`http://192.168.x.x:<port>`) is NOT a secure context, so
 * `window.isSecureContext` is false and `crypto.subtle` is `undefined` there.
 * Everything the LAN channel is built on runs through that object — which is why
 * the channel was unopenable from any browser as first shipped, and why it now
 * falls back to pure-JS AES-GCM (ADR-056 amendment 2026-08-18).
 *
 * So this file is deliberately the most expensive kind of test in the repo — a
 * real listener on a real interface, the real built web bundle, a real Chromium
 * — because it is the only configuration in which that defect exists at all.
 * A same-process test cannot substitute: it would have to SIMULATE the missing
 * `subtle` (the e2e layer does exactly that, and is worth having), whereas here
 * the browser withholds it for real.
 *
 * Gated, like the passkeys walk, on TWO things: this machine has a non-loopback
 * IPv4 address, and the operator asked for it.
 *
 *   CLAUDEUI_LAN_WALK=1 bunx vitest run --project integration \
 *     src/integration/remote/lan-browser-login.integration.test.ts
 *
 * Env knobs: `CLAUDEUI_LAN_WALK_IP` (pin the interface), `CLAUDEUI_LAN_WALK_HEADED=1`.
 *
 * ISOLATION. This instance owns nothing machine-global: `$HOME` is a temp dir
 * (so the DB, the config and the channel key are this run's), the listener takes
 * an ephemeral port, TLS mode is OFF and `tailscale-manager` is stubbed — the
 * walk must never touch the operator's `tailscale serve` table.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Browser, Page } from 'playwright'
import type { TestIpcBridge } from '../../test/bridges/test-ipc-bridge'
import type { CoreBoot } from '../../main/boot-core'
import type { RemoteStatus } from '../../shared/types'

/** The first non-internal IPv4 address of this machine, or '' when off-network. */
function detectLanIp(): string {
  const pinned = process.env.CLAUDEUI_LAN_WALK_IP
  if (pinned) return pinned
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return ''
}

const LAN_IP = detectLanIp()
const SKIP = process.env.CLAUDEUI_LAN_WALK !== '1' || LAN_IP === ''
const PASSWORD = 'lan-browser-walk-9c41f2'
/** A WS handshake, an app chunk and a React mount over a real socket. */
const SURFACE_TIMEOUT_MS = 75_000

// ---------------------------------------------------------------------------
// Hermetic environment — `vi.hoisted` so the redirect precedes the dynamic app
// imports and every module-load-time `os.homedir()`.
// ---------------------------------------------------------------------------

const { tempHome, priorHome } = vi.hoisted(() => {
  const empty = {
    tempHome: '',
    priorHome: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  }
  if (process.env.CLAUDEUI_LAN_WALK !== '1') return empty
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodePath = require('node:path') as typeof import('node:path')
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'claudeui-lan-walk-'))
  const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  return { tempHome: home, priorHome: prior }
})

// `getAppPath()` must be the repo root: `RemoteServer.getWebClientDir()` resolves
// `<appPath>/out/web`, and the REAL built bundle is what is under test here.
vi.mock('electron', async () => {
  const shim = await import('../../test/stubs/electron-shim')
  const nodePath = await import('node:path')
  const repoRoot = nodePath.resolve(__dirname, '..', '..', '..')
  const app = {
    ...shim.app,
    getAppPath: () => repoRoot,
    getPath: (name: string) => nodePath.join(process.env.HOME || repoRoot, `electron-${name}`)
  }
  return { ...shim, app, default: { ...shim.default, app } }
})

// The engine is never spawned — a walk about admission must not need an agent.
vi.mock('../../core/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/sdk')>()
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
    getCliVersion: (): string => '0.0.0-lan-walk'
  }
})

// SAFETY: the operator's `tailscale serve` table is machine-global. This walk
// never needs the proxy (TLS mode is off), so the manager is stubbed outright
// rather than merely left unused — a detect() that found a live tailnet must not
// be able to lead any code path here into claiming a port.
vi.mock('../../core/services/tailscale-manager', () => ({
  TailscaleManager: class {
    async detect(): Promise<{ state: 'missing' }> {
      return { state: 'missing' }
    }
    async getServeStatus(): Promise<{ occupied: [] }> {
      return { occupied: [] }
    }
    async serve(): Promise<never> {
      throw new Error('tailscale serve is not available in the LAN walk')
    }
    async unserve(): Promise<void> {}
  }
}))

// Ships a CloudFlare download path; RemoteServer constructs one unconditionally.
vi.mock('../../core/services/tunnel-manager', () => ({
  TunnelManager: class {
    setStatusHandler(): void {}
    getStatus(): { state: 'stopped'; url: null; error: null } {
      return { state: 'stopped', url: null, error: null }
    }
    async start(): Promise<void> {}
    stop(): void {}
  }
}))

// Leaf services that would spawn subprocesses, poll the network, or download a
// binary. Same list (and same reasons) as the passkeys walk.
vi.mock('../../core/services/usage-fetcher', () => ({
  usageFetcher: {
    setSessionGetter: vi.fn(),
    setIntervalSecs: vi.fn(),
    startPolling: vi.fn(),
    fetch: vi.fn(async () => null),
    updateFromRateLimitEvent: vi.fn()
  }
}))
vi.mock('../../core/services/service-session', () => ({
  serviceSession: {
    getUsage: vi.fn(async () => null),
    getControlHandle: vi.fn(async () => null),
    stop: vi.fn()
  }
}))
vi.mock('../../core/services/block-usage', () => ({
  blockUsageService: {
    setDebounceSecs: vi.fn(),
    startWatching: vi.fn(),
    recalculate: vi.fn(async () => ({ blocks: [] })),
    getData: vi.fn(() => null),
    setAccountFilter: vi.fn()
  }
}))
vi.mock('../../core/auth/vault/CredentialSync', () => ({
  credentialSync: {
    configure: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    getStatus: vi.fn(() => ({ connected: false }))
  }
}))
vi.mock('../../core/shared-providers', () => ({
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
vi.mock('../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    isBinaryAvailable: vi.fn(() => false),
    setCallerSessionLookup: vi.fn(),
    setDispatchAgent: vi.fn(),
    dispose: vi.fn()
  }
}))
vi.mock('../../core/opencode/model-discovery', () => ({
  discoverOpencodeModels: vi.fn(async () => []),
  invalidateOpencodeModelCache: vi.fn(),
  discoverOpencodeProviderCatalog: vi.fn(async () => []),
  getOpencodeProviderModels: vi.fn(async () => []),
  resolveOpencodeSpawnModel: vi.fn(async (m?: string) => m)
}))
vi.mock('../../core/pi/model-discovery', () => ({
  discoverPiModels: vi.fn(async () => []),
  getPiModelCatalogGroups: vi.fn(async () => []),
  invalidatePiModelCache: vi.fn(),
  resolvePiSpawnModel: vi.fn(async (m?: string) => m),
  getPiModelCatalog: vi.fn(async () => []),
  effortLevelsFromModel: vi.fn(() => [])
}))
vi.mock('../../core/pi/pi-locate', () => ({
  piBinaryAvailable: vi.fn(() => false),
  locatePiBinary: vi.fn(() => null)
}))
vi.mock('../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: {
    dispatch: vi.fn(),
    resolveApproval: vi.fn(() => false),
    disposeFor: vi.fn(),
    stopDispatch: vi.fn(() => false)
  },
  crossEngineDispatchAvailable: (): boolean => false,
  XENG_REQUEST_PREFIX: 'xeng:'
}))
vi.mock('../../core/services/voice-capture', () => ({
  startRecording: vi.fn(() => false),
  stopRecording: vi.fn()
}))
vi.mock('../../core/services/voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../core/services/subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../../core/services/usage-provider', () => ({ resolveUsageProvider: vi.fn() }))

// ---------------------------------------------------------------------------

let core: CoreBoot
let bridge: TestIpcBridge
let browser: Browser | null = null
let page: Page | null = null
let lanUrl = ''

const evidence: string[] = []
function note(line: string): void {
  evidence.push(line)
  console.log(`    ▸ ${line}`)
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return bridge.ipcRenderer.invoke(channel, ...args) as Promise<T>
}
const status = (): RemoteStatus => core.remoteServer.getStatus()

/** Where the walk's evidence lands (gitignored). */
const SHOT_DIR = path.resolve(process.cwd(), '.cache', 'screenshots')
async function shot(name: string): Promise<void> {
  if (!page) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `lan-walk-${name}.png`)
  await page.screenshot({ path: file })
  note(`screenshot: ${file}`)
}

async function hasTestId(id: string): Promise<boolean> {
  return (await page!.locator(`[data-testid="${id}"]`).count()) > 0
}

/**
 * Wait until ONE of `ids` is in the DOM and report which. Racing them is the
 * point: "did the login succeed or did it show an error" must not be answered by
 * two sequential waits, where the failing branch always costs a full timeout.
 */
async function raceTestIds(ids: string[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const id of ids) if (await hasTestId(id)) return id
    if (Date.now() > deadline) {
      throw new Error(`none of [${ids.join(', ')}] appeared within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

describe.skipIf(SKIP)('E2E (gated): LAN link password sign-in from a real browser', () => {
  beforeAll(async () => {
    expect(tempHome, 'the hermetic HOME redirect must be active').toContain('claudeui-lan-walk-')
    const webIndex = path.resolve(__dirname, '..', '..', '..', 'out', 'web', 'index.html')
    expect(
      fs.existsSync(webIndex),
      `built web client missing at ${webIndex} — run bun run build:web`
    ).toBe(true)

    const { TestIpcBridge: Bridge } = await import('../../test/bridges/test-ipc-bridge')
    const { setIpcBridge } = await import('../../test/stubs/electron-shim')
    bridge = new Bridge()
    setIpcBridge(bridge)

    const db = await import('../../core/services/db')
    // Ephemeral port, ALL interfaces (so the run is reachable at LAN_IP), TLS off.
    db.setRemoteConfig({
      port: 0,
      bindHost: null,
      autostart: false,
      tlsMode: 0,
      authPolicy: null,
      passwordBreakGlass: true
    })

    const { bootCore } = await import('../../main/boot-core')
    core = bootCore({ remoteAccessDisabled: false })

    await invoke('remote:set-password', PASSWORD)
    await invoke('remote:start')

    const s = status()
    expect(s.running).toBe(true)
    expect(s.tls, 'TLS mode must be OFF for this walk').toBeNull()
    expect(s.lanUrl, 'a non-loopback bind must mint a LAN channel key').toContain('#k=')
    // The link the card hands out names the auto-detected interface; the walk
    // pins its own so the origin is unambiguous evidence.
    lanUrl = s.lanUrl!.replace(/^http:\/\/[^:]+:/, `http://${LAN_IP}:`)
    note(`LAN link under test: ${lanUrl.replace(/#k=.*/, '#k=<redacted>')}`)

    const playwright = await import('playwright')
    browser = await playwright.chromium.launch({
      headless: process.env.CLAUDEUI_LAN_WALK_HEADED !== '1'
    })
    const context = await browser.newContext()
    page = await context.newPage()
    page.on('console', (m) => {
      if (m.type() === 'error') note(`page console.error: ${m.text()}`)
    })
    page.on('pageerror', (e) => note(`pageerror: ${e.message}`))
  }, 300_000)

  afterAll(async () => {
    await browser?.close().catch(() => {})
    await core?.remoteServer.stop().catch(() => {})

    if (priorHome.HOME === undefined) delete process.env.HOME
    else process.env.HOME = priorHome.HOME
    if (priorHome.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = priorHome.USERPROFILE
    if (evidence.length) console.log(`\n  LAN walk evidence:\n    ${evidence.join('\n    ')}\n`)
  }, 60_000)

  it('the LAN origin is NOT a secure context — the condition the defect lives in', async () => {
    await page!.goto(lanUrl, { waitUntil: 'domcontentloaded' })
    const ctx = await page!.evaluate(() => ({
      origin: location.origin,
      isSecureContext: window.isSecureContext,
      subtle: typeof (globalThis.crypto as Crypto | undefined)?.subtle,
      getRandomValues: typeof globalThis.crypto?.getRandomValues
    }))
    note(`browser context at the LAN origin: ${JSON.stringify(ctx)}`)
    expect(ctx.origin).toBe(`http://${LAN_IP}:${status().port}`)
    // Not an assumption — the fact the whole fix is built around.
    expect(ctx.isSecureContext).toBe(false)
    expect(ctx.subtle).toBe('undefined')
    // …while the CSPRNG is available in every context, which is why nonces are
    // not the problem.
    expect(ctx.getRandomValues).toBe('function')
  })

  /**
   * THE case the whole round exists for, in the only configuration that can
   * show it: a real browser, at a real LAN address, over plain HTTP.
   *
   * RED-BEFORE (the unfixed bundle, captured on this same walk): the password
   * form appeared, took the password, spent ~1 s on scrypt and answered
   * *"This link is not valid — get a new one from the host."* — the message that
   * sent the owner off rotating a perfectly good key. Green only once the
   * pure-JS AES-GCM fallback landed (ADR-056 amendment 2026-08-18); note that
   * the SERVER end of this socket is Node and therefore on Web Crypto, so a pass
   * here is a mixed-implementation channel, not two copies of noble agreeing.
   */
  it('password sign-in over the LAN link reaches the app', async () => {
    await page!.goto(lanUrl, { waitUntil: 'domcontentloaded' })

    // ADR-027: assert the structure first.
    await page!.waitForSelector('[data-testid="PasswordLogin"]', { timeout: 30_000 })
    await shot('01-password-form')

    await page!.locator('[data-testid="PasswordLogin.input"]').fill(PASSWORD)
    await page!.locator('[data-testid="PasswordLogin.submit"]').click()

    const landed = await raceTestIds(
      ['SessionView', 'PasswordLogin.error', 'ConnectionOverlay.retry', 'MissingCredential'],
      SURFACE_TIMEOUT_MS
    )
    if (landed !== 'SessionView') {
      const message = await page!
        .locator('[data-testid="PasswordLogin.error"]')
        .first()
        .textContent()
        .catch(() => null)
      note(`sign-in did NOT reach the app — landed on ${landed}, message: ${String(message)}`)
      await shot('02-failure')
    } else {
      note('signed in over the pure-JS channel at an insecure origin')
      await shot('02-signed-in')
    }
    expect(landed, 'the LAN link + password must sign in from a real browser').toBe('SessionView')
    expect(status().connectedClients).toBeGreaterThan(0)
  }, 120_000)

  it('rotating the LAN key over the DESKTOP transport answers with the new link', async () => {
    // The verb the Access Links card's `Rotate…` button calls, reached through
    // the real registry with the real host-anchor connection — i.e. the exact
    // path `window.api.authcfgRotateLanKey()` takes on the desktop.
    const before = status().lanUrl
    let result: unknown
    let failure: string | null = null
    try {
      result = await invoke('authcfg:rotate-lan-key')
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    }
    // The response carries a LIVE channel key; the log gets its shape, not its
    // value (the same rule the Access Links row masks by).
    note(
      `authcfg:rotate-lan-key → ${
        failure ? `THREW ${failure}` : JSON.stringify(result).replace(/#k=[0-9a-f]+/, '#k=<new>')
      }`
    )
    expect(failure).toBeNull()
    expect((result as { url?: string })?.url).toContain('#k=')
    expect(status().lanUrl).not.toBe(before)
  }, 30_000)
})
