/**
 * @vitest-environment node
 *
 * A cold history read gives the parent its session cards back (slice 1b). No
 * engine writes anything for a card, so `readSessionHistory` — the one host-side
 * door every cold read goes through — adds them from the link table; a
 * session with no children reads exactly as the engine returned it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../../shared/types'
import { readSessionHistory } from '../../../core/services/engine-history'
import { linkChild, refFor, sessionCardId } from '../../../core/services/session-links'
import { getSessionLink } from '../../../core/services/db'
import {
  createProposal,
  dismissProposal,
  proposalCardId
} from '../../../core/services/session-proposals'
import { emitEvent, syncCore } from '../../../core/services/sync-host'

const mocks = vi.hoisted(() => ({ claude: vi.fn() }))
vi.mock('../../../core/services/session-history', () => ({ loadSessionHistory: mocks.claude }))

const message = (id: string, timestamp: number): ChatMessage => ({
  id,
  role: 'assistant',
  content: [{ type: 'text', text: id }],
  timestamp
})

function engineReturns(messages: ChatMessage[]): void {
  mocks.claude.mockResolvedValue({
    messages,
    taskNotifications: [],
    customTitle: null,
    statusLine: null,
    agentIdToToolUseId: {},
    warnings: []
  })
}

describe('readSessionHistory — session cards', () => {
  it('puts the parent’s cards back where the links were made, leaving the rest of the read alone', async () => {
    syncCore.resetCanonicalForTests()
    const parent = `eh-parent-${process.pid}`
    const child = `eh-child-${process.pid}`
    emitEvent('session:created', [parent, { cwd: '/x' }])
    emitEvent('session:created', [child, { cwd: '/x' }])
    const { childRef } = linkChild({
      parent,
      childRoutingId: child,
      engine: 'claude',
      kind: 'handoff',
      createdBy: 'agent',
      grouped: true
    })
    const madeAt = getSessionLink(childRef)!.createdAt
    engineReturns([message('before', madeAt - 5), message('after', madeAt + 5)])

    const result = await readSessionHistory(parent, 'proj')

    expect(result.messages.map((m) => m.id)).toEqual(['before', sessionCardId(childRef), 'after'])
    expect(result.messages[1].content[0]).toMatchObject({
      type: 'session_card',
      childRef,
      kind: 'handoff'
    })
    // Everything else the engine returned is passed through.
    expect(result).toMatchObject({ customTitle: null, warnings: [] })
  })

  it('adds no cards to an anchored read: a fork started none of the source’s children', async () => {
    syncCore.resetCanonicalForTests()
    const parent = `eh-src-${process.pid}`
    const child = `eh-srckid-${process.pid}`
    emitEvent('session:created', [parent, { cwd: '/x' }])
    emitEvent('session:created', [child, { cwd: '/x' }])
    linkChild({
      parent,
      childRoutingId: child,
      engine: 'claude',
      kind: 'started',
      createdBy: 'agent',
      grouped: true
    })
    engineReturns([message('kept', 1)])

    const forked = await readSessionHistory(parent, 'proj', 'anchor-uuid')
    expect(forked.messages.map((m) => m.id)).toEqual(['kept'])
    // The same session read without an anchor still gets its card.
    expect((await readSessionHistory(parent, 'proj')).messages).toHaveLength(2)
  })

  it('returns the engine’s own result when the session has no children', async () => {
    const lonely = `eh-lonely-${process.pid}`
    refFor('claude', lonely)
    const raw = {
      messages: [message('a', 1)],
      taskNotifications: [],
      customTitle: null,
      statusLine: null,
      agentIdToToolUseId: {},
      warnings: []
    }
    mocks.claude.mockResolvedValue(raw)
    expect(await readSessionHistory(lonely, 'proj')).toBe(raw)
  })
})

describe('readSessionHistory — proposal cards', () => {
  const placement = { engine: 'claude' as const, permission_mode: 'default', cwd: '/x' }
  const BACKGROUND = 'x'.repeat(90)

  it('puts the proposer’s cards back where each was made, with the state they are in now', async () => {
    syncCore.resetCanonicalForTests()
    const parent = `eh-prop-${process.pid}`
    emitEvent('session:created', [parent, { cwd: '/x' }])
    const parentRef = refFor('claude', parent)
    const t0 = Date.now()
    const pending = createProposal({
      parentRef,
      title: 'Open',
      prompt: 'p',
      background: BACKGROUND,
      placement,
      now: t0
    })
    const gone = createProposal({
      parentRef,
      title: 'Gone',
      prompt: 'p',
      background: BACKGROUND,
      placement,
      now: t0 + 20
    })
    dismissProposal(gone.id, 'user', t0 + 21)
    engineReturns([
      message('before', t0 - 5),
      message('between', t0 + 10),
      message('after', t0 + 30)
    ])

    const result = await readSessionHistory(parent, 'proj')

    expect(result.messages.map((m) => m.id)).toEqual([
      'before',
      proposalCardId(pending.id),
      'between',
      proposalCardId(gone.id),
      'after'
    ])
    expect(result.messages[1].content[0]).toMatchObject({
      type: 'proposal_card',
      state: 'pending',
      title: 'Open'
    })
    expect(result.messages[3].content[0]).toMatchObject({ state: 'dismissed', reason: 'user' })
  })

  it('adds none to an anchored read: a fork proposed nothing', async () => {
    syncCore.resetCanonicalForTests()
    const parent = `eh-prop-fork-${process.pid}`
    emitEvent('session:created', [parent, { cwd: '/x' }])
    createProposal({
      parentRef: refFor('claude', parent),
      title: 'T',
      prompt: 'p',
      background: BACKGROUND,
      placement
    })
    engineReturns([message('only', 1)])
    const result = await readSessionHistory(parent, 'proj', 'anchor-uuid')
    expect(result.messages.map((m) => m.id)).toEqual(['only'])
  })

  it('reads a session that proposed nothing exactly as the engine returned it', async () => {
    syncCore.resetCanonicalForTests()
    const parent = `eh-prop-none-${process.pid}`
    emitEvent('session:created', [parent, { cwd: '/x' }])
    engineReturns([message('only', 1)])
    const result = await readSessionHistory(parent, 'proj')
    expect(result.messages.map((m) => m.id)).toEqual(['only'])
  })
})
