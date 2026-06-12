/**
 * Layer 2: Component tests for PlanReviewBar FC.
 *
 * Tested flows:
 *   1. onSend composes feedback and calls respondApproval('deny') + closes panel
 *   2. onSend is a no-op when no comments
 *   3. onSend is a no-op when approval is no longer pending
 *   4. Ctrl/Cmd+Shift+Enter triggers onSend
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { makePendingApproval } from '@test/factories/messages'
import type { PlanReviewBarViewProps } from '../View'
import type { PlanComment } from '../../../../../../shared/types'

let viewProps: PlanReviewBarViewProps
vi.mock('../View', () => ({
  PlanReviewBarView: (props: PlanReviewBarViewProps) => {
    viewProps = props
    return null
  }
}))

const ROUTE = 'route-plan-bar'

function makeComment(overrides: Partial<PlanComment> = {}): PlanComment {
  return {
    id: 'c1',
    selectedText: 'foo',
    comment: 'please change this',
    lineNumber: 1,
    endLineNumber: 1,
    sectionIndex: 0,
    createdAt: Date.now(),
    ...overrides
  } as PlanComment
}

describe('PlanReviewBar FC', () => {
  let app: TestApp
  let respondCalls: Array<{ decision: string; answers: unknown }>

  beforeEach(async () => {
    app = await bootTestApp()
    respondCalls = []

    app.bridge.ipcMain.handle(
      'session:approval-response',
      async (_e, _rid: string, _reqId: string, decision: string, answers: unknown) => {
        respondCalls.push({ decision, answers })
      }
    )

    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().openPlanPanel(ROUTE, 'plan', 'req-1')
    // Put the approval in pendingApprovals so approvalStillPending=true
    useSessionStore
      .getState()
      .addPendingApproval(ROUTE, makePendingApproval({ requestId: 'req-1' }))
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  async function renderFC(comments: PlanComment[]): Promise<void> {
    const { PlanReviewBar } = await import('../PlanReviewBar')
    await act(async () => {
      render(React.createElement(PlanReviewBar, { comments }))
    })
  }

  it('onSend composes feedback and denies the approval', async () => {
    await renderFC([makeComment()])

    await act(async () => {
      await viewProps.onSend()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(respondCalls).toHaveLength(1)
    expect(respondCalls[0].decision).toBe('deny')
    expect((respondCalls[0].answers as any).feedback).toContain('Comment:')
    expect(useSessionStore.getState().sessions[ROUTE].planReview).toBeNull()
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('onSend is a no-op when there are no comments', async () => {
    await renderFC([])

    await act(async () => {
      await viewProps.onSend()
    })

    expect(respondCalls).toHaveLength(0)
  })

  it('onSend is a no-op when the approval is no longer pending', async () => {
    useSessionStore.getState().removePendingApproval(ROUTE, 'req-1')
    await renderFC([makeComment()])

    await act(async () => {
      await viewProps.onSend()
    })

    expect(respondCalls).toHaveLength(0)
    expect(viewProps.approvalStillPending).toBe(false)
  })

  it('Ctrl+Shift+Enter triggers send', async () => {
    await renderFC([makeComment()])

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, ctrlKey: true })
      )
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(respondCalls).toHaveLength(1)
  })
})
