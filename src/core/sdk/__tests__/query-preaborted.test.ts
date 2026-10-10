/**
 * @vitest-environment node
 *
 * A signal that is ALREADY aborted when `query()` is called must not spawn. An abort
 * listener never fires for an aborted signal, so without the check a run cancelled
 * while its caller awaited a token refresh or a catalog fetch ran its whole prompt
 * regardless. The stream then ends the way an abort mid-run ends it: cleanly.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

vi.mock('../locate', () => ({
  locateClaudeLaunch: () => ({ command: '/resolved/bun-claude', args: [] }),
  locateBunClaude: () => '/resolved/bun-claude'
}))

import { query } from '../query'
import type { SpawnClaudeCodeProcess } from '../types'

function liveChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new Writable({ write: (_c, _e, cb): void => cb() }),
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    kill: (): boolean => true,
    pid: 4242
  }) as unknown as ChildProcess
}

describe('query() with an already-aborted signal', () => {
  it('spawns nothing and ends the stream cleanly (GUARD)', async () => {
    const spawned = vi.fn<SpawnClaudeCodeProcess>(() => liveChild())
    const abortController = new AbortController()
    abortController.abort()

    const q = query({
      prompt: 'do the thing',
      options: { abortController, spawnClaudeCodeProcess: spawned }
    })

    // Pre-fix: the hook ran, a real run started, and this iteration never ended.
    const messages: unknown[] = []
    for await (const m of q) messages.push(m)
    expect(messages).toEqual([])
    expect(spawned).not.toHaveBeenCalled()
  })

  it('answers the init accessors with empty instead of hanging', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const abortController = new AbortController()
      abortController.abort()
      const q = query({
        prompt: '',
        options: { abortController, spawnClaudeCodeProcess: () => liveChild() }
      })
      await expect(q.supportedModels()).resolves.toEqual([])
    } finally {
      errors.mockRestore()
    }
  })

  it('still spawns when the signal is not aborted', () => {
    const spawned = vi.fn<SpawnClaudeCodeProcess>(() => liveChild())
    const q = query({
      prompt: '',
      options: { abortController: new AbortController(), spawnClaudeCodeProcess: spawned }
    })
    expect(spawned).toHaveBeenCalledTimes(1)
    void q[Symbol.asyncIterator]().return?.(undefined)
  })
})
