/**
 * @vitest-environment node
 *
 * Layer 1/2 hybrid tests for terminal.ipc.ts.
 * Boots the real `registerTerminalIpc()` against a TestIpcBridge with a mocked
 * node-pty. Verifies channel registration, request/response round-trips, and
 * event pushes via webContents.send().
 */

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
        ptyStub.spawn(file, a, options)
    }
  }
  return origLoad.call(this, ...args)
}

// Electron module must resolve to our shim.
vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

// Silence logger noise.
vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// Import AFTER mocks so the real module picks up the mocked electron/pty.
import { registerTerminalIpc } from '../../../core/ipc/terminal.ipc'
import { terminalService } from '../../../core/services/terminal-service'

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
    // SyncCore 4d: the registration is window-free (so it can run in a windowless
    // boot); the desktop delivery target AND the window-lifetime shell teardown are
    // `terminalService.setWindow`'s, which is what `createWindow()` calls.
    registerTerminalIpc()
    terminalService.setWindow(harness.win)
  })

  afterEach(() => {
    // `terminalService` is a process singleton and its pty POOL outlives a test:
    // without this, `terminal:create(cwd, 0)` in the next case would resolve the
    // previous case's still-live shell instead of spawning.
    terminalService.killAll()
    terminalService.setWindow(null)
    harness.teardown()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Per-cwd terminal pool (`cwd#0`, `cwd#1`, …) over the DESKTOP transport
  // -------------------------------------------------------------------------

  it('resolves the same pool slot of one cwd to ONE pty', async () => {
    const first = await harness.call<string>('terminal:create', '/tmp/proj', 0)
    const again = await harness.call<string>('terminal:create', '/tmp/proj', 0)

    expect(again).toBe(first)
    expect(ptyStub.spawned).toHaveLength(1)

    // A different slot is a different shell; a different cwd likewise.
    const second = await harness.call<string>('terminal:create', '/tmp/proj', 1)
    const elsewhere = await harness.call<string>('terminal:create', '/tmp/other', 0)
    expect(new Set([first, second, elsewhere]).size).toBe(3)
    expect(ptyStub.spawned).toHaveLength(3)
  })

  it('terminal:create with no index still spawns a fresh pty (old-client compat)', async () => {
    const first = await harness.call<string>('terminal:create', '/tmp/proj')
    const second = await harness.call<string>('terminal:create', '/tmp/proj')
    expect(second).not.toBe(first)
    expect(ptyStub.spawned).toHaveLength(2)
  })

  it('terminal:attach replays the scrollback on terminal:data, BEFORE live bytes', async () => {
    const events: Array<{ terminalId: string; data: string; replay?: boolean }> = []
    harness.onEvent('terminal:data', (payload: any) => events.push(payload))

    const id = await harness.call<string>('terminal:create', '/tmp/proj', 0)
    ptyStub.spawned[0].emitData('$ ls\r\nfile1\r\n')
    await new Promise((r) => setTimeout(r, 25))
    expect(events).toHaveLength(1)

    // A second surface (or a remounted tab) opening slot 0 gets the same pty and
    // attaches; the ring is delivered on the SAME host-local lane, flagged as a
    // replay so the client resets instead of appending to what it already drew.
    const same = await harness.call<string>('terminal:create', '/tmp/proj', 0)
    expect(same).toBe(id)
    await expect(harness.call('terminal:attach', id)).resolves.toBe(true)

    expect(events[1]).toEqual({ terminalId: id, data: '$ ls\r\nfile1\r\n', replay: true })

    ptyStub.spawned[0].emitData('more\r\n')
    await new Promise((r) => setTimeout(r, 25))
    // Replay then live, never interleaved.
    expect(events.map((e) => [e.data, e.replay === true])).toEqual([
      ['$ ls\r\nfile1\r\n', false],
      ['$ ls\r\nfile1\r\n', true],
      ['more\r\n', false]
    ])
  })

  it('terminal:attach reports a stale tab instead of throwing; detach is a no-op', async () => {
    await expect(harness.call('terminal:attach', 'no-such-terminal')).resolves.toBe(false)
    await expect(harness.call('terminal:detach', 'no-such-terminal')).resolves.toBeUndefined()
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
    // pool answers with the live SLOTS of a cwd (empty for one with no shells)
    await expect(harness.call('terminal:pool', '/nonexistent')).resolves.toEqual([])
  })

  // -------------------------------------------------------------------------
  // `terminal:pool` — what the "still running here" indicator reads
  // -------------------------------------------------------------------------

  it('terminal:pool lists the live slots of one cwd, by directory not by spelling', async () => {
    await harness.call<string>('terminal:create', '/tmp/proj', 0)
    await harness.call<string>('terminal:create', '/tmp/proj', 2)
    await harness.call<string>('terminal:create', '/tmp/other', 0)

    await expect(harness.call('terminal:pool', '/tmp/proj')).resolves.toEqual([0, 2])
    // Same normalization the pool key itself uses — a trailing slash names the
    // same directory, and an indicator that disagreed with `create` would be
    // worse than no indicator.
    await expect(harness.call('terminal:pool', '/tmp/proj/')).resolves.toEqual([0, 2])
    await expect(harness.call('terminal:pool', '/tmp/other')).resolves.toEqual([0])
  })

  it('terminal:pool drops a slot as soon as its pty is gone', async () => {
    const id = await harness.call<string>('terminal:create', '/tmp/proj', 0)
    await harness.call<string>('terminal:create', '/tmp/proj', 1)
    await expect(harness.call('terminal:pool', '/tmp/proj')).resolves.toEqual([0, 1])

    await harness.call('terminal:kill', id)
    await expect(harness.call('terminal:pool', '/tmp/proj')).resolves.toEqual([1])

    // A natural exit frees its slot the same way.
    ptyStub.spawned[1].emitExit(0)
    await expect(harness.call('terminal:pool', '/tmp/proj')).resolves.toEqual([])
  })

  it('terminal:pool answers empty for a missing cwd instead of throwing', async () => {
    await expect(harness.call('terminal:pool', '')).resolves.toEqual([])
    await expect(harness.call('terminal:pool', '   ')).resolves.toEqual([])
  })

  it('terminal:pool leaks no pty ids — a caller re-opens by SLOT', async () => {
    const id = await harness.call<string>('terminal:create', '/tmp/proj', 0)
    const slots = await harness.call<number[]>('terminal:pool', '/tmp/proj')
    expect(slots).toEqual([0])
    expect(JSON.stringify(slots)).not.toContain(id)
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

    // Output is coalesced behind an 8ms flush timer (M-PT1); wait for the batch.
    await new Promise((r) => setTimeout(r, 25))

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

  it('the host window closing triggers killAll', async () => {
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
