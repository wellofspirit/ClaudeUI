/**
 * @vitest-environment node
 *
 * The shared-sandbox watcher: an outside edit of the user settings file's `sandbox` block reaches
 * canonical state through the real sync funnel. `fs.watchFile` is the one stub (it polls on
 * libuv's clock), so the spec captures the listener and fires it by hand, as
 * `app-settings-sources.test.ts` does for `settings.json`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const FILE = '/home/u/.claude/settings.json'
const { readClaudeSandboxState, listeners } = vi.hoisted(() => ({
  readClaudeSandboxState: vi.fn(),
  listeners: new Map<string, () => void>()
}))

// The one stub: stat polling runs on libuv's clock. The mock has no write function, so a watcher
// that tried to create the file would throw.
vi.mock('node:fs', () => {
  const watchFile = (file: unknown, _options: unknown, listener: () => void): void => {
    listeners.set(String(file), listener)
  }
  const unwatchFile = (file: unknown): void => {
    listeners.delete(String(file))
  }
  return { watchFile, unwatchFile, default: { watchFile, unwatchFile } }
})

vi.mock('../claude-sandbox-settings', () => ({
  claudeUserSettingsPath: () => '/home/u/.claude/settings.json',
  readClaudeSandboxState
}))

import { startClaudeSandboxWatcher } from '../claude-sandbox-watch'
import { emitEvent, syncCore } from '../sync-host'
import { DEFAULT_SANDBOX } from '../../../shared/types/engine-config'

const ON = { settings: { ...DEFAULT_SANDBOX, enabled: true }, supported: true }
const LISTED = {
  settings: { ...DEFAULT_SANDBOX, enabled: true, excludedCommands: ['git'] },
  supported: true
}

let startSeq = 0
const sandboxEvents = (): unknown[] =>
  (syncCore.getAfter(startSeq) ?? [])
    .filter((e) => e.channel === 'config:claude-sandbox-changed')
    .map((e) => e.args[0])

/** Fire the poll callback, as libuv would after a stat change. */
const poll = (): void => {
  const listener = listeners.get(FILE)
  if (!listener) throw new Error('the watcher did not watch the settings file')
  listener()
}

let stop: () => void

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
  syncCore.resetCanonicalForTests()
  syncCore.clearRing()
  startSeq = syncCore.currentSeq()
  stop = startClaudeSandboxWatcher()
})

afterEach(() => {
  stop()
})

describe('startClaudeSandboxWatcher', () => {
  it('an outside edit of the block emits one event with the new state', () => {
    readClaudeSandboxState.mockReturnValue(ON)
    poll()
    expect(sandboxEvents()).toEqual([ON])
    expect(syncCore.getCanonicalState().claudeSandbox).toEqual(ON)
    // The same poll again (mtime touched, block unchanged) says nothing more.
    poll()
    expect(sandboxEvents()).toHaveLength(1)
  })

  it('an edit that leaves the block as canonical has it emits nothing', () => {
    readClaudeSandboxState.mockReturnValue({ settings: DEFAULT_SANDBOX, supported: true })
    poll()
    expect(sandboxEvents()).toEqual([])
  })

  it("ClaudeUI's own save does not produce a second event", () => {
    // The handler's event updates canonical first; the poll that follows reads the same state.
    emitEvent('config:claude-sandbox-changed', [LISTED])
    readClaudeSandboxState.mockReturnValue(JSON.parse(JSON.stringify(LISTED)))
    poll()
    expect(sandboxEvents()).toEqual([LISTED])
  })

  it('a file that cannot be read emits nothing and keeps the last good state', () => {
    readClaudeSandboxState.mockReturnValue(ON)
    poll()
    readClaudeSandboxState.mockReturnValue(null)
    poll()
    expect(sandboxEvents()).toEqual([ON])
    expect(syncCore.getCanonicalState().claudeSandbox).toEqual(ON)
  })

  it('stopping unwatches the file', () => {
    stop()
    expect(listeners.has(FILE)).toBe(false)
  })
})
