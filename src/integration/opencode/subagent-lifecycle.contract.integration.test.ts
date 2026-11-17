/**
 * opencode 2.x contract: the task lifecycle of a native subagent as ClaudeUI's
 * mapper reports it (subagent-parity S2) — the REAL engine's events through
 * the REAL mapper:
 *
 *   OPENCODE_V2_INTEGRATION=1 bun run test:integration \
 *     src/integration/opencode/subagent-lifecycle.contract.integration.test.ts
 *
 * Pins what the unit suites assume of 2.3.0, where EVERY subagent runs in the
 * background (upstream removed the foreground path and the `background` input):
 *   - a run: ONE `task-started` (`isBackgrounded: true`) before the child's first
 *     step, progress per child step, the call answers at once, the child's own end
 *     is the one notification with the run's usage/runIndex/summary, and its
 *     `<subagent state="completed">` report wakes the parent for a turn of its own;
 *   - a slow child: the parent's turn ends while it works (the idle timer must
 *     hold), its end is the notification;
 *   - STEERING: a second call with the child's `sessionID` while it still runs
 *     (opencode joins it to the child's current run) leaves the first call
 *     un-notified by opencode — the mapper settles it before the second run
 *     starts, and the child's end notifies the second call only;
 *   - ROUNDS: a child whose round ends while its own background shell runs
 *     reports `state="running"` (the run stays live: re-armed, timer held), the
 *     shell's end wakes it for a second round, and the run's notification is
 *     re-sent with that round (`completed`); no report is ever a user message.
 */
import { expect, it } from 'vitest'
import { OpencodeEventMapper, type OpencodeMapperOutput } from '../../core/opencode/event-mapper'
import { describeV2, nonce, useRig, type Rig } from './harness/host'

const ALLOW_ALL = { permissions: [{ action: '*', resource: '*', effect: 'allow' as const }] }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A mapper over the rig's raw feed: `pump()` maps whatever arrived since the last call. */
function mapped(r: Rig, sessionID: string) {
  const mapper = new OpencodeEventMapper({ sessionID })
  const outputs: OpencodeMapperOutput[] = []
  let next = r.feed.mark()
  const pump = () => {
    for (; next < r.feed.events.length; next++) outputs.push(...mapper.map(r.feed.events[next]))
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
  return { mapper, outputs, pump, until, of }
}

describeV2('opencode 2.x contract: the task lifecycle of a native subagent', () => {
  // The slow child streams for 30 × 150 ms: a window for the parent to end / steer.
  const rig = useRig('subagent-lifecycle', { slowChunkMs: 150 })

  it('a run: one background start before the child’s steps, progress per step, one notification, a report that wakes the parent', async () => {
    const r = rig()
    const sessionID = await r.createSession(ALLOW_ALL)
    const m = mapped(r, sessionID)
    const { end, from } = await r.turn(sessionID, `[subread] ${nonce('run')}`)
    expect(end.type).toBe('session.execution.succeeded')
    const [linked] = m.of('subagent-started')
    // The call answered at once: the launch acknowledgement, not the child's answer.
    const launch = m
      .of('tool-result')
      .find((o) => o.result.toolUseId === linked.toolUseId && !o.ownerToolUseId)
    expect(launch?.result.result).toContain('working in the background')
    // The child's report wakes the parent; that turn is an ordinary one.
    const report = await r.feed.waitForReport(sessionID, linked.childSessionId, { after: from })
    expect(report.state).toBe('completed')
    expect(report.end?.type).toBe('session.execution.succeeded')
    m.pump()

    const started = m.of('task-started')
    expect(started).toHaveLength(1)
    expect(started[0].data).toMatchObject({
      toolUseId: linked.toolUseId,
      taskId: linked.childSessionId,
      taskType: 'local_agent',
      runIndex: 1,
      wakesParent: true,
      // Every run is a background one; never `false` (no "Send to background", ADR-111 §4).
      isBackgrounded: true,
      description: 'contract reader'
    })
    expect(started[0].data.startedAt).toBeGreaterThan(0)

    // The start precedes everything of the child's.
    const order = m.outputs.map((o) => o.kind)
    const firstChildOutput = m.outputs.findIndex(
      (o) =>
        (o.kind === 'message' && o.ownerToolUseId === linked.toolUseId) ||
        (o.kind === 'step-usage' && o.usage.ownerToolUseId === linked.toolUseId)
    )
    expect(order.indexOf('task-started')).toBeLessThan(firstChildOutput)

    // `[subread]`: the child reads a file (one tool), then answers: two steps.
    const progress = m.of('task-progress').map((o) => o.progress)
    expect(progress.length).toBeGreaterThanOrEqual(2)
    for (const p of progress)
      expect(p).toMatchObject({
        toolUseId: linked.toolUseId,
        toolName: 'subagent',
        parentToolUseId: null
      })
    const totals = progress.map((p) => p.usage?.totalTokens ?? 0)
    expect(totals).toEqual([...totals].sort((a, b) => a - b))
    expect(totals[0]).toBeGreaterThan(0)
    expect(progress.at(-1)?.usage?.toolUses).toBe(1)
    expect(progress.some((p) => p.lastToolName === 'read')).toBe(true)

    const notes = m.of('task-notification')
    expect(notes).toHaveLength(1)
    expect(notes[0].notification).toMatchObject({
      toolUseId: linked.toolUseId,
      taskId: linked.childSessionId,
      status: 'completed',
      runIndex: 1,
      isBackgrounded: true,
      usage: { totalTokens: totals.at(-1), toolUses: 1 }
    })
    // The child's own last words (it read the file, then answered).
    expect(notes[0].notification.summary).toContain('TOOL_RESULT_SEEN')
    expect(notes[0].notification.summary.length).toBeLessThanOrEqual(100)
    expect(m.mapper.hasLiveBackgroundChild()).toBe(false)
    // The report is never a user message: the only user row is the prompt.
    expect(m.of('user-message')).toHaveLength(1)
  })

  it('a slow child: the parent’s turn ends while it works; the child’s own end is the notification', async () => {
    const r = rig()
    const sessionID = await r.createSession(ALLOW_ALL)
    const m = mapped(r, sessionID)
    const { end } = await r.turn(sessionID, `[subbg] ${nonce('bg')}`)
    expect(end.type).toBe('session.execution.succeeded')
    m.pump()

    const [started] = m.of('task-started')
    expect(started.data).toMatchObject({ isBackgrounded: true, wakesParent: true, runIndex: 1 })
    // The parent is done, the child is not: the idle timer must hold until its end.
    expect(m.of('task-notification')).toHaveLength(0)
    expect(m.mapper.hasLiveBackgroundChild()).toBe(true)

    const note = await m.until(
      () =>
        m.of('task-notification').find((o) => o.notification.toolUseId === started.data.toolUseId),
      'the background child’s end'
    )
    expect(note.notification).toMatchObject({
      status: 'completed',
      runIndex: 1,
      isBackgrounded: true,
      taskId: started.data.taskId
    })
    // The slow child's own words (not the call's launch acknowledgement).
    expect(note.notification.summary).toContain('slow#')
    expect(note.notification.usage?.totalTokens).toBeGreaterThan(0)
    // The run lasted as long as the child streamed, far past the parent's turn.
    expect(note.notification.usage?.durationMs).toBeGreaterThan(1_000)
    expect(m.mapper.hasLiveBackgroundChild()).toBe(false)
    // One notification for the run, not one per observer.
    expect(m.of('task-notification')).toHaveLength(1)
    await r.feed.waitForReport(sessionID, started.data.taskId, { state: 'completed' })
  })

  it('steering: a second call while the child still runs settles the first, and only the second is notified at the child’s end', async () => {
    const r = rig()
    const sessionID = await r.createSession(ALLOW_ALL)
    const m = mapped(r, sessionID)
    await r.turn(sessionID, `[subbg] ${nonce('first')}`)
    const [first] = m.of('task-started')
    expect(m.mapper.hasLiveBackgroundChild()).toBe(true)

    await r.turn(sessionID, `[substeer] ${nonce('second')}`)
    const second = await m.until(
      () => m.of('task-started').find((o) => o.data.toolUseId !== first.data.toolUseId),
      'the steering call’s start'
    )
    expect(second.data).toMatchObject({
      taskId: first.data.taskId,
      runIndex: 2,
      isBackgrounded: true
    })

    // The first call was never told by opencode; the mapper settled it before the second began.
    const superseded = m
      .of('task-notification')
      .filter((o) => o.notification.toolUseId === first.data.toolUseId)
    expect(superseded).toHaveLength(1)
    expect(superseded[0].notification).toMatchObject({
      status: 'completed',
      summary: 'continued by a later call',
      runIndex: 1
    })
    const order = m.outputs.map((o) => o)
    expect(order.indexOf(superseded[0])).toBeLessThan(order.indexOf(second))

    // The child ends: the second call is notified, once; the first is not told again.
    const last = await m.until(
      () =>
        m.of('task-notification').find((o) => o.notification.toolUseId === second.data.toolUseId),
      'the steered child’s end',
      45_000
    )
    expect(last.notification).toMatchObject({
      status: 'completed',
      runIndex: 2,
      isBackgrounded: true
    })
    await sleep(500)
    const notes = m.of('task-notification').map((o) => o.notification.toolUseId)
    expect(notes.filter((id) => id === first.data.toolUseId)).toHaveLength(1)
    expect(notes.filter((id) => id === second.data.toolUseId)).toHaveLength(1)
    expect(m.mapper.hasLiveBackgroundChild()).toBe(false)
    await r.feed.waitForReport(sessionID, first.data.taskId, { state: 'completed' })
  })

  it('rounds: a `state="running"` report keeps the run live; the child’s second round re-notifies it', async () => {
    const r = rig()
    const sessionID = await r.createSession(ALLOW_ALL)
    const m = mapped(r, sessionID)
    const { from } = await r.turn(sessionID, `[subshellbg] ${nonce('rounds')}`)
    const [started] = await m.until(
      () => (m.of('task-started').length > 0 ? m.of('task-started') : undefined),
      'the run'
    )
    const child = started.data.taskId
    // Round one ends with the child's background shell still running.
    const running = await r.feed.waitForReport(sessionID, child, {
      after: from,
      read: false,
      timeoutMs: 30_000
    })
    expect(running.state).toBe('running')
    expect(running.text).toContain('Background work still running')
    m.pump()
    expect(m.of('task-notification')).toHaveLength(1)
    // Re-armed by the report: same run, live again (the idle timer holds).
    expect(m.of('task-started').map((o) => [o.data.toolUseId, o.data.runIndex])).toEqual([
      [started.data.toolUseId, 1],
      [started.data.toolUseId, 1]
    ])
    expect(m.mapper.hasLiveBackgroundChild()).toBe(true)

    // The shell's end wakes the child; its second round is the run's end.
    const done = await r.feed.waitForReport(sessionID, child, {
      after: running.at + 1,
      timeoutMs: 45_000
    })
    expect(done.state).toBe('completed')
    m.pump()
    const notes = m.of('task-notification').map((o) => o.notification)
    expect(notes.map((n) => [n.toolUseId, n.runIndex, n.status])).toEqual([
      [started.data.toolUseId, 1, 'completed'],
      [started.data.toolUseId, 1, 'completed']
    ])
    // The second notification carries the second round: more of the run's usage.
    expect(notes[1].usage!.totalTokens).toBeGreaterThan(notes[0].usage!.totalTokens)
    expect(notes[1].summary).not.toBe(notes[0].summary)
    expect(m.mapper.hasLiveBackgroundChild()).toBe(false)
    // Neither report (nor the shell's notice to the child) is a user message.
    expect(m.of('user-message')).toHaveLength(1)
  })
})
