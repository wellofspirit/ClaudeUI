/**
 * @vitest-environment node
 *
 * Framing/correlation unit tests for PiRpcClient, against a FAKE child process
 * (node:child_process's `spawn` is mocked) — no real pi binary involved. Covers:
 * chunk-split lines, CRLF stripping, id correlation, request timeout, and
 * non-JSON line tolerance (never crashes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))

vi.mock('node:child_process', () => ({
  spawn: mockSpawn
}))

vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

function makeFakeProc(): any {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (enc: string) => void }
    stderr: EventEmitter & { setEncoding: (enc: string) => void }
    stdin: { writable: boolean; write: ReturnType<typeof vi.fn> }
    pid: number
    kill: ReturnType<typeof vi.fn>
  }
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void }
  stdout.setEncoding = vi.fn()
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void }
  stderr.setEncoding = vi.fn()
  proc.stdout = stdout
  proc.stderr = stderr
  proc.stdin = { writable: true, write: vi.fn() }
  proc.pid = 4242
  proc.kill = vi.fn()
  return proc
}

let currentFakeProc: any

beforeEach(() => {
  mockSpawn.mockReset()
  currentFakeProc = null
  mockSpawn.mockImplementation(() => {
    const proc = makeFakeProc()
    currentFakeProc = proc
    // Defer 'spawn' so PiRpcClient.start()'s synchronous listener wiring
    // (this.proc = proc; .once('spawn', resolve); .on('exit', …)) completes first.
    process.nextTick(() => proc.emit('spawn'))
    return proc
  })
})

async function startClient(): Promise<{ client: import('../PiRpcClient').PiRpcClient; proc: ReturnType<typeof makeFakeProc> }> {
  const { PiRpcClient } = await import('../PiRpcClient')
  const client = new PiRpcClient('/fake/pi', { cwd: '/tmp', args: ['--mode', 'rpc'] })
  await client.start()
  return { client, proc: currentFakeProc }
}

/** Extract the last JSON object written to stdin, and its `id`. */
function lastWrittenCommand(proc: ReturnType<typeof makeFakeProc>): Record<string, unknown> {
  const calls = proc.stdin.write.mock.calls
  const lastLine = calls[calls.length - 1][0] as string
  return JSON.parse(lastLine.trimEnd())
}

describe('PiRpcClient — framing', () => {
  it('reassembles a JSON line split across multiple stdout chunks', async () => {
    const { client, proc } = await startClient()
    const events: unknown[] = []
    client.onEvent((ev) => events.push(ev))

    const line = JSON.stringify({ type: 'agent_start' })
    proc.stdout.emit('data', line.slice(0, 5))
    proc.stdout.emit('data', line.slice(5, 12))
    proc.stdout.emit('data', line.slice(12) + '\n')

    expect(events).toEqual([{ type: 'agent_start' }])
  })

  it('strips a trailing \\r (CRLF input) before parsing', async () => {
    const { client, proc } = await startClient()
    const events: unknown[] = []
    client.onEvent((ev) => events.push(ev))

    proc.stdout.emit('data', JSON.stringify({ type: 'agent_settled' }) + '\r\n')

    expect(events).toEqual([{ type: 'agent_settled' }])
  })

  it('tolerates a non-JSON stdout line without crashing or emitting anything', async () => {
    const { client, proc } = await startClient()
    const events: unknown[] = []
    client.onEvent((ev) => events.push(ev))

    expect(() => proc.stdout.emit('data', 'not json at all\n')).not.toThrow()
    expect(events).toEqual([])

    // The client must still work for subsequent well-formed lines.
    proc.stdout.emit('data', JSON.stringify({ type: 'agent_start' }) + '\n')
    expect(events).toEqual([{ type: 'agent_start' }])
  })

  it('does not split on U+2028/U+2029 inside a JSON string (readline would)', async () => {
    const { client, proc } = await startClient()
    const events: unknown[] = []
    client.onEvent((ev) => events.push(ev))

    const payload = JSON.stringify({ type: 'extension_error', extensionPath: 'x', event: 'y', error: 'a b' })
    proc.stdout.emit('data', payload + '\n')

    expect(events).toEqual([{ type: 'extension_error', extensionPath: 'x', event: 'y', error: 'a b' }])
  })

  it('routes only non-response lines to onEvent (response lines are NOT events)', async () => {
    const { client, proc } = await startClient()
    const events: unknown[] = []
    client.onEvent((ev) => events.push(ev))

    proc.stdout.emit('data', JSON.stringify({ type: 'response', id: 'r1', command: 'abort', success: true }) + '\n')
    expect(events).toEqual([])
  })

  it('dispatches multiple complete JSON lines delivered in ONE stdout chunk, all in order', async () => {
    const { client, proc } = await startClient()
    const events: unknown[] = []
    client.onEvent((ev) => events.push(ev))

    const chunk =
      JSON.stringify({ type: 'agent_start' }) +
      '\n' +
      JSON.stringify({ type: 'turn_start' }) +
      '\n' +
      JSON.stringify({ type: 'agent_settled' }) +
      '\n'
    proc.stdout.emit('data', chunk)

    expect(events).toEqual([{ type: 'agent_start' }, { type: 'turn_start' }, { type: 'agent_settled' }])
  })
})

describe('PiRpcClient — request/response correlation', () => {
  it('auto-assigns an id and resolves the matching request on a correlated response', async () => {
    const { client, proc } = await startClient()

    const promise = client.request({ type: 'get_state' })
    const written = lastWrittenCommand(proc)
    expect(written.type).toBe('get_state')
    expect(typeof written.id).toBe('string')

    proc.stdout.emit(
      'data',
      JSON.stringify({ type: 'response', id: written.id, command: 'get_state', success: true, data: { foo: 1 } }) + '\n'
    )

    await expect(promise).resolves.toEqual({
      type: 'response',
      id: written.id,
      command: 'get_state',
      success: true,
      data: { foo: 1 }
    })
  })

  it('correlates two concurrent requests independently, even when responses arrive out of order', async () => {
    const { client, proc } = await startClient()

    const p1 = client.request({ type: 'get_state' })
    const id1 = lastWrittenCommand(proc).id as string
    const p2 = client.request({ type: 'get_session_stats' })
    const id2 = lastWrittenCommand(proc).id as string
    expect(id1).not.toBe(id2)

    // Respond to the SECOND request first.
    proc.stdout.emit(
      'data',
      JSON.stringify({ type: 'response', id: id2, command: 'get_session_stats', success: true, data: { n: 2 } }) + '\n'
    )
    proc.stdout.emit(
      'data',
      JSON.stringify({ type: 'response', id: id1, command: 'get_state', success: true, data: { n: 1 } }) + '\n'
    )

    await expect(p2).resolves.toMatchObject({ data: { n: 2 } })
    await expect(p1).resolves.toMatchObject({ data: { n: 1 } })
  })

  it('resolves (does not reject) on success:false — the caller decides what failure means', async () => {
    const { client, proc } = await startClient()
    const promise = client.request({ type: 'set_model', provider: 'x', modelId: 'y' })
    const id = lastWrittenCommand(proc).id as string
    proc.stdout.emit(
      'data',
      JSON.stringify({ type: 'response', id, command: 'set_model', success: false, error: 'Model not found' }) + '\n'
    )
    await expect(promise).resolves.toEqual({
      type: 'response',
      id,
      command: 'set_model',
      success: false,
      error: 'Model not found'
    })
  })

  it('rejects on timeout when no response arrives', async () => {
    const { client } = await startClient()
    await expect(client.request({ type: 'get_state' }, 10)).rejects.toThrow(/timed out/)
  })

  it('rejects a pending request when the process exits', async () => {
    const { client, proc } = await startClient()
    const promise = client.request({ type: 'get_state' })
    proc.emit('exit', 1, null)
    await expect(promise).rejects.toThrow(/exited/)
  })
})

describe('PiRpcClient — dispose / onExit', () => {
  it('onExit fires with the exit code/signal', async () => {
    const { client, proc } = await startClient()
    const exits: Array<[number | null, NodeJS.Signals | null]> = []
    client.onExit((code, signal) => exits.push([code, signal]))
    proc.emit('exit', 0, null)
    expect(exits).toEqual([[0, null]])
  })

  it('dispose() terminates the process (SIGTERM off-Windows, taskkill tree-kill on Windows)', async () => {
    const { client, proc } = await startClient()
    mockSpawn.mockClear() // isolate any taskkill spawn from the initial pi spawn
    client.dispose()
    if (process.platform === 'win32') {
      // Windows: taskkill reaps the whole tree (M-PI3); it fires 'exit' itself.
      expect(mockSpawn).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', String(proc.pid), '/T', '/F'],
        expect.objectContaining({ stdio: 'ignore' })
      )
    } else {
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    }
  })

  it('dispose() on Windows tree-kills via taskkill and does NOT pre-empt with proc.kill (M-PI3)', async () => {
    if (process.platform !== 'win32') return
    const { client, proc } = await startClient()
    mockSpawn.mockClear() // isolate the taskkill spawn call from the initial pi spawn
    client.dispose()
    expect(mockSpawn).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', String(proc.pid), '/T', '/F'],
      expect.objectContaining({ stdio: 'ignore' })
    )
    // The whole point of M-PI3: proc.kill() must NOT run before taskkill (it
    // would kill the root synchronously and orphan the tree).
    expect(proc.kill).not.toHaveBeenCalled()
  })
})
