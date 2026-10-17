import { describe, it, expect } from 'vitest'
import type { SessionLinkInfo } from '../../../../shared/session-links'
import {
  MAX_NEST_DEPTH,
  ancestorIdsOf,
  childLinksOf,
  idOfRef,
  nestSessions,
  parentLinkOf,
  sessionTitleOf
} from '../session-links'

const link = (parentRef: string, over: Partial<SessionLinkInfo> = {}): SessionLinkInfo => ({
  parentRef,
  kind: 'started',
  state: 'live',
  createdBy: 'agent',
  wakeParent: false,
  createdAt: 1,
  ...over
})

const row = (sessionId: string): { sessionId: string } => ({ sessionId })

/** ids → refs `r-<id>`; links given as child id → [parent id, overrides]. */
function world(
  links: Record<string, [string, Partial<SessionLinkInfo>?]>,
  ids: string[]
): { sessionLinks: Record<string, SessionLinkInfo>; sessionRefs: Record<string, string> } {
  const sessionRefs: Record<string, string> = {}
  for (const id of ids) sessionRefs[id] = `r-${id}`
  const sessionLinks: Record<string, SessionLinkInfo> = {}
  for (const [child, [parent, over]] of Object.entries(links)) {
    sessionLinks[`r-${child}`] = link(`r-${parent}`, over)
  }
  return { sessionLinks, sessionRefs }
}

const shape = (rows: ReturnType<typeof nestSessions<{ sessionId: string }>>): [string, number][] =>
  rows.map((r) => [r.info.sessionId, r.depth])

describe('nestSessions', () => {
  const none = new Set<string>()

  it('puts a child right under its parent, whatever its place in the list', () => {
    const state = world({ c: ['p'] }, ['p', 'x', 'c'])
    const rows = nestSessions([row('x'), row('c'), row('p')], state, none)
    expect(shape(rows)).toEqual([
      ['x', 0],
      ['p', 0],
      ['c', 1]
    ])
    expect(rows[1]).toMatchObject({ childCount: 1, collapsed: false })
  })

  it('nests grandchildren, and keeps siblings in list order', () => {
    const state = world({ a: ['p'], b: ['p'], aa: ['a'] }, ['p', 'a', 'b', 'aa'])
    const rows = nestSessions([row('p'), row('b'), row('aa'), row('a')], state, none)
    expect(shape(rows)).toEqual([
      ['p', 0],
      ['b', 1],
      ['a', 1],
      ['aa', 2]
    ])
  })

  it('leaves a child top-level when its parent is not in this list (another project, hidden, deleted)', () => {
    const state = world({ c: ['p'] }, ['p', 'c'])
    expect(shape(nestSessions([row('c'), row('other')], state, none))).toEqual([
      ['c', 0],
      ['other', 0]
    ])
  })

  it('leaves a detached child top-level, and a failed or ended one nested', () => {
    const state = world(
      {
        d: ['p', { state: 'detached' }],
        f: ['p', { state: 'failed' }],
        e: ['p', { state: 'ended' }]
      },
      ['p', 'd', 'f', 'e']
    )
    expect(shape(nestSessions([row('p'), row('d'), row('f'), row('e')], state, none))).toEqual([
      ['p', 0],
      ['f', 1],
      ['e', 1],
      ['d', 0]
    ])
  })

  it('hides everything under a collapsed parent, and reports it collapsed', () => {
    const state = world({ a: ['p'], aa: ['a'] }, ['p', 'a', 'aa'])
    const rows = nestSessions([row('p'), row('a'), row('aa')], state, new Set(['p']))
    expect(shape(rows)).toEqual([['p', 0]])
    expect(rows[0]).toMatchObject({ childCount: 1, collapsed: true })
    // Collapsing a row with no children in the list changes nothing.
    expect(nestSessions([row('aa')], state, new Set(['aa']))[0]).toMatchObject({
      childCount: 0,
      collapsed: false
    })
  })

  it('caps the indent but loses no row on a long chain', () => {
    const ids = Array.from({ length: MAX_NEST_DEPTH + 3 }, (_, i) => `n${i}`)
    const links: Record<string, [string]> = {}
    for (let i = 1; i < ids.length; i++) links[ids[i]] = [ids[i - 1]]
    const rows = nestSessions(ids.map(row), world(links, ids), none)
    expect(rows).toHaveLength(ids.length)
    expect(Math.max(...rows.map((r) => r.depth))).toBe(MAX_NEST_DEPTH)
  })

  it('cuts a link cycle instead of dropping or repeating rows', () => {
    const state = world({ a: ['b'], b: ['a'], s: ['s'] }, ['a', 'b', 's'])
    const rows = nestSessions([row('a'), row('b'), row('s')], state, none)
    expect(rows.map((r) => r.info.sessionId).sort()).toEqual(['a', 'b', 's'])
  })

  it('draws a flat list when there are no links', () => {
    expect(
      shape(nestSessions([row('a'), row('b')], { sessionLinks: {}, sessionRefs: {} }, none))
    ).toEqual([
      ['a', 0],
      ['b', 0]
    ])
  })
})

describe('reading links', () => {
  const state = world({ c: ['p'], d: ['p', { state: 'detached' }] }, ['p', 'c', 'd'])

  it('finds a child’s parent link and the parent’s sidebar id; a detached one has none', () => {
    expect(parentLinkOf(state, 'c')).toMatchObject({ childRef: 'r-c', parentId: 'p' })
    expect(parentLinkOf(state, 'd')).toBeNull()
    expect(parentLinkOf(state, 'p')).toBeNull()
    expect(parentLinkOf(state, 'unknown')).toBeNull()
  })

  it('says the parent’s id is unknown when no session carries its ref', () => {
    const orphaned = { ...state, sessionRefs: { c: 'r-c' } }
    expect(parentLinkOf(orphaned, 'c')).toMatchObject({ parentId: null })
  })

  it('lists a session’s children oldest first, detached ones left out', () => {
    const two = world(
      {
        late: ['p', { createdAt: 9 }],
        early: ['p', { createdAt: 2 }],
        gone: ['p', { state: 'detached' }]
      },
      ['p', 'late', 'early', 'gone']
    )
    expect(childLinksOf(two, 'p').map((c) => c.childId)).toEqual(['early', 'late'])
    expect(childLinksOf(two, 'early')).toEqual([])
  })

  it('inverts the ref map', () => {
    expect(idOfRef(state.sessionRefs, 'r-c')).toBe('c')
    expect(idOfRef(state.sessionRefs, 'r-none')).toBeNull()
  })
})

describe('ancestorIdsOf', () => {
  it('lists the parents above a session, nearest first, and stops at a cycle or a detach', () => {
    const chain = world({ c: ['p'], g: ['c'] }, ['p', 'c', 'g'])
    expect(ancestorIdsOf(chain, 'g')).toEqual(['c', 'p'])
    expect(ancestorIdsOf(chain, 'p')).toEqual([])
    const cut = world({ c: ['p'], g: ['c', { state: 'detached' }] }, ['p', 'c', 'g'])
    expect(ancestorIdsOf(cut, 'g')).toEqual([])
    const loop = world({ a: ['b'], b: ['a'] }, ['a', 'b'])
    expect(ancestorIdsOf(loop, 'a')).toEqual(['b'])
  })
})

describe('sessionTitleOf', () => {
  const dirs = [
    {
      cwd: '/x',
      projectKey: 'x',
      folderName: 'x',
      sessions: [
        {
          sessionId: 'listed',
          cwd: '/x',
          projectKey: 'x',
          title: 'From listing',
          timestamp: 0,
          lastActivityAt: 0
        }
      ]
    }
  ]
  const sessions = {
    fresh: {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'First words\nof the prompt' }] }]
    }
  }
  const base = { customTitles: { named: 'My name' }, directories: dirs, sessions }

  it('prefers the user’s name, then the listing, then the first prompt', () => {
    expect(sessionTitleOf({ ...base, directories: dirs }, 'named')).toBe('My name')
    expect(sessionTitleOf(base, 'listed')).toBe('From listing')
    expect(sessionTitleOf(base, 'fresh')).toBe('First words of the prompt')
    expect(sessionTitleOf(base, 'nothing')).toBe('')
  })
})
