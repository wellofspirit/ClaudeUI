/**
 * fakePty — a node-pty-shaped object with spies.
 *
 * Tests mock `node-pty`'s default export with `spawn` bound to `createFakePtySpawn()`.
 * Each spawn returns a `FakePty` that records writes/resizes/kills and lets the
 * test push data or simulate exit.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FakeDisposable {
  dispose: () => void
}

export interface FakePty {
  pid: number
  cols: number
  rows: number
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
  disposed: boolean
  spawnOptions: Record<string, unknown>
  spawnArgs: { file: string; args: string[] }

  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
  onData: (cb: (data: string) => void) => FakeDisposable
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => FakeDisposable

  // Test-only helpers:
  emitData: (data: string) => void
  emitExit: (exitCode: number, signal?: number) => void
  dataListeners: Array<(d: string) => void>
  exitListeners: Array<(e: { exitCode: number; signal?: number }) => void>
}

export interface PtyStubController {
  /** Array of all PTYs ever spawned via this stub (ordered). */
  spawned: FakePty[]
  /** The `spawn` function bound to this controller; pass to vi.mock. */
  spawn: (file: string, args: string[], options: Record<string, unknown>) => FakePty
  /** Make the next `spawn` call throw the given error (e.g., missing binary). */
  queueSpawnError: (err: Error) => void
  /** Reset all recorded state. */
  reset: () => void
}

export function createPtyStub(): PtyStubController {
  const spawned: FakePty[] = []
  const pendingErrors: Error[] = []
  let nextPid = 1000

  function makeFake(file: string, args: string[], options: Record<string, unknown>): FakePty {
    const cols = typeof options.cols === 'number' ? options.cols : 80
    const rows = typeof options.rows === 'number' ? options.rows : 24
    const dataListeners: Array<(d: string) => void> = []
    const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = []

    const fake: FakePty = {
      pid: nextPid++,
      cols,
      rows,
      writes: [],
      resizes: [],
      killed: false,
      disposed: false,
      spawnOptions: options,
      spawnArgs: { file, args },

      write(data) {
        if (fake.killed) return
        fake.writes.push(data)
      },
      resize(c, r) {
        if (fake.killed) return
        fake.cols = c
        fake.rows = r
        fake.resizes.push({ cols: c, rows: r })
      },
      kill() {
        if (fake.killed) return
        fake.killed = true
        // Simulate async exit after kill
        queueMicrotask(() => fake.emitExit(0))
      },
      onData(cb) {
        dataListeners.push(cb)
        return {
          dispose: () => {
            const i = dataListeners.indexOf(cb)
            if (i >= 0) dataListeners.splice(i, 1)
          },
        }
      },
      onExit(cb) {
        exitListeners.push(cb)
        return {
          dispose: () => {
            const i = exitListeners.indexOf(cb)
            if (i >= 0) exitListeners.splice(i, 1)
          },
        }
      },

      emitData(data) {
        for (const cb of dataListeners.slice()) cb(data)
      },
      emitExit(exitCode, signal) {
        fake.killed = true
        const evt = { exitCode, signal }
        for (const cb of exitListeners.slice()) cb(evt)
        fake.disposed = true
      },
      dataListeners,
      exitListeners,
    }
    return fake
  }

  const spawn = (file: string, args: string[], options: Record<string, unknown>): FakePty => {
    if (pendingErrors.length > 0) {
      const err = pendingErrors.shift()!
      throw err
    }
    const fake = makeFake(file, args, options)
    spawned.push(fake)
    return fake
  }

  return {
    spawned,
    spawn,
    queueSpawnError(err: Error) {
      pendingErrors.push(err)
    },
    reset() {
      spawned.length = 0
      pendingErrors.length = 0
      nextPid = 1000
    },
  }
}
