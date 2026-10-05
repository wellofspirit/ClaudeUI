/**
 * @vitest-environment node
 *
 * `ensureClaudeModels` bounds the wait for the init-only cli.js query. The timeout
 * can land while `queryClaudeModels` is still inside `ensureHostTokenFresh()` — before
 * any child exists — so the abort has nothing to kill at that moment. The query that
 * is built afterwards must not spawn at all (the real `query()` is used; only the
 * spawn is captured), or the init-only cli.js would be orphaned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

const gate = vi.hoisted(() => ({
  release: null as null | (() => void),
  spawned: 0
}))

vi.mock('../../../core/sdk/locate', () => ({
  locateClaudeLaunch: () => ({ command: '/resolved/bun-claude', args: [] }),
  locateBunClaude: () => '/resolved/bun-claude'
}))

vi.mock('../../../core/sdk/host-token', async () => {
  const actual = await vi.importActual<typeof import('../../../core/sdk/host-token')>(
    '../../../core/sdk/host-token'
  )
  return {
    ...actual,
    // A slow token refresh: resolves when the test says so.
    ensureHostTokenFresh: (): Promise<void> => new Promise((resolve) => (gate.release = resolve))
  }
})

vi.mock('../../../core/services/claude-session', () => ({
  getSdkExecutableOpts: () => ({
    spawnClaudeCodeProcess: (): ChildProcess => {
      gate.spawned++
      return Object.assign(new EventEmitter(), {
        stdin: new Writable({ write: (_c, _e, cb): void => cb() }),
        stdout: new Readable({ read() {} }),
        stderr: new Readable({ read() {} }),
        kill: (): boolean => {
          return true
        },
        pid: 4242
      }) as unknown as ChildProcess
    }
  })
}))

import {
  ensureClaudeModels,
  freshClaudeModels,
  resetCachedClaudeModels
} from '../../../core/services/claude-model-catalog'

beforeEach(() => {
  gate.release = null
  gate.spawned = 0
  resetCachedClaudeModels()
})

describe('ensureClaudeModels — timeout during a slow token refresh', () => {
  it('gives up on time and leaves no child behind (GUARD)', async () => {
    const onError = vi.fn()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const models = await ensureClaudeModels(onError, 20)
      expect(models).toEqual([])
      expect(onError).toHaveBeenCalledTimes(1)
      expect(String(onError.mock.calls[0][0])).toMatch(/timed out/)

      // The token refresh finally lands, after the timeout aborted the flight.
      expect(gate.release).not.toBeNull()
      gate.release?.()
      await new Promise((r) => setTimeout(r, 30))

      // Pre-fix: the query was built with an aborted signal and spawned anyway,
      // and nothing ever killed that child.
      expect(gate.spawned).toBe(0)
      // And its `[]` (the aborted query never asked cli.js) is not cached as a fresh
      // catalog, which would serve the desktop picker nothing for the whole TTL.
      expect(freshClaudeModels(60_000)).toBeNull()
    } finally {
      errors.mockRestore()
    }
  })
})
