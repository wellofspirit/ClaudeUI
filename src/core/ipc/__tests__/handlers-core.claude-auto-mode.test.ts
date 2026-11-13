/**
 * @vitest-environment node
 *
 * `setClaudeAutoModeDisabled`: the handler behind `claude:set-disable-auto-mode`. It validates the
 * argument, writes through the strict writer, then announces what the FILE says.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { saveClaudeDisableAutoMode, loadClaudePermissions, emitEvent } = vi.hoisted(() => ({
  saveClaudeDisableAutoMode: vi.fn(),
  loadClaudePermissions: vi.fn(),
  emitEvent: vi.fn()
}))

vi.mock('../../services/claude-settings', () => ({
  saveClaudeDisableAutoMode,
  loadClaudePermissions,
  saveCleanupPeriodDays: vi.fn(),
  saveClaudePermissions: vi.fn()
}))
vi.mock('../../services/sync-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sync-host')>()),
  emitEvent
}))
vi.mock('../../services/ui-config', () => ({
  saveSessionConfig: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../../services/sync-seed', () => ({ refreshCanonicalDirectories: vi.fn() }))
vi.mock('../../automode/judge-route', () => ({
  describeJudgeModels: vi.fn(),
  resolveJudgeRoute: vi.fn()
}))

import { setClaudeAutoModeDisabled } from '../handlers-core'

const notify = vi.fn(async () => {})
const notifyOther = vi.fn(async () => {})
/** One running session per engine: only Claude's is told to re-read its settings. */
const manager = (): any => ({
  forEach: (fn: (s: unknown) => void) => {
    fn({ engineId: 'claude', notifySettingsChanged: notify })
    fn({ engineId: 'opencode', notifySettingsChanged: notifyOther })
    fn({ engineId: 'pi', notifySettingsChanged: notifyOther })
  }
})

describe('setClaudeAutoModeDisabled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes, then emits the value the file now holds, and nudges running Claude sessions only', () => {
    // The file says "disable" even though the argument is false: the event follows the file.
    loadClaudePermissions.mockReturnValue({ disableAutoMode: 'disable' })
    setClaudeAutoModeDisabled(manager(), false)
    expect(saveClaudeDisableAutoMode).toHaveBeenCalledWith(false)
    expect(loadClaudePermissions).toHaveBeenCalledWith('user')
    expect(emitEvent).toHaveBeenCalledWith('config:claude-auto-mode-changed', [true])
    expect(notify).toHaveBeenCalledTimes(1)
    // Not their setting: an opencode or pi session is left alone.
    expect(notifyOther).not.toHaveBeenCalled()
  })

  it('emits false when the file no longer carries the flag', () => {
    loadClaudePermissions.mockReturnValue({})
    setClaudeAutoModeDisabled(manager(), false)
    expect(emitEvent).toHaveBeenCalledWith('config:claude-auto-mode-changed', [false])
  })

  it.each(['true', 1, null, undefined, {}])('refuses %j and writes nothing', (bad) => {
    expect(() => setClaudeAutoModeDisabled(manager(), bad)).toThrow(/boolean/)
    expect(saveClaudeDisableAutoMode).not.toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('a writer refusal propagates and emits nothing', () => {
    saveClaudeDisableAutoMode.mockImplementationOnce(() => {
      throw new Error('settings.json is not valid JSON')
    })
    expect(() => setClaudeAutoModeDisabled(manager(), true)).toThrow(/not valid JSON/)
    expect(emitEvent).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})
