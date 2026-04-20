/**
 * Layer 1 unit tests for session-store actions.
 *
 * Pattern: drive the store directly through `useSessionStore.getState().<action>()`.
 * No React, no TestIpcBridge — just pure state transitions.
 *
 * Complements `session-store-actions.component.test.ts` which covers business-flow
 * actions (lifecycle, deletion, plan/mockup panels, worktree, etc.). This file
 * targets the low-level "pure reducer" behaviors from docs/test-coverage-proposal.md
 * section 2.4: upsert-by-id, streaming accumulation, tool_result attachment,
 * pending-approval keying, rekey semantics, multi-session isolation, BTW,
 * derived selector safety, and error lifecycle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  useSessionStore,
  useActiveSession,
  type PerSessionState,
} from '../session-store'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  makePendingApproval,
  resetFactoryCounter,
} from '@test/factories/messages'
import { renderHook } from '@testing-library/react'

const store = () => useSessionStore.getState()

beforeEach(() => {
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
    activeView: { type: 'chat' },
  })
})

// ---------------------------------------------------------------------------
// 1–3. addMessage — upsert-by-id + partial merge semantics
// ---------------------------------------------------------------------------

describe('addMessage', () => {
  it('appends a new message when the id has never been seen', () => {
    store().createNewSession('r1', '/p')
    const msg = makeChatMessage({ id: 'a-1', content: [{ type: 'text', text: 'hello' }] })
    store().addMessage('r1', msg)
    expect(store().sessions['r1'].messages).toHaveLength(1)
    expect(store().sessions['r1'].messages[0].id).toBe('a-1')
  })

  it('upserts (replaces in place) when the same id arrives again, does not duplicate', () => {
    store().createNewSession('r1', '/p')
    const first = makeChatMessage({
      id: 'a-1',
      content: [{ type: 'text', text: 'partial' }],
    })
    store().addMessage('r1', first)
    const second = makeChatMessage({
      id: 'a-1',
      content: [{ type: 'text', text: 'complete response' }],
    })
    store().addMessage('r1', second)

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
        makeToolUseBlock('Bash', { command: 'ls' }, 'tu-1'),
      ],
    })
    store().addMessage('r1', partial)

    // Second partial replaces text but omits the tool_use — mergeContentBlocks should preserve it
    const nextChunk = makeChatMessage({
      id: 'a-1',
      content: [{ type: 'text', text: 'thinking through the problem' }],
    })
    store().addMessage('r1', nextChunk)

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
    store().appendStreamingText('r1', 'streaming tokens...')
    expect(store().sessions['r1'].streamingText).toBe('streaming tokens...')
    store().addMessage('r1', makeAssistantMessage('final'))
    expect(store().sessions['r1'].streamingText).toBe('')
  })

  it('bootstraps a session when routingId is unknown (team-view scenario)', () => {
    store().addMessage('ghost-session', makeAssistantMessage('hello'))
    expect(store().sessions['ghost-session']).toBeDefined()
    expect(store().sessions['ghost-session'].messages).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4–6. Streaming accumulation (text + thinking)
// ---------------------------------------------------------------------------

describe('appendStreamingText', () => {
  it('initializes streamingText from empty when first chunk arrives', () => {
    store().createNewSession('r1', '/p')
    expect(store().sessions['r1'].streamingText).toBe('')
    store().appendStreamingText('r1', 'first chunk')
    expect(store().sessions['r1'].streamingText).toBe('first chunk')
  })

  it('appends subsequent chunks to the accumulator', () => {
    store().createNewSession('r1', '/p')
    store().appendStreamingText('r1', 'hello ')
    store().appendStreamingText('r1', 'world')
    expect(store().sessions['r1'].streamingText).toBe('hello world')
  })

  it('closes any in-progress thinking block and records duration when text starts arriving', () => {
    store().createNewSession('r1', '/p')
    store().appendStreamingThinking('r1', 'pondering...')
    expect(store().sessions['r1'].thinkingStartedAt).not.toBeNull()
    store().appendStreamingText('r1', 'answer')
    expect(store().sessions['r1'].streamingThinking).toBe('')
    expect(store().sessions['r1'].thinkingStartedAt).toBeNull()
    expect(store().sessions['r1'].thinkingDurationMs).toBeTypeOf('number')
  })
})

describe('appendStreamingThinking', () => {
  it('accumulates thinking text and stamps thinkingStartedAt on first chunk', () => {
    store().createNewSession('r1', '/p')
    const before = Date.now()
    store().appendStreamingThinking('r1', 'step 1 ')
    const startedAt = store().sessions['r1'].thinkingStartedAt!
    expect(startedAt).toBeGreaterThanOrEqual(before)
    store().appendStreamingThinking('r1', 'step 2')
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
      content: [makeToolUseBlock('Bash', { command: 'ls' }, 'tu-1')],
    })
    store().addMessage('r1', msg)

    store().appendToolResult('r1', 'tu-1', 'file1\nfile2', false)
    const updated = store().sessions['r1'].messages[0]
    const results = updated.content.filter((b) => b.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      toolUseId: 'tu-1',
      toolResult: 'file1\nfile2',
      isError: false,
    })
  })

  it('attaches to the most recent assistant message when multiple tool_uses exist across messages', () => {
    store().createNewSession('r1', '/p')
    store().addMessage(
      'r1',
      makeChatMessage({
        id: 'a-1',
        role: 'assistant',
        content: [makeToolUseBlock('Bash', {}, 'tu-old')],
      })
    )
    store().addMessage(
      'r1',
      makeChatMessage({
        id: 'a-2',
        role: 'assistant',
        content: [makeToolUseBlock('Read', {}, 'tu-new')],
      })
    )
    store().appendToolResult('r1', 'tu-new', 'contents', false)
    // Only the newer message should have the tool_result
    expect(
      store()
        .sessions['r1'].messages[0].content.some((b) => b.type === 'tool_result')
    ).toBe(false)
    expect(
      store()
        .sessions['r1'].messages[1].content.some((b) => b.type === 'tool_result')
    ).toBe(true)
  })

  it('marks isError=true when flagged', () => {
    store().createNewSession('r1', '/p')
    store().addMessage(
      'r1',
      makeChatMessage({
        id: 'a-1',
        role: 'assistant',
        content: [makeToolUseBlock('Bash', {}, 'tu-err')],
      })
    )
    store().appendToolResult('r1', 'tu-err', 'permission denied', true)
    const result = store().sessions['r1'].messages[0].content.find(
      (b) => b.type === 'tool_result'
    )
    expect(result).toMatchObject({ isError: true })
  })

  it('is a no-op when the toolUseId does not match any tool_use (does not throw, does not mutate)', () => {
    store().createNewSession('r1', '/p')
    store().addMessage(
      'r1',
      makeChatMessage({
        id: 'a-1',
        role: 'assistant',
        content: [makeToolUseBlock('Bash', {}, 'tu-real')],
      })
    )
    const before = store().sessions['r1'].messages[0].content.length
    expect(() => store().appendToolResult('r1', 'tu-ghost', 'x', false)).not.toThrow()
    expect(store().sessions['r1'].messages[0].content).toHaveLength(before)
  })

  it('is a no-op when the session does not exist', () => {
    expect(() => store().appendToolResult('ghost', 'tu-1', 'r', false)).not.toThrow()
    expect(store().sessions['ghost']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 9–11. Pending approvals keyed by requestId
// ---------------------------------------------------------------------------

describe('addPendingApproval / clearPendingApprovals', () => {
  it('addPendingApproval appends approvals keyed by requestId', () => {
    store().createNewSession('r1', '/p')
    store().addPendingApproval('r1', makePendingApproval({ requestId: 'req-a' }))
    store().addPendingApproval('r1', makePendingApproval({ requestId: 'req-b' }))
    const ids = store().sessions['r1'].pendingApprovals.map((a) => a.requestId)
    expect(ids).toEqual(['req-a', 'req-b'])
  })

  it('clearPendingApprovals empties the list for the targeted session', () => {
    store().createNewSession('r1', '/p')
    store().addPendingApproval('r1', makePendingApproval({ requestId: 'req-1' }))
    store().addPendingApproval('r1', makePendingApproval({ requestId: 'req-2' }))
    store().clearPendingApprovals('r1')
    expect(store().sessions['r1'].pendingApprovals).toEqual([])
  })

  it('clearPendingApprovals on session A does not affect session B', () => {
    store().createNewSession('r1', '/p')
    store().createNewSession('r2', '/p2', false)
    store().addPendingApproval('r1', makePendingApproval({ requestId: 'req-1' }))
    store().addPendingApproval('r2', makePendingApproval({ requestId: 'req-2' }))
    store().clearPendingApprovals('r1')
    expect(store().sessions['r1'].pendingApprovals).toEqual([])
    expect(store().sessions['r2'].pendingApprovals).toHaveLength(1)
  })

  it('removePendingApprovalByToolUse removes only the approval with the matching tool_use_id', () => {
    store().createNewSession('r1', '/p')
    store().addPendingApproval(
      'r1',
      makePendingApproval({ requestId: 'req-1', toolUseId: 'toolu_a' }),
    )
    store().addPendingApproval(
      'r1',
      makePendingApproval({ requestId: 'req-2', toolUseId: 'toolu_b' }),
    )
    // An older-style approval with no toolUseId should be unaffected.
    store().addPendingApproval(
      'r1',
      makePendingApproval({ requestId: 'req-3' }),
    )

    store().removePendingApprovalByToolUse('r1', 'toolu_a')
    const remaining = store().sessions['r1'].pendingApprovals.map((a) => a.requestId)
    expect(remaining).toEqual(['req-2', 'req-3'])
  })

  it('removePendingApprovalByToolUse is a no-op when no approval carries that id', () => {
    store().createNewSession('r1', '/p')
    store().addPendingApproval(
      'r1',
      makePendingApproval({ requestId: 'req-1', toolUseId: 'toolu_a' }),
    )
    store().removePendingApprovalByToolUse('r1', 'toolu_unknown')
    expect(store().sessions['r1'].pendingApprovals.map((a) => a.requestId)).toEqual(['req-1'])
  })
})

// ---------------------------------------------------------------------------
// 12–14. rekeySession — not covered by the .component test: activeView / no-op cases
// ---------------------------------------------------------------------------

describe('rekeySession (unit-level)', () => {
  it('is a no-op when the old routingId does not exist (does not create a ghost entry)', () => {
    store().rekeySession('missing', 'new-id')
    expect(store().sessions['new-id']).toBeUndefined()
    expect(store().sessions['missing']).toBeUndefined()
  })

  it('preserves session data byte-for-byte under the new id', () => {
    store().createNewSession('old', '/cwd-x')
    store().addMessage('old', makeAssistantMessage('hi'))
    const before = store().sessions['old']
    store().rekeySession('old', 'new')
    expect(store().sessions['old']).toBeUndefined()
    // Same reference — no deep copying
    expect(store().sessions['new']).toBe(before)
  })

  it('updates activeSessionId when the rekeyed session was active', () => {
    store().createNewSession('old', '/p')
    expect(store().activeSessionId).toBe('old')
    store().rekeySession('old', 'new')
    expect(store().activeSessionId).toBe('new')
  })

  it('does not touch activeSessionId when a non-active session is rekeyed', () => {
    store().createNewSession('active-one', '/p')
    store().createNewSession('background', '/q', false)
    store().rekeySession('background', 'background-new')
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
    store().addMessage('A', makeAssistantMessage('for A'))
    expect(store().sessions['B']).toBe(bBefore) // same reference
    expect(store().sessions['A'].messages).toHaveLength(1)
    expect(store().sessions['B'].messages).toHaveLength(0)
  })

  it('appendStreamingText on A does not leak into B', () => {
    store().createNewSession('A', '/a')
    store().createNewSession('B', '/b', false)
    store().appendStreamingText('A', 'a tokens')
    store().appendStreamingText('B', 'b tokens')
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
    const { result } = renderHook(() => useActiveSession((s: PerSessionState) => s.messages))
    expect(result.current).toEqual([])
  })

  it('useActiveSession returns EMPTY_SESSION_STATE slice when activeSessionId points at a deleted session', () => {
    useSessionStore.setState({ activeSessionId: 'ghost', sessions: {} })
    const { result } = renderHook(() =>
      useActiveSession((s: PerSessionState) => s.streamingText)
    )
    expect(result.current).toBe('')
  })

  it('useActiveSession reflects live updates when the active session exists', () => {
    store().createNewSession('r1', '/p')
    const { result, rerender } = renderHook(() =>
      useActiveSession((s: PerSessionState) => s.streamingText)
    )
    expect(result.current).toBe('')
    store().appendStreamingText('r1', 'stream')
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
    expect(s.teammates).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Extra: clearConversation — spec-mentioned "deterministic" reset
// ---------------------------------------------------------------------------

describe('clearConversation', () => {
  it('resets per-session state but preserves cwd and sdkActive', () => {
    store().createNewSession('r1', '/kept')
    store().addMessage('r1', makeAssistantMessage('hi'))
    store().addError('r1', 'e')
    useSessionStore.setState((st) => ({
      sessions: {
        ...st.sessions,
        r1: { ...st.sessions['r1'], sdkActive: true },
      },
    }))
    store().clearConversation('r1')
    const s = store().sessions['r1']
    expect(s.cwd).toBe('/kept')
    expect(s.sdkActive).toBe(true)
    expect(s.messages).toEqual([])
    expect(s.errors).toEqual([])
  })

  it('is a no-op when the session does not exist', () => {
    expect(() => store().clearConversation('ghost')).not.toThrow()
    expect(store().sessions['ghost']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Extra: setStatus updates cwd when SDK reports a new working directory
// (worktree enter/exit — regression pin against a real SDK behavior)
// ---------------------------------------------------------------------------

describe('setStatus cwd follow-through', () => {
  it('updates session.cwd when status.cwd differs from current', () => {
    store().createNewSession('r1', '/original')
    store().setStatus('r1', {
      state: 'idle',
      sessionId: 'sdk-id',
      model: 'claude-sonnet-4-6',
      cwd: '/worktree/branch',
      totalCostUsd: 0,
    })
    expect(store().sessions['r1'].cwd).toBe('/worktree/branch')
  })

  it('leaves cwd untouched when status.cwd matches current', () => {
    store().createNewSession('r1', '/same')
    store().setStatus('r1', {
      state: 'idle',
      sessionId: 'sdk-id',
      model: 'claude-sonnet-4-6',
      cwd: '/same',
      totalCostUsd: 0,
    })
    expect(store().sessions['r1'].cwd).toBe('/same')
  })

  it('leaves cwd untouched when status.cwd is null', () => {
    store().createNewSession('r1', '/keep')
    store().setStatus('r1', {
      state: 'idle',
      sessionId: null,
      model: null,
      cwd: null,
      totalCostUsd: 0,
    })
    expect(store().sessions['r1'].cwd).toBe('/keep')
  })
})
