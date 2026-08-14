/**
 * @vitest-environment node
 *
 * Layer 1 tests for the per-cwd terminal POOL (sync-core.md §Terminal).
 *
 * Terminals are an ORDERED pool per working directory — `cwd#0`, `cwd#1`, … —
 * and "open terminal N of this cwd" resolves attach-or-spawn IN MAIN, so the
 * desktop panel's tab 0 and a phone's tab 0 for the same repo are the same pty.
 * These cover the resolution itself; the policy that decides who may ask lives
 * in terminal-service and is covered by remote-terminal.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Module from 'node:module'
import { createPtyStub } from '../../../test/stubs/pty-stub'

const ptyStub = createPtyStub()

let mockPlatform: NodeJS.Platform = 'linux'
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, platform: () => mockPlatform }
})

type LoadFn = (...a: unknown[]) => unknown
const modRef = Module as unknown as { _load: LoadFn }
const origLoad: LoadFn = modRef._load
modRef._load = function patched(...a: unknown[]): unknown {
  if ((a[0] as string) === 'node-pty') {
    return {
      spawn: (file: string, args: string[], options: Record<string, unknown>) =>
        ptyStub.spawn(file, args, options)
    }
  }
  return origLoad.call(this, ...a)
}

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { PtyManager } from '../pty-manager'

const flushPtyBatch = (): Promise<void> => new Promise((r) => setTimeout(r, 25))

describe('PtyManager — per-cwd terminal pool', () => {
  let manager: PtyManager

  beforeEach(() => {
    ptyStub.reset()
    mockPlatform = 'linux'
    process.env.SHELL = '/bin/bash'
    manager = new PtyManager()
  })

  afterEach(() => {
    manager.killAll()
    vi.clearAllMocks()
  })

  it('spawns on the first open of a slot and ATTACHES on the second', () => {
    const first = manager.open('/repo', 0, vi.fn(), vi.fn())
    expect(first).toMatchObject({ index: 0, created: true })
    expect(ptyStub.spawned).toHaveLength(1)

    // A DIFFERENT surface asking for terminal 0 of the same cwd — the whole
    // point of the pool: one shell, two viewers, no second spawn.
    const second = manager.open('/repo', 0, vi.fn(), vi.fn())
    expect(second).toEqual({ id: first.id, index: 0, created: false })
    expect(ptyStub.spawned).toHaveLength(1)
  })

  it('keeps distinct slots distinct, and slots of different cwds independent', () => {
    const a0 = manager.open('/repo-a', 0, vi.fn(), vi.fn())
    const a1 = manager.open('/repo-a', 1, vi.fn(), vi.fn())
    const b0 = manager.open('/repo-b', 0, vi.fn(), vi.fn())

    expect(new Set([a0.id, a1.id, b0.id]).size).toBe(3)
    expect(ptyStub.spawned).toHaveLength(3)
    expect(manager.terminalAt('/repo-a', 0)).toBe(a0.id)
    expect(manager.terminalAt('/repo-a', 1)).toBe(a1.id)
    expect(manager.terminalAt('/repo-b', 0)).toBe(b0.id)
    // Slot 1 of the OTHER repo was never opened.
    expect(manager.terminalAt('/repo-b', 1)).toBeUndefined()
  })

  it('creates at a requested index past the end, leaving a hole', () => {
    const third = manager.open('/repo', 2, vi.fn(), vi.fn())
    expect(third.index).toBe(2)
    expect(manager.terminalAt('/repo', 0)).toBeUndefined()
    expect(manager.terminalAt('/repo', 1)).toBeUndefined()
    expect(manager.poolOf('/repo')).toEqual([{ index: 2, id: third.id }])

    // The next indexless open fills the lowest hole rather than appending.
    const filled = manager.open('/repo', null, vi.fn(), vi.fn())
    expect(filled.index).toBe(0)
  })

  it('frees the slot when the pty EXITS, so the next open respawns there', async () => {
    const first = manager.open('/repo', 0, vi.fn(), vi.fn())
    ptyStub.spawned[0].emitExit(0)

    expect(manager.terminalAt('/repo', 0)).toBeUndefined()
    expect(manager.poolOf('/repo')).toEqual([])

    const second = manager.open('/repo', 0, vi.fn(), vi.fn())
    expect(second.created).toBe(true)
    expect(second.id).not.toBe(first.id)
    expect(ptyStub.spawned).toHaveLength(2)
    await flushPtyBatch()
  })

  it('frees the slot on an explicit kill, and a late exit cannot evict its successor', async () => {
    const first = manager.open('/repo', 0, vi.fn(), vi.fn())
    manager.kill(first.id)
    // The successor takes slot 0 BEFORE the killed pty's async onExit lands.
    const second = manager.open('/repo', 0, vi.fn(), vi.fn())
    expect(second.id).not.toBe(first.id)

    await new Promise((r) => queueMicrotask(() => r(undefined)))

    // The stale exit must not have cleared the slot the successor now owns.
    expect(manager.terminalAt('/repo', 0)).toBe(second.id)
  })

  it('killByCwd empties that cwd’s pool and leaves other cwds alone', async () => {
    manager.open('/repo-a', 0, vi.fn(), vi.fn())
    manager.open('/repo-a', 1, vi.fn(), vi.fn())
    const other = manager.open('/repo-b', 0, vi.fn(), vi.fn())

    expect(manager.killByCwd('/repo-a')).toHaveLength(2)
    expect(manager.poolOf('/repo-a')).toEqual([])
    expect(manager.terminalAt('/repo-b', 0)).toBe(other.id)
    await new Promise((r) => queueMicrotask(() => r(undefined)))
  })

  it('an indexless open always spawns into the next free slot (old-client compat)', () => {
    // What a bundle that predates the pool sends: create(cwd) with no index. It
    // must keep getting SOME terminal — never silently attach to the operator's
    // existing shell.
    const a = manager.open('/repo', null, vi.fn(), vi.fn())
    const b = manager.open('/repo', null, vi.fn(), vi.fn())
    const c = manager.create('/repo', vi.fn(), vi.fn())

    expect([a.index, b.index]).toEqual([0, 1])
    expect(manager.indexOf(c)).toBe(2)
    expect(new Set([a.id, b.id, c]).size).toBe(3)
    expect(ptyStub.spawned).toHaveLength(3)
  })

  it('normalizes separators, a trailing slash, and (on win32) case', () => {
    const first = manager.open('/repo/sub', 0, vi.fn(), vi.fn())
    expect(manager.terminalAt('/repo/sub/', 0)).toBe(first.id)
    expect(manager.open('/repo/sub/', 0, vi.fn(), vi.fn()).id).toBe(first.id)
    // Case is significant off Windows: /REPO is a different directory there.
    expect(manager.terminalAt('/REPO/SUB', 0)).toBeUndefined()

    mockPlatform = 'win32'
    const win = manager.open('C:\\Repo', 0, vi.fn(), vi.fn())
    expect(manager.terminalAt('c:/repo', 0)).toBe(win.id)
    expect(manager.open('C:/repo\\', 0, vi.fn(), vi.fn()).id).toBe(win.id)
  })

  it('refuses a malformed index instead of silently spawning somewhere', () => {
    expect(() => manager.open('/repo', -1, vi.fn(), vi.fn())).toThrow(/non-negative integer/)
    expect(() => manager.open('/repo', 1.5, vi.fn(), vi.fn())).toThrow(/non-negative integer/)
    expect(ptyStub.spawned).toHaveLength(0)
  })

  it('an attaching surface can read the scrollback of a pty it never spawned', async () => {
    const spawnerData = vi.fn()
    const first = manager.open('/repo', 0, spawnerData, vi.fn())
    ptyStub.spawned[0].emitData('$ pwd\r\n/repo\r\n')
    await flushPtyBatch()

    const second = manager.open('/repo', 0, vi.fn(), vi.fn())
    expect(second.created).toBe(false)
    expect(manager.scrollbackOf(second.id)).toBe('$ pwd\r\n/repo\r\n')
    // The spawner's callback is the one bound to the pty; attaching does not
    // replace it, so the original viewer keeps streaming.
    expect(spawnerData).toHaveBeenCalledWith(first.id, '$ pwd\r\n/repo\r\n')
    expect(manager.scrollbackOf('no-such-terminal')).toBe('')
  })
})
