/**
 * @vitest-environment node
 *
 * Session refs and links (slice 1b, spec §4/§5; groups in slice 5): ref assignment and
 * shape, `resolveRef`, the link state machine against the real funnel (status,
 * rekey, removal), the replicated payload and its snapshot round trip, the
 * session card, grouping (the group head, detach / add), and the set-grouped command.
 *
 * The tables are the real ones (the node:sqlite-backed driver the suite aliases
 * `better-sqlite3` to) in a throwaway profile that outlives a test, so every case
 * uses ids of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineId, SessionStatus } from '../../../shared/types'
import { REF_PATTERN } from '../../../shared/session-links'
import { fromSnapshot, toSnapshot } from '../../shared/sync/state'
import { CommandRegistry, makeRemoteConnection } from '../../ipc/command-registry'
import { RemoteDispatcher } from '../remote-dispatcher'
import { addSyncSubscriber, emitEvent, syncCore } from '../sync-host'
import {
  findSessionRef,
  getSessionLink,
  getSessionRef,
  insertSessionRef,
  upsertSessionLink
} from '../db'
import {
  awaitingClientPrompt,
  groupHeadOf,
  groupOf,
  linkChild,
  linkPayload,
  linksOf,
  noteClientPrompt,
  recordLink,
  refFor,
  resetSessionLinksForTests,
  resolveRef,
  seedLinkState,
  sessionCardId,
  setLinkGrouped,
  setLinkState,
  setSessionGrouped,
  withSessionCards
} from '../session-links'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

let n = 0
/** A fresh id per call: the profile's tables outlive a test. */
const id = (label: string): string => `${label}-${process.pid}-${++n}`

function status(sessionId: string | null, state: SessionStatus['state'] = 'idle'): SessionStatus {
  return {
    state,
    sessionId,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId: 'claude',
    account: null
  } as SessionStatus
}

/** A session canonical knows, under a routing id the engine has not yet replaced. */
function born(routingId: string, engine: EngineId = 'claude'): string {
  emitEvent('session:created', [routingId, { cwd: '/proj', engineId: engine }])
  return routingId
}

let linkEvents: unknown[]
let stopSubscriber: () => void

beforeEach(() => {
  syncCore.resetCanonicalForTests()
  resetSessionLinksForTests()
  linkEvents = []
  stopSubscriber = addSyncSubscriber((_seq, channel, args) => {
    if (channel === 'session:link-changed') linkEvents.push(args[0])
  })
})

afterEach(() => {
  stopSubscriber()
})

const canonical = (): ReturnType<typeof syncCore.getCanonicalState> => syncCore.getCanonicalState()

describe('refs', () => {
  it('assigns each session one ref, well formed, unique and never shaped like cli.js’s local_ ids', () => {
    const refs = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const sid = id('cold')
      const ref = refFor('claude', sid)
      expect(ref).toMatch(REF_PATTERN)
      expect(ref.startsWith('local_')).toBe(false)
      expect(refFor('claude', sid)).toBe(ref)
      refs.add(ref)
    }
    expect(refs.size).toBe(300)
  })

  it('records a session still on its temporary routing id as a routing id only, and the rekey binds the real one', () => {
    const temp = born(id('temp'))
    const ref = refFor('claude', temp)
    expect(getSessionRef(ref)).toMatchObject({ routingId: temp, sessionId: null })

    const real = id('thread')
    emitEvent('session:status', [temp, status(real)])

    expect(getSessionRef(ref)).toMatchObject({ routingId: real, sessionId: real })
    expect(findSessionRef(temp)).toBeUndefined()
    const resolved = resolveRef(ref)
    expect(resolved).toMatchObject({ ok: true, ref, id: real })
  })

  it('binds both ids for a session canonical has not seen (a cold one)', () => {
    const cold = id('cold')
    const ref = refFor('opencode', cold)
    expect(getSessionRef(ref)).toMatchObject({
      engine: 'opencode',
      routingId: cold,
      sessionId: cold
    })
  })
})

describe('the engine a ref records', () => {
  it('is the birth engine for a session that has not reported a status yet (Codex starts lazily)', () => {
    const codex = born(id('codex'), 'codex')
    expect(canonical().sessions[codex].status.engineId).toBe('claude') // canonical's default
    const resolved = resolveRef(codex)
    expect(resolved).toMatchObject({ ok: true, engine: 'codex' })
    if (!resolved.ok) throw new Error('unreachable')
    expect(getSessionRef(resolved.ref)?.engine).toBe('codex')
  })

  it('records a parent’s birth engine when a child is linked under a session that never reported', () => {
    const parent = born(id('parent'), 'opencode')
    const child = born(id('child'))
    const { parentRef } = linkChild({
      parent,
      childRoutingId: child,
      engine: 'claude',
      kind: 'started',
      createdBy: 'agent',
      grouped: true
    })
    expect(getSessionRef(parentRef)?.engine).toBe('opencode')
  })

  it('follows the status once the session has reported its own', () => {
    const live = born(id('live'), 'pi')
    emitEvent('session:status', [live, { ...status(live), engineId: 'pi' }])
    expect(resolveRef(live)).toMatchObject({ ok: true, engine: 'pi' })
  })
})

describe('resolveRef', () => {
  it('accepts a ref, a live routing id and a durable session id', () => {
    const live = born(id('live'))
    emitEvent('session:status', [live, status(live)])
    const coldId = id('cold')
    syncCore.setDirectories([
      {
        cwd: '/proj',
        projectKey: 'proj',
        folderName: 'proj',
        sessions: [
          {
            sessionId: coldId,
            cwd: '/proj',
            projectKey: 'proj',
            title: 'Cold one',
            timestamp: 1,
            lastActivityAt: 1,
            engineId: 'pi'
          }
        ]
      }
    ])

    const byId = resolveRef(live)
    expect(byId).toMatchObject({ ok: true, id: live })
    if (!byId.ok) throw new Error('unreachable')
    expect(resolveRef(byId.ref)).toMatchObject({ ok: true, ref: byId.ref, id: live })

    const cold = resolveRef(coldId)
    expect(cold).toMatchObject({ ok: true, id: coldId, engine: 'pi' })
  })

  it('accepts an exact, unique title and says which sessions share one that is not', () => {
    const a = born(id('a'))
    const b = born(id('b'))
    const c = born(id('c'))
    emitEvent('config:sessions-changed', [
      { customTitles: { [a]: 'Release notes', [b]: 'Triage', [c]: 'Triage' } }
    ])

    expect(resolveRef('Release notes')).toMatchObject({ ok: true, id: a })
    // Exact: neither case nor a prefix finds a session.
    expect(resolveRef('release notes')).toEqual({ ok: false, reason: 'not-found' })
    expect(resolveRef('Release')).toEqual({ ok: false, reason: 'not-found' })

    const ambiguous = resolveRef('Triage')
    expect(ambiguous.ok).toBe(false)
    if (ambiguous.ok || ambiguous.reason !== 'ambiguous') throw new Error('expected ambiguous')
    expect(ambiguous.candidates.map((x) => x.title)).toEqual(['Triage', 'Triage'])
    expect(new Set(ambiguous.candidates.map((x) => x.ref)).size).toBe(2)
    for (const candidate of ambiguous.candidates) expect(candidate.ref).toMatch(REF_PATTERN)
  })

  it('refuses the words the caller resolves (self, origin, parent) even when a session is titled so', () => {
    const a = born(id('a'))
    emitEvent('config:sessions-changed', [{ customTitles: { [a]: 'self' } }])
    expect(resolveRef('self')).toEqual({ ok: false, reason: 'reserved' })
    expect(resolveRef('origin')).toEqual({ ok: false, reason: 'reserved' })
    expect(resolveRef('parent')).toEqual({ ok: false, reason: 'reserved' })
    expect(resolveRef('Parent')).toEqual({ ok: false, reason: 'reserved' })
  })

  it('never matches something shaped like a ref as a title', () => {
    const a = born(id('a'))
    // A title that looks like a ref we could mint, and ones that are merely ref-shaped
    // (a character our alphabet leaves out, or a capital).
    const b = born(id('b'))
    const c = born(id('c'))
    emitEvent('config:sessions-changed', [
      { customTitles: { [a]: 's-abcdef', [b]: 's-ilou01', [c]: 's-ZZZZZZ' } }
    ])
    expect(resolveRef('s-abcdef')).toEqual({ ok: false, reason: 'not-found' })
    expect(resolveRef('s-ilou01')).toEqual({ ok: false, reason: 'not-found' })
    expect(resolveRef('s-ZZZZZZ')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('says not-found for nothing, an unknown ref and an unknown id', () => {
    expect(resolveRef('')).toEqual({ ok: false, reason: 'not-found' })
    expect(resolveRef('s-23456a')).toEqual({ ok: false, reason: 'not-found' })
    expect(resolveRef(id('nobody'))).toEqual({ ok: false, reason: 'not-found' })
  })
})

describe('linkChild', () => {
  it('records the refs and a starting link, replicates them, and puts the card in the parent', () => {
    const parent = born(id('parent'))
    const child = born(id('child'), 'codex')
    const { parentRef, childRef } = linkChild({
      parent,
      childRoutingId: child,
      engine: 'codex',
      kind: 'handoff',
      createdBy: 'agent',
      grouped: true,
      title: 'Fix the flaky test'
    })

    expect(parentRef).toMatch(REF_PATTERN)
    expect(childRef).toMatch(REF_PATTERN)
    expect(getSessionLink(childRef)).toMatchObject({
      parentRef,
      kind: 'handoff',
      createdBy: 'agent',
      grouped: true,
      state: 'starting'
    })
    // Replicated: canonical holds the link and the id of each session it names.
    expect(canonical().sessionLinks[childRef]).toMatchObject({
      originRef: parentRef,
      state: 'starting'
    })
    expect(canonical().sessionRefs[parent]).toBe(parentRef)
    expect(canonical().sessionRefs[child]).toBe(childRef)
    expect(linkEvents.at(-1)).toEqual(linkPayload())
    // The card is a note row in the parent's transcript, one per child.
    const card = canonical().sessions[parent].messages.find((m) => m.id === sessionCardId(childRef))
    expect(card).toMatchObject({
      role: 'system',
      content: [
        {
          type: 'session_card',
          childRef,
          kind: 'handoff',
          title: 'Fix the flaky test',
          engineId: 'codex'
        }
      ]
    })
  })

  it('does not put a second card in the parent when the same child is linked again', () => {
    const parent = born(id('parent'))
    const child = born(id('child'))
    const input = {
      parent,
      childRoutingId: child,
      engine: 'claude' as const,
      kind: 'started' as const,
      createdBy: 'user' as const,
      grouped: true
    }
    const { childRef } = linkChild(input)
    linkChild(input)
    const cards = canonical().sessions[parent].messages.filter(
      (m) => m.id === sessionCardId(childRef)
    )
    expect(cards).toHaveLength(1)
  })
})

describe('the link state machine', () => {
  function started(): { parent: string; child: string; childRef: string; parentRef: string } {
    const parent = born(id('parent'))
    const child = born(id('child'))
    const { childRef, parentRef } = linkChild({
      parent,
      childRoutingId: child,
      engine: 'claude',
      kind: 'started',
      createdBy: 'agent',
      grouped: true
    })
    return { parent, child, childRef, parentRef }
  }
  const stateOf = (childRef: string): string | undefined => getSessionLink(childRef)?.state

  it('goes live when the child’s first status reaches canonical', () => {
    const { child, childRef } = started()
    expect(stateOf(childRef)).toBe('starting')
    emitEvent('session:status', [child, status(child)])
    expect(stateOf(childRef)).toBe('live')
    expect(canonical().sessionLinks[childRef].state).toBe('live')
  })

  it('goes live on the rekey, which is that first status carrying the engine’s own id', () => {
    const { child, childRef } = started()
    const real = id('thread')
    emitEvent('session:status', [child, status(real)])
    expect(stateOf(childRef)).toBe('live')
    // …and the replicated ref followed the session to its new id.
    expect(canonical().sessionRefs[real]).toBe(childRef)
    expect(canonical().sessionRefs[child]).toBeUndefined()
  })

  it('fails when the first thing the child reports is a disconnect', () => {
    const { child, childRef } = started()
    emitEvent('session:status', [child, status(null, 'disconnected')])
    expect(stateOf(childRef)).toBe('failed')
  })

  it('fails when the child is removed before it ever started, and ends when removed after', () => {
    const early = started()
    syncCore.removeSession(early.child)
    expect(stateOf(early.childRef)).toBe('failed')

    const late = started()
    emitEvent('session:status', [late.child, status(late.child)])
    syncCore.removeSession(late.child)
    expect(stateOf(late.childRef)).toBe('ended')
    // The deleted session no longer resolves, but its ref (and the link naming it) stay.
    expect(findSessionRef(late.child)).toBeUndefined()
    expect(canonical().sessionRefs[late.child]).toBeUndefined()
    expect(resolveRef(late.childRef)).toEqual({ ok: false, reason: 'not-found' })
  })

  it('keeps a spawn failure failed when the half-made session is then removed', () => {
    const { child, childRef } = started()
    setLinkState(childRef, 'failed')
    syncCore.removeSession(child)
    expect(stateOf(childRef)).toBe('failed')
  })

  it('leaves the children of a deleted parent in place, their links ended', () => {
    const { parent, child, childRef } = started()
    emitEvent('session:status', [child, status(child)])
    syncCore.removeSession(parent)
    expect(stateOf(childRef)).toBe('ended')
    expect(canonical().sessions[child]).toBeDefined()
    expect(canonical().sessionLinks[childRef].state).toBe('ended')
  })

  it('keeps its lifecycle state when the user ungroups the pair: grouping is not a state', () => {
    const { child, childRef } = started()
    expect(getSessionLink(childRef)?.grouped).toBe(true)
    expect(setLinkGrouped(childRef, false)).toBe(true)
    expect(setLinkGrouped(childRef, false)).toBe(false)
    expect(stateOf(childRef)).toBe('starting')
    emitEvent('session:status', [child, status(child)])
    expect(stateOf(childRef)).toBe('live')
    syncCore.removeSession(child)
    expect(stateOf(childRef)).toBe('ended')
    // The link, with its lineage, is still there.
    expect(getSessionLink(childRef)).toMatchObject({ grouped: false, state: 'ended' })
  })

  it('tells the clients once per real change, never for a no-op', () => {
    const { child, childRef } = started()
    const before = linkEvents.length
    emitEvent('session:status', [child, status(child)])
    expect(linkEvents).toHaveLength(before + 1)
    expect(setLinkState(childRef, 'live')).toBe(false)
    expect(linkEvents).toHaveLength(before + 1)
  })

  it('refuses a link that would make a session its own ancestor', () => {
    const a = refFor('claude', id('a'))
    const b = refFor('claude', id('b'))
    const c = refFor('claude', id('c'))
    recordLink({ childRef: b, parentRef: a, kind: 'started', createdBy: 'user', grouped: true })
    recordLink({ childRef: c, parentRef: b, kind: 'started', createdBy: 'user', grouped: true })
    expect(() =>
      recordLink({
        childRef: a,
        parentRef: c,
        kind: 'started',
        createdBy: 'user',
        grouped: true
      })
    ).toThrow(/under itself/)
    expect(() =>
      recordLink({
        childRef: a,
        parentRef: a,
        kind: 'started',
        createdBy: 'user',
        grouped: true
      })
    ).toThrow(/under itself/)
  })

  it('settles links left starting by a restart: live if the child had its id, failed if not', () => {
    const parentRef = refFor('claude', id('parent'))
    // A child whose ref knows the engine's id: it got as far as its first status.
    const withId = refFor('claude', id('had-id'))
    upsertSessionLink({
      childRef: withId,
      parentRef,
      kind: 'started',
      createdBy: 'agent',
      grouped: true,
      state: 'starting'
    })
    // A child still on its temporary routing id when the app went away.
    const pendingRef = linkChild({
      parent: born(id('p2')),
      childRoutingId: born(id('pending')),
      engine: 'claude',
      kind: 'started',
      createdBy: 'agent',
      grouped: true
    }).childRef
    // The restart forgets the in-memory set of children being waited for.
    resetSessionLinksForTests()

    seedLinkState()

    expect(getSessionLink(withId)?.state).toBe('live')
    expect(getSessionLink(pendingRef)?.state).toBe('failed')
    expect(canonical().sessionLinks[pendingRef].state).toBe('failed')
    expect(canonical().sessionLinks[withId].state).toBe('live')
  })
})

describe('the boot settle', () => {
  it('leaves alone a link this process is waiting for, which started while the seed ran', () => {
    const parent = born(id('parent'))
    const child = born(id('child'))
    const { childRef } = linkChild({
      parent,
      childRoutingId: child,
      engine: 'claude',
      kind: 'started',
      createdBy: 'agent',
      grouped: true
    })
    seedLinkState()
    expect(getSessionLink(childRef)?.state).toBe('starting')
    // …and it still goes live when its status arrives.
    emitEvent('session:status', [child, status(child)])
    expect(getSessionLink(childRef)?.state).toBe('live')
  })
})

describe('linksOf and the group head', () => {
  const link = (
    child: string,
    origin: string,
    over: { kind?: 'started' | 'handoff'; grouped?: boolean } = {}
  ): void =>
    recordLink({
      childRef: child,
      parentRef: origin,
      kind: over.kind ?? 'handoff',
      createdBy: 'agent',
      grouped: over.grouped ?? true
    })
  const fresh = (label: string): string => refFor('claude', id(label))

  it('keeps a chain of hand-offs in one flat group under the topmost session', () => {
    const a = fresh('a')
    const b = fresh('b')
    const c = fresh('c')
    const d = fresh('d')
    link(b, a)
    link(c, b)
    link(d, c)
    for (const ref of [a, b, c, d]) expect(groupHeadOf(ref)).toBe(a)
    expect(groupOf(c)).toEqual(new Set([a, b, c, d]))
    expect(groupOf(a)).toEqual(new Set([a, b, c, d]))
  })

  it('a standalone start breaks the chain: the started session heads a group of its own', () => {
    const a = fresh('a')
    const b = fresh('b')
    const x = fresh('x')
    const y = fresh('y')
    link(b, a)
    link(x, b, { kind: 'started', grouped: false })
    link(y, x)
    expect(groupHeadOf(x)).toBe(x)
    expect(groupHeadOf(y)).toBe(x)
    expect(groupOf(b)).toEqual(new Set([a, b]))
    expect(groupOf(y)).toEqual(new Set([x, y]))
    // The lineage is still recorded.
    expect(linksOf(x).origin?.parentRef).toBe(b)
    expect(linksOf(b).started.map((l) => l.childRef)).toEqual([x])
  })

  it('recomputes when the user detaches a member or adds one back', () => {
    const a = fresh('a')
    const b = fresh('b')
    const c = fresh('c')
    link(b, a)
    link(c, b)
    expect(groupHeadOf(c)).toBe(a)
    // Detaching b: c, whose origin is b, forms its own group under b.
    setLinkGrouped(b, false)
    expect(groupHeadOf(b)).toBe(b)
    expect(groupHeadOf(c)).toBe(b)
    expect(groupOf(a)).toEqual(new Set([a]))
    expect(groupOf(c)).toEqual(new Set([b, c]))
    // Adding b back merges the groups.
    setLinkGrouped(b, true)
    expect(groupHeadOf(c)).toBe(a)
    expect(groupOf(b)).toEqual(new Set([a, b, c]))
  })

  it('names a ref’s origin, the sessions it started and its group; a lone session is its own group', () => {
    const origin = fresh('origin')
    const me = fresh('me')
    const sibling = fresh('sibling')
    const standaloneKid = fresh('standalone')
    const memberKid = fresh('member')
    link(me, origin, { kind: 'started' })
    link(sibling, origin, { kind: 'started' })
    link(standaloneKid, me, { kind: 'started', grouped: false })
    link(memberKid, me, { kind: 'started' })

    const related = linksOf(me)
    expect(related.origin?.parentRef).toBe(origin)
    expect(related.started.map((l) => l.childRef).sort()).toEqual([standaloneKid, memberKid].sort())
    expect(related.group).toEqual(new Set([origin, me, sibling, memberKid]))
    expect(linksOf(origin).origin).toBeNull()
    const lone = fresh('lone')
    expect(linksOf(lone).group).toEqual(new Set([lone]))
  })
})

describe('the replicated state', () => {
  it('round-trips through the wire snapshot', () => {
    const parent = born(id('parent'))
    const child = born(id('child'))
    const { childRef } = linkChild({
      parent,
      childRoutingId: child,
      engine: 'claude',
      kind: 'handoff',
      createdBy: 'pressure',
      grouped: true
    })
    const snapshot = toSnapshot(canonical(), 7)
    expect(snapshot.sessionLinks?.[childRef]).toMatchObject({
      kind: 'handoff',
      createdBy: 'pressure'
    })
    const restored = fromSnapshot(snapshot)
    expect(restored.sessionLinks).toEqual(canonical().sessionLinks)
    expect(restored.sessionRefs).toEqual(canonical().sessionRefs)
    // An older server's snapshot has neither field.
    const old = { ...snapshot, sessionLinks: undefined, sessionRefs: undefined }
    expect(fromSnapshot(old)).toMatchObject({ sessionLinks: {}, sessionRefs: {} })
  })
})

describe('the session card on a cold read', () => {
  const msg = (mid: string, timestamp: number): never =>
    ({ id: mid, role: 'assistant', content: [{ type: 'text', text: mid }], timestamp }) as never

  it('is put back in the parent’s transcript where the link was made', () => {
    const parent = born(id('parent'))
    const child = born(id('child'))
    const { childRef } = linkChild({
      parent,
      childRoutingId: child,
      engine: 'pi',
      kind: 'started',
      createdBy: 'agent',
      grouped: true
    })
    const madeAt = getSessionLink(childRef)!.createdAt

    const out = withSessionCards(parent, [msg('before', madeAt - 10), msg('after', madeAt + 10)])
    expect(out.map((m) => m.id)).toEqual(['before', sessionCardId(childRef), 'after'])
    expect(out[1].content[0]).toMatchObject({ type: 'session_card', childRef, engineId: 'pi' })
    // With no later message the card goes last.
    expect(withSessionCards(parent, [msg('before', madeAt - 10)]).map((m) => m.id)).toEqual([
      'before',
      sessionCardId(childRef)
    ])
  })

  it('does not double a card the transcript already holds', () => {
    const parent = born(id('parent'))
    const child = born(id('child'))
    const { childRef } = linkChild({
      parent,
      childRoutingId: child,
      engine: 'claude',
      kind: 'started',
      createdBy: 'agent',
      grouped: true
    })
    const live = canonical().sessions[parent].messages
    expect(
      withSessionCards(parent, live).filter((m) => m.id === sessionCardId(childRef))
    ).toHaveLength(1)
  })

  it('leaves a transcript with no children alone, and the same array back', () => {
    const lonely = id('lonely')
    const list = [msg('a', 1)]
    expect(withSessionCards(lonely, list)).toBe(list)
    refFor('claude', lonely)
    expect(withSessionCards(lonely, list)).toBe(list)
  })
})

describe('setSessionGrouped — the session:link:set-grouped body', () => {
  it('detaches and re-adds the session it is given, replicating each change, and says so otherwise', () => {
    const parent = born(id('parent'))
    const child = born(id('child'))
    const { childRef } = linkChild({
      parent,
      childRoutingId: child,
      engine: 'claude',
      kind: 'started',
      createdBy: 'agent',
      grouped: true
    })
    expect(setSessionGrouped(child, false)).toEqual({ success: true })
    expect(getSessionLink(childRef)?.grouped).toBe(false)
    expect(canonical().sessionLinks[childRef].grouped).toBe(false)
    // Idempotent; and the link is still the origin record.
    expect(setSessionGrouped(child, false)).toEqual({ success: true })
    expect(setSessionGrouped(child, true)).toEqual({ success: true })
    expect(canonical().sessionLinks[childRef]).toMatchObject({ grouped: true, state: 'starting' })
    // A session that was never started from another has nothing to group.
    expect(setSessionGrouped(parent, true)).toEqual({
      success: false,
      error: 'This session was not started from another'
    })
    expect(setSessionGrouped(id('stranger'), true).success).toBe(false)
  })

  it('is the same call over the remote dispatcher as directly (a chat command on the session)', async () => {
    const parent = born(id('parent'))
    const child = born(id('child'))
    linkChild({
      parent,
      childRoutingId: child,
      engine: 'claude',
      kind: 'started',
      createdBy: 'agent',
      grouped: true
    })
    const registry = new CommandRegistry()
    const dispatcher = new RemoteDispatcher(registry)
    registry.register({
      channel: 'session:link:set-grouped',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      transport: 'remote',
      handler: async (routingId: string, grouped: boolean) => setSessionGrouped(routingId, grouped)
    })
    const viaDispatcher = await dispatcher.handle(
      { type: 'invoke', id: '1', channel: 'session:link:set-grouped', args: [child, false] },
      makeRemoteConnection('password', null)
    )
    expect(viaDispatcher).toEqual({ success: true })
    expect(getSessionLink(refFor('claude', child))?.grouped).toBe(false)
  })
})

describe('the first client prompt on a started session (slice 1c)', () => {
  const agentChild = (): { parent: string; child: string; childRef: string; parentRef: string } => {
    const parent = born(id('parent'))
    const child = born(id('child'))
    const { childRef, parentRef } = linkChild({
      parent,
      childRoutingId: child,
      engine: 'claude',
      kind: 'started',
      createdBy: 'agent',
      grouped: true
    })
    return { parent, child, childRef, parentRef }
  }

  it('is recorded on the link, once, and ends the wait', () => {
    const { child, childRef } = agentChild()
    expect(getSessionLink(childRef)?.clientPromptedAt).toBeNull()
    expect(awaitingClientPrompt(childRef)).toBe(true)
    noteClientPrompt(child)
    const first = getSessionLink(childRef)?.clientPromptedAt
    expect(first).toEqual(expect.any(Number))
    expect(awaitingClientPrompt(childRef)).toBe(false)
    noteClientPrompt(child)
    expect(getSessionLink(childRef)?.clientPromptedAt).toBe(first)
  })

  it('survives the child’s rekey: the same row, found by the new id', () => {
    const { child, childRef } = agentChild()
    emitEvent('session:status', [child, status('thread-after')])
    noteClientPrompt('thread-after')
    expect(awaitingClientPrompt(childRef)).toBe(false)
  })

  it('a prompt to a session with no link records nothing and leaves nothing behind', () => {
    const lone = born(id('lone'))
    expect(() => noteClientPrompt(lone)).not.toThrow()
    expect(() => noteClientPrompt(id('unknown'))).not.toThrow()
  })

  it('is not owed by a link the user made, or by a session with no link', () => {
    const parent = born(id('p'))
    const kid = born(id('k'))
    const parentRef = refFor('claude', parent)
    const kidRef = refFor('claude', kid)
    recordLink({
      parentRef,
      childRef: kidRef,
      kind: 'started',
      createdBy: 'user',
      grouped: true
    })
    expect(awaitingClientPrompt(kidRef)).toBe(false)
    expect(awaitingClientPrompt(parentRef)).toBe(false)
  })

  it('a prompt on the temporary id of a resumed session is recorded when its engine id arrives', () => {
    // A resumed session is bound to its link by the durable id alone; its first prompt
    // arrives under a fresh routing id the link cannot yet match.
    const durable = id('durable')
    const parent = born(id('parent'))
    const parentRef = refFor('claude', parent)
    insertSessionRef({ ref: 's-resume', engine: 'claude', sessionId: durable, routingId: null })
    recordLink({
      parentRef,
      childRef: 's-resume',
      kind: 'started',
      createdBy: 'agent',
      grouped: true,
      state: 'live'
    })
    const temp = born(id('temp'))
    noteClientPrompt(temp)
    expect(awaitingClientPrompt('s-resume')).toBe(true)
    emitEvent('session:status', [temp, status(durable)])
    expect(awaitingClientPrompt('s-resume')).toBe(false)
    expect(getSessionLink('s-resume')?.clientPromptedAt).toEqual(expect.any(Number))
  })

  it('a prompt before the rekey that carries no link changes nothing at the rekey', () => {
    const temp = born(id('temp'))
    noteClientPrompt(temp)
    expect(() => emitEvent('session:status', [temp, status(id('thread'))])).not.toThrow()
  })
})
