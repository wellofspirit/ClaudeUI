/**
 * @vitest-environment node
 *
 * `claude-mcp-cli.ts` against a fake child process: the argv (the JSON as ONE
 * element, `--` before the operands), the env cli.js is launched with, and the
 * failure paths. The real vendored binary is exercised by
 * `src/integration/sdk-contract/mcp-cli-writer.integration.test.ts`.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { spawn } from 'node:child_process'
import {
  addJsonArgs,
  addMcpServerNative,
  removeArgs,
  removeMcpServerNative
} from '../claude-mcp-cli'

const killTree = vi.hoisted(() => vi.fn())
vi.mock('../process-tree', () => ({ killProcessTree: killTree }))

interface FakeRun {
  spawnFn: typeof spawn
  calls: Array<{ command: string; args: string[]; opts: Record<string, unknown> }>
  child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }
}

function fakeSpawn(): FakeRun {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  const calls: FakeRun['calls'] = []
  const spawnFn = ((command: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ command, args, opts })
    return child
  }) as unknown as typeof spawn
  return { spawnFn, calls, child }
}

const launch = { command: 'C:/cc/bun-claude.exe', args: [] as string[] }

describe('claude-mcp-cli argv', () => {
  it('passes the JSON as a single argv element after `--`, so a name or value starting with - cannot be an option', () => {
    const config = { type: 'http' as const, url: 'https://x.test/mcp', headers: { A: 'b c "d"' } }
    expect(addJsonArgs('local', '-weird', config)).toEqual([
      'mcp',
      'add-json',
      '-s',
      'local',
      '--',
      '-weird',
      JSON.stringify(config)
    ])
    expect(removeArgs('user', 'srv')).toEqual(['mcp', 'remove', '-s', 'user', '--', 'srv'])
  })
})

describe('claude-mcp-cli without a cwd', () => {
  it('refuses project and local scope instead of running in the Electron cwd', async () => {
    const run = fakeSpawn()
    const deps = { launch, spawnFn: run.spawnFn }
    for (const scope of ['project', 'local'] as const) {
      expect(
        (await addMcpServerNative(scope, 's', { command: 'x' }, undefined, deps)).error
      ).toMatch(/need an open project/)
      expect((await removeMcpServerNative(scope, 's', undefined, deps)).error).toMatch(
        /need an open project/
      )
    }
    expect(run.calls).toHaveLength(0)
  })

  it('still runs user scope', async () => {
    const run = fakeSpawn()
    const p = removeMcpServerNative('user', 's', undefined, { launch, spawnFn: run.spawnFn })
    run.child.emit('close', 0)
    await expect(p).resolves.toEqual({})
    expect(run.calls).toHaveLength(1)
  })
})

describe('claude-mcp-cli run', () => {
  it('spawns the resolved launch with no shell, the session cwd and the unattended env', async () => {
    const run = fakeSpawn()
    const p = addMcpServerNative('project', 'srv', { command: 'x' }, '/repo', {
      launch,
      spawnFn: run.spawnFn,
      env: { KEEP: '1', NODE_OPTIONS: '--inspect' }
    })
    run.child.emit('close', 0)
    await expect(p).resolves.toEqual({})

    const [call] = run.calls
    expect(call.command).toBe(launch.command)
    expect(call.args.slice(0, 5)).toEqual(['mcp', 'add-json', '-s', 'project', '--'])
    expect(call.opts).toMatchObject({ cwd: '/repo', shell: false })
    const env = call.opts.env as Record<string, string>
    expect(env).toMatchObject({
      KEEP: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    })
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it("returns cli.js's own text when it exits non-zero", async () => {
    const run = fakeSpawn()
    const p = removeMcpServerNative('user', 'nope', '/repo', { launch, spawnFn: run.spawnFn })
    run.child.stderr.write('No MCP server named "nope" in user config\n')
    run.child.emit('close', 1)
    await expect(p).resolves.toEqual({ error: 'No MCP server named "nope" in user config' })
  })

  it('names the exit code when cli.js said nothing', async () => {
    const run = fakeSpawn()
    const p = removeMcpServerNative('user', 'nope', '/repo', { launch, spawnFn: run.spawnFn })
    run.child.emit('close', 3)
    expect((await p).error).toMatch(/exited with code 3/)
  })

  it('kills the process tree and reports a timeout', async () => {
    vi.useFakeTimers()
    try {
      const run = fakeSpawn()
      const p = addMcpServerNative('user', 'srv', { command: 'x' }, undefined, {
        launch,
        spawnFn: run.spawnFn,
        timeoutMs: 1000
      })
      await vi.advanceTimersByTimeAsync(1001)
      expect((await p).error).toMatch(/did not finish within 1 s/)
      expect(killTree).toHaveBeenCalledWith(run.child)
      // a late close must not flip the settled result
      run.child.emit('close', 0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a spawn failure instead of throwing', async () => {
    const spawnFn = (() => {
      throw new Error('spawn ENOENT')
    }) as unknown as typeof spawn
    await expect(
      addMcpServerNative('user', 'srv', { command: 'x' }, undefined, { launch, spawnFn })
    ).resolves.toEqual({ error: 'spawn ENOENT' })
  })
})
