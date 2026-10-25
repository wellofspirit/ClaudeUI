/**
 * opencode 2.x contract: a per-subagent Stop (subagent-parity S3) — the REAL
 * engine's events through the REAL mapper, interrupted through the REAL client
 * (the transport `OpencodeSession.stopTask` uses):
 *
 *   OPENCODE_V2_INTEGRATION=1 bun run test:integration \
 *     src/integration/opencode/subagent-stop.contract.integration.test.ts
 *
 * Pins what the unit suites assume of 2.1.2:
 *   - interrupting a FOREGROUND child fails the parent's call ("Subagent
 *     cancelled") and the parent's turn goes on — the model sees the failure;
 *   - interrupting a BACKGROUND child delivers a cancelled completion to the
 *     parent (a synthetic `<subagent … state="cancelled">` message the model reads);
 *   - interrupting the PARENT cancels a foreground child but a background child
 *     survives and still ends on its own;
 *   - a stopped child with a background grandchild (`experimental.subagent_depth`
 *     2): the plan stops grandchild then child, and nothing of the stopped
 *     subtree keeps running or is woken to run again.
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

  it('foreground: the parent’s call fails "Subagent cancelled", the turn goes on, the card reads stopped', async () => {
    const r = rig()
    const sessionID = await r.createSession(ALLOW_ALL)
    const m = driven(r, sessionID)
    const tag = nonce('fg')
    const from = await prompt(r, sessionID, `[subslow] ${tag}`)
    const started = await m.until(() => m.of('task-started')[0], 'the run to start')
    const callId = started.data.toolUseId
    await streaming(m, callId)

    const plan = await m.stop(callId)
    expect(plan.sessions).toEqual([started.data.taskId])

    // The parent's turn is NOT cut: it ends on its own, after the model read the failure.
    const end = await r.feed.waitForTurnEnd(sessionID, from)
    expect(end.type).toBe('session.execution.succeeded')
    const next = r.fixture.mentioning('Subagent cancelled')
    expect(next.length).toBeGreaterThan(0)
    expect(m.of('tool-result').find((o) => o.result.toolUseId === callId)).toMatchObject({
      result: { isError: true }
    })
    // One notification, the Stop's own.
    await sleep(300)
    expect(m.of('task-notification').map((o) => o.notification)).toMatchObject([
      { toolUseId: callId, status: 'stopped', taskId: started.data.taskId }
    ])
    expect(m.mapper.hasLiveBackgroundChild()).toBe(false)
    expect(await m.active()).not.toContain(started.data.taskId)
    // Stopped is final: nothing left to stop.
    expect(m.mapper.stopRun(callId)).toBeNull()
  })

  it('background: the stop delivers a cancelled completion that the parent’s model reads', async () => {
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

  it('a parent interrupt cancels a foreground child, but a background child survives and ends on its own', async () => {
    const r = rig()
    // Foreground: cancelled with the parent.
    const fgSession = await r.createSession(ALLOW_ALL)
    const fg = driven(r, fgSession)
    const fgFrom = await prompt(r, fgSession, `[subslow] ${nonce('pfg')}`)
    const fgStarted = await fg.until(() => fg.of('task-started')[0], 'the foreground run')
    await streaming(fg, fgStarted.data.toolUseId)
    await fg.client.interrupt(fgSession)
    const fgEnd = await r.feed.waitForTurnEnd(fgSession, fgFrom)
    expect(fgEnd.type).toBe('session.execution.interrupted')
    const fgChildEnd = await r.feed.waitForTurnEnd(fgStarted.data.taskId, fgFrom)
    expect(fgChildEnd.type).toBe('session.execution.interrupted')

    // Background: the parent streams on after launching it; interrupting the parent leaves it be.
    const bgSession = await r.createSession(ALLOW_ALL)
    const bg = driven(r, bgSession)
    const bgFrom = await prompt(r, bgSession, `[subbg] [afterslow] ${nonce('pbg')}`)
    const bgStarted = await bg.until(() => bg.of('task-started')[0], 'the background run')
    expect(bgStarted.data.isBackgrounded).toBe(true)
    await streaming(bg, bgStarted.data.toolUseId)
    // The parent is still streaming (its slow answer after the launch result).
    await r.feed.waitFor('session.text.delta', {
      sessionID: bgSession,
      after: bgFrom,
      where: (event) => event.data.delta.startsWith('after')
    })
    await bg.client.interrupt(bgSession)
    const bgEnd = await r.feed.waitForTurnEnd(bgSession, bgFrom)
    expect(bgEnd.type).toBe('session.execution.interrupted')
    await sleep(500)
    // Still running, and it finishes by itself: completed, not stopped.
    expect(await bg.active()).toContain(bgStarted.data.taskId)
    const done = await bg.until(
      () => bg.of('task-notification').find((o) => o.notification.status !== undefined),
      'the background child’s own end',
      45_000
    )
    expect(done.notification).toMatchObject({
      toolUseId: bgStarted.data.toolUseId,
      status: 'completed',
      isBackgrounded: true
    })
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

      // The parent call fails "Subagent cancelled" and the root's turn ends on its own.
      const end = await r.feed.waitForTurnEnd(sessionID, from)
      expect(end.type).toBe('session.execution.succeeded')
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
      // Nothing of the subtree is running.
      expect(await m.active()).not.toContain(child.data.taskId)
      expect(await m.active()).not.toContain(grand.data.taskId)

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
