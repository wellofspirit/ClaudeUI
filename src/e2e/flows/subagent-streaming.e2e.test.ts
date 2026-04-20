/**
 * Layer 3: E2E test — Subagent streaming.
 *
 * Parent task spawns a subagent → session:subagent-stream events route to the
 * correct subagent bucket keyed by toolUseId (used by AgentTabBar).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  resetFactoryCounter,
} from '@test/factories/messages'
import type { ChatMessage, SubagentStreamDelta } from '../../shared/types'

let app: TestApp
let eventCleanups: Array<() => void>

function wireEventHandlers(app: TestApp): Array<() => void> {
  const cleanups: Array<() => void> = []
  const store = useSessionStore.getState

  function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
    return (cb: T) => {
      const handler = (_: unknown, ...args: unknown[]): void => (cb as Function)(...args)
      app.bridge.ipcRenderer.on(channel, handler)
      const cleanup = (): void => { app.bridge.ipcRenderer.removeListener(channel, handler) }
      cleanups.push(cleanup)
      return cleanup
    }
  }

  onEvent<(routingId: string, msg: ChatMessage) => void>('session:message')((routingId, msg) => {
    store().addMessage(routingId, msg)
  })
  onEvent<(routingId: string, data: SubagentStreamDelta) => void>('session:subagent-stream')((routingId, data) => {
    if (data.type === 'thinking') {
      store().appendSubagentStreamingThinking(routingId, data.toolUseId, data.text)
    } else {
      store().appendSubagentStreamingText(routingId, data.toolUseId, data.text)
    }
  })
  onEvent<(routingId: string, data: { toolUseId: string; message: ChatMessage }) => void>('session:subagent-message')((routingId, data) => {
    store().addSubagentMessage(routingId, data.toolUseId, data.message)
  })
  onEvent<(routingId: string, data: { toolUseId: string; messages: ChatMessage[] }) => void>('session:subagent-message-batch')((routingId, data) => {
    store().appendSubagentMessageBatch(routingId, data.toolUseId, data.messages)
  })
  onEvent<(routingId: string, data: { toolUseId: string; toolResultToolUseId: string; result: string; isError: boolean }) => void>('session:subagent-tool-result')((routingId, data) => {
    store().appendSubagentToolResult(routingId, data.toolUseId, data.toolResultToolUseId, data.result, data.isError)
  })

  return cleanups
}

beforeEach(async () => {
  resetFactoryCounter()
  app = await bootTestApp()
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
  })
  eventCleanups = wireEventHandlers(app)
})

afterEach(() => {
  eventCleanups.forEach((fn) => fn())
  app.teardown()
})

describe('E2E: subagent streaming', () => {
  it('parent spawns subagent → subagent stream text accumulates under toolUseId', () => {
    const routingId = 'r1'
    const subagentToolUseId = 'sub-task-1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    // Parent emits a Task tool_use creating the subagent
    app.emit('session:message', routingId, makeChatMessage({
      content: [makeToolUseBlock('Task', { description: 'search the codebase' }, subagentToolUseId)],
    }))

    // Subagent streams text
    app.emit('session:subagent-stream', routingId, {
      toolUseId: subagentToolUseId, type: 'text', text: 'Looking '
    })
    app.emit('session:subagent-stream', routingId, {
      toolUseId: subagentToolUseId, type: 'text', text: 'for files...'
    })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.subagentStreamingText[subagentToolUseId]).toBe('Looking for files...')
  })

  it('multiple subagents get independent streaming buckets', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit('session:subagent-stream', routingId, { toolUseId: 'sub-A', type: 'text', text: 'alpha' })
    app.emit('session:subagent-stream', routingId, { toolUseId: 'sub-B', type: 'text', text: 'beta' })
    app.emit('session:subagent-stream', routingId, { toolUseId: 'sub-A', type: 'text', text: '-more' })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.subagentStreamingText['sub-A']).toBe('alpha-more')
    expect(session.subagentStreamingText['sub-B']).toBe('beta')
  })

  it('subagent messages land in the correct bucket (subagentMessages)', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    const subagentMsg = makeAssistantMessage('subagent response')
    app.emit('session:subagent-message', routingId, {
      toolUseId: 'sub-X', message: subagentMsg,
    })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.subagentMessages['sub-X']).toBeDefined()
    expect(session.subagentMessages['sub-X']).toHaveLength(1)
    expect(session.subagentMessages['sub-X'][0].content[0]).toEqual({ type: 'text', text: 'subagent response' })
  })

  it('thinking stream for subagent routes independently of text stream', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    app.emit('session:subagent-stream', routingId, {
      toolUseId: 'sub-think', type: 'thinking', text: 'pondering...',
    })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.subagentStreamingThinking['sub-think']).toBe('pondering...')
    // Text bucket for same subagent remains empty
    expect(session.subagentStreamingText['sub-think']).toBeUndefined()
  })
})
