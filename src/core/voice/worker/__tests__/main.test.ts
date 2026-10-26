/**
 * @vitest-environment node
 *
 * `runVoiceWorker`'s host contract — what lands on stdout, when it exits — run
 * in-process with every process-level thing injected and a fake recognizer.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as net from 'node:net'
import type { Recognizer } from '../recognizer'
import { IDLE_EXIT_MS, type Clock } from '../server'
import {
  VOICE_TOKEN_ENV,
  defaultThreads,
  routeConsoleToStderr,
  runVoiceWorker,
  type VoiceWorkerOptions
} from '../main'

const TOKEN = 'c0ffee'.repeat(10)

const fakeRecognizer: Recognizer = { decode: async () => ({ text: '', words: [] }) }

/** A clock that records the delay each timeout was armed with and fires them on demand. */
function manualClock(): Clock & { fireTimeouts(): void; delays(): number[] } {
  const timeouts = new Map<() => void, number>()
  return {
    now: () => 0,
    setInterval: () => () => {},
    setTimeout: (fn, ms) => {
      timeouts.set(fn, ms)
      return () => void timeouts.delete(fn)
    },
    fireTimeouts: () => [...timeouts.keys()].forEach((fn) => fn()),
    delays: () => [...timeouts.values()]
  }
}

/**
 * `runVoiceWorker`, with every server it starts stopped after the test, whatever the test did: the
 * process-reset leak guard fails a file that leaves a listening socket behind. `stop` is made
 * idempotent, so a test may still stop its own.
 */
const started: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(started.splice(0).map((stop) => stop()))
})
async function start(options: VoiceWorkerOptions): ReturnType<typeof runVoiceWorker> {
  const result = await runVoiceWorker(options)
  if (result.status !== 'listening') return result
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => (stopping ??= result.stop())
  started.push(stop)
  return { ...result, stop }
}

function harness(overrides: Partial<VoiceWorkerOptions> = {}) {
  const stdin = Object.assign(new EventEmitter(), { resume: vi.fn() })
  const out: string[] = []
  const err: string[] = []
  const exit = vi.fn()
  const loadRecognizer = vi.fn(async (..._args: [string, string, number]) => fakeRecognizer)
  const options: VoiceWorkerOptions = {
    argv: ['--addon', '/pack/addon', '--model', '/pack/model'],
    env: { [VOICE_TOKEN_ENV]: TOKEN },
    stdin,
    stdout: {
      write: (chunk, cb) => {
        out.push(chunk)
        cb?.()
      }
    },
    stderr: { write: (chunk) => void err.push(chunk) },
    exit,
    loadRecognizer,
    parallelism: 16,
    ...overrides
  }
  return { options, stdin, out, err, exit, loadRecognizer }
}

describe('defaultThreads', () => {
  it.each([
    [1, 2],
    [2, 2],
    [8, 4],
    [16, 8],
    [64, 8]
  ])('%i cores → %i threads', (cores, threads) => {
    expect(defaultThreads(cores)).toBe(threads)
  })
})

describe('runVoiceWorker', () => {
  it('prints exactly one listening line, for a server that is really listening', async () => {
    const h = harness()
    const result = await start(h.options)
    expect(result.status).toBe('listening')
    if (result.status !== 'listening') return

    expect(h.out).toHaveLength(1)
    expect(h.out[0].endsWith('\n')).toBe(true)
    expect(JSON.parse(h.out[0])).toEqual({ type: 'listening', port: result.port })
    expect(result.port).toBeGreaterThan(0)

    // Loopback only, and it accepts a connection.
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(result.port, '127.0.0.1', () => {
        sock.destroy()
        resolve()
      })
      sock.on('error', reject)
    })
    await result.stop()
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('hands the loader the directories and the thread count', async () => {
    const h = harness({ argv: ['--addon', '/a', '--model', '/m', '--threads', '3'] })
    const result = await start(h.options)
    expect(h.loadRecognizer).toHaveBeenCalledWith('/a', '/m', 3)
    if (result.status === 'listening') await result.stop()
  })

  it('defaults the threads from the core count', async () => {
    const h = harness({ parallelism: 8 })
    const result = await start(h.options)
    expect(h.loadRecognizer).toHaveBeenCalledWith('/pack/addon', '/pack/model', 4)
    if (result.status === 'listening') await result.stop()
  })

  it.each([
    ['no arguments', []],
    ['no --model', ['--addon', '/a']],
    ['no --addon', ['--model', '/m']],
    ['a flag without a value', ['--addon', '/a', '--model']],
    ['an unknown flag', ['--addon', '/a', '--model', '/m', '--token', 'x']],
    ['--threads 0', ['--addon', '/a', '--model', '/m', '--threads', '0']],
    ['--threads many', ['--addon', '/a', '--model', '/m', '--threads', 'many']]
  ])('%s → a fatal line and exit 1, without loading anything', async (_name, argv) => {
    const h = harness({ argv })
    const result = await start(h.options)
    expect(result.status).toBe('failed')
    expect(h.out).toHaveLength(1)
    expect(JSON.parse(h.out[0])).toMatchObject({ type: 'fatal' })
    expect(h.exit).toHaveBeenCalledWith(1)
    expect(h.loadRecognizer).not.toHaveBeenCalled()
  })

  it('a missing token is fatal (it comes from the environment, never argv)', async () => {
    const h = harness({ env: {} })
    const result = await start(h.options)
    expect(result.status).toBe('failed')
    expect(JSON.parse(h.out[0]).message).toContain(VOICE_TOKEN_ENV)
    expect(h.exit).toHaveBeenCalledWith(1)
    expect(h.loadRecognizer).not.toHaveBeenCalled()
  })

  it('a model that will not load is a fatal line and exit 1', async () => {
    const h = harness({
      loadRecognizer: async () => {
        throw new Error('onnxruntime.dll is missing')
      }
    })
    const result = await start(h.options)
    expect(result.status).toBe('failed')
    expect(JSON.parse(h.out[0])).toEqual({
      type: 'fatal',
      message: 'could not load the speech model: onnxruntime.dll is missing'
    })
    expect(h.exit).toHaveBeenCalledWith(1)
  })

  it('exits 0 when stdin ends, including while the model is still loading', async () => {
    let finishLoad!: () => void
    const h = harness({
      loadRecognizer: () =>
        new Promise<Recognizer>((resolve) => {
          finishLoad = () => resolve(fakeRecognizer)
        })
    })
    const running = start(h.options)
    expect(h.stdin.resume).toHaveBeenCalled()
    h.stdin.emit('end')
    expect(h.exit).toHaveBeenCalledWith(0)

    finishLoad()
    const result = await running
    if (result.status === 'listening') await result.stop()
  })

  it('exits 0 after ten idle minutes — the default delay is ten minutes', async () => {
    const clock = manualClock()
    const h = harness({ clock })
    const result = await start(h.options)
    expect(clock.delays()).toEqual([10 * 60_000])
    expect(IDLE_EXIT_MS).toBe(10 * 60_000)
    expect(h.exit).not.toHaveBeenCalled()
    clock.fireTimeouts()
    expect(h.exit).toHaveBeenCalledWith(0)
    if (result.status === 'listening') await result.stop()
  })

  it('an explicit idle delay is the one the timer is armed with', async () => {
    const clock = manualClock()
    const h = harness({ clock, idleExitMs: 1234 })
    const result = await start(h.options)
    expect(clock.delays()).toEqual([1234])
    if (result.status === 'listening') await result.stop()
  })

  describe('the voice-worker subcommand', () => {
    it('is stripped when it leads argv (bun src/server/main.ts voice-worker …)', async () => {
      const h = harness({ argv: ['voice-worker', '--addon', '/a', '--model', '/m'] })
      const result = await start(h.options)
      expect(h.loadRecognizer).toHaveBeenCalledWith('/a', '/m', 8)
      if (result.status === 'listening') await result.stop()
    })

    it('is not needed (the desktop entry passes flags only)', async () => {
      const h = harness({ argv: ['--addon', '/a', '--model', '/m'] })
      const result = await start(h.options)
      expect(result.status).toBe('listening')
      if (result.status === 'listening') await result.stop()
    })

    it('is only a subcommand at the front', async () => {
      const h = harness({ argv: ['--addon', 'voice-worker', '--model', '/m'] })
      const result = await start(h.options)
      expect(h.loadRecognizer).toHaveBeenCalledWith('voice-worker', '/m', 8)
      if (result.status === 'listening') await result.stop()
    })

    it('alone it is still a missing-argument fatal', async () => {
      const h = harness({ argv: ['voice-worker'] })
      const result = await start(h.options)
      expect(result.status).toBe('failed')
      expect(JSON.parse(h.out[0]).message).toContain('--addon')
    })
  })

  describe('a crash', () => {
    it.each(['uncaughtException', 'unhandledRejection'] as const)(
      'after `listening` (%s) goes to stderr only: stdout keeps exactly one line',
      async (event) => {
        const events = new EventEmitter()
        const h = harness({ processEvents: events as VoiceWorkerOptions['processEvents'] })
        const result = await start(h.options)
        expect(h.out).toHaveLength(1)

        events.emit(event, new Error('kaboom'))
        expect(h.out).toHaveLength(1)
        expect(h.err.join('')).toContain('kaboom')
        expect(h.exit).toHaveBeenCalledWith(1)
        if (result.status === 'listening') await result.stop()
      }
    )

    it('before `listening` it is the fatal line on stdout, as for any startup failure', async () => {
      const events = new EventEmitter()
      let finishLoad!: () => void
      const h = harness({
        processEvents: events as VoiceWorkerOptions['processEvents'],
        loadRecognizer: () =>
          new Promise<Recognizer>((resolve) => {
            finishLoad = () => resolve(fakeRecognizer)
          })
      })
      const running = start(h.options)
      events.emit('uncaughtException', new Error('during load'))
      expect(h.out).toHaveLength(1)
      expect(JSON.parse(h.out[0])).toEqual({ type: 'fatal', message: 'during load' })
      expect(h.exit).toHaveBeenCalledWith(1)

      finishLoad()
      const result = await running
      if (result.status === 'listening') await result.stop()
    })

    it('a non-Error value is reported without its content', async () => {
      const events = new EventEmitter()
      const h = harness({ processEvents: events as VoiceWorkerOptions['processEvents'] })
      const result = await start(h.options)
      events.emit('unhandledRejection', { secret: TOKEN })
      expect(h.err.join('')).not.toContain(TOKEN)
      expect(h.exit).toHaveBeenCalledWith(1)
      if (result.status === 'listening') await result.stop()
    })
  })

  it('never writes the token to stdout or stderr', async () => {
    const bad = harness({ argv: ['--bogus'] })
    await start(bad.options)
    const ok = harness()
    const result = await start(ok.options)
    if (result.status === 'listening') await result.stop()
    for (const text of [...bad.out, ...bad.err, ...ok.out, ...ok.err]) {
      expect(text).not.toContain(TOKEN)
    }
  })
})

describe('stdout stays the protocol line (ADR-101)', () => {
  it('routeConsoleToStderr sends log / info / debug to stderr, formatted', () => {
    const written: string[] = []
    const target = { log: console.log, info: console.info, debug: console.debug }

    routeConsoleToStderr(target, { write: (chunk) => void written.push(chunk) })
    target.log('loaded %s in %d ms', 'recognizer', 12)
    target.info('info', { a: 1 })
    target.debug('debug')

    expect(written).toEqual(['loaded recognizer in 12 ms\n', 'info { a: 1 }\n', 'debug\n'])
  })

  it('runVoiceWorker with injected stdout leaves the process console alone (a test must not rewrite it)', async () => {
    const before = [console.log, console.info, console.debug]
    const h = harness()

    await start(h.options)

    expect([console.log, console.info, console.debug]).toEqual(before)
  })
})
