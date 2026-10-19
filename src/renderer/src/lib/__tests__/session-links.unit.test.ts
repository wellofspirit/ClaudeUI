import { describe, it, expect } from 'vitest'
import type { SessionLinkInfo } from '../../../../shared/session-links'
import {
  groupHeadIdOf,
  groupSessions,
  idOfRef,
  originLinkOf,
  sessionTitleOf,
  startedLinksOf
} from '../session-links'

const link = (originRef: string, over: Partial<SessionLinkInfo> = {}): SessionLinkInfo => ({
  originRef,
  kind: 'handoff',
  state: 'live',
  createdBy: 'agent',
  grouped: true,
  createdAt: 1,
  ...over
})

const row = (sessionId: string): { sessionId: string } => ({ sessionId })

/** ids → refs `r-<id>`; links given as started id → [origin id, overrides]. */
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

const shape = (rows: ReturnType<typeof groupSessions<{ sessionId: string }>>): [string, number][] =>
  rows.map((r) => [r.info.sessionId, r.depth])

describe('groupHeadIdOf', () => {
  it('is the topmost session reached through grouped links, and null for a session that heads (or is alone)', () => {
    const chain = world({ b: ['a'], c: ['b'], d: ['c'] }, ['a', 'b', 'c', 'd'])
    for (const id of ['b', 'c', 'd']) expect(groupHeadIdOf(chain, id), id).toBe('a')
    expect(groupHeadIdOf(chain, 'a')).toBeNull()
    expect(groupHeadIdOf(chain, 'unknown')).toBeNull()
  })

  it('stops at a standalone link: a standalone start heads a group of its own', () => {
    const state = world({ b: ['a'], x: ['b', { kind: 'started', grouped: false }], y: ['x'] }, [
      'a',
      'b',
      'x',
      'y'
    ])
    expect(groupHeadIdOf(state, 'b')).toBe('a')
    expect(groupHeadIdOf(state, 'x')).toBeNull()
    expect(groupHeadIdOf(state, 'y')).toBe('x')
  })

  it('is null when the head’s id is not known, and ends a cycle instead of looping', () => {
    const orphaned = { ...world({ c: ['p'] }, ['c']) }
    expect(groupHeadIdOf(orphaned, 'c')).toBeNull()
    const loop = world({ a: ['b'], b: ['a'] }, ['a', 'b'])
    expect(['a', 'b']).toContain(groupHeadIdOf(loop, 'a'))
  })
})

describe('groupSessions', () => {
  const none = new Set<string>()

  it('puts a member right under its head, whatever its place in the list', () => {
    const state = world({ c: ['p'] }, ['p', 'x', 'c'])
    const rows = groupSessions([row('x'), row('c'), row('p')], state, none)
    expect(shape(rows)).toEqual([
      ['x', 0],
      ['p', 0],
      ['c', 1]
    ])
    expect(rows[1]).toMatchObject({ memberCount: 1, collapsed: false })
  })

  it('draws a chain of hand-offs as one flat group: the head and every member one level in, in start order', () => {
    const state = world(
      {
        h1: ['p', { createdAt: 10 }],
        h2: ['h1', { createdAt: 20 }],
        h3: ['h2', { createdAt: 30 }],
        h4: ['h3', { createdAt: 40 }]
      },
      ['p', 'h1', 'h2', 'h3', 'h4']
    )
    // Listed newest first, as a sidebar lists them; the group runs oldest first under the head.
    const rows = groupSessions([row('h4'), row('h3'), row('h2'), row('h1'), row('p')], state, none)
    expect(shape(rows)).toEqual([
      ['p', 0],
      ['h1', 1],
      ['h2', 1],
      ['h3', 1],
      ['h4', 1]
    ])
    expect(rows[0]).toMatchObject({ memberCount: 4 })
    expect(Math.max(...rows.map((r) => r.depth))).toBe(1)
  })

  it('a standalone start is an ordinary top-level row, and its own hand-offs form their own group', () => {
    const state = world(
      {
        b: ['a'],
        x: ['b', { kind: 'started', grouped: false }],
        y: ['x']
      },
      ['a', 'b', 'x', 'y']
    )
    expect(shape(groupSessions([row('a'), row('b'), row('x'), row('y')], state, none))).toEqual([
      ['a', 0],
      ['b', 1],
      ['x', 0],
      ['y', 1]
    ])
  })

  it('leaves a member top-level when its head is not in this list (another project, hidden, deleted)', () => {
    const state = world({ c: ['p'] }, ['p', 'c'])
    expect(shape(groupSessions([row('c'), row('other')], state, none))).toEqual([
      ['c', 0],
      ['other', 0]
    ])
  })

  it('keeps a failed or ended member in the group', () => {
    const state = world({ f: ['p', { state: 'failed' }], e: ['p', { state: 'ended' }] }, [
      'p',
      'f',
      'e'
    ])
    expect(shape(groupSessions([row('p'), row('f'), row('e')], state, none))).toEqual([
      ['p', 0],
      ['f', 1],
      ['e', 1]
    ])
  })

  it('hides every member under a collapsed head, and reports it collapsed', () => {
    const state = world({ a: ['p'], aa: ['a'] }, ['p', 'a', 'aa'])
    const rows = groupSessions([row('p'), row('a'), row('aa')], state, new Set(['p']))
    expect(shape(rows)).toEqual([['p', 0]])
    expect(rows[0]).toMatchObject({ memberCount: 2, collapsed: true })
    // Collapsing a row that heads nothing changes nothing.
    expect(groupSessions([row('aa')], state, new Set(['aa']))[0]).toMatchObject({
      memberCount: 0,
      collapsed: false
    })
  })

  it('cuts a link cycle instead of dropping or repeating rows', () => {
    const state = world({ a: ['b'], b: ['a'], s: ['s'] }, ['a', 'b', 's'])
    const rows = groupSessions([row('a'), row('b'), row('s')], state, none)
    expect(rows.map((r) => r.info.sessionId).sort()).toEqual(['a', 'b', 's'])
  })

  it('draws a flat list when there are no links', () => {
    expect(
      shape(groupSessions([row('a'), row('b')], { sessionLinks: {}, sessionRefs: {} }, none))
    ).toEqual([
      ['a', 0],
      ['b', 0]
    ])
  })
})

describe('reading links', () => {
  const state = world({ c: ['p'], d: ['p', { grouped: false }] }, ['p', 'c', 'd'])

  it('finds the link to the session that started one and that session’s sidebar id, grouped or not', () => {
    expect(originLinkOf(state, 'c')).toMatchObject({ childRef: 'r-c', originId: 'p' })
    // A standalone session still records where it came from.
    expect(originLinkOf(state, 'd')).toMatchObject({ childRef: 'r-d', originId: 'p' })
    expect(originLinkOf(state, 'p')).toBeNull()
    expect(originLinkOf(state, 'unknown')).toBeNull()
  })

  it('says the origin’s id is unknown when no session carries its ref', () => {
    const orphaned = { ...state, sessionRefs: { c: 'r-c' } }
    expect(originLinkOf(orphaned, 'c')).toMatchObject({ originId: null })
  })

  it('lists the sessions a session started oldest first, standalone ones included', () => {
    const two = world(
      {
        late: ['p', { createdAt: 9 }],
        early: ['p', { createdAt: 2 }],
        alone: ['p', { createdAt: 5, grouped: false }]
      },
      ['p', 'late', 'early', 'alone']
    )
    expect(startedLinksOf(two, 'p').map((c) => c.childId)).toEqual(['early', 'alone', 'late'])
    expect(startedLinksOf(two, 'early')).toEqual([])
  })

  it('inverts the ref map', () => {
    expect(idOfRef(state.sessionRefs, 'r-c')).toBe('c')
    expect(idOfRef(state.sessionRefs, 'r-none')).toBeNull()
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
