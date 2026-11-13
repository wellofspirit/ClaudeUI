/**
 * Layer 1: a branch ("fork from a message") forks from its SOURCE only until it materialises.
 * Once the engine reports the fork's own session id (the rekey), the next spawn after the
 * process ends resumes the fork itself; a fork whose first spawn failed before any id still forks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import { spawnSession } from '../../lib/session-spawn'
import { makeAssistantMessage, makeChatMessage, makeSessionStatus } from '@test/factories/messages'
import { resolvePiCapabilities } from '../../../../shared/model-capabilities'
import { resetReplicaSeam, mirrorStoreIntoReplica, seed } from '@test/helpers/replica-seed'
import type { SessionSpawnRequest } from '../../../../shared/types'

let createSession: ReturnType<typeof vi.fn>
const reqOf = (n: number): SessionSpawnRequest => createSession.mock.calls[n][1]

async function forkOf(engine: 'claude' | 'pi' = 'claude'): Promise<string> {
  useSessionStore
    .getState()
    .loadHistoricalSession(
      'src-1',
      [makeChatMessage({ id: 'u1' }), makeAssistantMessage('a', { id: 'a1' })],
      '/proj'
    )
  if (engine === 'pi') {
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'src-1': {
          ...s.sessions['src-1'],
          selectedEngineId: 'pi',
          selectedModel: 'prov/model',
          status: makeSessionStatus({ engineId: 'pi', capabilities: resolvePiCapabilities() })
        }
      }
    }))
    mirrorStoreIntoReplica()
  }
  const id = await useSessionStore.getState().forkFromMessage('src-1', 'a1')
  return id!
}

beforeEach(() => {
  resetReplicaSeam()
  createSession = vi.fn(async () => undefined)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn(),
    createSession,
    resolveForkAnchor: vi.fn(async () => ({ anchorUuid: 'anchor-1' }))
  }
  useSessionStore.setState({ activeSessionId: null, sessions: {}, recentSessionIds: [] })
  mirrorStoreIntoReplica()
})

describe('a branch across its first spawn and the next', () => {
  it('forks from the source on the first spawn, then resumes its own id after the rekey and a disconnect', async () => {
    const routingId = await forkOf()
    await spawnSession(routingId)
    expect(reqOf(0).resume).toEqual({ sessionId: 'src-1', at: 'anchor-1', fork: true })

    // The engine reports the fork's own id, then the process ends (idle timeout).
    seed.rekey(routingId, 'fork-own-id')
    seed.status(
      'fork-own-id',
      makeSessionStatus({ state: 'disconnected', sessionId: 'fork-own-id' })
    )
    const session = useSessionStore.getState().sessions['fork-own-id']
    expect(session.sdkActive).toBe(false)
    expect(session.forkOrigin).toBeNull()

    await spawnSession('fork-own-id')
    expect(reqOf(1).resume).toEqual({ sessionId: 'fork-own-id' })
  })

  it('a first spawn that failed before any id was reported still forks on the next send', async () => {
    const routingId = await forkOf()
    createSession.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(spawnSession(routingId)).rejects.toThrow('spawn failed')

    await spawnSession(routingId)
    expect(reqOf(1).resume).toEqual({ sessionId: 'src-1', at: 'anchor-1', fork: true })
  })

  it('a fork the engine rejected (it reports the SOURCE id) still forks on the next send', async () => {
    const routingId = await forkOf('pi')
    await spawnSession(routingId)
    seed.status(
      routingId,
      makeSessionStatus({
        engineId: 'pi',
        capabilities: resolvePiCapabilities(),
        state: 'idle',
        sessionId: 'src-1'
      })
    )
    seed.status('src-1', makeSessionStatus({ state: 'disconnected', sessionId: 'src-1' }))
    expect(useSessionStore.getState().sessions['src-1'].sdkActive).toBe(false)

    await spawnSession('src-1')
    expect(reqOf(1).resume).toEqual({ sessionId: 'src-1', at: 'anchor-1', fork: true })
  })

  it('a pi fork clears the pointer on the same rekey', async () => {
    const routingId = await forkOf('pi')
    expect(useSessionStore.getState().sessions[routingId].forkOrigin).not.toBeNull()
    seed.status(
      routingId,
      makeSessionStatus({
        engineId: 'pi',
        capabilities: resolvePiCapabilities(),
        state: 'idle',
        sessionId: 'pi-fork-id'
      })
    )
    expect(useSessionStore.getState().sessions['pi-fork-id'].forkOrigin).toBeNull()
  })
})
