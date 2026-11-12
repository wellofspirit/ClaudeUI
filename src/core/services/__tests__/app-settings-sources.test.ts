/**
 * @vitest-environment node
 *
 * A settings change reaches core from three sources: a client's save, the
 * `settings.json` watcher (another instance sharing the profile, or a hand edit)
 * and the boot read. Core must end up in the same state whichever one it was.
 *
 * This drives the REAL `ui-config.ts` watcher against real files (`os.homedir()`
 * redirected into a temp tree, as `ui-config-shared-automode.test.ts` does) and
 * the real sync funnel. `fs.watchFile` is the one stub: it polls on libuv's own
 * clock, so the spec captures the listener and fires it by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const homedirHolder = vi.hoisted(() => ({ current: '' }))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => homedirHolder.current,
    default: { ...actual, homedir: () => homedirHolder.current }
  }
})

/** The listeners `startConfigWatcher` registered, by watched file path. */
const watchListeners = vi.hoisted(() => new Map<string, () => void>())
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  const watchFile = (file: unknown, _options: unknown, listener: () => void): void => {
    watchListeners.set(String(file), listener)
  }
  const unwatchFile = (file: unknown): void => {
    watchListeners.delete(String(file))
  }
  return { ...actual, watchFile, unwatchFile, default: { ...actual, watchFile, unwatchFile } }
})

vi.mock('../db', () => ({
  allSessionMeta: () => [],
  setSessionMeta: vi.fn(),
  deleteSessionMeta: vi.fn(),
  importSessionEnginesOnce: vi.fn()
}))
/** The core sinks `applySettings` drives; spies survive `vi.resetModules()`. */
const sinks = vi.hoisted(() => ({
  setIntervalSecs: vi.fn(),
  setDebounceSecs: vi.fn(),
  setSessionTimeout: vi.fn()
}))
vi.mock('../usage-fetcher', () => ({ usageFetcher: { setIntervalSecs: sinks.setIntervalSecs } }))
vi.mock('../block-usage', () => ({
  blockUsageService: { setDebounceSecs: sinks.setDebounceSecs }
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), applyFilter: vi.fn() }
}))

let home: string
let settingsFile: string

/** Boot as `registerSessionIpc` does: start the watcher, seed canonical from disk, apply once. */
async function boot(): Promise<{
  mockup: typeof import('../mockup-settings')
  logger: { applyFilter: ReturnType<typeof vi.fn> }
}> {
  const uiConfig = await import('../ui-config')
  const { syncCore } = await import('../sync-host')
  const mockup = await import('../mockup-settings')
  const { startApplyingSettings } = await import('../app-settings-apply')
  const { logger } = await import('../logger')
  uiConfig.startConfigWatcher()
  syncCore.setAppState({ settings: uiConfig.loadSettings() as Record<string, unknown> })
  startApplyingSettings({ setSessionTimeout: sinks.setSessionTimeout })
  return { mockup, logger: logger as unknown as { applyFilter: ReturnType<typeof vi.fn> } }
}

/** Another instance (or a hand edit) rewrites settings.json; the watcher's poll notices. */
function writeFromOutside(settings: Record<string, unknown>): void {
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
  const listener = watchListeners.get(settingsFile)
  if (!listener) throw new Error('startConfigWatcher did not watch settings.json')
  listener()
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'app-settings-sources-'))
  homedirHolder.current = home
  mkdirSync(join(home, '.claude', 'ui'), { recursive: true })
  settingsFile = join(home, '.claude', 'ui', 'settings.json')
  watchListeners.clear()
  vi.clearAllMocks()
  vi.resetModules()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('a settings change that arrives through the file watcher', () => {
  it('tightens the mockup CSP when another instance turns plaintext http off', async () => {
    writeFileSync(settingsFile, JSON.stringify({ mockupAllowHttp: true }))
    const { mockup } = await boot()
    expect(mockup.getMockupSecuritySettings().allowHttp).toBe(true)

    writeFromOutside({ mockupAllowHttp: false })

    expect(mockup.getMockupSecuritySettings().allowHttp).toBe(false)
  })

  it('drops an origin another instance removed from the mockup connect allowlist', async () => {
    writeFileSync(settingsFile, JSON.stringify({ mockupConnectAllowlist: 'api.example.com' }))
    const { mockup } = await boot()
    expect(mockup.getMockupSecuritySettings().connectAllowlist).toEqual(['api.example.com'])

    writeFromOutside({ mockupConnectAllowlist: '' })

    expect(mockup.getMockupSecuritySettings().connectAllowlist).toEqual([])
  })
})

describe('every core sink follows the settings, from whichever source', () => {
  it('a watcher change reaches the intervals, the log filter, the session timeout and the mockup CSP', async () => {
    writeFileSync(settingsFile, JSON.stringify({}))
    const { mockup, logger } = await boot()
    expect(mockup.getMockupSecuritySettings().allowHttp).toBe(false)

    // The same values and expectations as the IPC arm in remote-handlers.ipc.test.ts, on purpose.
    writeFromOutside({
      usageRefreshSecs: 77,
      analyticsRefreshSecs: 88,
      logLevel: 'debug',
      logFilter: 'Proxy',
      sessionTimeoutMins: 5,
      mockupAllowHttp: true
    })

    expect(sinks.setIntervalSecs).toHaveBeenLastCalledWith(77)
    expect(sinks.setDebounceSecs).toHaveBeenLastCalledWith(88)
    expect(logger.applyFilter).toHaveBeenLastCalledWith('Proxy', 'debug')
    expect(sinks.setSessionTimeout).toHaveBeenLastCalledWith(300000)
    expect(mockup.getMockupSecuritySettings().allowHttp).toBe(true)
  })

  it('boot with no settings.json gives every sink the shared default (the usage poll is 120 s)', async () => {
    const { DEFAULT_SETTINGS } = await import('../../../shared/app-settings')
    const { logger } = await boot()

    expect(sinks.setIntervalSecs).toHaveBeenLastCalledWith(DEFAULT_SETTINGS.usageRefreshSecs)
    expect(sinks.setIntervalSecs).toHaveBeenLastCalledWith(120)
    expect(sinks.setDebounceSecs).toHaveBeenLastCalledWith(DEFAULT_SETTINGS.analyticsRefreshSecs)
    expect(logger.applyFilter).toHaveBeenLastCalledWith(
      DEFAULT_SETTINGS.logFilter,
      DEFAULT_SETTINGS.logLevel
    )
    expect(sinks.setSessionTimeout).toHaveBeenLastCalledWith(
      DEFAULT_SETTINGS.sessionTimeoutMins * 60 * 1000
    )
  })

  it('a hand edit with the wrong types applies the defaults', async () => {
    writeFileSync(settingsFile, JSON.stringify({ usageRefreshSecs: 300, mockupAllowHttp: true }))
    const { mockup } = await boot()
    expect(sinks.setIntervalSecs).toHaveBeenLastCalledWith(300)
    expect(mockup.getMockupSecuritySettings().allowHttp).toBe(true)

    writeFromOutside({ usageRefreshSecs: 'fast', mockupAllowHttp: 'yes' })

    expect(sinks.setIntervalSecs).toHaveBeenLastCalledWith(120)
    expect(mockup.getMockupSecuritySettings().allowHttp).toBe(false)
  })

  it('a key this build does not know stays in canonical state and does not break applying', async () => {
    writeFileSync(settingsFile, JSON.stringify({}))
    await boot()
    const { syncCore } = await import('../sync-host')

    writeFromOutside({ fromANewerBuild: { nested: true }, usageRefreshSecs: 90 })

    expect(syncCore.getCanonicalState().settings.fromANewerBuild).toEqual({ nested: true })
    expect(sinks.setIntervalSecs).toHaveBeenLastCalledWith(90)
  })
})
