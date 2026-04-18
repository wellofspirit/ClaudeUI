/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for `TunnelManager`.
 *
 * Covers spec 3.3 of docs/test-coverage-proposal.md:
 * - start() spawns cloudflared with correct args and reports "connected" once
 *   stdout/stderr contains the tunnel URL.
 * - start() reports error if the binary fails to spawn (ENOENT-style).
 * - stop() sends SIGTERM to the process and clears internal state.
 * - start() while already running throws (matches actual behavior).
 *
 * Child processes are faked via an EventEmitter-based spawn mock; no real
 * cloudflared binary is launched. Filesystem lookups for the binary are
 * stubbed so ensureBinary() does not try to download anything.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface FakeChildProcess extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  pid: number
}

const spawnedProcesses: FakeChildProcess[] = []
const spawnCalls: Array<{ cmd: string; args: readonly string[]; options: unknown }> = []

// Behavior knob: if true, the next spawn synchronously throws (EACCES-style).
// Otherwise it returns an emitter; emit 'error' on it to simulate ENOENT.
let throwOnNextSpawn: Error | null = null

vi.mock('node:child_process', () => ({
  spawn: vi.fn((cmd: string, args: readonly string[], options: unknown) => {
    spawnCalls.push({ cmd, args, options })
    if (throwOnNextSpawn) {
      const err = throwOnNextSpawn
      throwOnNextSpawn = null
      throw err
    }
    const fake = new EventEmitter() as FakeChildProcess
    fake.stdout = new EventEmitter()
    fake.stderr = new EventEmitter()
    fake.kill = vi.fn()
    fake.pid = 1234 + spawnedProcesses.length
    spawnedProcesses.push(fake)
    return fake
  }),
  execFileSync: vi.fn(() => Buffer.from('')),
}))

// Make fs.existsSync() always return true so ensureBinary() short-circuits
// past the download path. The other fs.* calls won't be reached.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn(),
    renameSync: vi.fn(),
    createWriteStream: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })),
  }
})

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Import after mocks are registered.
import { TunnelManager } from '../tunnel-manager'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TUNNEL_URL = 'https://fluffy-cat-42.trycloudflare.com'

/** Resolve once the test's spawn mock has a FakeChildProcess ready. */
async function waitForSpawn(timeoutMs = 1000): Promise<FakeChildProcess> {
  const start = Date.now()
  while (spawnedProcesses.length === 0) {
    if (Date.now() - start > timeoutMs) throw new Error('spawn did not happen')
    await new Promise((r) => setImmediate(r))
  }
  return spawnedProcesses[spawnedProcesses.length - 1]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TunnelManager', () => {
  let manager: TunnelManager

  beforeEach(() => {
    spawnedProcesses.length = 0
    spawnCalls.length = 0
    throwOnNextSpawn = null
    manager = new TunnelManager()
  })

  afterEach(() => {
    // Ensure we tear down between tests so a leaking 'exit' listener from a
    // half-stopped manager doesn't trigger a scheduleRestart.
    try { manager.stop() } catch { /* ignore */ }
    vi.clearAllMocks()
  })

  it("start() spawns cloudflared with the expected args and resolves with the URL once stderr emits it", async () => {
    const startP = manager.start(8787)
    const proc = await waitForSpawn()

    // The spawn call should target cloudflared with `tunnel --url http://localhost:<port>`.
    expect(spawnCalls.length).toBe(1)
    const call = spawnCalls[0]
    // First positional arg is the binary path — we don't pin the exact path (it
    // depends on os.homedir()), but it must end with a cloudflared filename.
    expect(call.cmd).toMatch(/cloudflared(\.exe)?$/)
    expect(call.args).toEqual(['tunnel', '--url', 'http://localhost:8787'])

    // Emit the URL line on stderr (cloudflared logs to stderr).
    proc.stderr.emit('data', Buffer.from(`INF Your quick tunnel is ${TUNNEL_URL}\n`))

    await expect(startP).resolves.toBe(TUNNEL_URL)
    expect(manager.getStatus()).toEqual({ state: 'connected', url: TUNNEL_URL, error: null })
  })

  it('start() rejects with an error when the process emits an ENOENT-style error', async () => {
    const startP = manager.start(8787)
    const proc = await waitForSpawn()

    const enoent = Object.assign(new Error('spawn cloudflared ENOENT'), {
      code: 'ENOENT',
    })
    proc.emit('error', enoent)

    await expect(startP).rejects.toThrow(/ENOENT/)
    const status = manager.getStatus()
    expect(status.state).toBe('error')
    expect(status.error).toMatch(/ENOENT/)
  })

  it('stop() sends SIGTERM to the process and clears status to "stopped"', async () => {
    const startP = manager.start(8787)
    const proc = await waitForSpawn()
    proc.stderr.emit('data', Buffer.from(`url=${TUNNEL_URL}\n`))
    await startP

    expect(manager.getStatus().state).toBe('connected')

    manager.stop()

    expect(proc.kill).toHaveBeenCalledTimes(1)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(manager.getStatus()).toEqual({ state: 'stopped', url: null, error: null })

    // Simulating the child's subsequent exit must NOT trigger a restart,
    // because stop() set `destroyed = true`.
    proc.emit('exit', null, 'SIGTERM')
    // Give any queued timers a chance to fire.
    await new Promise((r) => setImmediate(r))
    // No new spawn should have happened.
    expect(spawnCalls.length).toBe(1)
  })

  it('calling start() a second time without stopping throws "Tunnel already running"', async () => {
    const startP = manager.start(8787)
    const proc = await waitForSpawn()
    proc.stderr.emit('data', Buffer.from(`${TUNNEL_URL}\n`))
    await startP

    await expect(manager.start(9999)).rejects.toThrow(/already running/i)
    // Second start should not have spawned another process.
    expect(spawnCalls.length).toBe(1)
  })
})
