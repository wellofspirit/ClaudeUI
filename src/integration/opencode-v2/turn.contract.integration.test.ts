/**
 * opencode 2.x contract: server lease, a streamed turn, interrupt, subagent
 * child sessions, the session list, and cold history (ADR-093 §2, §5, §6, §8.1).
 *
 *   OPENCODE_V2_INTEGRATION=1 [OPENCODE_V2_BIN=/path/to/opencode] \
 *     bun run test:integration src/integration/opencode-v2
 */
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import provenance from '../../core/opencode/protocol-v2/provenance.json'
import type { Session_Message_Info } from '../../core/opencode/protocol-v2/openapi'
import { SLOW_CHUNKS } from './harness/fixture-provider'
import { describeV2, nonce, useRig, V2_BIN } from './harness/host'
import { eventSessionID } from '../../core/opencode/protocol-v2/events'

const LIFECYCLE: string[] = [
  'session.execution.started',
  'session.step.started',
  'session.text.started',
  'session.text.ended',
  'session.step.ended',
  'session.execution.succeeded'
]

describeV2('opencode 2.x contract: turns, interrupt, history', () => {
  const rig = useRig('turn')

  it('the binary is the version the protocol was generated from', () => {
    // Isolated like every engine process here, though --version should touch nothing.
    const printed = execFileSync(V2_BIN, ['--version'], {
      encoding: 'utf8',
      cwd: rig().cwd,
      env: { PATH: process.env.PATH ?? '', ...rig().home.env, OPENCODE_DISABLE_AUTOUPDATE: '1' }
    }).trim()
    const version = printed.replace(/^opencode\s+/, '').replace(/^v/, '')
    // A candidate binary for a pin bump runs with OPENCODE_V2_ALLOW_VERSION_MISMATCH=1.
    if (process.env.OPENCODE_V2_ALLOW_VERSION_MISMATCH !== '1')
      expect(version).toBe(provenance.version)
    expect(version).toMatch(/^2\.\d+\.\d+/)
  })

  it('(a) prompt → streamed text → succeeded, with usage and cost', async () => {
    const { api, feed, fixture } = rig()
    const sessionID = await rig().createSession()
    const tag = nonce('hello')
    const from = feed.mark()
    const accepted = await api.ok('session.prompt', {
      params: { sessionID },
      body: { text: `hello ${tag}` }
    })
    expect(accepted.data).toMatchObject({ type: 'user', sessionID, delivery: 'steer' })
    const end = await feed.waitForTurnEnd(sessionID, from)
    expect(end.type).toBe('session.execution.succeeded')

    expect(feed.streamedText(sessionID, from)).toBe(`echo: hello ${tag}`)
    const ended = feed.select('session.text.ended', { sessionID, after: from })
    expect(ended.map((event) => event.data.text)).toEqual([`echo: hello ${tag}`])
    // The lifecycle a mapper relies on, in order.
    const lifecycle = feed.events
      .slice(from)
      .filter((event) => eventSessionID(event) === sessionID && LIFECYCLE.includes(event.type))
      .map((event) => event.type)
    expect(lifecycle).toEqual(LIFECYCLE)
    const step = feed.select('session.step.ended', { sessionID, after: from })
    expect(step).toHaveLength(1)
    expect(step[0].data).toMatchObject({
      finish: 'stop',
      tokens: { input: 120, output: 30 }
    })
    expect(step[0].data.cost).toBeGreaterThan(0)
    expect(step[0].durable.aggregateID).toBe(sessionID)
    const usage = feed.select('session.usage.updated', { sessionID, after: from }).at(-1)
    expect(usage?.data.tokens.output).toBeGreaterThanOrEqual(30)
    expect(fixture.mentioning(tag)).toHaveLength(1)
  })

  it('(d) interrupt mid-stream keeps the partial text and ends as a user stop', async () => {
    const { api, feed } = rig()
    const sessionID = await rig().createSession()
    const from = feed.mark()
    await api.ok('session.prompt', { params: { sessionID }, body: { text: '[slow] interrupt me' } })
    await feed.waitFor('session.text.delta', {
      sessionID,
      after: from,
      where: (event) => event.data.delta.includes('#2 ')
    })
    const interrupted = await api.ok('session.interrupt', { params: { sessionID } })
    expect(interrupted).toEqual({ interrupted: true })
    const end = await feed.waitForTurnEnd(sessionID, from)
    expect(end.type).toBe('session.execution.interrupted')
    if (end.type === 'session.execution.interrupted') expect(end.data.reason).toBe('user')

    const streamed = feed.streamedText(sessionID, from)
    expect(streamed).toContain('slow#0 ')
    expect(streamed).not.toContain(`slow#${SLOW_CHUNKS - 1} `)
    const history = await api.ok('session.message.list', {
      params: { sessionID },
      query: { order: 'asc' }
    })
    const assistant = history.data.filter(
      (row): row is Extract<Session_Message_Info, { type: 'assistant' }> => row.type === 'assistant'
    )
    const kept = assistant
      .flatMap((row) => row.content)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
    expect(kept.length).toBeGreaterThan(0)
    expect(streamed.startsWith(kept) || kept.startsWith(streamed)).toBe(true)
    expect(history.data.at(-1)).toMatchObject({ type: 'idle', outcome: 'interrupted' })
  })

  it('subagent: the child session is announced with parentID and listed under its parent', async () => {
    const { api, feed } = rig()
    const sessionID = await rig().createSession()
    const { end, from } = await rig().turn(sessionID, '[sub] spawn a child')
    expect(end.type).toBe('session.execution.succeeded')
    const child = feed.select('session.created', {
      after: from,
      where: (event) => event.data.parentID === sessionID
    })
    expect(child).toHaveLength(1)
    const childID = child[0].data.sessionID
    expect(
      feed.select('session.execution.succeeded', { sessionID: childID, after: from })
    ).toHaveLength(1)
    const progress = feed.select('session.tool.progress', { sessionID, after: from })
    expect(progress.some((event) => event.data.metadata.sessionID === childID)).toBe(true)
    const listed = await api.ok('session.list', { query: { parentID: sessionID } })
    expect(listed.data.map((session) => session.id)).toEqual([childID])
  })

  it('(j) GET /api/session?directory= lists the session; another directory does not', async () => {
    const { api, home } = rig()
    const sessionID = await rig().createSession()
    const elsewhere = home.workspace('other')
    const other = await api.ok('session.create', {
      body: { location: { directory: elsewhere } },
      directory: elsewhere
    })
    const here = await api.ok('session.list', { query: { directory: rig().cwd, parentID: 'null' } })
    const ids = here.data.map((session) => session.id)
    expect(ids).toContain(sessionID)
    expect(ids).not.toContain(other.data.id)
    const there = await api.ok('session.list', { query: { directory: elsewhere } })
    expect(there.data.map((session) => session.id)).toEqual([other.data.id])
  })

  it('(i) cold history after a server restart equals live history', async () => {
    const sessionID = await rig().createSession()
    const { end } = await rig().turn(sessionID, `history ${nonce('cold')}`)
    expect(end.type).toBe('session.execution.succeeded')
    const hot = await rig().api.ok('session.message.list', {
      params: { sessionID },
      query: { order: 'asc' }
    })
    expect(hot.data.map((row) => row.type)).toEqual(
      expect.arrayContaining(['user', 'assistant', 'idle'])
    )
    const exit = await rig().restart()
    // The --stdio lease: stdin EOF ends the process cleanly.
    expect(exit).toEqual({ code: 0, signal: null, forced: false })
    const cold = await rig().api.ok('session.message.list', {
      params: { sessionID },
      query: { order: 'asc' }
    })
    expect(cold.data).toEqual(hot.data)
    const session = await rig().api.ok('session.get', { params: { sessionID } })
    expect(session.data.outcome).toBe('succeeded')
  })
})
