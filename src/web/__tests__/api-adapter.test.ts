/**
 * Layer 1 unit tests for the web ClaudeAPI adapter.
 *
 * Focus: the git live-watching methods. They used to be `async () => {}`
 * no-ops ("Git polling not supported in remote"), so `gitStatus` in the store
 * stayed null forever and GitChangesPill — which bails on a null status — never
 * rendered on the remote web client at any width. They now invoke the real
 * channels, which the remote server routes into the shared gitWatchRegistry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createWebSocketApi } from '../api-adapter'
import { SyncClient } from '../../shared/sync/sync-client'
import type { RemoteConnection } from '../connection'

type FakeConnection = {
  invoke: ReturnType<typeof vi.fn>
  on: RemoteConnection['on']
  /** Push a server event to the api's listeners. */
  push: (channel: string, ...args: unknown[]) => void
}

/**
 * Fake transport around the REAL protocol core — the adapter now registers its
 * listeners on the connection's SyncClient, so `push` delivers an event exactly
 * the way a server frame does (readiness gate opened: the app is "mounted").
 */
function makeConnection(): FakeConnection {
  const sync = new SyncClient({ requestResync: () => {} })
  sync.markReady()
  let seq = 0
  return {
    invoke: vi.fn(async () => undefined),
    on: (channel) => sync.on(channel),
    push: (channel, ...args) => sync.receiveEvent({ seq: ++seq, channel, args })
  }
}

let connection: FakeConnection
let api: ReturnType<typeof createWebSocketApi>

beforeEach(() => {
  connection = makeConnection()
  api = createWebSocketApi(connection as unknown as RemoteConnection)
})

describe('web api-adapter — git live watching', () => {
  it('gitStartWatching invokes git:start-watching with the cwd (GUARD)', async () => {
    await api.gitStartWatching('/repo/app')
    expect(connection.invoke).toHaveBeenCalledWith('git:start-watching', '/repo/app')
  })

  it('gitStopWatching invokes git:stop-watching with the cwd (GUARD)', async () => {
    await api.gitStopWatching('/repo/app')
    expect(connection.invoke).toHaveBeenCalledWith('git:stop-watching', '/repo/app')
  })

  it('surfaces a safeHandler error envelope as a rejection', async () => {
    connection.invoke.mockResolvedValueOnce({ ok: false, error: 'not a repo' })
    await expect(api.gitStartWatching('/repo/app')).rejects.toThrow('not a repo')
  })

  it('delivers git:status-update pushes to onGitStatusUpdate subscribers', () => {
    const seen: unknown[] = []
    const off = api.onGitStatusUpdate((data) => seen.push(data))
    connection.push('git:status-update', { cwd: '/repo/app', status: { files: [] } })
    expect(seen).toEqual([{ cwd: '/repo/app', status: { files: [] } }])
    off()
    connection.push('git:status-update', { cwd: '/repo/app', status: { files: [] } })
    expect(seen).toHaveLength(1)
  })
})
