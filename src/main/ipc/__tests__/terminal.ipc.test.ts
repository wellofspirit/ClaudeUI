/**
 * @vitest-environment node
 *
 * Layer 1/2 hybrid tests for terminal.ipc.ts.
 * Boots the real `registerTerminalIpc()` against a TestIpcBridge with a mocked
 * node-pty. Verifies channel registration, request/response round-trips, and
 * event pushes via webContents.send().
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Module from 'module'
import { createPtyStub } from '../../../test/stubs/pty-stub'
import { bootIpcHarness, type IpcHarness } from '../../../test/helpers/boot-ipc-harness'

// Shared pty stub across tests. Reset in beforeEach.
const ptyStub = createPtyStub()

// Pin platform for shell selection — PtyManager calls os.platform() in create().
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, platform: () => 'linux' as NodeJS.Platform }
})

// PtyManager loads node-pty via CommonJS require() (not ESM import), so
// vi.mock('node-pty') doesn't reach it. Patch Module._load instead — the
// same approach used by pty-manager.test.ts.
type LoadFn = (...a: unknown[]) => unknown
const modRef = Module as unknown as { _load: LoadFn }
const origLoad: LoadFn = modRef._load
modRef._load = function patched(...args: unknown[]): unknown {
  const request = args[0] as string
  if (request === 'node-pty') {
    return {
      spawn: (file: string, a: string[], options: Record<string, unknown>) =>
        ptyStub.spawn(file, a, options),
    }
  }
  return origLoad.call(this, ...args)
}

// Electron module must resolve to our shim.
vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

// Silence logger noise.
vi.mock('../../services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Import AFTER mocks so the real module picks up the mocked electron/pty.
import { registerTerminalIpc } from '../terminal.ipc'

describe('terminal.ipc', () => {
  let harness: IpcHarness
  let closedHandler: (() => void) | null = null

  beforeEach(() => {
    ptyStub.reset()
    harness = bootIpcHarness()
    // Capture the `closed` handler the IPC registration wires up.
    closedHandler = null
    harness.win.on = (event: string, cb: () => void): any => {
      if (event === 'closed') closedHandler = cb
      return harness.win
    }
    registerTerminalIpc(harness.win)
  })

  afterEach(() => {
    harness.teardown()
    vi.clearAllMocks()
  })

  it('registers all 5 channels after registerTerminalIpc', async () => {
    // Every channel must accept an invoke without a "no handler" error.
    await harness.call('terminal:create', '/tmp/a')
    const id = ptyStub.spawned[0] ? 'x' : 'x'
    // write/resize/kill take an id; passing an unknown id is a no-op per PtyManager
    await expect(harness.call('terminal:write', id, 'data')).resolves.toBeUndefined()
    await expect(harness.call('terminal:resize', id, 80, 24)).resolves.toBeUndefined()
    await expect(harness.call('terminal:kill', id)).resolves.toBeUndefined()
    // kill-by-cwd returns an array of killed ids
    await expect(harness.call('terminal:kill-by-cwd', '/nonexistent')).resolves.toEqual([])
  })

  it('terminal:create returns a string id', async () => {
    const id = await harness.call<string>('terminal:create', '/tmp/proj')
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(ptyStub.spawned).toHaveLength(1)
  })

  it('PTY data flows to renderer via terminal:data event', async () => {
    const dataEvents: Array<{ terminalId: string; data: string }> = []
    harness.onEvent('terminal:data', (payload: any) => dataEvents.push(payload))

    const id = await harness.call<string>('terminal:create', '/tmp/proj')
    ptyStub.spawned[0].emitData('hello world')

    expect(dataEvents).toHaveLength(1)
    expect(dataEvents[0]).toEqual({ terminalId: id, data: 'hello world' })
  })

  it('PTY exit flows to renderer via terminal:exit event', async () => {
    const exitEvents: Array<{ terminalId: string; code: number }> = []
    harness.onEvent('terminal:exit', (payload: any) => exitEvents.push(payload))

    const id = await harness.call<string>('terminal:create', '/tmp/proj')
    ptyStub.spawned[0].emitExit(137)

    expect(exitEvents).toHaveLength(1)
    expect(exitEvents[0]).toEqual({ terminalId: id, code: 137 })
  })

  it('terminal:write forwards data to the spawned PTY', async () => {
    const id = await harness.call<string>('terminal:create', '/tmp')
    await harness.call('terminal:write', id, 'echo hi\n')
    expect(ptyStub.spawned[0].writes).toEqual(['echo hi\n'])
  })

  it('terminal:resize forwards cols/rows to the spawned PTY', async () => {
    const id = await harness.call<string>('terminal:create', '/tmp')
    await harness.call('terminal:resize', id, 120, 40)
    expect(ptyStub.spawned[0].resizes).toEqual([{ cols: 120, rows: 40 }])
  })

  it('terminal:kill removes the PTY and marks it killed', async () => {
    const id = await harness.call<string>('terminal:create', '/tmp')
    await harness.call('terminal:kill', id)
    expect(ptyStub.spawned[0].killed).toBe(true)
    // Killing again is a no-op (renderer contract — don't throw on unknown id)
    await expect(harness.call('terminal:kill', id)).resolves.toBeUndefined()
  })

  it('win.on("closed") triggers killAll', async () => {
    const id1 = await harness.call<string>('terminal:create', '/tmp/a')
    const id2 = await harness.call<string>('terminal:create', '/tmp/b')
    expect(ptyStub.spawned).toHaveLength(2)

    expect(closedHandler).toBeTruthy()
    closedHandler!()

    expect(ptyStub.spawned[0].killed).toBe(true)
    expect(ptyStub.spawned[1].killed).toBe(true)
    // Both ids produced
    expect(id1).not.toBe(id2)
  })
})
