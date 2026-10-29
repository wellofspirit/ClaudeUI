/**
 * Layer 3: E2E test — a permission judge's verdict reaches the card it judged.
 *
 * tool_use → `session:tool-review` → the verdict is a block on that message, and
 * an approved verdict raises no approval at all. The whole point of F18 is that
 * a turn a machine consented to leaves a trace: this flow drives the real
 * bridge, the real reducer and the real store projection, so a verdict that is
 * emitted but never bound would fail here rather than only in the reducer unit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useSessionStore } from '../../renderer/src/stores/session-store'
import type { ToolReviewBlock } from '../../shared/types'
import {
  makeChatMessage,
  makeToolUseBlock,
  makeSessionStatus,
  resetFactoryCounter
} from '@test/factories/messages'

let app: TestApp

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

/** The blocks a message carries that are review verdicts. */
function reviewsOn(routingId: string, toolUseId: string): ToolReviewBlock[] {
  const session = useSessionStore.getState().sessions[routingId]
  return session.messages
    .flatMap((m) => m.content)
    .filter((b): b is ToolReviewBlock => b.type === 'tool_review' && b.toolUseId === toolUseId)
}

function seedToolUse(routingId: string, toolUseId: string): void {
  useSessionStore.getState().createNewSession(routingId, '/test')
  app.emit(
    'session:status',
    routingId,
    makeSessionStatus({ state: 'running', sessionId: routingId })
  )
  app.emit(
    'session:message',
    routingId,
    makeChatMessage({
      content: [makeToolUseBlock('Bash', { command: 'bun run build' }, toolUseId)]
    })
  )
}

describe('E2E: auto-mode verdict on the card it judged', () => {
  it('an approved verdict attaches to the tool_use message and raises no approval', () => {
    const routingId = 'r1'
    seedToolUse(routingId, 'tool-1')

    app.emit('session:tool-review', routingId, {
      toolUseId: 'tool-1',
      review: {
        type: 'tool_review',
        toolUseId: 'tool-1',
        reviewId: 'rv-1',
        reviewer: 'auto-mode',
        decision: 'approved',
        rationale: 'Writes only to dist/.'
      }
    })
    app.emit('session:tool-result', routingId, {
      toolUseId: 'tool-1',
      result: 'built in 2.31s',
      isError: false
    })

    expect(reviewsOn(routingId, 'tool-1')).toEqual([
      {
        type: 'tool_review',
        toolUseId: 'tool-1',
        reviewId: 'rv-1',
        reviewer: 'auto-mode',
        decision: 'approved',
        rationale: 'Writes only to dist/.'
      }
    ])
    expect(useSessionStore.getState().sessions[routingId].pendingApprovals).toHaveLength(0)
  })

  it('a verdict for a tool_use nobody holds is dropped, not parked', () => {
    const routingId = 'r1'
    seedToolUse(routingId, 'tool-3')

    app.emit('session:tool-review', routingId, {
      toolUseId: 'nobody',
      review: {
        type: 'tool_review',
        toolUseId: 'nobody',
        reviewId: 'rv-3',
        reviewer: 'auto-mode',
        decision: 'denied'
      }
    })

    const blocks = useSessionStore.getState().sessions[routingId].messages.flatMap((m) => m.content)
    expect(blocks.some((b) => b.type === 'tool_review')).toBe(false)
  })
})
