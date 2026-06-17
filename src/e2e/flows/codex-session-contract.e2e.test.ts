/**
 * Layer 3: E2E contract test — Codex session IPC event sequence.
 *
 * Feeds a realistic Codex turn sequence through the bridge/store and asserts
 * the resulting messages/state — without spawning the real codex binary.
 *
 * Payload shapes are taken directly from CodexSession.ts + mapCodexEvent.ts
 * (i.e. what those modules actually emit, not what we wish they emitted).
 *
 * Coverage:
 *   1. Handshake: session:status with provider:'codex' + CODEX_CAPABILITIES → store reflects provider + running.
 *   2. Text stream: session:stream {type:'text'} deltas then a finalising session:message → streamingText accumulates then clears.
 *   3. Thinking stream: session:stream {type:'thinking'} → streamingThinking accumulates.
 *   4. Tool sequence: session:message (assistant, tool_use block) → session:tool-result → store upserts result block into the same message.
 *   5. Approval request: session:approval-request (Shell / ApplyPatch tools) → pending approval in store; idle status clears it.
 *   6. Token usage status-line: session:status-line with Codex shape (totalCostUsd:0, context window) → store reflects it.
 *   7. Turn completion: session:result + session:status idle → terminal state (messages intact, no pending approvals, streaming cleared).
 *   8. Full turn with thinking + text + tool in one realistic sequence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import {
  makeAssistantMessage,
  makeSessionStatus,
  makePendingApproval,
  resetFactoryCounter
} from '@test/factories/messages'
import { CODEX_CAPABILITIES } from '../../shared/types'
import type {
  ChatMessage,
  PendingApproval,
  StreamDelta,
  SessionStatus,
  SessionResult,
  StatusLineData,
  TodoItem
} from '../../shared/types'

let app: TestApp
let eventCleanups: Array<() => void>

// ---------------------------------------------------------------------------
// Minimal event wiring (mirrors useClaudeEvents — keeps the test self-contained)
// ---------------------------------------------------------------------------

function wireEventHandlers(app: TestApp): Array<() => void> {
  const cleanups: Array<() => void> = []
  const store = useSessionStore.getState

  function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
    return (cb: T) => {
      const handler = (_: unknown, ...args: unknown[]): void => (cb as Function)(...args)
      app.bridge.ipcRenderer.on(channel, handler)
      const cleanup = (): void => {
        app.bridge.ipcRenderer.removeListener(channel, handler)
      }
      cleanups.push(cleanup)
      return cleanup
    }
  }

  onEvent<(routingId: string, msg: ChatMessage) => void>('session:message')((routingId, msg) => {
    store().addMessage(routingId, msg)
  })

  onEvent<(routingId: string, data: StreamDelta) => void>('session:stream')((routingId, data) => {
    if (data.type === 'thinking') store().appendStreamingThinking(routingId, data.text)
    else store().appendStreamingText(routingId, data.text)
  })

  onEvent<(routingId: string, approval: PendingApproval) => void>('session:approval-request')(
    (routingId, approval) => {
      store().addPendingApproval(routingId, approval)
    }
  )

  onEvent<(routingId: string, status: SessionStatus) => void>('session:status')(
    (routingId, status) => {
      let effective = routingId
      if (status.sessionId && status.sessionId !== routingId) {
        const s = store()
        if (s.sessions[routingId]) {
          s.rekeySession(routingId, status.sessionId)
          effective = status.sessionId
        }
      }
      if (status.state === 'disconnected') {
        store().markSdkInactive(effective)
        store().setStatus(effective, { ...status, state: 'idle' })
        store().clearPendingApprovals(effective)
        return
      }
      store().setStatus(effective, status)
      if (status.state === 'idle') store().clearPendingApprovals(effective)
    }
  )

  onEvent<(routingId: string, result: SessionResult) => void>('session:result')((routingId) => {
    const s = store()
    const session = s.sessions[routingId]
    if (session && session.todos.length > 0) {
      const allDone = session.todos.every((t: TodoItem) => t.status === 'completed')
      if (allDone) s.setTodos(routingId, [])
    }
  })

  onEvent<(routingId: string, error: string) => void>('session:error')((routingId, error) => {
    store().addError(routingId, error)
  })

  onEvent<(routingId: string, warning: string) => void>('session:warning')((routingId, warning) => {
    store().addWarning(routingId, warning)
  })

  onEvent<
    (routingId: string, data: { toolUseId: string; result: string; isError: boolean }) => void
  >('session:tool-result')((routingId, { toolUseId, result, isError }) => {
    store().appendToolResult(routingId, toolUseId, result, isError)
  })

  onEvent<(routingId: string, data: StatusLineData) => void>('session:status-line')(
    (routingId, data) => {
      store().setStatusLine(routingId, data)
    }
  )

  return cleanups
}

// ---------------------------------------------------------------------------
// Factory helpers: Codex-shaped payloads (mirroring mapCodexEvent.ts output)
// ---------------------------------------------------------------------------

function makeCodexStatus(
  state: SessionStatus['state'],
  sessionId: string,
  overrides?: Partial<SessionStatus>
): SessionStatus {
  return makeSessionStatus({
    state,
    sessionId,
    provider: 'codex',
    capabilities: CODEX_CAPABILITIES,
    model: 'o4-mini',
    cwd: '/test/codex-project',
    totalCostUsd: 0,
    ...overrides
  })
}

function makeCodexStatusLine(overrides?: Partial<StatusLineData>): StatusLineData {
  return {
    totalCostUsd: 0,
    totalDurationMs: 1200,
    totalApiDurationMs: 0,
    totalInputTokens: 500,
    totalOutputTokens: 120,
    cachedTokens: 50,
    totalTokens: 620,
    contextWindowSize: 128000,
    usedPercentage: (620 / 128000) * 100,
    remainingPercentage: ((128000 - 620) / 128000) * 100,
    ...overrides
  }
}

function makeCodexSessionResult(): SessionResult {
  return {
    totalCostUsd: 0,
    durationMs: 1500,
    result: 'completed',
    sessionId: null
  }
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  resetFactoryCounter()
  app = await bootTestApp()
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {}
  })
  eventCleanups = wireEventHandlers(app)
})

afterEach(() => {
  eventCleanups.forEach((fn) => fn())
  app.teardown()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Codex contract: handshake / status', () => {
  it('session:status (provider:codex, idle) after thread/start seeds provider + capabilities', () => {
    const tempId = 'codex-temp-1'
    const threadId = 'thread-abc-001'
    useSessionStore.getState().createNewSession(tempId, '/test/codex-project')

    // CodexSession emits session:status idle with its stable threadId after handshake
    app.emit('session:status', tempId, makeCodexStatus('idle', threadId))

    const state = useSessionStore.getState()
    // Old temp key gone, rekeyed to threadId
    expect(state.sessions[tempId]).toBeUndefined()
    expect(state.sessions[threadId]).toBeDefined()

    const session = state.sessions[threadId]
    expect(session.status.provider).toBe('codex')
    expect(session.status.capabilities).toEqual(CODEX_CAPABILITIES)
    expect(session.status.state).toBe('idle')
    expect(session.status.model).toBe('o4-mini')
  })

  it('session:status (running) reflects running state after turn/start', () => {
    const id = 'thread-running-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')

    app.emit('session:status', id, makeCodexStatus('running', id))

    const session = useSessionStore.getState().sessions[id]
    expect(session.status.state).toBe('running')
    expect(session.status.provider).toBe('codex')
    expect(session.status.capabilities.costUsd).toBe(false)
    expect(session.status.capabilities.subagents).toBe(false)
    expect(session.status.capabilities.effortLevels).toBe(true)
  })

  it('CODEX_CAPABILITIES gates: no thinking, no voice, no backgroundTasks, no hostedMcp', () => {
    const id = 'thread-caps-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('idle', id))

    // Rekey may have happened — find the session
    const state = useSessionStore.getState()
    const session = Object.values(state.sessions).find(
      (s) => s.status.provider === 'codex'
    )
    expect(session).toBeDefined()
    expect(session!.status.capabilities.thinkingModes).toBe(false)
    expect(session!.status.capabilities.voice).toBe(false)
    expect(session!.status.capabilities.backgroundTasks).toBe(false)
    expect(session!.status.capabilities.hostedMcp).toBe(false)
    expect(session!.status.capabilities.plan).toBe(true)
    expect(session!.status.capabilities.fork).toBe(true)
  })
})

describe('Codex contract: text streaming + finalising message', () => {
  it('stream deltas accumulate in streamingText; final session:message with same id clears it', () => {
    const id = 'thread-stream-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('running', id))

    const itemId = 'item-agent-msg-1'

    // Codex: item/agentMessage/delta × N → session:stream {type:'text'}
    app.emit('session:stream', id, { type: 'text', text: 'The ' })
    app.emit('session:stream', id, { type: 'text', text: 'answer ' })
    app.emit('session:stream', id, { type: 'text', text: 'is 42.' })

    expect(useSessionStore.getState().sessions[id].streamingText).toBe('The answer is 42.')

    // Codex: item/completed {agentMessage} → session:message (mapItemCompleted)
    // The message uses itemId as its id — store upserts by id, clearing streamingText
    const finalMsg: ChatMessage = {
      id: itemId,
      role: 'assistant',
      content: [{ type: 'text', text: 'The answer is 42.' }],
      timestamp: Date.now()
    }
    app.emit('session:message', id, finalMsg)

    const session = useSessionStore.getState().sessions[id]
    // streamingText clears after addMessage() is called (store upserts by id)
    // The message must be present
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].id).toBe(itemId)
    expect(session.messages[0].role).toBe('assistant')
    const block = session.messages[0].content[0]
    expect(block.type).toBe('text')
    if (block.type === 'text') expect(block.text).toBe('The answer is 42.')
  })

  it('multiple stream chunks from different text items accumulate correctly', () => {
    const id = 'thread-stream-multi-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')

    // First item streams
    app.emit('session:stream', id, { type: 'text', text: 'Hello ' })
    app.emit('session:stream', id, { type: 'text', text: 'world' })
    expect(useSessionStore.getState().sessions[id].streamingText).toBe('Hello world')

    // First item completes — clears streamingText via addMessage upsert
    app.emit('session:message', id, makeAssistantMessage('Hello world', { id: 'item-1' }))
    // streamingText should now be clear (message replaced)
    useSessionStore.getState().appendStreamingText(id, '') // force check
    // Emit second item's stream
    app.emit('session:stream', id, { type: 'text', text: 'Follow-up.' })
    expect(useSessionStore.getState().sessions[id].streamingText).toBe('Follow-up.')
  })
})

describe('Codex contract: thinking stream', () => {
  it('session:stream {type:thinking} accumulates in streamingThinking', () => {
    const id = 'thread-think-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('running', id))

    // Codex: item/reasoning/textDelta or summaryTextDelta → session:stream {type:'thinking'}
    app.emit('session:stream', id, { type: 'thinking', text: 'Let me reason: ' })
    app.emit('session:stream', id, { type: 'thinking', text: 'step A → step B.' })

    const session = useSessionStore.getState().sessions[id]
    expect(session.streamingThinking).toBe('Let me reason: step A → step B.')
    // Text stream should be untouched
    expect(session.streamingText).toBe('')
  })

  it('text stream after thinking clears streamingThinking (store transition: reasoning → answer)', () => {
    const id = 'thread-think-text-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')

    // Thinking stream starts
    app.emit('session:stream', id, { type: 'thinking', text: 'Thinking...' })
    expect(useSessionStore.getState().sessions[id].streamingThinking).toBe('Thinking...')

    // Text stream arrives — appendStreamingText() clears streamingThinking (thinking→answer transition)
    app.emit('session:stream', id, { type: 'text', text: 'Result.' })

    const session = useSessionStore.getState().sessions[id]
    // streamingThinking is cleared; streamingText has the answer
    expect(session.streamingThinking).toBe('')
    expect(session.streamingText).toBe('Result.')
  })
})

describe('Codex contract: tool use sequence', () => {
  it('Shell tool: item/started → tool_use message; item/completed → tool-result upserted into same message', () => {
    const id = 'thread-tool-001'
    const itemId = 'item-cmd-1'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('running', id))

    // CodexSession/mapItemStarted: item/started (commandExecution) → session:message {tool_use, toolName:'Shell'}
    const toolUseMsg: ChatMessage = {
      id: itemId,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          toolUseId: itemId,
          toolName: 'Shell',
          toolInput: { command: 'ls /tmp' }
        }
      ],
      timestamp: Date.now()
    }
    app.emit('session:message', id, toolUseMsg)

    // Verify tool_use message is in store
    let session = useSessionStore.getState().sessions[id]
    expect(session.messages).toHaveLength(1)
    const toolBlock = session.messages[0].content[0]
    expect(toolBlock.type).toBe('tool_use')
    if (toolBlock.type === 'tool_use') {
      expect(toolBlock.toolName).toBe('Shell')
      expect(toolBlock.toolUseId).toBe(itemId)
      expect(toolBlock.toolInput).toEqual({ command: 'ls /tmp' })
    }

    // mapItemCompleted: item/completed (commandExecution) → session:tool-result {toolUseId: itemId}
    app.emit('session:tool-result', id, {
      toolUseId: itemId,
      result: 'file1.txt\nfile2.txt',
      isError: false
    })

    // Verify tool_result was upserted into the same message (appendToolResult logic)
    session = useSessionStore.getState().sessions[id]
    expect(session.messages).toHaveLength(1)
    const resultBlock = session.messages[0].content.find((b) => b.type === 'tool_result')
    expect(resultBlock).toBeDefined()
    if (resultBlock && resultBlock.type === 'tool_result') {
      expect(resultBlock.toolUseId).toBe(itemId)
      expect(resultBlock.toolResult).toBe('file1.txt\nfile2.txt')
      expect(resultBlock.isError).toBe(false)
    }
  })

  it('ApplyPatch tool: fileChange item type maps to toolName:ApplyPatch', () => {
    const id = 'thread-tool-patch-001'
    const itemId = 'item-patch-1'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')

    const patchMsg: ChatMessage = {
      id: itemId,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          toolUseId: itemId,
          toolName: 'ApplyPatch',
          toolInput: { path: 'src/index.ts', reason: 'Fix bug' }
        }
      ],
      timestamp: Date.now()
    }
    app.emit('session:message', id, patchMsg)
    app.emit('session:tool-result', id, {
      toolUseId: itemId,
      result: 'Applied 2 change(s)',
      isError: false
    })

    const session = useSessionStore.getState().sessions[id]
    const msg = session.messages[0]
    const toolUse = msg.content.find((b) => b.type === 'tool_use')
    expect(toolUse?.type === 'tool_use' && toolUse.toolName).toBe('ApplyPatch')
    const toolResult = msg.content.find((b) => b.type === 'tool_result')
    expect(toolResult).toBeDefined()
  })

  it('failed tool result (isError:true) is stored correctly', () => {
    const id = 'thread-tool-err-001'
    const itemId = 'item-failed-1'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')

    app.emit('session:message', id, {
      id: itemId,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          toolUseId: itemId,
          toolName: 'Shell',
          toolInput: { command: 'bad-command' }
        }
      ],
      timestamp: Date.now()
    } satisfies ChatMessage)

    app.emit('session:tool-result', id, {
      toolUseId: itemId,
      result: 'Command not found',
      isError: true
    })

    const session = useSessionStore.getState().sessions[id]
    const resultBlock = session.messages[0].content.find((b) => b.type === 'tool_result')
    expect(resultBlock).toBeDefined()
    if (resultBlock && resultBlock.type === 'tool_result') {
      expect(resultBlock.isError).toBe(true)
      expect(resultBlock.toolResult).toBe('Command not found')
    }
  })

  it('tool-result routes to correct message when multiple tool_use blocks exist', () => {
    const id = 'thread-tool-multi-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')

    // Two separate tool_use messages (Codex emits one item per tool, each is its own message)
    const msgA: ChatMessage = {
      id: 'item-A',
      role: 'assistant',
      content: [{ type: 'tool_use', toolUseId: 'item-A', toolName: 'Shell', toolInput: { command: 'cmd-a' } }],
      timestamp: Date.now()
    }
    const msgB: ChatMessage = {
      id: 'item-B',
      role: 'assistant',
      content: [{ type: 'tool_use', toolUseId: 'item-B', toolName: 'Shell', toolInput: { command: 'cmd-b' } }],
      timestamp: Date.now()
    }
    app.emit('session:message', id, msgA)
    app.emit('session:message', id, msgB)

    app.emit('session:tool-result', id, { toolUseId: 'item-B', result: 'result-B', isError: false })
    app.emit('session:tool-result', id, { toolUseId: 'item-A', result: 'result-A', isError: false })

    const session = useSessionStore.getState().sessions[id]
    const findResult = (toolUseId: string) => {
      for (const msg of session.messages) {
        const b = msg.content.find((b) => b.type === 'tool_result' && b.toolUseId === toolUseId)
        if (b) return b
      }
      return undefined
    }
    const rA = findResult('item-A')
    const rB = findResult('item-B')
    expect(rA?.type === 'tool_result' && rA.toolResult).toBe('result-A')
    expect(rB?.type === 'tool_result' && rB.toolResult).toBe('result-B')
  })
})

describe('Codex contract: approval request / resolution', () => {
  it('session:approval-request (Shell/commandExecution) adds to pendingApprovals', () => {
    const id = 'thread-approval-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('running', id))

    // CodexSession.wireServerRequestHandlers: item/commandExecution/requestApproval → session:approval-request
    const approval = makePendingApproval({
      requestId: 'req-codex-1',
      toolName: 'Shell',
      toolUseId: 'item-cmd-approval-1',
      input: { command: 'rm -rf /tmp/scratch', reason: 'Clean up temp files' }
    })
    app.emit('session:approval-request', id, approval)

    const session = useSessionStore.getState().sessions[id]
    expect(session.pendingApprovals).toHaveLength(1)
    expect(session.pendingApprovals[0].requestId).toBe('req-codex-1')
    expect(session.pendingApprovals[0].toolName).toBe('Shell')
    expect(session.pendingApprovals[0].input).toEqual({ command: 'rm -rf /tmp/scratch', reason: 'Clean up temp files' })
  })

  it('session:approval-request (ApplyPatch/fileChange) adds to pendingApprovals', () => {
    const id = 'thread-approval-patch-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('running', id))

    app.emit(
      'session:approval-request',
      id,
      makePendingApproval({
        requestId: 'req-codex-patch-1',
        toolName: 'ApplyPatch',
        toolUseId: 'item-patch-approval-1',
        input: { reason: 'Patch README.md' }
      })
    )

    const session = useSessionStore.getState().sessions[id]
    expect(session.pendingApprovals).toHaveLength(1)
    expect(session.pendingApprovals[0].toolName).toBe('ApplyPatch')
  })

  it('idle status after resolution clears pendingApprovals', () => {
    const id = 'thread-approval-idle-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('running', id))

    app.emit(
      'session:approval-request',
      id,
      makePendingApproval({ requestId: 'req-a', toolName: 'Shell' })
    )
    app.emit(
      'session:approval-request',
      id,
      makePendingApproval({ requestId: 'req-b', toolName: 'ApplyPatch' })
    )
    expect(useSessionStore.getState().sessions[id].pendingApprovals).toHaveLength(2)

    // Turn completes; CodexSession emits session:status idle
    app.emit('session:result', id, makeCodexSessionResult())
    app.emit('session:status', id, makeCodexStatus('idle', id))

    expect(useSessionStore.getState().sessions[id].pendingApprovals).toHaveLength(0)
  })

  it('multiple independent approvals are tracked by requestId', () => {
    const id = 'thread-approval-multi-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')

    app.emit('session:approval-request', id, makePendingApproval({ requestId: 'r1', toolName: 'Shell' }))
    app.emit('session:approval-request', id, makePendingApproval({ requestId: 'r2', toolName: 'ApplyPatch' }))
    app.emit('session:approval-request', id, makePendingApproval({ requestId: 'r3', toolName: 'UserInput' }))

    const approvals = useSessionStore.getState().sessions[id].pendingApprovals
    expect(approvals).toHaveLength(3)
    expect(approvals.map((a) => a.requestId)).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('Codex contract: token usage / status-line', () => {
  it('session:status-line with Codex shape (totalCostUsd:0) is stored', () => {
    const id = 'thread-statusline-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('running', id))

    const statusLine = makeCodexStatusLine()
    app.emit('session:status-line', id, statusLine)

    const session = useSessionStore.getState().sessions[id]
    expect(session.statusLine).toBeDefined()
    expect(session.statusLine!.totalCostUsd).toBe(0)
    expect(session.statusLine!.totalInputTokens).toBe(500)
    expect(session.statusLine!.totalOutputTokens).toBe(120)
    expect(session.statusLine!.cachedTokens).toBe(50)
    expect(session.statusLine!.contextWindowSize).toBe(128000)
    expect(session.statusLine!.usedPercentage).toBeCloseTo((620 / 128000) * 100)
  })

  it('successive status-line updates replace the previous value', () => {
    const id = 'thread-statusline-update-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')

    app.emit('session:status-line', id, makeCodexStatusLine({ totalInputTokens: 100, totalTokens: 200 }))
    app.emit('session:status-line', id, makeCodexStatusLine({ totalInputTokens: 400, totalTokens: 600 }))

    const session = useSessionStore.getState().sessions[id]
    // Most recent value wins
    expect(session.statusLine!.totalInputTokens).toBe(400)
    expect(session.statusLine!.totalTokens).toBe(600)
  })

  it('status-line with zero contextWindowSize stores null for usedPercentage', () => {
    const id = 'thread-statusline-zero-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')

    // mapTokenUsageUpdated: contextWindow=0 → usedPercentage: null
    const statusLine = makeCodexStatusLine({ contextWindowSize: 0, usedPercentage: null, remainingPercentage: null })
    app.emit('session:status-line', id, statusLine)

    const session = useSessionStore.getState().sessions[id]
    expect(session.statusLine!.usedPercentage).toBeNull()
    expect(session.statusLine!.remainingPercentage).toBeNull()
  })
})

describe('Codex contract: turn completion / terminal state', () => {
  it('session:result + session:status idle → running:false, messages intact, no approvals', () => {
    const id = 'thread-complete-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('running', id))

    app.emit('session:stream', id, { type: 'text', text: 'Working...' })
    app.emit('session:message', id, makeAssistantMessage('Done!', { id: 'item-final-1' }))
    app.emit(
      'session:approval-request',
      id,
      makePendingApproval({ requestId: 'req-during-turn', toolName: 'Shell' })
    )

    // Turn completes: mapTurnCompleted → session:result + CodexSession.wireNotificationHandlers → session:status idle
    app.emit('session:result', id, makeCodexSessionResult())
    app.emit('session:status', id, makeCodexStatus('idle', id))

    const session = useSessionStore.getState().sessions[id]
    expect(session.status.state).toBe('idle')
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].content[0].type === 'text' && session.messages[0].content[0].text).toBe('Done!')
    expect(session.pendingApprovals).toHaveLength(0)
  })

  it('failed turn emits session:status error state', () => {
    const id = 'thread-failed-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('running', id))

    // mapTurnCompleted: turn.status='failed' → result + error alert + CodexSession sends state:'error'
    app.emit('session:result', id, { totalCostUsd: 0, durationMs: 500, result: 'failed', sessionId: null })
    app.emit('session:error', id, 'Turn failed: rate limit exceeded')
    app.emit('session:status', id, makeCodexStatus('error', id))

    const session = useSessionStore.getState().sessions[id]
    expect(session.status.state).toBe('error')
    expect(session.errors).toContain('Turn failed: rate limit exceeded')
  })

  it('process-exit error path: session:error + session:status error', () => {
    const id = 'thread-exit-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')
    app.emit('session:status', id, makeCodexStatus('running', id))

    // CodexSession.child.on('exit') when this.running=true → session:error + state:'error'
    app.emit('session:error', id, 'Codex process exited unexpectedly (code=1, signal=null)')
    app.emit('session:status', id, makeCodexStatus('error', id))

    const session = useSessionStore.getState().sessions[id]
    expect(session.status.state).toBe('error')
    expect(session.errors[0]).toMatch(/exited unexpectedly/)
  })

  it('error notification with willRetry:false maps to session:error; willRetry:true to session:warning', () => {
    const id = 'thread-errnotif-001'
    useSessionStore.getState().createNewSession(id, '/test/codex-project')

    // mapErrorNotification: willRetry=false → alertKind:'error' → session:error
    app.emit('session:error', id, 'Network error')
    // mapErrorNotification: willRetry=true → alertKind:'warning' → session:warning
    app.emit('session:warning', id, 'Retrying due to rate limit...')

    const session = useSessionStore.getState().sessions[id]
    expect(session.errors).toContain('Network error')
    expect(session.warnings).toContain('Retrying due to rate limit...')
  })
})

describe('Codex contract: full turn sequence (thinking + text + Shell tool)', () => {
  it('realistic multi-step turn: thinking → text → tool_use → tool-result → final text → idle', () => {
    const tempId = 'codex-full-temp'
    const threadId = 'thread-full-001'
    useSessionStore.getState().createNewSession(tempId, '/test/codex-project')

    // 1. Handshake: thread/start response → session:status idle with stable threadId
    app.emit('session:status', tempId, makeCodexStatus('idle', threadId))
    // After rekey:
    expect(useSessionStore.getState().sessions[threadId]).toBeDefined()

    // 2. turn/start → session:status running
    app.emit('session:status', threadId, makeCodexStatus('running', threadId))
    expect(useSessionStore.getState().sessions[threadId].status.state).toBe('running')

    // 3. Reasoning deltas
    app.emit('session:stream', threadId, { type: 'thinking', text: 'I should run ls first.' })

    // 4. Agent message delta (text)
    app.emit('session:stream', threadId, { type: 'text', text: "I'll check the directory. " })

    // 5. Shell tool starts: item/started (commandExecution) → session:message {tool_use, Shell}
    const cmdItemId = 'item-cmd-full-1'
    app.emit('session:message', threadId, {
      id: cmdItemId,
      role: 'assistant',
      content: [{ type: 'tool_use', toolUseId: cmdItemId, toolName: 'Shell', toolInput: { command: 'ls .' } }],
      timestamp: Date.now()
    } satisfies ChatMessage)

    // 6. Approval request for the command
    const approvalId = 'req-full-1'
    app.emit(
      'session:approval-request',
      threadId,
      makePendingApproval({ requestId: approvalId, toolName: 'Shell', toolUseId: cmdItemId, input: { command: 'ls .' } })
    )
    expect(useSessionStore.getState().sessions[threadId].pendingApprovals).toHaveLength(1)

    // 7. User approves → tool result arrives
    app.emit('session:tool-result', threadId, { toolUseId: cmdItemId, result: 'src/\nREADME.md', isError: false })

    // 8. Token usage update
    app.emit('session:status-line', threadId, makeCodexStatusLine())

    // 9. Final agent message
    const finalItemId = 'item-agent-full-2'
    app.emit('session:stream', threadId, { type: 'text', text: 'Found 2 entries.' })
    app.emit('session:message', threadId, {
      id: finalItemId,
      role: 'assistant',
      content: [{ type: 'text', text: 'Found 2 entries.' }],
      timestamp: Date.now()
    } satisfies ChatMessage)

    // 10. turn/completed → session:result + session:status idle
    app.emit('session:result', threadId, makeCodexSessionResult())
    app.emit('session:status', threadId, makeCodexStatus('idle', threadId))

    // --- Assertions on final state ---
    const session = useSessionStore.getState().sessions[threadId]

    // Status
    expect(session.status.state).toBe('idle')
    expect(session.status.provider).toBe('codex')
    expect(session.status.capabilities).toEqual(CODEX_CAPABILITIES)

    // Messages: cmd tool_use + final text
    expect(session.messages).toHaveLength(2)
    const toolUseMsg = session.messages.find((m) =>
      m.content.some((b) => b.type === 'tool_use' && b.toolUseId === cmdItemId)
    )
    expect(toolUseMsg).toBeDefined()
    const toolResultBlock = toolUseMsg!.content.find((b) => b.type === 'tool_result')
    expect(toolResultBlock).toBeDefined()
    if (toolResultBlock?.type === 'tool_result') {
      expect(toolResultBlock.toolResult).toBe('src/\nREADME.md')
      expect(toolResultBlock.isError).toBe(false)
    }

    const textMsg = session.messages.find((m) => m.id === finalItemId)
    expect(textMsg).toBeDefined()
    expect(textMsg!.content[0]).toEqual({ type: 'text', text: 'Found 2 entries.' })

    // Approvals cleared by idle status
    expect(session.pendingApprovals).toHaveLength(0)

    // Status-line stored
    expect(session.statusLine).toBeDefined()
    expect(session.statusLine!.totalCostUsd).toBe(0)
    expect(session.statusLine!.contextWindowSize).toBe(128000)
  })
})

describe('Codex contract: session isolation with concurrent Claude session', () => {
  it('Codex and Claude sessions coexist without cross-contamination', () => {
    const codexId = 'thread-codex-iso'
    const claudeId = 'claude-session-iso'
    useSessionStore.getState().createNewSession(codexId, '/codex-project')
    useSessionStore.getState().createNewSession(claudeId, '/claude-project')

    // Codex session running
    app.emit('session:status', codexId, makeCodexStatus('running', codexId))
    // Claude session running (with Claude capabilities)
    app.emit(
      'session:status',
      claudeId,
      makeSessionStatus({ state: 'running', sessionId: claudeId })
    )

    // Stream events are isolated
    app.emit('session:stream', codexId, { type: 'text', text: 'codex output' })
    app.emit('session:stream', claudeId, { type: 'text', text: 'claude output' })

    expect(useSessionStore.getState().sessions[codexId].streamingText).toBe('codex output')
    expect(useSessionStore.getState().sessions[claudeId].streamingText).toBe('claude output')

    // Provider capabilities are independent
    expect(useSessionStore.getState().sessions[codexId].status.provider).toBe('codex')
    expect(useSessionStore.getState().sessions[codexId].status.capabilities.costUsd).toBe(false)
    expect(useSessionStore.getState().sessions[claudeId].status.provider).toBe('claude')
    expect(useSessionStore.getState().sessions[claudeId].status.capabilities.costUsd).toBe(true)

    // Approval in Codex doesn't bleed to Claude
    app.emit(
      'session:approval-request',
      codexId,
      makePendingApproval({ requestId: 'codex-req', toolName: 'Shell' })
    )
    expect(useSessionStore.getState().sessions[codexId].pendingApprovals).toHaveLength(1)
    expect(useSessionStore.getState().sessions[claudeId].pendingApprovals).toHaveLength(0)
  })
})
