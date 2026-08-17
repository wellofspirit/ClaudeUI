/**
 * @vitest-environment node
 *
 * Seam test for EngineRegistry.createSession's positional-args → opts-object
 * factory contract (Item 6b). Deliberately does NOT import register-engines —
 * this registry instance starts with no factories registered, so we can
 * assert both the happy path (a registered factory) and the unregistered
 * path ('opencode') without any mocking.
 */
import { describe, it, expect } from 'vitest'
import { engineRegistry } from '../EngineRegistry'
import type { ISession, EngineSpawnOptions } from '../ISession'

describe('EngineRegistry.createSession — opts-object factory contract', () => {
  it('passes routingId, win, cwd, and the SAME opts object through to the factory', () => {
    let received: unknown[] = []
    engineRegistry.register('claude', (...args) => {
      received = args
      return {} as ISession
    })

    const win = {} as never
    const opts: EngineSpawnOptions = { model: 'm1', forkSession: true }
    engineRegistry.createSession('claude', 'rid-1', win, '/cwd', opts)

    expect(received).toEqual(['rid-1', win, '/cwd', opts])
    expect(received[3]).toBe(opts)
  })

  it('throws for an unregistered engine id', () => {
    expect(() =>
      engineRegistry.createSession('opencode', 'rid-2', {} as never, '/cwd', {})
    ).toThrow(/No session factory registered/)
  })
})
