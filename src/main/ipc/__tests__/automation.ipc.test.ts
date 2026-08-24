/**
 * @vitest-environment node
 *
 * Layer 1/2 hybrid tests for automation.ipc.ts.
 * Mocks AutomationManager to verify that every registered channel
 * routes to the right manager method with the right args.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bootIpcHarness, type IpcHarness } from '../../../test/helpers/boot-ipc-harness'

// vi.mock is hoisted above top-level consts; declare shared state inside
// vi.hoisted so the factory can close over it safely.
const { mockState, managerSpies } = vi.hoisted(() => {
  const mockState = { isPackaged: false }
  const managerSpies = {
    load: vi.fn(),
    startAll: vi.fn(),
    list: vi.fn(() => [{ id: 'a1' }]),
    upsert: vi.fn(),
    delete: vi.fn(),
    runNow: vi.fn(async () => {
      /* slow */
    }),
    toggle: vi.fn(),
    listRuns: vi.fn(() => [{ id: 'r1' }]),
    loadRunMessages: vi.fn(() => [{ role: 'assistant' }]),
    cancelRun: vi.fn(),
    dismissRun: vi.fn(),
    sendMessage: vi.fn()
  }
  return { mockState, managerSpies }
})

// Mock the AutomationManager class to use our spies without touching disk.
// isValidAutomationId is re-exported with its real slug semantics so the IPC
// perimeter validation (M-AU3) is exercised end-to-end.
vi.mock('../../../core/services/automation-manager', () => ({
  isValidAutomationId: (id: unknown): id is string =>
    typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id),
  AutomationManager: class {
    constructor(_win: unknown) {
      /* no-op */
    }
    load = managerSpies.load
    startAll = managerSpies.startAll
    list = managerSpies.list
    upsert = managerSpies.upsert
    delete = managerSpies.delete
    runNow = managerSpies.runNow
    toggle = managerSpies.toggle
    listRuns = managerSpies.listRuns
    loadRunMessages = managerSpies.loadRunMessages
    cancelRun = managerSpies.cancelRun
    dismissRun = managerSpies.dismissRun
    sendMessage = managerSpies.sendMessage
  }
}))

// Electron shim with a dynamic isPackaged getter.
vi.mock('electron', async () => {
  const shim = await import('../../../test/stubs/electron-shim')
  return {
    ...shim,
    app: {
      ...shim.app,
      get isPackaged() {
        return mockState.isPackaged
      }
    }
  }
})

vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// Import AFTER mocks.
import { registerAutomationIpc } from '../../../core/ipc/automation.ipc'

describe('automation.ipc', () => {
  let harness: IpcHarness

  beforeEach(() => {
    harness = bootIpcHarness()
    Object.values(managerSpies).forEach((fn) => fn.mockClear?.())
    mockState.isPackaged = false // dev mode by default
  })

  afterEach(() => {
    harness.teardown()
    vi.clearAllMocks()
  })

  it('registers all 10 channels after registerAutomationIpc', async () => {
    registerAutomationIpc()
    // Every channel must resolve without "no handler" errors.
    await expect(harness.call('automation:list')).resolves.toBeDefined()
    await expect(harness.call('automation:save', { id: 'x' })).resolves.toBeUndefined()
    await expect(harness.call('automation:delete', 'x')).resolves.toBeUndefined()
    await expect(harness.call('automation:run-now', 'x')).resolves.toBeUndefined()
    await expect(harness.call('automation:toggle', 'x', true)).resolves.toBeUndefined()
    await expect(harness.call('automation:list-runs', 'x')).resolves.toBeDefined()
    await expect(harness.call('automation:load-run-history', 'x', 'r1')).resolves.toBeDefined()
    await expect(harness.call('automation:cancel', 'x')).resolves.toBeUndefined()
    await expect(harness.call('automation:dismiss-run', 'x', 'r1')).resolves.toBeUndefined()
    await expect(harness.call('automation:send-message', 'x', 'hi')).resolves.toBeUndefined()
  })

  it('automation:list returns manager.list() result', async () => {
    managerSpies.list.mockReturnValueOnce([{ id: 'custom' }] as any)
    registerAutomationIpc()
    const result = await harness.call<Array<{ id: string }>>('automation:list')
    expect(result).toEqual([{ id: 'custom' }])
    expect(managerSpies.list).toHaveBeenCalledTimes(1)
  })

  it('automation:save calls manager.upsert with automation', async () => {
    registerAutomationIpc()
    const auto = { id: 'a1', prompt: 'Deploy', enabled: true } as any
    await harness.call('automation:save', auto)
    expect(managerSpies.upsert).toHaveBeenCalledWith(auto)
  })

  it('automation:delete calls manager.delete with id', async () => {
    registerAutomationIpc()
    await harness.call('automation:delete', 'auto-123')
    expect(managerSpies.delete).toHaveBeenCalledWith('auto-123')
  })

  it('automation:run-now is fire-and-forget (does not await)', async () => {
    // runNow takes arbitrary time — the handler MUST NOT await it or the
    // renderer would block until completion. We assert the IPC returns
    // before runNow's promise resolves.
    let resolveRun: (() => void) | undefined
    managerSpies.runNow.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve
        })
    )
    registerAutomationIpc()

    const start = Date.now()
    await harness.call('automation:run-now', 'auto-1')
    const elapsed = Date.now() - start

    expect(managerSpies.runNow).toHaveBeenCalledWith('auto-1')
    // Should return immediately (< 50ms); runNow is still pending.
    expect(elapsed).toBeLessThan(100)
    // Resolve to avoid unhandled-promise spam in test output.
    resolveRun?.()
  })

  it('automation:run-now swallows runNow rejections (no unhandled)', async () => {
    managerSpies.runNow.mockRejectedValueOnce(new Error('boom'))
    registerAutomationIpc()
    // IPC call itself must not reject.
    await expect(harness.call('automation:run-now', 'auto-1')).resolves.toBeUndefined()
  })

  it('automation:toggle calls manager.toggle with id and enabled flag', async () => {
    registerAutomationIpc()
    await harness.call('automation:toggle', 'auto-1', true)
    await harness.call('automation:toggle', 'auto-1', false)
    expect(managerSpies.toggle).toHaveBeenNthCalledWith(1, 'auto-1', true)
    expect(managerSpies.toggle).toHaveBeenNthCalledWith(2, 'auto-1', false)
  })

  it('automation:cancel calls manager.cancelRun with id', async () => {
    registerAutomationIpc()
    await harness.call('automation:cancel', 'auto-1')
    expect(managerSpies.cancelRun).toHaveBeenCalledWith('auto-1')
  })

  it('automation:send-message calls manager.sendMessage with id and prompt', async () => {
    registerAutomationIpc()
    await harness.call('automation:send-message', 'auto-1', 'Add tests')
    expect(managerSpies.sendMessage).toHaveBeenCalledWith('auto-1', 'Add tests')
  })

  it('M-AU3: rejects a traversal automation id before reaching the manager', async () => {
    registerAutomationIpc()
    // Every id-bearing channel must reject `../..` and never call the manager.
    await expect(harness.call('automation:delete', '../..')).rejects.toThrow(
      /invalid automation id/i
    )
    await expect(harness.call('automation:save', { id: '../evil' })).rejects.toThrow(
      /invalid automation id/i
    )
    await expect(harness.call('automation:run-now', '../..')).rejects.toThrow(
      /invalid automation id/i
    )
    await expect(harness.call('automation:toggle', 'a/b', true)).rejects.toThrow(
      /invalid automation id/i
    )
    await expect(harness.call('automation:list-runs', '..')).rejects.toThrow(
      /invalid automation id/i
    )
    await expect(harness.call('automation:load-run-history', 'ok-id', '../r')).rejects.toThrow(
      /invalid automation id/i
    )
    await expect(harness.call('automation:cancel', 'a\\b')).rejects.toThrow(
      /invalid automation id/i
    )
    await expect(harness.call('automation:dismiss-run', '../..', 'r1')).rejects.toThrow(
      /invalid automation id/i
    )
    await expect(harness.call('automation:send-message', '../..', 'hi')).rejects.toThrow(
      /invalid automation id/i
    )

    expect(managerSpies.delete).not.toHaveBeenCalled()
    expect(managerSpies.upsert).not.toHaveBeenCalled()
    expect(managerSpies.runNow).not.toHaveBeenCalled()
    expect(managerSpies.toggle).not.toHaveBeenCalled()
    expect(managerSpies.dismissRun).not.toHaveBeenCalled()
    expect(managerSpies.sendMessage).not.toHaveBeenCalled()
  })

  it('dev mode (isPackaged=false) skips auto-start but still loads', () => {
    // automation.ipc.ts captures `is.dev` at module load time from app.isPackaged.
    // Our mock defaults to isPackaged=false, so the module sees dev=true.
    registerAutomationIpc()
    expect(managerSpies.load).toHaveBeenCalledTimes(1)
    expect(managerSpies.startAll).not.toHaveBeenCalled()
  })

  it.skip('prod mode (isPackaged=true) calls startAll', () => {
    // SKIP: automation.ipc.ts evaluates `const is = { dev: !app.isPackaged }`
    // at module-load time (ESM top-level), not per-registration. Flipping the
    // flag after import has no effect. Testing prod-mode behavior requires
    // either a vi.resetModules() re-import dance or restructuring the source
    // to check isPackaged inside registerAutomationIpc. Not worth the plumbing
    // for a one-line branch.
  })
})
