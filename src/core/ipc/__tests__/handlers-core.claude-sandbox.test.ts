/**
 * @vitest-environment node
 *
 * `setClaudeSandbox`: the handler behind `claude:set-sandbox`. It vets the argument with the
 * file module's patch parser, saves, then announces what the FILE holds afterwards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { parseSandboxPatch, saveClaudeSandbox, readClaudeSandboxState, emitEvent } = vi.hoisted(
  () => ({
    parseSandboxPatch: vi.fn(),
    saveClaudeSandbox: vi.fn(),
    readClaudeSandboxState: vi.fn(),
    emitEvent: vi.fn()
  })
)

vi.mock('../../services/claude-sandbox-settings', () => ({
  parseSandboxPatch,
  saveClaudeSandbox,
  readClaudeSandboxState
}))
vi.mock('../../services/claude-settings', () => ({
  saveClaudeDisableAutoMode: vi.fn(),
  loadClaudePermissions: vi.fn(),
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

import { setClaudeSandbox } from '../handlers-core'
import { DEFAULT_SANDBOX } from '../../../shared/types/engine-config'

const AFTER = { settings: { ...DEFAULT_SANDBOX, enabled: true }, supported: true }

describe('setClaudeSandbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    parseSandboxPatch.mockImplementation((v: unknown) => v)
  })

  it('parses, saves the patch, then emits the state the file now holds (not the patch)', () => {
    readClaudeSandboxState.mockReturnValue(AFTER)
    setClaudeSandbox({ excludedCommands: ['git'] })
    expect(parseSandboxPatch).toHaveBeenCalledWith({ excludedCommands: ['git'] })
    expect(saveClaudeSandbox).toHaveBeenCalledWith({ excludedCommands: ['git'] })
    expect(emitEvent).toHaveBeenCalledTimes(1)
    expect(emitEvent).toHaveBeenCalledWith('config:claude-sandbox-changed', [AFTER])
  })

  it('a malformed argument rejects before anything is written', () => {
    parseSandboxPatch.mockImplementationOnce(() => {
      throw new Error('bad sandbox patch')
    })
    expect(() => setClaudeSandbox('nope')).toThrow(/bad sandbox patch/)
    expect(saveClaudeSandbox).not.toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('a refused write propagates and emits nothing', () => {
    saveClaudeSandbox.mockImplementationOnce(() => {
      throw new Error('settings.json is not valid JSON')
    })
    expect(() => setClaudeSandbox({ enabled: true })).toThrow(/not valid JSON/)
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('emits nothing when the file cannot be read back', () => {
    readClaudeSandboxState.mockReturnValue(null)
    setClaudeSandbox({ enabled: true })
    expect(saveClaudeSandbox).toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
  })
})
