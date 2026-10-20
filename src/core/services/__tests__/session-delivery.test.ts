/**
 * @vitest-environment node
 *
 * The delivery rule for items that are not the user's (slice 1a, spec §6.5):
 * busy → the engine's queue; idle and (session-message or wake) and budget left
 * → a turn starts; otherwise HELD in the inbox and delivered, oldest first, ahead
 * of the target's next turn. Taint (`userOriginClean`) and the agent-turn budget
 * are counted per session.
 *
 * The inbox is the real `session_inbox` table (the node:sqlite-backed driver the
 * suite aliases `better-sqlite3` to); sessions are doubles with one adapter
 * method, because the rule is engine-neutral.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NonUserItem, NonUserOutcome } from '../../providers/ISession'
import {
  TurnOriginLedger,
  AGENT_TURN_BUDGET,
  DISPATCH_WAKE_CAP
} from '../../providers/turn-origin-ledger'
import type { SessionManager } from '../session-manager'
import { dispatchReportsOf, heldInboxCount, heldInboxItems, insertDispatchReport } from '../db'
import { syncCore } from '../sync-host'
import {
  HELD_INBOX_CAP,
  ITEM_BODY_MAX,
  deliver,
  flushHeld,
  flushHeldDispatchResults,
  reholdNonUserItem,
  sessionOriginState
} from '../session-delivery'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

interface FakeSession {
  willQueue: boolean
  originLedger: TurnOriginLedger
  getSessionId: () => string | null
  isEngineLive?: () => boolean
  deliverNonUser: ReturnType<typeof vi.fn<(item: NonUserItem) => Promise<NonUserOutcome>>>
}

/** `outcomes` answers successive deliveries; the last repeats. A `started` turn makes the session busy. */
function fake(
  outcomes: NonUserOutcome[] = ['started'],
  willQueue = false,
  delayMs = 0
): FakeSession {
  let call = 0
  const session: FakeSession = {
    willQueue,
    originLedger: new TurnOriginLedger(),
    getSessionId: () => null,
    deliverNonUser: vi.fn(async () => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      const outcome = outcomes[Math.min(call++, outcomes.length - 1)]
      if (outcome === 'started') session.willQueue = true
      return outcome
    })
  }
  return session
}

let n = 0
/** A fresh target per test: the inbox table outlives a test in the shared throwaway profile. */
function target(): string {
  return `rid-delivery-${process.pid}-${++n}`
}

function managerOf(entries: Record<string, FakeSession>): SessionManager {
  return { get: (id: string) => entries[id], has: (id: string) => id in entries } as never
}

const FROM = { key: 'sender-1', title: 'Triage assistant' }
const msg = (text: string, over: Partial<NonUserItem> = {}): NonUserItem => ({
  origin: 'session-message',
  text,
  from: FROM,
  wake: false,
  ...over
})
const note = (text: string, over: Partial<NonUserItem> = {}): NonUserItem =>
  msg(text, { origin: 'agent-note', ...over })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('where an item goes', () => {
  it('a target with no live session holds it, and nothing else happens', async () => {
    const t = target()
    expect(await deliver(managerOf({}), t, msg('hello'))).toEqual({
      result: 'held',
      why: 'no-live-session'
    })
    expect(heldInboxItems(t)).toMatchObject([
      {
        origin: 'session-message',
        fromKey: 'sender-1',
        fromTitle: 'Triage assistant',
        body: 'hello'
      }
    ])
  })

  it('a busy target takes it in its queue — whatever it is, wake or not, budget or not', async () => {
    const t = target()
    const s = fake(['queued'], true)
    for (let i = 0; i < AGENT_TURN_BUDGET; i++) s.originLedger.agentTurnStarted()
    expect(await deliver(managerOf({ [t]: s }), t, note('fyi'))).toEqual({ result: 'queued' })
    expect(s.deliverNonUser).toHaveBeenCalledTimes(1)
    expect(heldInboxCount(t)).toBe(0)
  })

  it('an idle target starts a turn on a session message even without wake', async () => {
    const t = target()
    const s = fake(['started'])
    expect(await deliver(managerOf({ [t]: s }), t, msg('do it'))).toEqual({ result: 'delivered' })
    expect(s.deliverNonUser).toHaveBeenCalledWith(msg('do it'))
  })

  it('an idle target starts a turn on a note only when it carries wake', async () => {
    const t = target()
    const s = fake(['started'])
    const m = managerOf({ [t]: s })
    expect(await deliver(m, t, note('later'))).toEqual({ result: 'held', why: 'idle-no-wake' })
    expect(s.deliverNonUser).not.toHaveBeenCalled()
    expect(await deliver(m, t, note('now', { wake: true }))).toEqual({ result: 'delivered' })
    // The held note leads the woken turn.
    expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual(['later', 'now'])
    expect(heldInboxCount(t)).toBe(0)
  })

  it('an engine that cannot take it now leaves it held, untainted', async () => {
    const t = target()
    const s = fake(['unavailable'])
    expect(await deliver(managerOf({ [t]: s }), t, msg('x'))).toEqual({
      result: 'held',
      why: 'engine-unavailable'
    })
    expect(heldInboxCount(t)).toBe(1)
    expect(s.originLedger.userOriginClean).toBe(true)
  })

  it('past the agent-turn budget an idle target holds, and the user speaking restores it', async () => {
    const t = target()
    const s = fake(['started'])
    const m = managerOf({ [t]: s })
    for (let i = 0; i < AGENT_TURN_BUDGET; i++) s.originLedger.agentTurnStarted()
    expect(await deliver(m, t, msg('again'))).toEqual({ result: 'held', why: 'budget-exhausted' })
    expect(s.deliverNonUser).not.toHaveBeenCalled()
    s.originLedger.userPrompt()
    expect(await deliver(m, t, msg('again 2'))).toEqual({ result: 'delivered' })
  })
})

describe('taint and budget', () => {
  it('a delivery taints the session and a started turn spends budget; the user resets both', async () => {
    const t = target()
    const s = fake(['started', 'queued'])
    const m = managerOf({ [t]: s })
    expect(sessionOriginState(m, t)).toEqual({
      userOriginClean: true,
      agentTurnStartsSinceUser: 0,
      agentTurnBudget: AGENT_TURN_BUDGET
    })
    await deliver(m, t, msg('one'))
    expect(sessionOriginState(m, t)).toMatchObject({
      userOriginClean: false,
      agentTurnStartsSinceUser: 1
    })
    // Now busy: joins the running turn, taints, but starts nothing.
    await deliver(m, t, msg('two'))
    expect(sessionOriginState(m, t)).toMatchObject({
      userOriginClean: false,
      agentTurnStartsSinceUser: 1
    })
    s.originLedger.userPrompt()
    expect(sessionOriginState(m, t)).toMatchObject({
      userOriginClean: true,
      agentTurnStartsSinceUser: 0
    })
  })

  it('a held item taints nothing — the model has not read it', async () => {
    const t = target()
    const s = fake()
    await deliver(managerOf({ [t]: s }), t, note('later'))
    expect(s.originLedger.userOriginClean).toBe(true)
  })

  it('has no state for a session that is not live', () => {
    expect(sessionOriginState(managerOf({}), 'nobody')).toBeNull()
  })
})

describe('the held inbox', () => {
  async function holdThree(t: string, m: SessionManager): Promise<void> {
    await deliver(m, t, note('first'))
    await deliver(m, t, note('second', { senderModeClass: 'bypass' }))
    await deliver(m, t, note('third'))
  }

  it('is delivered oldest first as leading items, the first one starting the turn', async () => {
    const t = target()
    const s = fake(['started', 'queued', 'queued'])
    const m = managerOf({ [t]: s })
    await holdThree(t, m)
    expect(heldInboxItems(t).map((r) => r.body)).toEqual(['first', 'second', 'third'])
    expect(heldInboxItems(t)[1].senderModeClass).toBe('bypass')

    expect(await flushHeld(m, t)).toBe(true)
    expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual([
      'first',
      'second',
      'third'
    ])
    // Idle targets are woken by the first; the sender's class rides along.
    expect(s.deliverNonUser.mock.calls.every(([item]) => item.wake)).toBe(true)
    expect(s.deliverNonUser.mock.calls[1][0].senderModeClass).toBe('bypass')
    expect(heldInboxCount(t)).toBe(0)
    expect(s.originLedger.userOriginClean).toBe(false)
    // Flushing is not the agent starting a turn: the user (or a newer item) did.
    expect(s.originLedger.agentTurnStartsSinceUser).toBe(0)
  })

  it('stops at the first item the engine cannot take; the rest stay held', async () => {
    const t = target()
    const s = fake(['started', 'unavailable'])
    const m = managerOf({ [t]: s })
    await holdThree(t, m)
    await flushHeld(m, t)
    expect(heldInboxItems(t).map((r) => r.body)).toEqual(['second', 'third'])
  })

  it('goes ahead of a newer item that wakes an idle target', async () => {
    const t = target()
    const s = fake(['started', 'queued', 'queued'])
    const m = managerOf({ [t]: s })
    await deliver(m, t, note('old 1'))
    await deliver(m, t, note('old 2'))
    expect(await deliver(m, t, msg('new'))).toEqual({ result: 'delivered' })
    expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual([
      'old 1',
      'old 2',
      'new'
    ])
    expect(heldInboxCount(t)).toBe(0)
    expect(s.originLedger.agentTurnStartsSinceUser).toBe(1)
  })

  it('is replicated as a per-session count, in the snapshot too', async () => {
    const t = target()
    syncCore.emit('session:created', [t, { cwd: '/tmp/x' }])
    const m = managerOf({ [t]: fake(['started']) })
    await deliver(m, t, note('one'))
    await deliver(m, t, note('two'))
    expect(syncCore.getCanonicalState().sessions[t].heldCount).toBe(2)
    expect(syncCore.getSnapshot().sessions[t].heldCount).toBe(2)
    await flushHeld(m, t)
    expect(syncCore.getCanonicalState().sessions[t].heldCount).toBe(0)
  })

  it("also answers to the session's engine session id", async () => {
    const t = target()
    const s = fake(['started'])
    s.getSessionId = () => `${t}-engine`
    await deliver(managerOf({}), `${t}-engine`, note('while cold'))
    expect(await flushHeld(managerOf({ [t]: s }), t)).toBe(true)
    expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual(['while cold'])
    expect(heldInboxCount(`${t}-engine`)).toBe(0)
  })
})

describe('concurrent deliveries (review M2)', () => {
  it('two deliveries to one idle target with two held rows send every item exactly once, in order', async () => {
    const t = target()
    const s = fake(['started', 'queued'], false, 5)
    const m = managerOf({ [t]: s })
    await deliver(m, t, note('old 1'))
    await deliver(m, t, note('old 2'))

    const [a, b] = await Promise.all([deliver(m, t, msg('new A')), deliver(m, t, msg('new B'))])

    expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual([
      'old 1',
      'old 2',
      'new A',
      'new B'
    ])
    expect(a).toEqual({ result: 'delivered' })
    expect(b).toEqual({ result: 'queued' })
    expect(heldInboxCount(t)).toBe(0)
  })

  it('a delivery racing the prompt path flush does not repeat a row', async () => {
    const t = target()
    const s = fake(['started', 'queued'], false, 5)
    const m = managerOf({ [t]: s })
    await deliver(m, t, note('old'))
    await Promise.all([flushHeld(m, t), flushHeld(m, t)])
    expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual(['old'])
  })
})

describe('an engine that exited (review M4)', () => {
  it('holds a message for an idle target whose process is gone — nothing is spawned', async () => {
    const t = target()
    const s = fake(['started'])
    s.isEngineLive = () => false
    expect(await deliver(managerOf({ [t]: s }), t, msg('hello'))).toEqual({
      result: 'held',
      why: 'engine-exited'
    })
    expect(s.deliverNonUser).not.toHaveBeenCalled()
    expect(heldInboxItems(t).map((r) => r.body)).toEqual(['hello'])
  })

  it('a busy target is not asked: it is live by definition', async () => {
    const t = target()
    const s = fake(['queued'], true)
    s.isEngineLive = () => false
    expect(await deliver(managerOf({ [t]: s }), t, msg('hello'))).toEqual({ result: 'queued' })
  })

  it("the user's own prompt still brings it back: the flush does not check", async () => {
    const t = target()
    const s = fake(['started'])
    s.isEngineLive = () => false
    const m = managerOf({ [t]: s })
    await deliver(m, t, msg('hello'))
    expect(await flushHeld(m, t)).toBe(true)
    expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual(['hello'])
  })
})

describe('the inbox is bounded (review m2, m3)', () => {
  it('refuses out loud past the cap, instead of dropping or evicting', async () => {
    const t = target()
    const m = managerOf({})
    for (let i = 0; i < HELD_INBOX_CAP; i++) {
      expect(await deliver(m, t, note(`n${i}`))).toMatchObject({ result: 'held' })
    }
    expect(await deliver(m, t, note('one too many'))).toEqual({
      result: 'refused',
      why: 'inbox-full'
    })
    expect(heldInboxCount(t)).toBe(HELD_INBOX_CAP)
  })

  it('an item an engine gave back is kept even at the cap — it was already promised', () => {
    const t = target()
    const s = fake()
    ;(s as unknown as { routingId: string }).routingId = t
    for (let i = 0; i < HELD_INBOX_CAP; i++) {
      reholdNonUserItem(s as never, note(`n${i}`))
    }
    reholdNonUserItem(s as never, note('given back'))
    expect(heldInboxCount(t)).toBe(HELD_INBOX_CAP + 1)
  })

  it('cuts an over-long body and says so', async () => {
    const t = target()
    await deliver(managerOf({}), t, note('x'.repeat(ITEM_BODY_MAX + 5000)))
    const [row] = heldInboxItems(t)
    expect(row.body).toHaveLength(ITEM_BODY_MAX)
    expect(row.body.endsWith('[... message truncated ...]')).toBe(true)
    await deliver(managerOf({}), t, note('short'))
    expect(heldInboxItems(t)[1].body).toBe('short')
  })

  it('a newer item does not overtake rows the flush could not deliver', async () => {
    const t = target()
    const s = fake(['unavailable', 'started'])
    const m = managerOf({ [t]: s })
    await deliver(m, t, note('older'))
    expect(await deliver(m, t, msg('newer'))).toEqual({
      result: 'held',
      why: 'engine-unavailable'
    })
    expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual(['older'])
    expect(heldInboxItems(t).map((r) => r.body)).toEqual(['older', 'newer'])
  })
})

describe('X-Agent results: origin dispatch-result (ADR-105 §3)', () => {
  const XA = { key: 's-abc234', title: 'rev' }
  const result = (text: string, over: Partial<NonUserItem> = {}): NonUserItem => ({
    origin: 'dispatch-result',
    text,
    from: XA,
    wake: true,
    ...over
  })

  it('wakes an idle parent, is framed under the X-Agent prefix key, and does not spend the agent-turn budget', async () => {
    const t = target()
    const s = fake(['started'])
    expect(await deliver(managerOf({ [t]: s }), t, result('done'))).toEqual({
      result: 'delivered'
    })
    expect(s.deliverNonUser).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'dispatch-result',
        from: { key: 'x-agent:s-abc234', title: 'rev' },
        wake: true
      })
    )
    expect(s.originLedger.agentTurnStartsSinceUser).toBe(0)
    expect(s.originLedger.dispatchWakesSinceUser).toBe(1)
    // Still non-user: the turn it starts cannot satisfy the clean-user-turn gate.
    expect(s.originLedger.userOriginClean).toBe(false)
  })

  it('an exhausted agent-turn budget does not hold it, and it does not hold the budget back either', async () => {
    const t = target()
    const s = fake(['started'])
    for (let i = 0; i < AGENT_TURN_BUDGET; i++) s.originLedger.agentTurnStarted()
    expect(await deliver(managerOf({ [t]: s }), t, result('still comes'))).toEqual({
      result: 'delivered'
    })
    // ...and a plain session message is still refused a turn by that budget.
    const u = target()
    const full = fake(['started'])
    for (let i = 0; i < AGENT_TURN_BUDGET; i++) full.originLedger.agentTurnStarted()
    expect(await deliver(managerOf({ [u]: full }), u, msg('chat'))).toEqual({
      result: 'held',
      why: 'budget-exhausted'
    })
  })

  it('past its own cap of 25 wakes since the user last spoke the result is held, and a user prompt resets it', async () => {
    const t = target()
    const s = fake(['started'])
    const m = managerOf({ [t]: s })
    for (let i = 0; i < DISPATCH_WAKE_CAP; i++) {
      s.willQueue = false // each wake's turn ended
      expect(await deliver(m, t, result(`r${i}`))).toEqual({ result: 'delivered' })
    }
    expect(s.originLedger.dispatchWakesSinceUser).toBe(DISPATCH_WAKE_CAP)
    s.willQueue = false
    expect(await deliver(m, t, result('the 26th'))).toEqual({ result: 'held', why: 'dispatch-cap' })
    expect(heldInboxItems(t)).toMatchObject([{ origin: 'dispatch-result', body: 'the 26th' }])
    expect(s.deliverNonUser).toHaveBeenCalledTimes(DISPATCH_WAKE_CAP)

    s.originLedger.userPrompt()
    s.willQueue = false
    expect(await deliver(m, t, result('after the user spoke'))).toEqual({ result: 'delivered' })
    // The older held result leads the woken turn.
    expect(s.deliverNonUser.mock.calls.slice(-2).map(([item]) => item.text)).toEqual([
      'the 26th',
      'after the user spoke'
    ])
  })

  it('a busy parent takes it in its queue (no wake counted)', async () => {
    const t = target()
    const s = fake(['queued'], true)
    expect(await deliver(managerOf({ [t]: s }), t, result('mid-turn'))).toEqual({
      result: 'queued'
    })
    expect(s.originLedger.dispatchWakesSinceUser).toBe(0)
  })

  it('is held while the parent is not live, with its origin and prefixed sender key intact', async () => {
    const t = target()
    expect(await deliver(managerOf({}), t, result('waits'))).toEqual({
      result: 'held',
      why: 'no-live-session'
    })
    expect(heldInboxItems(t)).toMatchObject([
      { origin: 'dispatch-result', fromKey: 'x-agent:s-abc234', fromTitle: 'rev', body: 'waits' }
    ])
    const dead = fake(['started'])
    dead.isEngineLive = () => false
    const u = target()
    expect(await deliver(managerOf({ [u]: dead }), u, result('engine down'))).toEqual({
      result: 'held',
      why: 'engine-exited'
    })
  })

  it('flushHeldDispatchResults delivers only the held results, in order, and stamps their reports delivered', async () => {
    const t = target()
    const x = `s-flush${n}`
    insertDispatchReport({
      targetId: x,
      toolUseId: 'toolu_1',
      status: 'delivered',
      report: 'R1',
      createdAt: 1
    })
    insertDispatchReport({
      targetId: x,
      toolUseId: 'toolu_2',
      status: 'delivered',
      report: 'R2',
      createdAt: 2
    })
    insertDispatchReport({
      targetId: x,
      toolUseId: 'toolu_3',
      status: 'delivered',
      report: 'R3',
      createdAt: 3
    })
    // Held while the parent was down: results of runs 2 and 3 (run 1 blocked and was handed
    // back as a tool result, so it is in no inbox) and an ordinary session message.
    await deliver(
      managerOf({}),
      t,
      result('first', { from: { key: x, title: 'rev' }, reportRun: 2 })
    )
    await deliver(managerOf({}), t, msg('a chat message'))
    await deliver(
      managerOf({}),
      t,
      result('second', { from: { key: x, title: 'rev' }, reportRun: 3 })
    )
    expect(heldInboxCount(t)).toBe(3)

    const s = fake(['started', 'queued'])
    expect(await flushHeldDispatchResults(managerOf({ [t]: s }), t)).toBe(true)
    expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual(['first', 'second'])
    // The chat message stays held for the user's next prompt.
    expect(heldInboxItems(t).map((r) => r.body)).toEqual(['a chat message'])
    expect(s.originLedger.dispatchWakesSinceUser).toBe(1)
    // Exactly the runs that went out are stamped; run 1 (never held) is not touched.
    expect(dispatchReportsOf([x]).map((r) => [r.run, r.deliveredAt !== null])).toEqual([
      [1, false],
      [2, true],
      [3, true]
    ])
    // Nothing left to deliver: a second flush is a no-op (delivered once).
    expect(await flushHeldDispatchResults(managerOf({ [t]: s }), t)).toBe(false)
    expect(s.deliverNonUser).toHaveBeenCalledTimes(2)
  })

  it('flushHeldDispatchResults waits for the resumed session’s totals seed before it starts a turn (as a user prompt does)', async () => {
    const t = target()
    await deliver(managerOf({}), t, result('report', { from: { key: `s-seed${n}`, title: 'rev' } }))
    const s = fake(['started'])
    let folded = false
    let release!: () => void
    const seed = new Promise<void>((resolve) => (release = resolve)).then(() => {
      folded = true
    })
    let startedBeforeFold: boolean | undefined
    s.deliverNonUser.mockImplementation(async () => {
      startedBeforeFold = !folded
      return 'started'
    })
    ;(s as unknown as { resumeSeedReady: () => Promise<void> }).resumeSeedReady = () => seed
    const flushed = flushHeldDispatchResults(managerOf({ [t]: s }), t)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(s.deliverNonUser).not.toHaveBeenCalled()
    release()
    expect(await flushed).toBe(true)
    expect(startedBeforeFold).toBe(false)
  })

  describe('a flush of held results keeps an X-Agent’s earlier message ahead of its later result (ADR-105 §4)', () => {
    const fromMessage = (id: string): NonUserItem['from'] => ({
      key: `x-agent-message:${id}`,
      title: 'rev'
    })

    it('the question the X-Agent asked before it reported is delivered first; another sender’s message waits', async () => {
      const t = target()
      const x = `s-order${n}`
      await deliver(managerOf({}), t, msg('question', { from: fromMessage(x) }))
      await deliver(managerOf({}), t, msg('somebody else'))
      await deliver(managerOf({}), t, result('report', { from: { key: x, title: 'rev' } }))
      const s = fake(['started', 'queued'])
      expect(await flushHeldDispatchResults(managerOf({ [t]: s }), t)).toBe(true)
      expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual(['question', 'report'])
      expect(heldInboxItems(t).map((r) => r.body)).toEqual(['somebody else'])
    })

    it('a message sent AFTER the result is not carried ahead of it, nor one of another X-Agent', async () => {
      const t = target()
      const x = `s-after${n}`
      await deliver(managerOf({}), t, msg('other agent', { from: fromMessage('s-other0') }))
      await deliver(managerOf({}), t, result('report', { from: { key: x, title: 'rev' } }))
      await deliver(managerOf({}), t, msg('later question', { from: fromMessage(x) }))
      const s = fake(['started'])
      await flushHeldDispatchResults(managerOf({ [t]: s }), t)
      expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual(['report'])
      expect(heldInboxItems(t).map((r) => r.body)).toEqual(['other agent', 'later question'])
    })

    it('without agent-turn budget the message stays held and the result still goes (its own cap)', async () => {
      const t = target()
      const x = `s-budget${n}`
      await deliver(managerOf({}), t, msg('question', { from: fromMessage(x) }))
      await deliver(managerOf({}), t, result('report', { from: { key: x, title: 'rev' } }))
      const s = fake(['started'])
      for (let i = 0; i < AGENT_TURN_BUDGET; i++) s.originLedger.agentTurnStarted()
      await flushHeldDispatchResults(managerOf({ [t]: s }), t)
      expect(s.deliverNonUser.mock.calls.map(([item]) => item.text)).toEqual(['report'])
      expect(heldInboxItems(t).map((r) => r.body)).toEqual(['question'])
    })
  })

  it('an interrupted-at-quit notice (no run) stamps no report when it goes out', async () => {
    const t = target()
    const x = `s-notice${n}`
    insertDispatchReport({
      targetId: x,
      toolUseId: 'toolu_1',
      status: 'delivered',
      report: 'R1',
      createdAt: 1
    })
    await deliver(managerOf({}), t, result('interrupted', { from: { key: x, title: 'rev' } }))
    const s = fake(['started'])
    expect(await flushHeldDispatchResults(managerOf({ [t]: s }), t)).toBe(true)
    expect(dispatchReportsOf([x])[0].deliveredAt).toBeNull()
  })

  it('an X-Agent result is held even past the inbox cap — never refused, so the notification stays true (R2)', async () => {
    const t = target()
    for (let i = 0; i < HELD_INBOX_CAP; i++) await deliver(managerOf({}), t, note(`n${i}`))
    expect(heldInboxCount(t)).toBe(HELD_INBOX_CAP)
    // An ordinary item is refused out loud at the cap...
    expect(await deliver(managerOf({}), t, note('one too many'))).toEqual({
      result: 'refused',
      why: 'inbox-full'
    })
    // ...an X-Agent's result is the only trace of its run and is kept.
    expect(await deliver(managerOf({}), t, result('the report'))).toEqual({
      result: 'held',
      why: 'no-live-session'
    })
    expect(heldInboxCount(t)).toBe(HELD_INBOX_CAP + 1)
  })

  it('a flush stops at the wake cap: the result stays held for the next prompt', async () => {
    const t = target()
    await deliver(managerOf({}), t, result('waiting'))
    const s = fake(['started'])
    for (let i = 0; i < DISPATCH_WAKE_CAP; i++) s.originLedger.dispatchWakeStarted()
    expect(await flushHeldDispatchResults(managerOf({ [t]: s }), t)).toBe(false)
    expect(s.deliverNonUser).not.toHaveBeenCalled()
    expect(heldInboxCount(t)).toBe(1)
    // The user's own prompt flush takes it, cap or not.
    expect(await flushHeld(managerOf({ [t]: s }), t)).toBe(true)
    expect(heldInboxCount(t)).toBe(0)
  })
})
