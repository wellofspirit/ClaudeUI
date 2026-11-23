/**
 * opencode 2.x contract: a per-subagent Stop (subagent-parity S3) — the REAL
 * engine's events through the REAL mapper, interrupted through the REAL client
 * (the transport `OpencodeSession.stopTask` uses):
 *
 *   OPENCODE_V2_INTEGRATION=1 bun run test:integration \
 *     src/integration/opencode/subagent-stop.contract.integration.test.ts
 *
 * Pins what the unit suites assume of 2.3.0, where every subagent runs in the
 * background:
 *   - stopping a child while the PARENT's turn still runs: the parent's turn is
 *     not cut, the card reads stopped, and the cancellation reaches the parent's
 *     model as a `<subagent … state="cancelled">` report;
 *   - stopping a child after the parent's turn ended: the cancelled report wakes
 *     the parent for a turn the model reads;
 *   - interrupting the PARENT leaves its child running (owner ruling 2b): the
 *     child ends on its own, `completed`, and its report wakes the parent for an
 *     ordinary turn;
 *   - a stopped child with a grandchild (`experimental.subagent_depth` 2): the
 *     plan stops grandchild then child, and nothing of the stopped subtree keeps
 *     running or is woken to run again.
 */
import { expect, it } from 'vitest'
import { OpencodeClient } from '../../core/opencode/OpencodeClient'
import { OpencodeEventMapper, type OpencodeMapperOutput } from '../../core/opencode/event-mapper'
import { basic } from './harness/client-feed'
import { describeV2, fixtureConfig, nonce, useRig, type Rig } from './harness/host'

const ALLOW_ALL = { permissions: [{ action: '*', resource: '*', effect: 'allow' as const }] }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A mapper over the rig's raw feed, acting like `OpencodeSession` does for the
 * Stop: `stop(callId)` plans with `stopRun` and interrupts each session in order
 * through the production client; a `reinterrupt` output is answered the same way.
 */
function driven(r: Rig, sessionID: string) {
  const mapper = new OpencodeEventMapper({ sessionID })
  const client = new OpencodeClient({
    baseUrl: r.server.url,
    authHeader: basic(r.server.password),
    directory: r.cwd
  })
  const outputs: OpencodeMapperOutput[] = []
  const reinterrupted: string[] = []
  let next = r.feed.mark()
  const pump = () => {
    for (; next < r.feed.events.length; next++)
      for (const o of mapper.map(r.feed.events[next])) {
        outputs.push(o)
        if (o.kind === 'reinterrupt') {
          reinterrupted.push(o.sessionID)
          void client.interrupt(o.sessionID)
        }
      }
    return outputs
  }
  const until = async <T>(probe: () => T | undefined, label: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      pump()
      const hit = probe()
      if (hit !== undefined) return hit
      if (Date.now() > deadline)
        throw new Error(
          `timed out waiting for ${label}; outputs: ${outputs.map((o) => o.kind).join(', ')}`
        )
      await sleep(50)
    }
  }
  const of = <K extends OpencodeMapperOutput['kind']>(kind: K) =>
    pump().filter((o): o is Extract<OpencodeMapperOutput, { kind: K }> => o.kind === kind)
  const stop = async (
    callId: string,
    order: 'planned' | 'reversed' = 'planned',
    afterInterrupt?: (sessionID: string) => Promise<void>
  ) => {
    pump()
    const plan = mapper.stopRun(callId)
    if (!plan) throw new Error(`no live run for ${callId}`)
    for (const id of order === 'planned' ? plan.sessions : [...plan.sessions].reverse()) {
      await client.interrupt(id)
      await afterInterrupt?.(id)
    }
    return plan
  }
  const active = async () => Object.keys(await client.activeSessions())
  return { mapper, client, outputs, reinterrupted, pump, until, of, stop, active }
}

/** Prompt without waiting for the turn to end. */
async function prompt(r: Rig, sessionID: string, text: string) {
  const from = r.feed.mark()
  await r.api.ok('session.prompt', { params: { sessionID }, body: { text } })
  return from
}

/**
 * Waits (bounded) until the session has no running execution. Keeps pumping the mapper, so a
 * reinterrupt the feed raises meanwhile is sent — the woken child is stopped on the way.
 */
async function untilIdle(m: ReturnType<typeof driven>, sessionID: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    m.pump()
    const active = await m.active()
    if (!active.includes(sessionID)) return active
    if (Date.now() > deadline)
      throw new Error(`${sessionID} still has a running execution; active: ${active.join(', ')}`)
    await sleep(200)
  }
}

describeV2('opencode 2.x contract: a per-subagent Stop', () => {
  // Slow children stream for 30 × 150 ms: a window to stop them. Depth 2 for the nested case.
  const rig = useRig('subagent-stop', {
    slowChunkMs: 150,
    config: (fixture) => ({ ...fixtureConfig(fixture), experimental: { subagent_depth: 2 } })
  })

  /** The child has said something: it is really running. */
  const streaming = (m: ReturnType<typeof driven>, callId: string) =>
    m.until(
      () =>
        m.outputs.some(
          (o) => o.kind === 'item-delta' && o.target.ownerToolUseId === callId && o.chunk
        ) || undefined,
      `the child of ${callId} streaming`
    )

  it('while the parent’s turn runs: the turn is not cut, the card reads stopped, the model reads the cancellation', async () => {
    const r = rig()
    const sessionID = await r.createSession(ALLOW_ALL)
    const m = driven(r, sessionID)
    const tag = nonce('mid')
    // The parent streams slowly after the launch: its turn is still running at the Stop.
    const from = await prompt(r, sessionID, `[subbg] [afterslow] ${tag}`)
    const started = await m.until(() => m.of('task-started')[0], 'the run to start')
    const callId = started.data.toolUseId
    await streaming(m, callId)
    expect(await m.active()).toContain(sessionID)

    const plan = await m.stop(callId)
    expect(plan.sessions).toEqual([started.data.taskId])

    // The parent's turn is NOT cut, and the cancelled report reaches its model.
    const report = await r.feed.waitForReport(sessionID, started.data.taskId, { after: from })
    expect(report.state).toBe('cancelled')
    expect(report.end?.type).toBe('session.execution.succeeded')
    expect(r.feed.select('session.execution.interrupted', { sessionID, after: from })).toEqual([])
    expect(r.fixture.mentioning('state="cancelled"').length).toBeGreaterThan(0)
    // One notification, the Stop's own.
    expect(m.of('task-notification').map((o) => o.notification)).toMatchObject([
      { toolUseId: callId, status: 'stopped', taskId: started.data.taskId, isBackgrounded: true }
    ])
    expect(m.mapper.hasLiveBackgroundChild()).toBe(false)
    expect(await m.active()).not.toContain(started.data.taskId)
    // Stopped is final: nothing left to stop.
    expect(m.mapper.stopRun(callId)).toBeNull()
  })

  it('after the parent’s turn: the stop delivers a cancelled report that wakes the parent', async () => {
    const r = rig()
    const sessionID = await r.createSession(ALLOW_ALL)
    const m = driven(r, sessionID)
    const tag = nonce('bg')
    const { end } = await r.turn(sessionID, `[subbg] ${tag}`)
    expect(end.type).toBe('session.execution.succeeded')
    const started = await m.until(() => m.of('task-started')[0], 'the run to start')
    const callId = started.data.toolUseId
    expect(started.data.isBackgrounded).toBe(true)
    await streaming(m, callId)
    // The parent's turn is over; only the child works.
    expect(m.mapper.hasLiveBackgroundChild()).toBe(true)

    const mark = r.feed.mark()
    await m.stop(callId)

    const note = await m.until(() => m.of('task-notification')[0], 'the cancelled end')
    expect(note.notification).toMatchObject({
      toolUseId: callId,
      status: 'stopped',
      isBackgrounded: true
    })
    expect(m.mapper.hasLiveBackgroundChild()).toBe(false)
    // The completion reaches the parent as a message that WAKES it: a new turn the model reads.
    await r.feed.waitFor('session.execution.started', { sessionID, after: mark })
    await r.feed.waitForTurnEnd(sessionID, mark)
    expect(r.fixture.mentioning('state="cancelled"').length).toBeGreaterThan(0)
    expect(await m.active()).not.toContain(started.data.taskId)
  })

  it('a parent interrupt leaves its child running: it ends on its own and its report wakes the parent', async () => {
    const r = rig()
    const sessionID = await r.createSession(ALLOW_ALL)
    const m = driven(r, sessionID)
    const from = await prompt(r, sessionID, `[subbg] [afterslow] ${nonce('parent')}`)
    const started = await m.until(() => m.of('task-started')[0], 'the run')
    expect(started.data.isBackgrounded).toBe(true)
    await streaming(m, started.data.toolUseId)
    // The parent is still streaming (its slow answer after the launch result).
    await r.feed.waitFor('session.text.delta', {
      sessionID,
      after: from,
      where: (event) => event.data.delta.startsWith('after')
    })
    await m.client.interrupt(sessionID, { resume: true })
    const end = await r.feed.waitForTurnEnd(sessionID, from)
    expect(end.type).toBe('session.execution.interrupted')
    await sleep(500)
    m.pump()
    // Still running, still live to the mapper (it holds the idle timer), nothing settled.
    expect(await m.active()).toContain(started.data.taskId)
    expect(m.mapper.hasLiveBackgroundChild()).toBe(true)
    expect(m.of('task-notification')).toEqual([])
    // It finishes by itself: completed, not stopped …
    const done = await m.until(() => m.of('task-notification')[0], 'the child’s own end', 45_000)
    expect(done.notification).toMatchObject({
      toolUseId: started.data.toolUseId,
      status: 'completed',
      isBackgrounded: true
    })
    // … and its report wakes the parent: a new turn, which nobody stopped.
    const report = await r.feed.waitForReport(sessionID, started.data.taskId, {
      after: from,
      timeoutMs: 45_000
    })
    expect(report.state).toBe('completed')
    expect(report.end?.type).toBe('session.execution.succeeded')
    expect(m.mapper.hasLiveBackgroundChild()).toBe(false)
  })

  // `reversed` interrupts the child BEFORE its grandchild and waits for the child's end first (the
  // plan's order is the other way round): the grandchild's cancelled completion then reaches a
  // child that is no longer running, which opencode WAKES — the case the latch exists for.
  it.each(['planned', 'reversed'] as const)(
    'depth 2 (%s order): stopping a child stops its background grandchild, and nothing of the subtree runs on',
    async (order) => {
      const r = rig()
      const sessionID = await r.createSession(ALLOW_ALL)
      const m = driven(r, sessionID)
      const from = await prompt(r, sessionID, `[subnest] ${nonce('nest')}`)
      const child = await m.until(() => m.of('task-started')[0], 'the child run')
      const grand = await m.until(
        () => m.of('task-started').find((o) => o.data.toolUseId !== child.data.toolUseId),
        'the background grandchild run',
        45_000
      )
      expect(grand.data.isBackgrounded).toBe(true)
      // Both work: the grandchild streams its slow reply, the child is on its slow reply too.
      await streaming(m, grand.data.toolUseId)
      expect(await m.active()).toEqual(
        expect.arrayContaining([child.data.taskId, grand.data.taskId])
      )

      const mark = r.feed.mark()
      const plan = await m.stop(
        child.data.toolUseId,
        order,
        order === 'reversed'
          ? async (id) => {
              if (id === child.data.taskId) await r.feed.waitForTurnEnd(id, mark)
            }
          : undefined
      )
      expect(plan.sessions).toEqual([grand.data.taskId, child.data.taskId])

      // The root's own turn ended long before (the call answered at once); the child's
      // cancelled report wakes it for a turn that ends on its own.
      const end = await r.feed.waitForTurnEnd(sessionID, from)
      expect(end.type).toBe('session.execution.succeeded')
      const report = await r.feed.waitForReport(sessionID, child.data.taskId, { after: mark })
      expect(report.state).toBe('cancelled')
      expect(report.end?.type).toBe('session.execution.succeeded')
      // Give a woken child its chance (a cancelled grandchild's completion wakes its parent).
      await sleep(2_500)
      m.pump()
      const stoppedIds = new Set([child.data.toolUseId, grand.data.toolUseId])
      const notes = m
        .of('task-notification')
        .map((o) => o.notification)
        .filter((n) => n.toolUseId && stoppedIds.has(n.toolUseId))
      expect(notes.map((n) => [n.toolUseId, n.status]).sort()).toEqual(
        [
          [child.data.toolUseId, 'stopped'],
          [grand.data.toolUseId, 'stopped']
        ].sort()
      )
      // Nothing of the subtree is running — bounded, not one sample: on 2.2.5 the child is woken
      // by its cancelled grandchild's completion and starts a fresh execution, which the latch
      // interrupts again; the engine releases the claim when that run ends, a beat later.
      for (const id of [child.data.taskId, grand.data.taskId]) await untilIdle(m, id)

      // Every execution the child started after the Stop was asked to stop again, and was
      // ended by that, not by finishing its (slow) turn.
      const starts = r.feed.select('session.execution.started', {
        sessionID: child.data.taskId,
        after: mark
      })
      expect(m.reinterrupted.filter((id) => id === child.data.taskId)).toHaveLength(starts.length)
      const ended = (type: 'succeeded' | 'interrupted') =>
        r.feed.select(`session.execution.${type}`, { sessionID: child.data.taskId, after: mark })
      if (order === 'reversed') {
        // opencode woke the child (the grandchild's cancelled completion), and the latch stopped it.
        expect(starts).toHaveLength(1)
        expect(ended('succeeded')).toHaveLength(0)
        expect(ended('interrupted')).toHaveLength(2)
      }
    }
  )
})
