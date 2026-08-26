/**
 * Layer 1 unit tests for session-store actions.
 *
 * Pattern: drive the store directly through `useSessionStore.getState().<action>()`.
 * No React, no TestIpcBridge — just pure state transitions.
 *
 * Complements `session-store-actions.component.test.ts` which covers business-flow
 * actions (lifecycle, deletion, plan/mockup panels, worktree, etc.). This file
 * targets the low-level "pure reducer" behaviors: upsert-by-id, streaming accumulation, tool_result attachment,
 * pending-approval keying, rekey semantics, multi-session isolation, BTW,
 * derived selector safety, and error lifecycle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore, useActiveSession, type PerSessionState } from '../session-store'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  makePendingApproval,
  makeSessionStatus,
  resetFactoryCounter
} from '@test/factories/messages'
import { claudeModel, type GitStatusData } from '../../../../shared/types'
import { renderHook } from '@testing-library/react'
import { seed, resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

const store = () => useSessionStore.getState()

beforeEach(() => {
  // The replica is a module singleton holding canonical state: resetting only the
  // store would leave the two disagreeing and the next projection would resurrect
  // the previous test's sessions (SyncCore phase 4c).
  resetReplicaSeam()
  resetFactoryCounter()

  // Minimal window.api stub — some actions persist via saveSessionConfig, which
  // is a fire-and-forget side effect. Use a spy so we can also assert on it.
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    watchBackground: vi.fn(),
    unwatchBackground: vi.fn(),
    killTerminal: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn(),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    clearConversation: vi.fn().mockResolvedValue(undefined)
  } as any

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    hiddenSessionIds: [],
    hiddenProjectKeys: [],
    terminalGroups: {},
    activeView: { type: 'chat' }
  })
  mirrorStoreIntoReplica()
})

// ---------------------------------------------------------------------------
// 1–3. addMessage — upsert-by-id + partial merge semantics
// ---------------------------------------------------------------------------

describe('addMessage', () => {
  it('appends a new message when the id has never been seen', () => {
    store().createNewSession('r1', '/p')
    const msg = makeChatMessage({ id: 'a-1', content: [{ type: 'text', text: 'hello' }] })
    seed.message('r1', msg)
    expect(store().sessions['r1'].messages).toHaveLength(1)
    expect(store().sessions['r1'].messages[0].id).toBe('a-1')
  })

  it('upserts (replaces in place) when the same id arrives again, does not duplicate', () => {
    store().createNewSession('r1', '/p')
    const first = makeChatMessage({
      id: 'a-1',
      content: [{ type: 'text', text: 'partial' }]
    })
    seed.message('r1', first)
    const second = makeChatMessage({
      id: 'a-1',
      content: [{ type: 'text', text: 'complete response' }]
    })
    seed.message('r1', second)

    const { messages } = store().sessions['r1']
    expect(messages).toHaveLength(1)
    // mergeContentBlocks: new text replaces old (no newHasText preservation)
    expect(messages[0].content).toEqual([{ type: 'text', text: 'complete response' }])
  })

  it('partial stream then full message: preserves tool_use from first, replaces text with second', () => {
    store().createNewSession('r1', '/p')
    // First partial: has a tool_use that the full won't repeat
    const partial = makeChatMessage({
      id: 'a-1',
      content: [
        { type: 'text', text: 'let me...' },
        makeToolUseBlock('Bash', { command: 'ls' }, 'tu-1')
      ]
    })
    seed.message('r1', partial)

    // Second partial replaces text but omits the tool_use — mergeContentBlocks should preserve it
    const nextChunk = makeChatMessage({
      id: 'a-1',
      content: [{ type: 'text', text: 'thinking through the problem' }]
    })
    seed.message('r1', nextChunk)

    const msg = store().sessions['r1'].messages[0]
    expect(store().sessions['r1'].messages).toHaveLength(1)
    const texts = msg.content.filter((b) => b.type === 'text')
    const toolUses = msg.content.filter((b) => b.type === 'tool_use')
    expect(toolUses).toHaveLength(1) // preserved from first partial
    expect(texts).toHaveLength(1)
    expect((texts[0] as { text: string }).text).toBe('thinking through the problem')
  })

  it('clears streamingText on the target session when message is committed', () => {
    store().createNewSession('r1', '/p')
    seed.streamText('r1', 'streaming tokens...')
    expect(store().sessions['r1'].streamingText).toBe('streaming tokens...')
    seed.message('r1', makeAssistantMessage('final'))
    expect(store().sessions['r1'].streamingText).toBe('')
  })

  it('is a no-op when routingId is unknown — no ghost session (F7)', () => {
    // This used to BOOTSTRAP a placeholder ("a cross-client event must not be
    // dropped"). Nothing can outrun `session:created` through one FIFO funnel and
    // one seq-ordered ring, so the only events that ever landed here named a
    // session that had been DELETED, or a pre-spawn config echo — and both minted
    // a permanent `cwd: ''` row in every snapshot.
    seed.message('ghost-session', makeAssistantMessage('hello'))
    expect(store().sessions['ghost-session']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4–6. Streaming accumulation (text + thinking)
// ---------------------------------------------------------------------------

describe('appendStreamingText', () => {
  it('initializes streamingText from empty when first chunk arrives', () => {
    store().createNewSession('r1', '/p')
    expect(store().sessions['r1'].streamingText).toBe('')
    seed.streamText('r1', 'first chunk')
    expect(store().sessions['r1'].streamingText).toBe('first chunk')
  })

  it('appends subsequent chunks to the accumulator', () => {
    store().createNewSession('r1', '/p')
    seed.streamText('r1', 'hello ')
    seed.streamText('r1', 'world')
    expect(store().sessions['r1'].streamingText).toBe('hello world')
  })

  // The thinking-span CLOCK moved to the emitter in 4b and the renderer's copy was
  // deleted in 4c: durations arrive on the block (BaseSession.send stamps
  // ChatMessage.thinkingDurationMs, the reducer moves it onto the block), so the
  // behavior is pinned by main/providers/__tests__/base-session-thinking-span.test.ts
  // and shared/sync/__tests__/reducer.unit.test.ts instead.
})

describe('appendStreamingThinking', () => {
  it('accumulates thinking text and stamps thinkingStartedAt on first chunk', () => {
    store().createNewSession('r1', '/p')
    const before = Date.now()
    seed.streamThinking('r1', 'step 1 ')
    const startedAt = store().sessions['r1'].thinkingStartedAt!
    expect(startedAt).toBeGreaterThanOrEqual(before)
    seed.streamThinking('r1', 'step 2')
    expect(store().sessions['r1'].streamingThinking).toBe('step 1 step 2')
    // Does not overwrite startedAt on subsequent chunks
    expect(store().sessions['r1'].thinkingStartedAt).toBe(startedAt)
  })
})

// ---------------------------------------------------------------------------
// 7–8. appendToolResult — attaches to the right tool_use block
// ---------------------------------------------------------------------------

describe('appendToolResult', () => {
  it('attaches a tool_result block to the assistant message containing the matching tool_use', () => {
    store().createNewSession('r1', '/p')
    const msg = makeChatMessage({
      id: 'a-1',
      role: 'assistant',
      content: [makeToolUseBlock('Bash', { command: 'ls' }, 'tu-1')]
    })
    seed.message('r1', msg)

    seed.toolResult('r1', 'tu-1', 'file1\nfile2', false)
    const updated = store().sessions['r1'].messages[0]
    const results = updated.content.filter((b) => b.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      toolUseId: 'tu-1',
      toolResult: 'file1\nfile2',
      isError: false
    })
  })

  it('attaches to the most recent assistant message when multiple tool_uses exist across messages', () => {
    store().createNewSession('r1', '/p')
    seed.message(
      'r1',
      makeChatMessage({
        id: 'a-1',
        role: 'assistant',
        content: [makeToolUseBlock('Bash', {}, 'tu-old')]
      })
    )
    seed.message(
      'r1',
      makeChatMessage({
        id: 'a-2',
        role: 'assistant',
        content: [makeToolUseBlock('Read', {}, 'tu-new')]
      })
    )
    seed.toolResult('r1', 'tu-new', 'contents', false)
    // Only the newer message should have the tool_result
    expect(store().sessions['r1'].messages[0].content.some((b) => b.type === 'tool_result')).toBe(
      false
    )
    expect(store().sessions['r1'].messages[1].content.some((b) => b.type === 'tool_result')).toBe(
      true
    )
  })

  it('marks isError=true when flagged', () => {
    store().createNewSession('r1', '/p')
    seed.message(
      'r1',
      makeChatMessage({
        id: 'a-1',
        role: 'assistant',
        content: [makeToolUseBlock('Bash', {}, 'tu-err')]
      })
    )
    seed.toolResult('r1', 'tu-err', 'permission denied', true)
    const result = store().sessions['r1'].messages[0].content.find((b) => b.type === 'tool_result')
    expect(result).toMatchObject({ isError: true })
  })

  it('is a no-op when the toolUseId does not match any tool_use (does not throw, does not mutate)', () => {
    store().createNewSession('r1', '/p')
    seed.message(
      'r1',
      makeChatMessage({
        id: 'a-1',
        role: 'assistant',
        content: [makeToolUseBlock('Bash', {}, 'tu-real')]
      })
    )
    const before = store().sessions['r1'].messages[0].content.length
    expect(() => seed.toolResult('r1', 'tu-ghost', 'x', false)).not.toThrow()
    expect(store().sessions['r1'].messages[0].content).toHaveLength(before)
  })

  it('is a no-op when the session does not exist', () => {
    expect(() => seed.toolResult('ghost', 'tu-1', 'r', false)).not.toThrow()
    expect(store().sessions['ghost']).toBeUndefined()
  })

  // RN10 — a replayed onToolResult (reconnect catchup / history replay) used to
  // append a SECOND tool_result block for the same toolUseId. The renderer only
  // shows the first, so the duplicates grew the message invisibly.
  it('is idempotent: a replayed result for the same toolUseId does not duplicate the block', () => {
    store().createNewSession('r1', '/p')
    seed.message(
      'r1',
      makeChatMessage({
        id: 'a-1',
        role: 'assistant',
        content: [makeToolUseBlock('Bash', { command: 'ls' }, 'tu-1')]
      })
    )

    seed.toolResult('r1', 'tu-1', 'first', false)
    const afterFirst = store().sessions['r1'].messages[0]
    // Replay of the very same event, plus a differing-payload replay.
    seed.toolResult('r1', 'tu-1', 'first', false)
    seed.toolResult('r1', 'tu-1', 'second', true)

    const msg = store().sessions['r1'].messages[0]
    const results = msg.content.filter((b) => b.type === 'tool_result')
    expect(results).toHaveLength(1)
    // First result wins, untouched.
    expect(results[0]).toMatchObject({ toolUseId: 'tu-1', toolResult: 'first', isError: false })
    // And the no-op returns the identical state (no needless re-render).
    expect(msg).toBe(afterFirst)
  })

  it('still attaches results for a DIFFERENT toolUseId in the same message', () => {
    store().createNewSession('r1', '/p')
    seed.message(
      'r1',
      makeChatMessage({
        id: 'a-1',
        role: 'assistant',
        content: [makeToolUseBlock('Bash', {}, 'tu-1'), makeToolUseBlock('Read', {}, 'tu-2')]
      })
    )
    seed.toolResult('r1', 'tu-1', 'one', false)
    seed.toolResult('r1', 'tu-2', 'two', false)
    const results = store().sessions['r1'].messages[0].content.filter(
      (b) => b.type === 'tool_result'
    )
    expect(results.map((r) => r.toolUseId)).toEqual(['tu-1', 'tu-2'])
  })
})

// ---------------------------------------------------------------------------
// Bounded module-level caches (RN8) — rekeyMap and gitStatusCache live for the
// whole renderer process, so they must evict rather than grow forever.
// ---------------------------------------------------------------------------

describe('bounded module caches (RN8)', () => {
  // SyncCore phase 4c: the bounded `rekeyMap` + `resolveRoutingId` are DELETED. Core
  // owns the rekey and re-keys its own registry in the same tick it emits the
  // `session:status` that implies one, so every LATER event already carries the new
  // id and there is no stale id left to resolve. The move itself is pinned by
  // shared/sync/__tests__/reducer.unit.test.ts (rekeyCanonical).

  it('gitStatusCache evicts the oldest cwd past its 100-entry cap', () => {
    const status = (branch: string): GitStatusData => ({
      branch,
      ahead: 0,
      behind: 0,
      trackingBranch: null,
      files: [],
      staged: [],
      unstaged: [],
      untracked: [],
      linesAdded: 0,
      linesRemoved: 0
    })

    // 101 distinct cwds → the first cached cwd falls off a 100-entry cap.
    for (let i = 0; i <= 100; i++) {
      store().createNewSession(`g-${i}`, `/cap-cwd-${i}`, false)
      store().setGitStatus(`g-${i}`, status(`b-${i}`))
    }

    // A brand-new session on the EVICTED cwd gets no seeded git state...
    store().createNewSession('probe-old', '/cap-cwd-0', false)
    expect(store().sessions['probe-old'].gitStatus).toBeNull()
    expect(store().sessions['probe-old'].isGitRepo).toBe(false)
    // ...while the most recent cwd is still warm.
    store().createNewSession('probe-new', '/cap-cwd-100', false)
    expect(store().sessions['probe-new'].gitStatus).toMatchObject({ branch: 'b-100' })
    expect(store().sessions['probe-new'].isGitRepo).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 9–11. Pending approvals keyed by requestId
// ---------------------------------------------------------------------------

describe('addPendingApproval / clearPendingApprovals', () => {
  it('addPendingApproval appends approvals keyed by requestId', () => {
    store().createNewSession('r1', '/p')
    seed.approvalRequest('r1', makePendingApproval({ requestId: 'req-a' }))
    seed.approvalRequest('r1', makePendingApproval({ requestId: 'req-b' }))
    const ids = store().sessions['r1'].pendingApprovals.map((a) => a.requestId)
    expect(ids).toEqual(['req-a', 'req-b'])
  })

  it('clearPendingApprovals empties the list for the targeted session', () => {
    store().createNewSession('r1', '/p')
    seed.approvalRequest('r1', makePendingApproval({ requestId: 'req-1' }))
    seed.approvalRequest('r1', makePendingApproval({ requestId: 'req-2' }))
    seed.status('r1', {
      ...useSessionStore.getState().sessions['r1'].status,
      state: 'disconnected'
    })
    expect(store().sessions['r1'].pendingApprovals).toEqual([])
  })

  it('clearPendingApprovals on session A does not affect session B', () => {
    store().createNewSession('r1', '/p')
    store().createNewSession('r2', '/p2', false)
    seed.approvalRequest('r1', makePendingApproval({ requestId: 'req-1' }))
    seed.approvalRequest('r2', makePendingApproval({ requestId: 'req-2' }))
    seed.status('r1', {
      ...useSessionStore.getState().sessions['r1'].status,
      state: 'disconnected'
    })
    expect(store().sessions['r1'].pendingApprovals).toEqual([])
    expect(store().sessions['r2'].pendingApprovals).toHaveLength(1)
  })

  it('removePendingApprovalByToolUse removes only the approval with the matching tool_use_id', () => {
    store().createNewSession('r1', '/p')
    seed.approvalRequest('r1', makePendingApproval({ requestId: 'req-1', toolUseId: 'toolu_a' }))
    seed.approvalRequest('r1', makePendingApproval({ requestId: 'req-2', toolUseId: 'toolu_b' }))
    // An older-style approval with no toolUseId should be unaffected.
    seed.approvalRequest('r1', makePendingApproval({ requestId: 'req-3' }))

    seed.toolResult('r1', 'toolu_a', '')
    const remaining = store().sessions['r1'].pendingApprovals.map((a) => a.requestId)
    expect(remaining).toEqual(['req-2', 'req-3'])
  })

  it('removePendingApprovalByToolUse is a no-op when no approval carries that id', () => {
    store().createNewSession('r1', '/p')
    seed.approvalRequest('r1', makePendingApproval({ requestId: 'req-1', toolUseId: 'toolu_a' }))
    seed.toolResult('r1', 'toolu_unknown', '')
    expect(store().sessions['r1'].pendingApprovals.map((a) => a.requestId)).toEqual(['req-1'])
  })
})

// ---------------------------------------------------------------------------
// 12–14. rekeySession — not covered by the .component test: activeView / no-op cases
// ---------------------------------------------------------------------------

describe('rekeySession (unit-level)', () => {
  it('is a no-op when the old routingId does not exist (does not create a ghost entry)', () => {
    seed.rekey('missing', 'new-id')
    expect(store().sessions['new-id']).toBeUndefined()
    expect(store().sessions['missing']).toBeUndefined()
  })

  it('preserves session data under the new id', () => {
    store().createNewSession('old', '/cwd-x')
    seed.message('old', makeAssistantMessage('hi'))
    const before = store().sessions['old']
    seed.rekey('old', 'new')
    expect(store().sessions['old']).toBeUndefined()
    // Deep equality, not identity: the reducer moves the CANONICAL entry and the
    // projection rebuilds the store one from it, so the reference changes. What
    // must not change is the content — the old action's "same reference" was an
    // implementation detail, and the property it stood for is this.
    // Field-wise, not whole-object: the status event that CAUSES the rekey also
    // lands (that is what a rekey is), so `status.sessionId` legitimately differs.
    const after = store().sessions['new']
    expect(after.messages).toEqual(before.messages)
    expect(after.cwd).toBe(before.cwd)
    expect(after.selectedEngineId).toBe(before.selectedEngineId)
    expect(after.selectedModel).toBe(before.selectedModel)
    expect(after.permissionMode).toBe(before.permissionMode)
  })

  it('updates activeSessionId when the rekeyed session was active', () => {
    store().createNewSession('old', '/p')
    expect(store().activeSessionId).toBe('old')
    seed.rekey('old', 'new')
    expect(store().activeSessionId).toBe('new')
  })

  it('does not touch activeSessionId when a non-active session is rekeyed', () => {
    store().createNewSession('active-one', '/p')
    store().createNewSession('background', '/q', false)
    seed.rekey('background', 'background-new')
    expect(store().activeSessionId).toBe('active-one')
  })
})

// ---------------------------------------------------------------------------
// 15. Multi-session isolation — side-effect-free verification
// ---------------------------------------------------------------------------

describe('multi-session isolation', () => {
  it('addMessage targeting session A does not touch session B', () => {
    store().createNewSession('A', '/a')
    store().createNewSession('B', '/b', false)
    const bBefore = store().sessions['B']
    seed.message('A', makeAssistantMessage('for A'))
    expect(store().sessions['B']).toBe(bBefore) // same reference
    expect(store().sessions['A'].messages).toHaveLength(1)
    expect(store().sessions['B'].messages).toHaveLength(0)
  })

  it('appendStreamingText on A does not leak into B', () => {
    store().createNewSession('A', '/a')
    store().createNewSession('B', '/b', false)
    seed.streamText('A', 'a tokens')
    seed.streamText('B', 'b tokens')
    expect(store().sessions['A'].streamingText).toBe('a tokens')
    expect(store().sessions['B'].streamingText).toBe('b tokens')
  })

  it('addError on A does not populate B.errors', () => {
    store().createNewSession('A', '/a')
    store().createNewSession('B', '/b', false)
    store().addError('A', 'boom')
    expect(store().sessions['A'].errors).toEqual(['boom'])
    expect(store().sessions['B'].errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 16. BTW side-question — clearBtw is deterministic
// ---------------------------------------------------------------------------

describe('BTW (side question) actions', () => {
  it('setBtwQuestion sets question, clears response, sets loading=true', () => {
    store().createNewSession('r1', '/p')
    store().setBtwQuestion('r1', 'what about X?')
    expect(store().sessions['r1'].btwQuestion).toBe('what about X?')
    expect(store().sessions['r1'].btwResponse).toBeNull()
    expect(store().sessions['r1'].btwLoading).toBe(true)
  })

  it('setBtwResponse stores the response and flips loading off', () => {
    store().createNewSession('r1', '/p')
    store().setBtwQuestion('r1', 'q')
    store().setBtwResponse('r1', 'the answer')
    expect(store().sessions['r1'].btwResponse).toBe('the answer')
    expect(store().sessions['r1'].btwLoading).toBe(false)
  })

  it('clearBtw resets question, response, and loading deterministically', () => {
    store().createNewSession('r1', '/p')
    store().setBtwQuestion('r1', 'q')
    store().setBtwResponse('r1', 'a')
    store().clearBtw('r1')
    const s = store().sessions['r1']
    expect(s.btwQuestion).toBeNull()
    expect(s.btwResponse).toBeNull()
    expect(s.btwLoading).toBe(false)
  })

  it('clearBtw on a session with no BTW state is a no-op (idempotent)', () => {
    store().createNewSession('r1', '/p')
    expect(() => store().clearBtw('r1')).not.toThrow()
    const s = store().sessions['r1']
    expect(s.btwQuestion).toBeNull()
    expect(s.btwResponse).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 17. Errors — lifecycle (task listed `dismissError`; the real API is removeError/clearErrors)
// ---------------------------------------------------------------------------

describe('error lifecycle', () => {
  it('addError appends to errors[]', () => {
    store().createNewSession('r1', '/p')
    store().addError('r1', 'oops')
    store().addError('r1', 'again')
    expect(store().sessions['r1'].errors).toEqual(['oops', 'again'])
  })

  it('removeError removes exactly the indexed entry and preserves order', () => {
    store().createNewSession('r1', '/p')
    store().addError('r1', 'first')
    store().addError('r1', 'middle')
    store().addError('r1', 'last')
    store().removeError('r1', 1)
    expect(store().sessions['r1'].errors).toEqual(['first', 'last'])
  })

  it('removeError with out-of-range index is a no-op', () => {
    store().createNewSession('r1', '/p')
    store().addError('r1', 'only')
    store().removeError('r1', 99)
    expect(store().sessions['r1'].errors).toEqual(['only'])
  })

  it('clearErrors empties the array for that session only', () => {
    store().createNewSession('r1', '/p')
    store().createNewSession('r2', '/p2', false)
    store().addError('r1', 'x')
    store().addError('r2', 'y')
    store().clearErrors('r1')
    expect(store().sessions['r1'].errors).toEqual([])
    expect(store().sessions['r2'].errors).toEqual(['y'])
  })
})

// ---------------------------------------------------------------------------
// 17b. Warnings — lifecycle (mirrors errors; fed by session:warning, e.g.
// model_refusal_fallback / model_fallback system messages)
// ---------------------------------------------------------------------------

describe('warning lifecycle', () => {
  it('addWarning appends to warnings[] without touching errors[]', () => {
    store().createNewSession('r1', '/p')
    store().addWarning('r1', 'model fell back')
    store().addWarning('r1', 'again')
    expect(store().sessions['r1'].warnings).toEqual(['model fell back', 'again'])
    expect(store().sessions['r1'].errors).toEqual([])
  })

  it('removeWarning removes exactly the indexed entry and preserves order', () => {
    store().createNewSession('r1', '/p')
    store().addWarning('r1', 'first')
    store().addWarning('r1', 'middle')
    store().addWarning('r1', 'last')
    store().removeWarning('r1', 1)
    expect(store().sessions['r1'].warnings).toEqual(['first', 'last'])
  })

  it('clearWarnings empties the array for that session only', () => {
    store().createNewSession('r1', '/p')
    store().createNewSession('r2', '/p2', false)
    store().addWarning('r1', 'x')
    store().addWarning('r2', 'y')
    store().clearWarnings('r1')
    expect(store().sessions['r1'].warnings).toEqual([])
    expect(store().sessions['r2'].warnings).toEqual(['y'])
  })
})

// ---------------------------------------------------------------------------
// 17c. retractMessages — refusal-fallback retraction (model_refusal_fallback)
// ---------------------------------------------------------------------------

describe('retractMessages', () => {
  const msg = (id: string) =>
    makeChatMessage({ id, content: [{ type: 'text', text: `body of ${id}` }] })

  it('removes exactly the listed messages and clears streaming state', () => {
    store().createNewSession('r1', '/p')
    seed.message('r1', msg('m1'))
    seed.message('r1', msg('m2'))
    seed.streamText('r1', 'refused partial text')

    seed.retract('r1', ['m1'])

    const s = store().sessions['r1']
    expect(s.messages.map((m) => m.id)).toEqual(['m2'])
    expect(s.streamingText).toBe('')
    expect(s.streamingThinking).toBe('')
  })

  it('unknown ids are a no-op for messages but still clear streaming', () => {
    store().createNewSession('r1', '/p')
    seed.message('r1', msg('m1'))
    seed.streamText('r1', 'stale partial')

    seed.retract('r1', [])

    const s = store().sessions['r1']
    expect(s.messages.map((m) => m.id)).toEqual(['m1'])
    expect(s.streamingText).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 18. setActiveView / switchSession — the store has switchSession (not setActiveSession)
// ---------------------------------------------------------------------------

describe('setActiveView', () => {
  it('sets the top-level activeView', () => {
    store().setActiveView({ type: 'usage' })
    expect(store().activeView).toEqual({ type: 'usage' })
    store().setActiveView({ type: 'automations' })
    expect(store().activeView).toEqual({ type: 'automations' })
  })

  it('does not touch activeSessionId', () => {
    store().createNewSession('r1', '/p')
    const activeBefore = store().activeSessionId
    store().setActiveView({ type: 'usage' })
    expect(store().activeSessionId).toBe(activeBefore)
  })
})

// ---------------------------------------------------------------------------
// 19. Derived selector — out-of-band / stale routingId never throws
// ---------------------------------------------------------------------------

describe('derived selector safety', () => {
  it('sessions[nonexistent] returns undefined (no throw)', () => {
    expect(store().sessions['does-not-exist']).toBeUndefined()
    expect(() => {
      const _s = store().sessions['does-not-exist']
      void _s
    }).not.toThrow()
  })

  it('useActiveSession returns EMPTY_SESSION_STATE slice when activeSessionId is null', () => {
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
    const { result } = renderHook(() => useActiveSession((s: PerSessionState) => s.messages))
    expect(result.current).toEqual([])
  })

  it('useActiveSession returns EMPTY_SESSION_STATE slice when activeSessionId points at a deleted session', () => {
    useSessionStore.setState({ activeSessionId: 'ghost', sessions: {} })
    mirrorStoreIntoReplica()
    const { result } = renderHook(() => useActiveSession((s: PerSessionState) => s.streamingText))
    expect(result.current).toBe('')
  })

  it('useActiveSession reflects live updates when the active session exists', () => {
    store().createNewSession('r1', '/p')
    const { result, rerender } = renderHook(() =>
      useActiveSession((s: PerSessionState) => s.streamingText)
    )
    expect(result.current).toBe('')
    seed.streamText('r1', 'stream')
    rerender()
    expect(result.current).toBe('stream')
  })
})

// ---------------------------------------------------------------------------
// 20. createNewSession defaults
// ---------------------------------------------------------------------------

describe('createNewSession defaults', () => {
  it('creates a session with idle status and empty messages', () => {
    store().createNewSession('r1', '/project')
    const s = store().sessions['r1']
    expect(s.cwd).toBe('/project')
    expect(s.messages).toEqual([])
    expect(s.status.state).toBe('idle')
    expect(s.sdkActive).toBe(false)
    expect(s.isHistorical).toBe(false)
    expect(s.pendingApprovals).toEqual([])
    expect(s.errors).toEqual([])
    expect(s.streamingText).toBe('')
    expect(s.streamingThinking).toBe('')
    expect(s.rightPanel).toBe('none')
    expect(s.permissionMode).toBe('default')
  })
})

// ---------------------------------------------------------------------------
// Extra: clearConversation — spec-mentioned "deterministic" reset
// ---------------------------------------------------------------------------

describe('clearConversation', () => {
  /**
   * F4. The SEALED half of the reset is no longer a local write: the action
   * invokes, main emits the replicated `session:conversation-cleared`, and the
   * fold blanks it here and on every other client. Before this, canonical kept
   * the whole transcript and the next `sync-full` handed it back to the client
   * that had just cleared it.
   */
  it('invokes main with the fresh-run mode, and the FOLD does the reset', async () => {
    store().createNewSession('r1', '/kept')
    seed.message('r1', makeAssistantMessage('hi'))
    store().addError('r1', 'e')
    useSessionStore.setState((st) => ({
      sessions: { ...st.sessions, r1: { ...st.sessions['r1'], sdkActive: true } }
    }))
    mirrorStoreIntoReplica()

    await store().clearConversation('r1')
    // The mode a fresh RUN starts in can only be resolved client-side.
    expect(window.api.clearConversation).toHaveBeenCalledWith('r1', 'default')
    // View-half is local and immediate.
    expect(store().sessions['r1'].errors).toEqual([])
    // Sealed half arrives with the event main would have emitted.
    seed.conversationCleared('r1', 'default')
    const s = store().sessions['r1']
    expect(s.cwd).toBe('/kept')
    expect(s.sdkActive).toBe(true)
    expect(s.messages).toEqual([])
  })

  it('is a no-op when the session does not exist', async () => {
    await expect(store().clearConversation('ghost')).resolves.toBeUndefined()
    expect(window.api.clearConversation).not.toHaveBeenCalled()
    expect(store().sessions['ghost']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Extra: changePermissionMode — centralized apply semantics for the desktop
// Shift+Tab handler + the mobile mode picker (both call this action now).
// ---------------------------------------------------------------------------

describe('changePermissionMode', () => {
  // SyncCore phase 4c deleted BOTH halves of the optimism: the pre-spawn "update
  // the store directly" and the `.catch` revert. They existed because the mode the
  // pill showed was this client's guess — skipped for the one case a live session
  // could reject (`auto`), un-guessed when the invoke failed. `permissionMode` is
  // SEALED now and every path emits `session:permission-mode`: the live session's
  // own setter (including the reverted mode the engine chose) and, pre-spawn where
  // there is no session object, `handlers-core.setPermissionMode`'s echo.
  it('is invoke-only: the pill does not move until the event says so', () => {
    store().createNewSession('r1', '/p')
    expect(store().sessions['r1'].permissionMode).toBe('default')

    store().changePermissionMode('r1', 'acceptEdits')

    expect(window.api.setPermissionMode).toHaveBeenCalledWith('r1', 'acceptEdits')
    expect(store().sessions['r1'].permissionMode).toBe('default')

    // ...and the echo is what moves it.
    seed.permissionMode('r1', 'acceptEdits')
    expect(store().sessions['r1'].permissionMode).toBe('acceptEdits')
  })

  it('a rejected invoke leaves the mode exactly where the engine last put it', async () => {
    store().createNewSession('r1', '/p')
    seed.permissionMode('r1', 'plan')
    ;(window.api.setPermissionMode as any).mockRejectedValueOnce(new Error('rejected by SDK'))

    store().changePermissionMode('r1', 'auto')
    await new Promise((resolve) => setTimeout(resolve, 0))

    // No local revert to undo, because there was no local apply to begin with.
    expect(store().sessions['r1'].permissionMode).toBe('plan')
  })
})

// ---------------------------------------------------------------------------
// Extra: setStatus updates cwd when SDK reports a new working directory
// (worktree enter/exit — regression pin against a real SDK behavior)
// ---------------------------------------------------------------------------

describe('setStatus cwd follow-through', () => {
  it('updates session.cwd when status.cwd differs from current', () => {
    store().createNewSession('r1', '/original')
    // The status carries a stable sessionId, so the reducer ALSO rekeys — the
    // entry moves to 'sdk-id' in the same fold (SyncCore phase 4c).
    seed.status(
      'r1',
      makeSessionStatus({
        state: 'idle',
        sessionId: 'sdk-id',
        model: claudeModel('claude-sonnet-4-6'),
        cwd: '/worktree/branch'
      })
    )
    expect(store().sessions['sdk-id'].cwd).toBe('/worktree/branch')
  })

  it('leaves cwd untouched when status.cwd matches current', () => {
    store().createNewSession('r1', '/same')
    seed.status(
      'r1',
      makeSessionStatus({
        state: 'idle',
        sessionId: 'sdk-id',
        model: claudeModel('claude-sonnet-4-6'),
        cwd: '/same'
      })
    )
    expect(store().sessions['sdk-id'].cwd).toBe('/same')
  })

  it('leaves cwd untouched when status.cwd is null', () => {
    store().createNewSession('r1', '/keep')
    seed.status('r1', makeSessionStatus({ state: 'idle', sessionId: null, model: null, cwd: null }))
    expect(store().sessions['r1'].cwd).toBe('/keep')
  })
})
