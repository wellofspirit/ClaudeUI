/**
 * Layer 3: E2E test — Subagent streaming.
 *
 * Parent task spawns a subagent → item appends retain the owner tool identity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { emitItemDelta } from '@test/helpers/item-stream'
import { itemStreamKey } from '../../core/shared/sync/item-stream'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  resetFactoryCounter
} from '@test/factories/messages'

let app: TestApp

// SyncCore phase 4c: the ~20-handler `wireEventHandlers` table this file used to
// carry — a hand-maintained copy of useClaudeEvents, itself a copy of the reducer —
// is DELETED. `app.emit` feeds the harness SyncClient, whose raw-event tap folds
// `applyEvent` and projects the result into the store (boot-test-app §5), so these
// flows now exercise the real interpretation instead of a third one.

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
})

afterEach(() => {
  app.teardown()
})

describe('E2E: subagent streaming', () => {
  it('parent spawns subagent → subagent stream text accumulates under toolUseId', () => {
    const routingId = 'r1'
    const subagentToolUseId = 'sub-task-1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    // Parent emits a Task tool_use creating the subagent
    app.emit(
      'session:message',
      routingId,
      makeChatMessage({
        content: [
          makeToolUseBlock('Task', { description: 'search the codebase' }, subagentToolUseId)
        ]
      })
    )

    // Subagent streams text
    const target = emitItemDelta(app, routingId, 'Looking ', {
      ownerToolUseId: subagentToolUseId,
      open: true
    })
    emitItemDelta(app, routingId, 'for files...', {
      ownerToolUseId: subagentToolUseId,
      open: false
    })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.itemStreams[itemStreamKey(target)].value).toBe('Looking for files...')
  })

  it('multiple subagents get independent streaming buckets', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    const targetA = emitItemDelta(app, routingId, 'alpha', {
      ownerToolUseId: 'sub-A',
      open: true
    })
    const targetB = emitItemDelta(app, routingId, 'beta', {
      ownerToolUseId: 'sub-B',
      open: true
    })
    emitItemDelta(app, routingId, '-more', { ownerToolUseId: 'sub-A', open: false })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.itemStreams[itemStreamKey(targetA)].value).toBe('alpha-more')
    expect(session.itemStreams[itemStreamKey(targetB)].value).toBe('beta')
  })

  it('subagent messages land in the correct bucket (subagentMessages)', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    const subagentMsg = makeAssistantMessage('subagent response')
    app.emit('session:subagent-message', routingId, {
      toolUseId: 'sub-X',
      message: subagentMsg
    })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.subagentMessages['sub-X']).toBeDefined()
    expect(session.subagentMessages['sub-X']).toHaveLength(1)
    expect(session.subagentMessages['sub-X'][0].content[0]).toEqual({
      type: 'text',
      text: 'subagent response'
    })
  })

  it('thinking stream for subagent routes independently of text stream', () => {
    const routingId = 'r1'
    useSessionStore.getState().createNewSession(routingId, '/test')

    const target = emitItemDelta(app, routingId, 'pondering...', {
      ownerToolUseId: 'sub-think',
      kind: 'thinking',
      open: true
    })

    const session = useSessionStore.getState().sessions[routingId]
    expect(session.itemStreams[itemStreamKey(target)].value).toBe('pondering...')
    expect(
      Object.values(session.itemStreams).some(
        (stream) => stream.target.ownerToolUseId === 'sub-think' && stream.target.kind === 'text'
      )
    ).toBe(false)
  })
})
