/**
 * @vitest-environment node
 *
 * The production wiring of the first-contact copy cleanup (S7 review 5):
 * importing the credential module installs the hook on the real server
 * manager, and a real manager start runs `deleteProvenCopies` before the
 * first acquire resolves — and refuses to count a server as clean while the
 * recogniser is not wired. Fake spawn, fake credential table, fake tokens.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  OpencodeServerManager,
  OpencodeCredentialCleanupError,
  opencodeServerManager,
  type SpawnServerFn
} from '../OpencodeServerManager'
import { installCopyCleanupHook, opencodeCredentialStore } from '../opencode-credentials'
import { OpencodeCredentialStore, memorySlotMemory } from '../credential-store'
import { fakeChatgptJwt, fakeCredentialTable } from './fixtures/fake-credential-table'

function fakeManager(order: string[]): OpencodeServerManager {
  let port = 41000
  const spawnFn: SpawnServerFn = async () => {
    const child = new EventEmitter() as unknown as ChildProcess
    child.kill = (() => true) as ChildProcess['kill']
    return { process: child, baseUrl: `http://127.0.0.1:${port++}` }
  }
  return new OpencodeServerManager({
    spawnFn,
    locateBinaryFn: () => '/fake/opencode',
    startMcpHostFn: async () => ({ port: 1, token: 't', close: async () => {} }),
    configInputFn: () => ({ pluginDir: '/res/claudeui-xeng' }),
    waitReadyFn: async () => {
      order.push('readiness (a location request)')
      return { state: 'ready', signal: 'registry', elapsedMs: 1 }
    },
    waitGuardFn: async () => ({ state: 'active', elapsedMs: 0 }),
    endServerFn: () => {},
    serverCwd: '/server-home'
  })
}

const copy = {
  id: 'cred_imported',
  integrationID: 'openai',
  label: 'imported',
  value: {
    type: 'oauth' as const,
    methodID: 'chatgpt-browser',
    refresh: 'rt-vault',
    access: fakeChatgptJwt('acct-1', 1),
    expires: 1
  }
}

describe('first-contact hook wiring', () => {
  it('importing the credential module installs the hook on the real manager', () => {
    const hook = (opencodeServerManager as unknown as { serverStartedHook?: unknown })
      .serverStartedHook
    expect(typeof hook).toBe('function')
    expect(opencodeCredentialStore).toBeInstanceOf(OpencodeCredentialStore)
  })

  it('a real manager start deletes the proven copy BEFORE the first acquire resolves', async () => {
    const order: string[] = []
    const table = fakeCredentialTable()
    table.seed(copy)
    const store = new OpencodeCredentialStore({
      connect: table.connect,
      memory: memorySlotMemory(),
      isClaudeuiToken: (refresh) => refresh === 'rt-vault'
    })
    const manager = fakeManager(order)
    const api = table.api
    const remove = api.remove
    api.remove = async (id) => {
      order.push(`remove ${id}`)
      return remove(id)
    }
    installCopyCleanupHook(manager, store, () => api)
    await manager.acquire('/a')
    order.push('acquired')
    expect(order).toEqual(['remove cred_imported', 'readiness (a location request)', 'acquired'])
    expect(table.rows()).toEqual([])
  })

  it('without the recogniser the hook fails, so the server never counts as clean (fail closed)', async () => {
    vi.useFakeTimers()
    try {
      const order: string[] = []
      const table = fakeCredentialTable()
      const store = new OpencodeCredentialStore({ connect: table.connect })
      const manager = fakeManager(order)
      installCopyCleanupHook(manager, store, () => table.api)
      const caught = manager.acquire('/a').catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await caught).toBeInstanceOf(OpencodeCredentialCleanupError)
      expect(order).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
