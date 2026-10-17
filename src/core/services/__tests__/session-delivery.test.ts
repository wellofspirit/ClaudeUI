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
import { TurnOriginLedger, AGENT_TURN_BUDGET } from '../../providers/turn-origin-ledger'
import type { SessionManager } from '../session-manager'
import { heldInboxCount, heldInboxItems } from '../db'
import { syncCore } from '../sync-host'
import {
  HELD_INBOX_CAP,
  ITEM_BODY_MAX,
  deliver,
  flushHeld,
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
