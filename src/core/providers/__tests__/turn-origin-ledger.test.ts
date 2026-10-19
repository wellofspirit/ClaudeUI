/**
 * @vitest-environment node
 *
 * The two per-session counters behind non-user deliveries (slice 1a, spec §5.1):
 * whether the session has read agent text since the user last spoke, and how many
 * turns such text has started since.
 */
import { describe, it, expect } from 'vitest'
import { AGENT_TURN_BUDGET, STARTS_PER_USER_TURN, TurnOriginLedger } from '../turn-origin-ledger'
import { BaseSession } from '../BaseSession'
import '../../services/session-links' // installs the client-prompt observer
import { getSessionLink, insertSessionRef, upsertSessionLink } from '../../services/db'

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

describe('what the session tools’ start gate reads (slice 1c)', () => {
  it('a session an agent started stays so through its brief and the host’s own instruction, and only a client prompt clears it', () => {
    const ledger = new TurnOriginLedger()
    expect(ledger.agentCreated).toBe(false)
    ledger.markAgentCreated()
    // The brief the start flow sends is a "user" prompt on the wire but not the user typing.
    ledger.userPrompt({ agentBrief: true })
    expect(ledger.agentCreated).toBe(true)
    // ClaudeUI acting on the user's standing setting is not the user typing into this session either.
    ledger.userPrompt({ hostInstruction: true })
    expect(ledger.agentCreated).toBe(true)
    ledger.userPrompt()
    expect(ledger.agentCreated).toBe(false)
  })

  it('knows whether the current turn is the host’s own instruction', () => {
    const ledger = new TurnOriginLedger()
    ledger.userPrompt({ hostInstruction: true })
    expect(ledger.hostInstructionTurn).toBe(true)
    ledger.userPrompt()
    expect(ledger.hostInstructionTurn).toBe(false)
  })

  it('counts the sessions a turn starts, up to the cap, and the user speaking resets it', () => {
    const ledger = new TurnOriginLedger()
    expect(STARTS_PER_USER_TURN).toBe(10)
    for (let i = 0; i < STARTS_PER_USER_TURN - 1; i++) ledger.sessionStarted()
    expect(ledger.startsLeft).toBe(true)
    ledger.sessionStarted()
    expect(ledger.startsLeft).toBe(false)
    expect(ledger.sessionStartsSinceUser).toBe(STARTS_PER_USER_TURN)
    ledger.userPrompt()
    expect(ledger.startsLeft).toBe(true)
  })

  it('a queued host instruction taken by the engine does not clear it; a queued typed prompt does', () => {
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
      take(): void {
        this.queue.consumeById(this.queue.pending()[0].itemId)
      }
    }
    const s = new Probe('r', null, '/x')
    s.originLedger.markAgentCreated()
    s.enqueuePrompt('wrap up', undefined, undefined, 'host-instruction')
    s.take()
    expect(s.originLedger.agentCreated).toBe(true)
    expect(s.originLedger.hostInstructionTurn).toBe(true)
    s.enqueuePrompt('typed')
    s.take()
    expect(s.originLedger.agentCreated).toBe(false)
    expect(s.originLedger.hostInstructionTurn).toBe(false)
  })

  it('a queued brief is never counted as a client prompt: the session stays agent-created and its link unmarked', () => {
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
      take(): void {
        this.queue.consumeById(this.queue.pending()[0].itemId)
      }
    }
    const rid = `queued-brief-${process.pid}`
    insertSessionRef({ ref: 's-brief1', engine: 'opencode', sessionId: null, routingId: rid })
    upsertSessionLink({
      childRef: 's-brief1',
      parentRef: 's-parent',
      kind: 'started',
      createdBy: 'agent',
      grouped: true,
      state: 'live'
    })
    const s = new Probe(rid, null, '/x')
    s.originLedger.markAgentCreated()
    s.enqueuePrompt('Background: …', undefined, undefined, 'agent-brief')
    // The broadcast item is an ordinary one: the brief marker is host-side only.
    expect(s.queuedItems[0].origin).toBeUndefined()
    s.take()
    expect(s.originLedger.agentCreated).toBe(true)
    expect(getSessionLink('s-brief1')?.clientPromptedAt).toBeNull()
    // The user typing afterwards is what lifts it.
    s.enqueuePrompt('typed')
    s.take()
    expect(s.originLedger.agentCreated).toBe(false)
    expect(getSessionLink('s-brief1')?.clientPromptedAt).toEqual(expect.any(Number))
  })

  it('a queued typed prompt the engine takes is recorded on the session’s link; a host instruction is not', () => {
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
      take(): void {
        this.queue.consumeById(this.queue.pending()[0].itemId)
      }
    }
    const rid = `queued-link-${process.pid}`
    insertSessionRef({ ref: 's-queue1', engine: 'opencode', sessionId: null, routingId: rid })
    upsertSessionLink({
      childRef: 's-queue1',
      parentRef: 's-parent',
      kind: 'started',
      createdBy: 'agent',
      grouped: true,
      state: 'live'
    })
    const s = new Probe(rid, null, '/x')
    s.enqueuePrompt('wrap up', undefined, undefined, 'host-instruction')
    s.take()
    expect(getSessionLink('s-queue1')?.clientPromptedAt).toBeNull()
    s.enqueuePrompt('typed')
    s.take()
    expect(getSessionLink('s-queue1')?.clientPromptedAt).toEqual(expect.any(Number))
  })
})
