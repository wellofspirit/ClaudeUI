/**
 * @vitest-environment node
 *
 * The host's handle on the voice worker (ADR-101): lazy single spawn, shared
 * concurrent acquires, respawn after any exit, the 30 s ready deadline, the
 * pack / platform / launcher refusals, and `stop()`.
 *
 * The worker here is a tiny REAL child process (a script this file writes to a temp
 * dir and runs with the test runner's own Node) that prints the `listening` line
 * and speaks just enough of the protocol to prove who it is talking to — no model,
 * no addon. What is under test is the process contract, so a stub of
 * `child_process` would have tested nothing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../services/logger', () => ({ logger: log }))

import {
  LocalVoiceServer,
  VoicePackMissingError,
  VOICE_SERVER_HELD_MESSAGE,
  VOICE_WORKER_START_TIMEOUT_MS,
  VoicePlatformUnsupportedError,
  isVoicePackMissing,
  setVoiceWorkerLauncher,
  type VoiceWorkerLaunch
} from '../local-voice-server'
import { VOICE_TOKEN_ENV } from '../worker/main'

/**
 * The fake worker. `FAKE_MODE` picks the behaviour:
 *   ok      listening, then serves `voice_start` (checks the token) and `quit`
 *   chatty  as ok, plus extra stdout lines after `listening`
 *   fatal   prints a fatal line, exits 1
 *   die     writes to stderr, exits 3 without a line
 *   hang    never prints anything
 *   garbage prints 25 non-protocol lines, never a protocol line
 *   noisy   prints noise lines first, then `listening` split across two chunks
 *   split   a `fatal` whose multi-byte character is split across two chunks
 *   as ok, a `crash` message makes it write to stderr and exit 7
 * Like the real worker it exits 0 when stdin ends.
 */
const FAKE_WORKER = `
const net = require('node:net')
const readline = require('node:readline')
const mode = process.env.FAKE_MODE || 'ok'
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
if (mode === 'fatal') {
  process.stdout.write(JSON.stringify({ type: 'fatal', message: 'model exploded' }) + '\\n', () => process.exit(1))
} else if (mode === 'die') {
  process.stderr.write('onnxruntime.dll is missing\\n', () => process.exit(3))
} else if (mode === 'garbage') {
  for (let i = 0; i < 25; i++) process.stdout.write('hello there ' + i + '\\n')
  setInterval(() => {}, 1000)
} else if (mode === 'split') {
  const line = Buffer.from(JSON.stringify({ type: 'fatal', message: 'caf\u00e9 is broken' }) + '\\n')
  const cut = line.indexOf(0xc3) + 1
  process.stdout.write(line.subarray(0, cut))
  setTimeout(() => process.stdout.write(line.subarray(cut), () => process.exit(1)), 80)
} else if (mode === 'hang') {
  setInterval(() => {}, 1000)
} else {
  const server = net.createServer((socket) => {
    const rl = readline.createInterface({ input: socket })
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      if (msg.type === 'quit') process.exit(0)
      if (msg.type === 'crash') process.stderr.write('segfault in onnxruntime\\n', () => process.exit(7))
      if (msg.type === 'voice_start') {
        const ok = msg.token === process.env.${VOICE_TOKEN_ENV}
        socket.write(JSON.stringify(ok ? { type: 'ready', pid: process.pid } : { type: 'error', message: 'unauthorized' }) + '\\n')
      }
    })
    rl.on('error', () => {})
    socket.on('error', () => {})
  })
  server.listen(0, '127.0.0.1', () => {
    const listening = JSON.stringify({ type: 'listening', port: server.address().port }) + '\\n'
    if (mode === 'noisy') {
      process.stdout.write('[module] loaded something\\n')
      process.stdout.write('not json at all\\n')
      process.stdout.write('{"type":"log","message":"json but not ours"}\\n')
      process.stdout.write(listening.slice(0, 12))
      setTimeout(() => process.stdout.write(listening.slice(12)), 80)
    } else {
      process.stdout.write(listening)
    }
    if (mode === 'chatty') {
      process.stdout.write('some later noise\\n')
      process.stdout.write(JSON.stringify({ type: 'fatal', message: 'ignored after listening' }) + '\\n')
    }
  })
}
`

let dir: string
let script: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-voice-server-'))
  script = path.join(dir, 'fake-worker.cjs')
  fs.writeFileSync(script, FAKE_WORKER)
})

afterAll(() => {
  fs.unlinkSync(script)
  fs.rmdirSync(dir)
})

const PACK = { addonDir: '/store/sherpa-onnx-node', modelDir: '/store/model' }

interface Harness {
  server: LocalVoiceServer
  launches: VoiceWorkerLaunch[]
  spawned: Array<{ command: string; args: string[]; options: SpawnOptions; child: ChildProcess }>
  workerArgs: string[][]
}

const servers: LocalVoiceServer[] = []

function harness(
  mode = 'ok',
  deps: Partial<ConstructorParameters<typeof LocalVoiceServer>[0]> = {}
): Harness {
  const launches: VoiceWorkerLaunch[] = []
  const workerArgs: string[][] = []
  const spawned: Harness['spawned'] = []
  const server = new LocalVoiceServer({
    getLauncher: () => (args) => {
      workerArgs.push(args)
      const launch = {
        command: process.execPath,
        args: [script, ...args],
        env: { FAKE_MODE: mode }
      }
      launches.push(launch)
      return launch
    },
    resolvePack: () => PACK,
    platformKey: () => 'win32-x64',
    spawn: (command, args, options) => {
      const child = nodeSpawn(command, args, options)
      spawned.push({ command, args, options, child })
      return child
    },
    ...deps
  })
  servers.push(server)
  return { server, launches, spawned, workerArgs }
}

afterEach(async () => {
  setVoiceWorkerLauncher(null)
  for (const server of servers.splice(0)) await server.stop()
})

/** Talk to the fake worker the way a capture would; resolves with its first reply. */
function ask(port: number, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const rl = readline.createInterface({ input: socket })
    rl.once('line', (line) => {
      socket.destroy()
      resolve(JSON.parse(line))
    })
    rl.on('error', reject)
    socket.on('error', reject)
    socket.write(JSON.stringify(message) + '\n')
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('LocalVoiceServer.acquire', () => {
  it('spawns the worker lazily, with the pack paths and a token only in its environment', async () => {
    const h = harness()
    expect(h.spawned).toHaveLength(0)
    expect(h.server.isRunning()).toBe(false)

    const endpoint = await h.server.acquire()

    expect(h.server.isRunning()).toBe(true)
    expect(endpoint.port).toBeGreaterThan(0)
    expect(endpoint.startFields.token).toMatch(/^[0-9a-f]{64}$/)
    expect(h.workerArgs).toEqual([['--addon', PACK.addonDir, '--model', PACK.modelDir]])

    const [{ args, options }] = h.spawned
    // argv is readable by every local user; the token must never ride on it.
    expect(args.join(' ')).not.toContain(endpoint.startFields.token)
    expect((options.env as Record<string, string>)[VOICE_TOKEN_ENV]).toBe(
      endpoint.startFields.token
    )
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
  })

  it('hands out an endpoint the worker accepts the token on — and refuses another', async () => {
    const h = harness()
    const { port, startFields } = await h.server.acquire()

    expect(await ask(port, { type: 'voice_start', language: 'en', ...startFields })).toMatchObject({
      type: 'ready'
    })
    expect(await ask(port, { type: 'voice_start', language: 'en', token: 'nope' })).toMatchObject({
      type: 'error'
    })
  })

  it('shares one spawn between concurrent acquires and later ones', async () => {
    const h = harness()
    const [a, b, c] = await Promise.all([
      h.server.acquire(),
      h.server.acquire(),
      h.server.acquire()
    ])
    const d = await h.server.acquire()

    expect(h.spawned).toHaveLength(1)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(d).toEqual(a)
  })

  it('keeps the worker’s stdin open for its whole life', async () => {
    const h = harness()
    const { port, startFields } = await h.server.acquire()
    await new Promise((resolve) => setTimeout(resolve, 150))

    // A closed stdin reads as "parent gone" and the worker exits 0.
    expect(h.spawned[0].child.stdin?.destroyed).toBe(false)
    expect(h.server.isRunning()).toBe(true)
    expect(await ask(port, { type: 'voice_start', ...startFields })).toMatchObject({
      type: 'ready'
    })
  })

  it('ignores everything the worker prints after its first line', async () => {
    const h = harness('chatty')
    const endpoint = await h.server.acquire()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(h.server.isRunning()).toBe(true)
    expect(
      await ask(endpoint.port, { type: 'voice_start', ...endpoint.startFields })
    ).toMatchObject({
      type: 'ready'
    })
  })

  it('respawns on the next acquire after the worker exits, with a fresh token', async () => {
    const h = harness()
    const first = await h.server.acquire()
    const pid1 = (await ask(first.port, { type: 'voice_start', ...first.startFields }))
      .pid as number

    // The idle exit: the worker goes away on its own.
    const socket = net.connect(first.port, '127.0.0.1')
    socket.on('error', () => undefined)
    socket.write(JSON.stringify({ type: 'quit' }) + '\n')
    await vi.waitFor(() => expect(h.server.isRunning()).toBe(false), { timeout: 5000 })

    const second = await h.server.acquire()
    const pid2 = (await ask(second.port, { type: 'voice_start', ...second.startFields }))
      .pid as number

    expect(h.spawned).toHaveLength(2)
    expect(pid2).not.toBe(pid1)
    expect(second.startFields.token).not.toBe(first.startFields.token)
    socket.destroy()
  })

  it('rejects with the worker’s own message on a `fatal` line, and tries again next time', async () => {
    const h = harness('fatal')
    await expect(h.server.acquire()).rejects.toThrow(/could not start: model exploded/)
    expect(h.server.isRunning()).toBe(false)

    await expect(h.server.acquire()).rejects.toThrow(/model exploded/)
    expect(h.spawned).toHaveLength(2)
  })

  it('rejects with the exit code only — the stderr tail goes to the log, not the Error', async () => {
    const h = harness('die')
    const failure = await h.server.acquire().catch((err: Error) => err)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/exited before it was ready \(code 3\)$/)
    expect((failure as Error).message).not.toContain('onnxruntime')
    expect(h.server.isRunning()).toBe(false)
    expect(log.warn).toHaveBeenCalledWith(
      'LocalVoice',
      expect.stringContaining('onnxruntime.dll is missing')
    )
  })

  it('allows a stuck worker 20 s — under the 30 s a remote voice:start invoke waits', () => {
    // The pill and a remote client's rejection show this text.
    expect(VOICE_WORKER_START_TIMEOUT_MS).toBe(20_000)
  })

  it('reads a fatal line whose multi-byte character is split across chunks', async () => {
    const h = harness('split')
    await expect(h.server.acquire()).rejects.toThrow(/could not start: caf\u00e9 is broken/)
  })

  it('skips noise before the protocol line, even with the line split across chunks', async () => {
    const h = harness('noisy')
    const endpoint = await h.server.acquire()

    expect(h.server.isRunning()).toBe(true)
    expect(
      await ask(endpoint.port, { type: 'voice_start', ...endpoint.startFields })
    ).toMatchObject({
      type: 'ready'
    })
  })

  it('gives up on a worker that only ever prints noise (20 lines)', async () => {
    const h = harness('garbage')
    await expect(h.server.acquire()).rejects.toThrow(/something other than its ready line/)
  })

  describe('a crash after listening', () => {
    it('is a warning with the code and the stderr tail, and the next acquire respawns', async () => {
      const h = harness()
      const first = await h.server.acquire()
      log.warn.mockClear()

      const socket = net.connect(first.port, '127.0.0.1')
      socket.on('error', () => undefined)
      socket.write(JSON.stringify({ type: 'crash' }) + '\n')
      await vi.waitFor(() => expect(h.server.isRunning()).toBe(false), { timeout: 5000 })

      expect(log.warn).toHaveBeenCalledWith(
        'LocalVoice',
        expect.stringMatching(/crashed \(code 7\).*segfault in onnxruntime/)
      )
      const second = await h.server.acquire()
      expect(second.startFields.token).not.toBe(first.startFields.token)
      socket.destroy()
    })

    it('a stop(), or an idle exit with code 0, is not reported as a crash', async () => {
      const h = harness()
      const endpoint = await h.server.acquire()
      log.warn.mockClear()

      const socket = net.connect(endpoint.port, '127.0.0.1')
      socket.on('error', () => undefined)
      socket.write(JSON.stringify({ type: 'quit' }) + '\n')
      await vi.waitFor(() => expect(h.server.isRunning()).toBe(false), { timeout: 5000 })
      await h.server.acquire()
      await h.server.stop()

      expect(log.warn).not.toHaveBeenCalled()
      socket.destroy()
    })
  })

  it('rejects a first line that is not the protocol, and kills the worker', async () => {
    const h = harness('garbage')
    await expect(h.server.acquire()).rejects.toThrow(/something other than its ready line/)
    const { child } = h.spawned[0]
    await vi.waitFor(
      () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
      {
        timeout: 5000
      }
    )
  })

  it('kills a worker that does not report ready in time', async () => {
    const h = harness('hang', { startTimeoutMs: 300 })
    await expect(h.server.acquire()).rejects.toThrow(/did not become ready within/)

    const { child } = h.spawned[0]
    await vi.waitFor(
      () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
      {
        timeout: 5000
      }
    )
    expect(h.server.isRunning()).toBe(false)
  })

  it('reports a launcher whose program does not exist', async () => {
    const h = harness('ok', {
      getLauncher: () => () => ({ command: path.join(dir, 'no-such-program'), args: [] })
    })
    await expect(h.server.acquire()).rejects.toThrow(/Could not start the voice worker/)
    expect(h.server.isRunning()).toBe(false)
  })

  describe('refusals, before anything is spawned', () => {
    it('VoicePackMissingError when the pack is not installed', async () => {
      const h = harness('ok', { resolvePack: () => null })
      const failure = await h.server.acquire().catch((err: unknown) => err)

      expect(failure).toBeInstanceOf(VoicePackMissingError)
      expect((failure as VoicePackMissingError).code).toBe('needs-voice-pack')
      expect(isVoicePackMissing(failure)).toBe(true)
      expect(h.spawned).toHaveLength(0)
    })

    it('VoicePlatformUnsupportedError on a host with no speech runtime — before the pack is even looked at', async () => {
      const resolvePack = vi.fn(() => PACK)
      const h = harness('ok', { platformKey: () => null, resolvePack })

      await expect(h.server.acquire()).rejects.toBeInstanceOf(VoicePlatformUnsupportedError)
      expect(resolvePack).not.toHaveBeenCalled()
      expect(h.spawned).toHaveLength(0)
    })

    it('an error naming the fix when no entrypoint installed a launcher', async () => {
      const server = new LocalVoiceServer({
        resolvePack: () => PACK,
        platformKey: () => 'win32-x64'
      })
      setVoiceWorkerLauncher(null)

      await expect(server.acquire()).rejects.toThrow(/setVoiceWorkerLauncher\(\)/)
    })

    it('reads the launcher the entrypoint installed', async () => {
      const server = new LocalVoiceServer({
        resolvePack: () => PACK,
        platformKey: () => 'win32-x64'
      })
      servers.push(server)
      setVoiceWorkerLauncher((args) => ({
        command: process.execPath,
        args: [script, ...args],
        env: { FAKE_MODE: 'ok' }
      }))

      const endpoint = await server.acquire()
      expect(endpoint.port).toBeGreaterThan(0)
    })
  })
})

describe('LocalVoiceServer.stop', () => {
  it('ends the worker and resolves only once it is gone', async () => {
    const h = harness()
    const { port, startFields } = await h.server.acquire()
    const pid = (await ask(port, { type: 'voice_start', ...startFields })).pid as number
    expect(alive(pid)).toBe(true)

    await h.server.stop()

    expect(alive(pid)).toBe(false)
    expect(h.server.isRunning()).toBe(false)
  })

  it('is a no-op with nothing running, and a later acquire spawns afresh', async () => {
    const h = harness()
    await h.server.stop()
    await h.server.acquire()
    await h.server.stop()
    await h.server.stop()
    await h.server.acquire()

    expect(h.spawned).toHaveLength(2)
  })

  it('rejects an acquire that is still starting', async () => {
    const h = harness('hang')
    const starting = h.server.acquire()
    const outcome = starting.catch((err: unknown) => err)
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))

    await h.server.stop()

    expect(await outcome).toBeInstanceOf(Error)
    expect(h.server.isRunning()).toBe(false)
  })
})

describe('LocalVoiceServer.suspend', () => {
  it('stops the worker and makes every acquire reject until released', async () => {
    const h = harness()
    const { port, startFields } = await h.server.acquire()
    const pid = (await ask(port, { type: 'voice_start', ...startFields })).pid as number

    const release = await h.server.suspend('removing the speech pack')

    expect(alive(pid)).toBe(false)
    expect(h.server.isRunning()).toBe(false)
    await expect(h.server.acquire()).rejects.toThrow(VOICE_SERVER_HELD_MESSAGE)
    await expect(h.server.acquire()).rejects.toThrow(/being updated/)
    expect(h.spawned).toHaveLength(1)

    release()
    const after = await h.server.acquire()
    expect(h.spawned).toHaveLength(2)
    expect(after.port).toBeGreaterThan(0)
  })

  it('rejects a start that is in flight when the hold begins', async () => {
    const h = harness('hang')
    const outcome = h.server.acquire().catch((err: unknown) => err)
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))

    const release = await h.server.suspend('removing')

    const failure = await outcome
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(VOICE_SERVER_HELD_MESSAGE)
    release()
  })

  it('refuses a second hold while one is in force, and only the holder releases it', async () => {
    const h = harness()
    const release = await h.server.suspend('first')

    await expect(h.server.suspend('second')).rejects.toThrow(/already being updated \(first\)/)
    // The refused attempt did not disturb the first hold.
    await expect(h.server.acquire()).rejects.toThrow(VOICE_SERVER_HELD_MESSAGE)

    release()
    release() // idempotent
    const again = await h.server.suspend('third')
    await expect(h.server.acquire()).rejects.toThrow(VOICE_SERVER_HELD_MESSAGE)
    // A stale release from an earlier hold cannot lift this one.
    release()
    await expect(h.server.acquire()).rejects.toThrow(VOICE_SERVER_HELD_MESSAGE)
    again()
    await expect(h.server.acquire()).resolves.toMatchObject({ port: expect.any(Number) })
  })

  it('holds even with nothing running, so a removal cannot race a first press', async () => {
    const h = harness()
    const release = await h.server.suspend('removing')

    await expect(h.server.acquire()).rejects.toThrow(VOICE_SERVER_HELD_MESSAGE)
    expect(h.spawned).toHaveLength(0)
    release()
  })
})
