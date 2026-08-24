/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Module from 'node:module'
import { createPtyStub } from '../../../test/stubs/pty-stub'

const ptyStub = createPtyStub()

// Mutable platform for the mocked `os` module. Pty-manager calls os.platform()
// during create(); tests set this before calling create().
let mockPlatform: NodeJS.Platform = 'linux'

// Mock `os` so we can steer os.platform() between tests (ESM namespace exports
// aren't configurable, so vi.spyOn(os, 'platform') does not work).
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    platform: () => mockPlatform
  }
})

// pty-manager uses `require('node-pty')` inline inside create(). Vitest's
// vi.mock() hooks into the ESM graph, which doesn't intercept Node's native
// CommonJS require(). Patch Module._load to short-circuit the 'node-pty'
// lookup and return our stub. This way pty-manager never loads the real
// native binding (which would fail on non-Windows or in CI without a build).
const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load
;(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function patched(
  ...a: unknown[]
): unknown {
  const request = a[0] as string
  if (request === 'node-pty') {
    return {
      spawn: (file: string, args: string[], options: Record<string, unknown>) =>
        ptyStub.spawn(file, args, options)
    }
  }
  return origLoad.call(this, ...a)
}

// Silence logger writes during tests.
vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// Import after mocks are registered.
import { PtyManager } from '../../../core/services/pty-manager'

// Convenience: flush queued microtasks (for kill -> emitExit via queueMicrotask).
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

// PTY output is coalesced behind an 8ms timer (M-PT1). Wait past it so the
// batched terminal:data send lands before asserting.
const flushPtyBatch = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

describe('PtyManager', () => {
  let manager: PtyManager
  const originalShell = process.env.SHELL
  const originalProgramFiles = process.env.ProgramFiles

  beforeEach(() => {
    ptyStub.reset()
    mockPlatform = 'linux'
    manager = new PtyManager()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = originalShell
    }
    if (originalProgramFiles === undefined) {
      delete process.env.ProgramFiles
    } else {
      process.env.ProgramFiles = originalProgramFiles
    }
  })

  describe('create()', () => {
    it('on win32 spawns a shell and passes cwd/cols/rows', () => {
      mockPlatform = 'win32'
      // Make ProgramFiles undefined so resolveWindowsShell falls through
      // existsSync checks to COMSPEC/cmd.exe (non-existent PowerShell path).
      delete process.env.ProgramFiles

      const id = manager.create('C:/repo', vi.fn(), vi.fn())

      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
      expect(ptyStub.spawned.length).toBe(1)

      const fake = ptyStub.spawned[0]
      // Shell must be a non-empty string (pwsh path, cmd.exe, or COMSPEC).
      expect(typeof fake.spawnArgs.file).toBe('string')
      expect(fake.spawnArgs.file.length).toBeGreaterThan(0)
      expect(fake.spawnOptions.cwd).toBe('C:/repo')
      expect(fake.spawnOptions.cols).toBe(80)
      expect(fake.spawnOptions.rows).toBe(24)
      expect(fake.spawnOptions.name).toBe('xterm-256color')
    })

    it('on non-win32 uses $SHELL when set', () => {
      mockPlatform = 'linux'
      process.env.SHELL = '/usr/bin/zsh'

      manager.create('/home/user/repo', vi.fn(), vi.fn())

      expect(ptyStub.spawned[0].spawnArgs.file).toBe('/usr/bin/zsh')
    })

    it('on non-win32 falls back to /bin/bash when $SHELL is unset', () => {
      mockPlatform = 'darwin'
      delete process.env.SHELL

      manager.create('/tmp/proj', vi.fn(), vi.fn())

      expect(ptyStub.spawned[0].spawnArgs.file).toBe('/bin/bash')
    })

    it('passes the cwd through to spawn options', () => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'

      manager.create('/my/custom/cwd', vi.fn(), vi.fn())

      expect(ptyStub.spawned[0].spawnOptions.cwd).toBe('/my/custom/cwd')
    })

    it('uses default cols=80, rows=24', () => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'

      manager.create('/x', vi.fn(), vi.fn())

      expect(ptyStub.spawned[0].cols).toBe(80)
      expect(ptyStub.spawned[0].rows).toBe(24)
    })

    it('returns a uuid string; multiple calls produce distinct ids', () => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'

      const id1 = manager.create('/a', vi.fn(), vi.fn())
      const id2 = manager.create('/b', vi.fn(), vi.fn())
      const id3 = manager.create('/c', vi.fn(), vi.fn())

      for (const id of [id1, id2, id3]) {
        expect(typeof id).toBe('string')
        // RFC4122 uuid v4 shape
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      }
      expect(new Set([id1, id2, id3]).size).toBe(3)
    })

    it('coalesces multiple chunks into a single batched onData call (M-PT1)', async () => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'

      const onData = vi.fn()
      const id = manager.create('/x', onData, vi.fn())
      const fake = ptyStub.spawned[0]

      fake.emitData('hello ')
      fake.emitData('world')
      // Buffered, not yet flushed — no IPC storm of one message per chunk.
      expect(onData).not.toHaveBeenCalled()

      await flushPtyBatch()
      // Both chunks arrive as ONE batched message.
      expect(onData).toHaveBeenCalledTimes(1)
      expect(onData).toHaveBeenCalledWith(id, 'hello world')
    })

    it('onExit callback fires with (id, exitCode) and removes the entry from the map', () => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'

      const onExit = vi.fn()
      const id = manager.create('/x', vi.fn(), onExit)
      const fake = ptyStub.spawned[0]

      expect(manager.has(id)).toBe(true)

      fake.emitExit(42)

      expect(onExit).toHaveBeenCalledTimes(1)
      expect(onExit).toHaveBeenCalledWith(id, 42)
      expect(manager.has(id)).toBe(false)
    })
  })

  describe('flow control (M-PT1)', () => {
    beforeEach(() => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'
    })

    it('pauses the pty when output floods past the high-water mark', () => {
      manager.create('/x', vi.fn(), vi.fn())
      const fake = ptyStub.spawned[0]

      // > 1 MiB emitted synchronously within one flush window (before the 8ms
      // timer fires) → the buffer crosses the high-water mark and we pause.
      const chunk = 'a'.repeat(64 * 1024) // 64 KiB
      for (let i = 0; i < 20; i++) fake.emitData(chunk) // ~1.25 MiB

      expect(fake.pauseCount).toBeGreaterThan(0)
      expect(fake.paused).toBe(true)
    })

    it('does NOT pause for ordinary interactive output', async () => {
      manager.create('/x', vi.fn(), vi.fn())
      const fake = ptyStub.spawned[0]

      fake.emitData('$ ls\r\n')
      fake.emitData('file1 file2\r\n')
      await flushPtyBatch()

      expect(fake.pauseCount).toBe(0)
      expect(fake.paused).toBe(false)
    })

    it('resumes the pty after the buffered flood is flushed to the renderer', async () => {
      const onData = vi.fn()
      manager.create('/x', onData, vi.fn())
      const fake = ptyStub.spawned[0]

      const chunk = 'a'.repeat(64 * 1024)
      for (let i = 0; i < 20; i++) fake.emitData(chunk)
      expect(fake.paused).toBe(true)

      await flushPtyBatch()
      // The batched flood was delivered in one send, and flow control lifted.
      expect(onData).toHaveBeenCalledTimes(1)
      expect(onData.mock.calls[0][1].length).toBe(20 * 64 * 1024)
      expect(fake.paused).toBe(false)
      expect(fake.resumeCount).toBeGreaterThan(0)
    })

    it('kill() clears the pending flush timer (no leaked send after kill)', async () => {
      const onData = vi.fn()
      const id = manager.create('/x', onData, vi.fn())
      const fake = ptyStub.spawned[0]

      fake.emitData('buffered but never flushed')
      manager.kill(id)
      await flushPtyBatch()

      // The scheduled flush was cancelled; kill's emitExit path also has nothing
      // to deliver, so no stale data lands.
      expect(onData).not.toHaveBeenCalled()
    })
  })

  describe('write()', () => {
    beforeEach(() => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'
    })

    it('routes input to the correct PTY by id', () => {
      const idA = manager.create('/a', vi.fn(), vi.fn())
      const idB = manager.create('/b', vi.fn(), vi.fn())
      const [fakeA, fakeB] = ptyStub.spawned

      manager.write(idA, 'alpha')
      manager.write(idB, 'beta')
      manager.write(idA, 'gamma')

      expect(fakeA.writes).toEqual(['alpha', 'gamma'])
      expect(fakeB.writes).toEqual(['beta'])
    })

    it('is a no-op (does not throw) on unknown id', () => {
      expect(() => manager.write('bogus-id', 'data')).not.toThrow()
    })
  })

  describe('resize()', () => {
    beforeEach(() => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'
    })

    it('routes resize to the correct PTY by id', () => {
      const idA = manager.create('/a', vi.fn(), vi.fn())
      const idB = manager.create('/b', vi.fn(), vi.fn())
      const [fakeA, fakeB] = ptyStub.spawned

      manager.resize(idA, 120, 40)
      manager.resize(idB, 100, 30)

      expect(fakeA.resizes).toEqual([{ cols: 120, rows: 40 }])
      expect(fakeB.resizes).toEqual([{ cols: 100, rows: 30 }])
    })

    it('is a no-op (does not throw) on unknown id', () => {
      expect(() => manager.resize('bogus-id', 120, 40)).not.toThrow()
    })
  })

  describe('kill()', () => {
    beforeEach(() => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'
    })

    it('calls pty.kill, removes the entry, and is idempotent', async () => {
      const id = manager.create('/a', vi.fn(), vi.fn())
      const fake = ptyStub.spawned[0]
      const killSpy = vi.spyOn(fake, 'kill')

      manager.kill(id)
      expect(killSpy).toHaveBeenCalledTimes(1)
      expect(manager.has(id)).toBe(false)

      // Second kill is a no-op; does not throw and does not invoke kill again.
      manager.kill(id)
      expect(killSpy).toHaveBeenCalledTimes(1)
      expect(manager.has(id)).toBe(false)

      // Flush the queued emitExit so it doesn't leak into other tests.
      await flushMicrotasks()
    })

    it('swallows errors when pty.kill() throws', () => {
      const id = manager.create('/a', vi.fn(), vi.fn())
      // Replace the underlying pty.kill with a throwing function.
      const entry = (
        manager as unknown as {
          ptys: Map<string, { pty: { kill: () => void } }>
        }
      ).ptys.get(id)!
      entry.pty.kill = () => {
        throw new Error('kill failed')
      }

      expect(() => manager.kill(id)).not.toThrow()
      // Entry is still removed even if kill threw.
      expect(manager.has(id)).toBe(false)
    })
  })

  describe('killByCwd()', () => {
    beforeEach(() => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'
    })

    it('kills only PTYs with matching cwd and returns their ids', () => {
      const id1 = manager.create('/repo-a', vi.fn(), vi.fn())
      const id2 = manager.create('/repo-b', vi.fn(), vi.fn())
      const id3 = manager.create('/repo-a', vi.fn(), vi.fn())

      const killed = manager.killByCwd('/repo-a')

      expect(new Set(killed)).toEqual(new Set([id1, id3]))
      expect(manager.has(id1)).toBe(false)
      expect(manager.has(id3)).toBe(false)
      expect(manager.has(id2)).toBe(true)
    })

    it('returns [] when no PTYs match the cwd', () => {
      manager.create('/repo-a', vi.fn(), vi.fn())
      manager.create('/repo-b', vi.fn(), vi.fn())

      const killed = manager.killByCwd('/nowhere')

      expect(killed).toEqual([])
    })
  })

  describe('killAll()', () => {
    it('kills every PTY regardless of cwd', () => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'

      const id1 = manager.create('/a', vi.fn(), vi.fn())
      const id2 = manager.create('/b', vi.fn(), vi.fn())
      const id3 = manager.create('/c', vi.fn(), vi.fn())

      manager.killAll()

      expect(manager.has(id1)).toBe(false)
      expect(manager.has(id2)).toBe(false)
      expect(manager.has(id3)).toBe(false)
      for (const fake of ptyStub.spawned) {
        expect(fake.killed).toBe(true)
      }
    })
  })

  describe('has()', () => {
    it('returns true before kill and false after', () => {
      mockPlatform = 'linux'
      process.env.SHELL = '/bin/bash'

      const id = manager.create('/x', vi.fn(), vi.fn())
      expect(manager.has(id)).toBe(true)

      manager.kill(id)
      expect(manager.has(id)).toBe(false)
    })
  })
})
