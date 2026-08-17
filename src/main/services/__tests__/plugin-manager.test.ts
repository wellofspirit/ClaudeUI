/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for PluginManager.
 *
 * Strategy:
 *  - Mock `electron` with the standard shim.
 *  - Mock `../../sdk` and `./claude-session` so we don't
 *    pull the 11MB bundled CLI into the worker.
 *  - Override `os.homedir()` to point at a tmp dir so `PLUGINS_DIR` resolves
 *    to a scratch location we own. The override MUST happen before the module
 *    under test is imported (top-level vi.mock is hoisted).
 *  - Write real plugin directories with `package.json` + `dist/index.js` files
 *    and let PluginManager `require()` them for real — this is what exercises
 *    the loader path, not a stub.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { emitEvent, clearSyncSubscribersForTests, syncCore } from '../../../core/services/sync-host'
import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Mocks (must be registered before importing plugin-manager).
// ---------------------------------------------------------------------------

// Shared tmpdir across the suite — allocated in a hoisted block so it exists
// before `plugin-manager.ts` is imported (PLUGINS_DIR is a module-level const).
const hoisted = vi.hoisted(() => {
  const realFs = require('fs') as typeof import('fs')

  const realOs = require('os') as typeof import('os')

  const realPath = require('path') as typeof import('path')
  const home = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'claudeui-plugin-test-'))
  return { TEST_HOME: home }
})
const TEST_HOME = hoisted.TEST_HOME
const PLUGINS_DIR = path.join(TEST_HOME, '.claude', 'ui', 'plugins')

// Override os.homedir() so PLUGINS_DIR resolves inside our scratch area.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: { ...actual, homedir: () => hoisted.TEST_HOME },
    homedir: () => hoisted.TEST_HOME
  }
})

// Electron is loaded via the shared test shim (uses BrowserWindow/ipcMain stubs).
vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

// Don't pull the real SDK bundle — we only need the named export to exist.
vi.mock('../../../core/sdk', () => ({
  query: vi.fn()
}))

// claude-session imports the SDK and Electron app internals. A bare stub is
// enough since SyncCore phase 4c: the plugin bridge registers itself with the
// FUNNEL (`addSyncSubscriber`), not as a static "extra window" on ClaudeSession,
// so there are no statics left to fake.
vi.mock('../../../core/services/claude-session', () => ({ ClaudeSession: {} }))

// Silence logger chatter and capture warn/error calls for assertions.
// The factory runs at hoisted-time before any top-level bindings exist, so we
// instantiate the spies inside the factory and re-export them for use below.
vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// ---------------------------------------------------------------------------
// Imports AFTER mocks so the plugin-manager picks up the mocked dependencies.
// ---------------------------------------------------------------------------

import { PluginManager } from '../plugin-manager'
import { TestIpcBridge } from '../../../test/bridges/test-ipc-bridge'
import { setIpcBridge } from '../../../test/stubs/electron-shim'
import { RemoteDispatcher } from '../../../core/services/remote-dispatcher'
import { logger as loggerMod } from '../../../core/services/logger'

// Typed handles on the mocked logger spies (for assertions).
const loggerSpies = loggerMod as unknown as {
  debug: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

// ---------------------------------------------------------------------------
// Helpers — write fixture plugins to the scratch plugins dir.
// ---------------------------------------------------------------------------

interface FixtureOpts {
  /** Plugin directory name (also the id). */
  id: string
  /** Override package.json contents. */
  pkg?: Record<string, unknown> | string
  /** Literal JS source for dist/index.js. Must export { activate, deactivate? } */
  entryJs?: string
  /** Skip creating the dist/index.js file entirely. */
  omitEntry?: boolean
}

function writePlugin(opts: FixtureOpts): string {
  const dir = path.join(PLUGINS_DIR, opts.id)
  fs.mkdirSync(dir, { recursive: true })

  const pkg = opts.pkg ?? {
    name: opts.id,
    version: '1.0.0',
    claudeui: { plugin: true, entryPoint: 'dist/index.js' }
  }
  const pkgText = typeof pkg === 'string' ? pkg : JSON.stringify(pkg, null, 2)
  fs.writeFileSync(path.join(dir, 'package.json'), pkgText)

  if (!opts.omitEntry) {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    const js = opts.entryJs ?? 'module.exports = { activate: () => {}, deactivate: () => {} }'
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), js)
  }

  return dir
}

/** Wipe PLUGINS_DIR between tests so each test starts clean. */
function clearPluginsDir(): void {
  if (fs.existsSync(PLUGINS_DIR)) {
    fs.rmSync(PLUGINS_DIR, { recursive: true, force: true })
  }
  // Bust Node's require.cache for anything under PLUGINS_DIR. Without this,
  // reusing a plugin id across tests returns the stale cached module instead
  // of the freshly-written dist/index.js.
  const normalized = PLUGINS_DIR.replace(/\\/g, '/')
  for (const key of Object.keys(require.cache)) {
    if (key.replace(/\\/g, '/').startsWith(normalized)) {
      delete require.cache[key]
    }
  }
}

// ---------------------------------------------------------------------------
// Scaffolding — construct a PluginManager with stub dependencies.
// ---------------------------------------------------------------------------

interface Scaffold {
  manager: PluginManager
  bridge: TestIpcBridge
  win: any
  sessionManager: { getSessionId: ReturnType<typeof vi.fn> } & Record<string, unknown>
  automationManager: Record<string, unknown>
  remoteDispatcher: RemoteDispatcher
}

function scaffold(opts?: { sessionIdFor?: (routingId: string) => string | null }): Scaffold {
  const bridge = new TestIpcBridge()
  setIpcBridge(bridge)
  const win = bridge.createBrowserWindow()

  const sessionManager = {
    getSessionId: vi.fn((routingId: string) =>
      opts?.sessionIdFor ? opts.sessionIdFor(routingId) : null
    )
  }
  const automationManager = {}
  const remoteDispatcher = new RemoteDispatcher()

  const manager = new PluginManager({
    win,
    sessionManager: sessionManager as any,
    automationManager: automationManager as any,
    remoteDispatcher
  })

  return {
    manager,
    bridge,
    win,
    sessionManager: sessionManager as any,
    automationManager,
    remoteDispatcher
  }
}

/**
 * Fire a session event the way `BaseSession.send()` does — through the funnel.
 *
 * 4c: no reaching into a private bridge object any more. The manager is a plain
 * subscriber, so driving `emitEvent` exercises the real chain (ring → canonical →
 * every subscriber → `fireEvent`) instead of poking a fake window's shim. The
 * `manager` argument is kept so every call site reads unchanged.
 */
function fireSessionEventViaBridge(
  _manager: PluginManager,
  channel: string,
  routingId: string,
  data: unknown
): void {
  // Canonical must KNOW the session, on BOTH lanes: since phase 5 S1 a stream
  // delta is placed by OFFSET, and there is no length to measure against a
  // session that does not exist — so core drops it rather than delivering an
  // unplaceable frame. Production gets the entry from the `session:created` that
  // `prepareAndCreateSession` emits at spawn; this seed is that, minus the spawn.
  if (!syncCore.getCanonicalState().sessions[routingId]) syncCore.seedSession(routingId, {})
  emitEvent(channel, [routingId, data])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PluginManager', () => {
  let s: Scaffold

  beforeEach(() => {
    clearPluginsDir()
    Object.values(loggerSpies).forEach((fn) => fn.mockClear())
    s = scaffold()
  })

  afterEach(() => {
    s.manager.stopAll()
    // The manager subscribed to the funnel on construction; a leaked subscription
    // would fan the next test's events into a shut-down manager.
    clearSyncSubscribersForTests()
    clearPluginsDir()
  })

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  describe('loadAll()', () => {
    it('returns without throwing when plugins directory does not exist', async () => {
      // PLUGINS_DIR was cleared in beforeEach
      expect(fs.existsSync(PLUGINS_DIR)).toBe(false)
      await expect(s.manager.loadAll()).resolves.toBeUndefined()
      expect(s.manager.listPlugins()).toEqual([])
    })

    it('loads a plugin with a valid package.json and entry point', async () => {
      writePlugin({
        id: 'valid-plugin',
        pkg: {
          name: 'valid-plugin',
          version: '2.3.4',
          claudeui: { plugin: true, displayName: 'Valid', entryPoint: 'dist/index.js' }
        },
        entryJs: 'module.exports = { activate: (ctx) => { ctx.logger.info("activated") } }'
      })

      await s.manager.loadAll()

      const plugins = s.manager.listPlugins()
      expect(plugins).toHaveLength(1)
      expect(plugins[0]).toMatchObject({
        id: 'valid-plugin',
        name: 'Valid',
        version: '2.3.4',
        enabled: true
      })
      expect(plugins[0].error).toBeUndefined()
    })

    it('continues loading remaining plugins when one has a malformed package.json', async () => {
      // Bad: not valid JSON
      writePlugin({ id: 'broken', pkg: '{ this is not json' })
      // Good
      writePlugin({ id: 'ok' })

      await s.manager.loadAll()

      const plugins = s.manager.listPlugins()
      // The broken one never gets added (JSON.parse throws before set); the
      // good one must still be present.
      const ids = plugins.map((p) => p.id)
      expect(ids).toContain('ok')
      expect(ids).not.toContain('broken')
      expect(loggerSpies.error).toHaveBeenCalled()
    })

    it('skips directories missing the claudeui.plugin flag', async () => {
      // No claudeui block at all
      writePlugin({
        id: 'not-a-plugin',
        pkg: { name: 'not-a-plugin', version: '1.0.0' }
      })
      // Has claudeui but plugin=false
      writePlugin({
        id: 'disabled-flag',
        pkg: { name: 'disabled-flag', version: '1.0.0', claudeui: { plugin: false } }
      })
      // Genuine plugin
      writePlugin({ id: 'real' })

      await s.manager.loadAll()

      const ids = s.manager.listPlugins().map((p) => p.id)
      expect(ids).toEqual(['real'])
    })

    it('records an error and leaves plugin disabled when entry point is missing', async () => {
      writePlugin({
        id: 'no-entry',
        pkg: {
          name: 'no-entry',
          version: '1.0.0',
          claudeui: { plugin: true, entryPoint: 'dist/does-not-exist.js' }
        },
        omitEntry: true
      })

      await s.manager.loadAll()

      const plugins = s.manager.listPlugins()
      expect(plugins).toHaveLength(1)
      expect(plugins[0].enabled).toBe(false)
      expect(plugins[0].error).toMatch(/entry point not found/i)
    })

    it('records an error when entry module has no activate() function', async () => {
      writePlugin({
        id: 'no-activate',
        entryJs: 'module.exports = { notActivate: true }'
      })

      await s.manager.loadAll()
      const plugins = s.manager.listPlugins()
      expect(plugins[0].enabled).toBe(false)
      expect(plugins[0].error).toMatch(/activate\(\) function/)
    })

    it('emits plugin:all-loaded after scanning', async () => {
      writePlugin({ id: 'all-loaded-peer' })
      writePlugin({
        id: 'all-loaded-listener',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              global.__allLoaded = 0
              ctx.on('plugin:all-loaded', () => { global.__allLoaded++ })
            }
          }
        `
      })

      await s.manager.loadAll()
      expect((global as any).__allLoaded).toBe(1)
      delete (global as any).__allLoaded
    })
  })

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('invokes activate() on load with a PluginContext', async () => {
      writePlugin({
        id: 'track-activate',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              global.__activateCall = { id: ctx.id, hasOn: typeof ctx.on, hasEmit: typeof ctx.emit }
            }
          }
        `
      })

      await s.manager.loadAll()

      const call = (global as any).__activateCall
      expect(call).toBeDefined()
      expect(call.id).toBe('track-activate')
      expect(call.hasOn).toBe('function')
      expect(call.hasEmit).toBe('function')
      delete (global as any).__activateCall
    })

    it('invokes deactivate() during stopAll()', async () => {
      writePlugin({
        id: 'track-deactivate',
        entryJs: `
          module.exports = {
            activate: () => {},
            deactivate: () => { global.__deactivateCalls = (global.__deactivateCalls || 0) + 1 }
          }
        `
      })

      await s.manager.loadAll()
      expect((global as any).__deactivateCalls).toBeUndefined()

      s.manager.stopAll()
      expect((global as any).__deactivateCalls).toBe(1)
      delete (global as any).__deactivateCalls
    })

    it("one plugin's activate() throwing does not prevent others from activating", async () => {
      writePlugin({
        id: 'a-boom',
        entryJs: 'module.exports = { activate: () => { throw new Error("boom") } }'
      })
      writePlugin({
        id: 'b-ok',
        entryJs: 'module.exports = { activate: () => { global.__bActivated = true } }'
      })

      await s.manager.loadAll()

      // Plugin "a-boom" is present but disabled with an error recorded.
      const plugins = s.manager.listPlugins()
      const a = plugins.find((p) => p.id === 'a-boom')!
      const b = plugins.find((p) => p.id === 'b-ok')!
      expect(a.enabled).toBe(false)
      expect(a.error).toMatch(/boom/)
      expect(b.enabled).toBe(true)
      expect((global as any).__bActivated).toBe(true)
      delete (global as any).__bActivated
    })

    it('reloadPlugin() deactivates, re-requires, and re-activates', async () => {
      writePlugin({
        id: 'reloadable',
        entryJs: `
          module.exports = {
            activate: () => { global.__activations = (global.__activations || 0) + 1 },
            deactivate: () => { global.__deactivations = (global.__deactivations || 0) + 1 }
          }
        `
      })

      await s.manager.loadAll()
      expect((global as any).__activations).toBe(1)

      await s.manager.reloadPlugin('reloadable')
      expect((global as any).__deactivations).toBe(1)
      expect((global as any).__activations).toBe(2)

      delete (global as any).__activations
      delete (global as any).__deactivations
    })
  })

  // -------------------------------------------------------------------------
  // Session API (ADR-005) — object-shaped events with routingId + sessionId
  // -------------------------------------------------------------------------

  describe('session event forwarding', () => {
    it('forwards session:* events as objects containing routingId + sessionId', async () => {
      s = scaffold({ sessionIdFor: (rid) => (rid === 'R-1' ? 'SID-1' : null) })

      writePlugin({
        id: 'listener',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              global.__sessionEvents = []
              ctx.on('session:message', (evt) => { global.__sessionEvents.push(evt) })
            }
          }
        `
      })
      await s.manager.loadAll()

      fireSessionEventViaBridge(s.manager, 'session:message', 'R-1', { message: { id: 'm1' } })

      const events = (global as any).__sessionEvents as any[]
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        routingId: 'R-1',
        sessionId: 'SID-1',
        message: { id: 'm1' }
      })
      delete (global as any).__sessionEvents
    })

    it('forwards VOLATILE-lane deltas with the pre-phase-5 payload shape (parity guard)', async () => {
      // `session:stream` / `session:subagent-stream` stopped being events in
      // phase 5 S1. A plugin's contract predates that split and must not change
      // because of it, so the bridge observes the stream lane in-process and
      // re-materializes the emission through the SHARED inverse. This test is the
      // guard: it fails if the observer, the gate or the inverse regresses.
      s = scaffold({ sessionIdFor: (rid) => (rid === 'R-1' ? 'SID-1' : null) })

      writePlugin({
        id: 'delta-listener',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              global.__deltas = []
              ctx.on('session:stream', (evt) => { global.__deltas.push(['parent', evt]) })
              ctx.on('session:subagent-stream', (evt) => { global.__deltas.push(['sub', evt]) })
            }
          }
        `
      })
      await s.manager.loadAll()

      fireSessionEventViaBridge(s.manager, 'session:stream', 'R-1', {
        type: 'thinking',
        text: 'weighing'
      })
      fireSessionEventViaBridge(s.manager, 'session:subagent-stream', 'R-1', {
        toolUseId: 'tu-1',
        type: 'text',
        text: 'sub output'
      })

      const deltas = (global as any).__deltas as any[]
      expect(deltas).toHaveLength(2)
      expect(deltas[0]).toEqual([
        'parent',
        { routingId: 'R-1', sessionId: 'SID-1', type: 'thinking', text: 'weighing' }
      ])
      expect(deltas[1]).toEqual([
        'sub',
        {
          routingId: 'R-1',
          sessionId: 'SID-1',
          type: 'text',
          toolUseId: 'tu-1',
          text: 'sub output'
        }
      ])
      delete (global as any).__deltas
    })

    it('forwards the VOLATILE TAILS with their pre-phase-5 payload shape (parity guard)', async () => {
      // The S2 half of the same promise: `session:bash-output`,
      // `session:background-output` and `automation:stream-event` left the event
      // lane too, so a plain sync subscriber no longer sees them. They ride the
      // lane in the PASS-THROUGH flavor — the emission verbatim — so the bridge
      // needs no inverse for them, only the observer. This fails if the observer
      // stops forwarding `stream-ev`, which would silently delete bash output
      // from every plugin that watches a command run.
      s = scaffold({ sessionIdFor: (rid) => (rid === 'R-1' ? 'SID-1' : null) })

      writePlugin({
        id: 'tail-listener',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              global.__tails = []
              ctx.on('session:bash-output', (evt) => { global.__tails.push(['bash', evt]) })
              ctx.on('session:background-output', (evt) => { global.__tails.push(['bg', evt]) })
              ctx.on('automation:stream-event', (evt) => { global.__tails.push(['auto', evt]) })
            }
          }
        `
      })
      await s.manager.loadAll()

      fireSessionEventViaBridge(s.manager, 'session:bash-output', 'R-1', {
        toolUseId: 'tu-1',
        output: 'hello\n',
        totalLines: 1,
        totalBytes: 6
      })
      fireSessionEventViaBridge(s.manager, 'session:background-output', 'R-1', {
        toolUseId: 'tu-1',
        tail: 'bg\n',
        totalSize: 3,
        done: false
      })
      // The automation tail is NOT session-scoped: one arg, no routingId, so the
      // bridge hands it through unwrapped exactly as it always did.
      emitEvent('automation:stream-event', [
        { automationId: 'auto-1', type: 'text', text: 'tok' }
      ])

      const tails = (global as any).__tails as any[]
      expect(tails).toHaveLength(3)
      expect(tails[0]).toEqual([
        'bash',
        {
          routingId: 'R-1',
          sessionId: 'SID-1',
          toolUseId: 'tu-1',
          output: 'hello\n',
          totalLines: 1,
          totalBytes: 6
        }
      ])
      expect(tails[1]).toEqual([
        'bg',
        {
          routingId: 'R-1',
          sessionId: 'SID-1',
          toolUseId: 'tu-1',
          tail: 'bg\n',
          totalSize: 3,
          done: false
        }
      ])
      expect(tails[2]).toEqual([
        'auto',
        { automationId: 'auto-1', type: 'text', text: 'tok' }
      ])
      delete (global as any).__tails
    })

    it('emits sessionId: null when SessionManager has no mapping yet (ADR-005 early events)', async () => {
      s = scaffold({ sessionIdFor: () => null })

      writePlugin({
        id: 'early-listener',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              global.__early = []
              ctx.on('session:stream', (evt) => { global.__early.push(evt) })
            }
          }
        `
      })
      await s.manager.loadAll()

      fireSessionEventViaBridge(s.manager, 'session:stream', 'R-temp', { type: 'text', text: 'hi' })

      const events = (global as any).__early as any[]
      expect(events).toHaveLength(1)
      expect(events[0].routingId).toBe('R-temp')
      expect(events[0].sessionId).toBeNull()
      expect(events[0].text).toBe('hi')
      delete (global as any).__early
    })

    it('does not deliver events to plugins that did not subscribe to that channel', async () => {
      writePlugin({
        id: 'subs-stream-only',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              global.__streamHits = 0
              global.__resultHits = 0
              ctx.on('session:stream', () => { global.__streamHits++ })
            }
          }
        `
      })
      await s.manager.loadAll()

      fireSessionEventViaBridge(s.manager, 'session:result', 'R-1', { cost: 1 })
      fireSessionEventViaBridge(s.manager, 'session:stream', 'R-1', { type: 'text', text: 'x' })

      expect((global as any).__streamHits).toBe(1)
      expect((global as any).__resultHits).toBe(0)
      delete (global as any).__streamHits
      delete (global as any).__resultHits
    })

    it('drops events silently when no listener is registered for the channel', async () => {
      // No plugins at all — event on an unregistered channel must not throw.
      await s.manager.loadAll()
      expect(() => {
        fireSessionEventViaBridge(s.manager, 'session:message', 'R-1', { x: 1 })
      }).not.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Disposal — handlers and subscriptions released on unload
  // -------------------------------------------------------------------------

  describe('disposal', () => {
    it('unregisters IPC handlers when plugin is stopped', async () => {
      writePlugin({
        id: 'ipc-owner',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              ctx.registerIpcHandler('ping', () => 'pong')
            }
          }
        `
      })

      await s.manager.loadAll()
      // The namespaced channel is registered on the bridge's ipcMain.
      await expect(s.bridge.ipcRenderer.invoke('plugin:ipc-owner:ping')).resolves.toBe('pong')

      s.manager.stopAll()

      await expect(s.bridge.ipcRenderer.invoke('plugin:ipc-owner:ping')).rejects.toThrow(
        /No handler registered/
      )
    })

    it('removes remote dispatcher handlers when plugin is stopped', async () => {
      writePlugin({
        id: 'remote-owner',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              ctx.registerRemoteHandler('ping', async () => 'pong')
            }
          }
        `
      })

      await s.manager.loadAll()
      expect(s.remoteDispatcher.has('plugin:remote-owner:ping')).toBe(true)

      s.manager.stopAll()
      expect(s.remoteDispatcher.has('plugin:remote-owner:ping')).toBe(false)
    })

    it('removes event subscriptions on stopAll() — plugin no longer receives events', async () => {
      writePlugin({
        id: 'evt-sub',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              global.__evtHits = 0
              ctx.on('session:message', () => { global.__evtHits++ })
            }
          }
        `
      })
      await s.manager.loadAll()

      fireSessionEventViaBridge(s.manager, 'session:message', 'R-1', { ok: true })
      expect((global as any).__evtHits).toBe(1)

      s.manager.stopAll()
      // After stopAll, the plugin's `on()` disposable should have fired —
      // firing another event must not hit the plugin's handler.
      fireSessionEventViaBridge(s.manager, 'session:message', 'R-1', { ok: true })
      expect((global as any).__evtHits).toBe(1)
      delete (global as any).__evtHits
    })

    it('removes registered views on disposal (getViews() returns empty)', async () => {
      writePlugin({
        id: 'view-owner',
        entryJs: `
          module.exports = {
            activate: (ctx) => {
              ctx.registerView({ label: 'My View', htmlFile: 'index.html' })
            }
          }
        `
      })

      await s.manager.loadAll()
      expect(s.manager.getViews()).toHaveLength(1)
      expect(s.manager.getViews()[0]).toMatchObject({ pluginId: 'view-owner', label: 'My View' })

      s.manager.stopAll()
      expect(s.manager.getViews()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Plugin context surface — sanity check that only documented APIs are exposed
  // -------------------------------------------------------------------------

  describe('plugin context surface', () => {
    it('exposes the documented PluginContext keys to plugins', async () => {
      writePlugin({
        id: 'surface-check',
        entryJs: `
          module.exports = {
            activate: (ctx) => { global.__ctxKeys = Object.keys(ctx).sort() }
          }
        `
      })

      await s.manager.loadAll()

      const keys = (global as any).__ctxKeys as string[]
      // All expected fields must be present...
      const expected = [
        'id',
        'pluginDir',
        'dataDir',
        'configDir',
        'debug',
        'logger',
        'sessions',
        'automations',
        'window',
        'ipcMain',
        'sdkQuery',
        'on',
        'emit',
        'registerIpcHandler',
        'registerRemoteHandler',
        'registerView'
      ].sort()
      for (const k of expected) expect(keys).toContain(k)

      // ...and ipcRenderer is NOT exposed (plugins use ipcMain on main-process side,
      // direct ipcRenderer would be a privilege escalation path).
      expect(keys).not.toContain('ipcRenderer')
      delete (global as any).__ctxKeys
    })
  })
})
