/**
 * @vitest-environment node
 *
 * `query()` spawns the harness launch (ADR-082 §2): the resolver's launch by
 * default, a caller's `pathToClaudeCodeExecutable` as a native launch, and a
 * caller's `executable` exactly. A native launch must produce today's argv
 * byte for byte; a Node-script launch must put the script first and lay its
 * env over the caller's. Captured through the `spawnClaudeCodeProcess` hook, so
 * nothing is executed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { HarnessLaunch } from '../../harness/launch'

const locate = vi.hoisted(() => ({
  launch: { command: '/resolved/bun-claude', args: [] } as HarnessLaunch
}))
vi.mock('../locate', () => ({
  locateClaudeLaunch: () => locate.launch,
  locateBunClaude: () => locate.launch.command
}))

import { query } from '../query'
import { buildArgs } from '../args'
import type { QueryHandle, QueryOptions, SDKMessage, SpawnClaudeCodeProcess } from '../types'

interface Spawned {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

let handles: QueryHandle[] = []
afterEach(() => {
  for (const h of handles) void h[Symbol.asyncIterator]().return?.(undefined)
  handles = []
})
beforeEach(() => {
  locate.launch = { command: '/resolved/bun-claude', args: [] }
})

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new Writable({ write: (_c, _e, cb): void => cb() }),
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    kill: (): boolean => true,
    pid: 4242
  }) as unknown as ChildProcess
}

function spawnWith(options: QueryOptions): Spawned {
  let spawned: Spawned | null = null
  const hook: SpawnClaudeCodeProcess = ({ command, args, env }) => {
    spawned = { command, args, env }
    return fakeChild()
  }
  const q = query({
    prompt: (async function* () {
      /* no prompt */
    })() as AsyncIterable<SDKMessage>,
    options: { ...options, spawnClaudeCodeProcess: hook }
  })
  handles.push(q)
  if (!spawned) throw new Error('nothing spawned')
  return spawned
}

describe('query() launch', () => {
  it('spawns the resolver launch with the same argv as before', () => {
    const { command, args } = spawnWith({ standaloneExecutable: true, env: {} })
    expect(command).toBe('/resolved/bun-claude')
    expect(args).toEqual(buildArgs({ standaloneExecutable: true, env: {} }))
  })

  it('spawns a node-script launch as [node, script, ...args] with its env over the caller env', () => {
    locate.launch = {
      command: '/usr/bin/node',
      args: ['/pkg/cli.js'],
      env: { LAUNCH_MARKER: '1', CALLER: 'launch-wins' }
    }
    const { command, args, env } = spawnWith({ env: { CALLER: 'caller', OTHER: 'kept' } })
    expect(command).toBe('/usr/bin/node')
    expect(args).toEqual(['/pkg/cli.js', ...buildArgs({})])
    expect(env?.LAUNCH_MARKER).toBe('1')
    expect(env?.CALLER).toBe('launch-wins')
    expect(env?.OTHER).toBe('kept')
  })

  it('treats pathToClaudeCodeExecutable as a native launch, ignoring the resolver', () => {
    locate.launch = { command: '/usr/bin/node', args: ['/pkg/cli.js'], env: { LAUNCH_MARKER: '1' } }
    const { command, args, env } = spawnWith({ pathToClaudeCodeExecutable: '/caller/claude' })
    expect(command).toBe('/caller/claude')
    expect(args).toEqual(buildArgs({}))
    expect(env?.LAUNCH_MARKER).toBeUndefined()
  })

  it('spawns an explicit executable exactly, executableArgs first', () => {
    const { command, args } = spawnWith({
      executable: '/custom/runner',
      executableArgs: ['--flag'],
      pathToClaudeCodeExecutable: '/caller/cli.js',
      standaloneExecutable: false
    })
    expect(command).toBe('/custom/runner')
    expect(args).toEqual(['--flag', '/caller/cli.js', ...buildArgs({})])
  })

  it('keeps the legacy script argv for a non-standalone resolver launch', () => {
    const { command, args } = spawnWith({ standaloneExecutable: false })
    expect(command).toBe('/resolved/bun-claude')
    expect(args).toEqual(['/resolved/bun-claude', ...buildArgs({})])
  })
})
