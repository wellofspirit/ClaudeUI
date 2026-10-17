/**
 * @vitest-environment node
 *
 * The two per-session counters behind non-user deliveries (slice 1a, spec §5.1):
 * whether the session has read agent text since the user last spoke, and how many
 * turns such text has started since.
 */
import { describe, it, expect } from 'vitest'
import { AGENT_TURN_BUDGET, TurnOriginLedger } from '../turn-origin-ledger'
import { BaseSession } from '../BaseSession'

describe('TurnOriginLedger', () => {
  it('starts clean, with the whole budget', () => {
    const ledger = new TurnOriginLedger()
    expect(ledger.userOriginClean).toBe(true)
    expect(ledger.agentTurnStartsSinceUser).toBe(0)
    expect(ledger.budgetLeft).toBe(true)
    expect(ledger.cap).toBe(AGENT_TURN_BUDGET)
    expect(AGENT_TURN_BUDGET).toBe(10)
  })

  it('a delivery taints; agent-started turns spend budget; the user resets both', () => {
    const ledger = new TurnOriginLedger()
    ledger.nonUserDelivered()
    expect(ledger.userOriginClean).toBe(false)
    for (let i = 0; i < AGENT_TURN_BUDGET - 1; i++) ledger.agentTurnStarted()
    expect(ledger.budgetLeft).toBe(true)
    ledger.agentTurnStarted()
    expect(ledger.agentTurnStartsSinceUser).toBe(AGENT_TURN_BUDGET)
    expect(ledger.budgetLeft).toBe(false)
    ledger.userPrompt()
    expect(ledger.userOriginClean).toBe(true)
    expect(ledger.agentTurnStartsSinceUser).toBe(0)
    expect(ledger.budgetLeft).toBe(true)
  })

  it('reports the exhausted budget once per user-free stretch', () => {
    const ledger = new TurnOriginLedger(1)
    ledger.agentTurnStarted()
    expect(ledger.noteBudgetExhausted()).toBe(true)
    expect(ledger.noteBudgetExhausted()).toBe(false)
    ledger.userPrompt()
    ledger.agentTurnStarted()
    expect(ledger.noteBudgetExhausted()).toBe(true)
  })

  it('every session has its own, so a rekeyed session keeps it', () => {
    class Probe extends BaseSession {
      readonly engineId = 'opencode' as const
      readonly capabilities = {} as never
      readonly willQueue = false
      getSessionId = (): null => null
      run = async (): Promise<void> => {}
      interrupt = async (): Promise<void> => {}
      cancel = (): void => {}
      resolveApproval = (): void => {}
      setModel = async (): Promise<void> => {}
      setPermissionMode = async (): Promise<void> => {}
      dispose = (): void => {}
    }
    const a = new Probe('a', null, '/x')
    const b = new Probe('b', null, '/x')
    a.originLedger.nonUserDelivered()
    expect(b.originLedger.userOriginClean).toBe(true)
    a.routingId = 'a-rekeyed'
    expect(a.originLedger.userOriginClean).toBe(false)
  })
})

describe('the user speaking resets the ledger when the prompt is TAKEN, not when it is typed (review M1)', () => {
  class Probe extends BaseSession {
    readonly engineId = 'opencode' as const
    readonly capabilities = {} as never
    readonly willQueue = true
    getSessionId = (): null => null
    run = async (): Promise<void> => {}
    interrupt = async (): Promise<void> => {}
    cancel = (): void => {}
    resolveApproval = (): void => {}
    setModel = async (): Promise<void> => {}
    setPermissionMode = async (): Promise<void> => {}
    dispose = (): void => {}
    /** What an engine does when it takes the oldest queued item. */
    take(): void {
      this.queue.consumeById(this.queue.pending()[0].itemId)
    }
    recall(): void {
      this.queue.recallById(this.queue.pending()[0].itemId)
    }
  }

  function taintedSession(): Probe {
    const s = new Probe('r', null, '/x')
    s.originLedger.nonUserDelivered()
    s.originLedger.agentTurnStarted()
    return s
  }

  it.each([
    ['a typed prompt', undefined],
    ['a host instruction', 'host-instruction' as const]
  ])('%s that queues leaves the session tainted until the engine takes it', (_name, origin) => {
    const s = taintedSession()
    s.enqueuePrompt('ok', undefined, undefined, origin)
    expect(s.originLedger.userOriginClean).toBe(false)
    expect(s.originLedger.agentTurnStartsSinceUser).toBe(1)
    s.take()
    expect(s.originLedger.userOriginClean).toBe(true)
    expect(s.originLedger.agentTurnStartsSinceUser).toBe(0)
  })

  it('a prompt taken back was never spoken into the session', () => {
    const s = taintedSession()
    s.enqueuePrompt('ok')
    s.recall()
    expect(s.originLedger.userOriginClean).toBe(false)
  })
})
