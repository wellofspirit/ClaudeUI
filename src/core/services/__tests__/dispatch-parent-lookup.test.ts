/**
 * @vitest-environment node
 *
 * The production wiring of a dispatch run to its dispatching session (ADR-105 §1):
 * emits go out under the parent's id, the session object is whatever the manager has now,
 * and a disconnected parent's transcript is read from its engine's history.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeDispatchParentLookup } from '../dispatch-parent-lookup'
import type { LiveParentSession } from '../dispatch-parent'
import type { ChatMessage, EngineId } from '../../../shared/types'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const message = (id: string): ChatMessage => ({
  id,
  role: 'user',
  content: [{ type: 'text', text: id }],
  timestamp: 0
})

describe('makeDispatchParentLookup', () => {
  it('emits through emitEvent with the parent id as args[0], the wire form a session’s own send uses', () => {
    const emitEvent = vi.fn()
    const lookup = makeDispatchParentLookup({
      getSession: () => undefined,
      emitEvent,
      canonical: () => undefined
    })
    lookup.emit('uuid-1', 'session:task-started', { toolUseId: 't1' })
    expect(emitEvent).toHaveBeenCalledWith('session:task-started', ['uuid-1', { toolUseId: 't1' }])
  })

  it('answers with whatever session object the manager has at that moment', () => {
    let current: LiveParentSession | undefined = { getMessages: () => [] }
    const lookup = makeDispatchParentLookup({
      getSession: () => current,
      emitEvent: vi.fn(),
      canonical: () => undefined
    })
    const first = lookup.session('p')
    current = { getMessages: () => [message('new')] }
    expect(lookup.session('p')).not.toBe(first)
    expect(lookup.session('p')!.getMessages()[0].id).toBe('new')
    current = undefined
    expect(lookup.session('p')).toBeUndefined()
  })

  it('reads canonical’s transcript, and an absent session as empty', () => {
    const lookup = makeDispatchParentLookup({
      getSession: () => undefined,
      emitEvent: vi.fn(),
      canonical: (id) => (id === 'p' ? { messages: [message('c1')], cwd: '/proj' } : undefined)
    })
    expect(lookup.canonicalMessages!('p').map((m) => m.id)).toEqual(['c1'])
    expect(lookup.canonicalMessages!('other')).toEqual([])
  })

  it('reads the history cold from canonical’s cwd and engine; nothing to read without them', async () => {
    const readHistory = vi.fn(async () => [message('h1')])
    const lookup = makeDispatchParentLookup({
      getSession: () => undefined,
      emitEvent: vi.fn(),
      canonical: (id) =>
        id === 'p' ? { messages: [], cwd: '/proj', engineId: 'pi' as EngineId } : undefined,
      readHistory
    })
    expect((await lookup.readMessages!('p')).map((m) => m.id)).toEqual(['h1'])
    expect(readHistory).toHaveBeenCalledWith('p', '/proj', 'pi')
    expect(await lookup.readMessages!('gone')).toEqual([])
    expect(readHistory).toHaveBeenCalledTimes(1)
  })
})
