/**
 * Layer 2: Component tests for PlanReviewPanel FC.
 *
 * Tested flows:
 *   1. renders empty div when no planReview
 *   2. onSaveComment → addPlanComment store action
 *   3. onUpdateComment → updatePlanComment
 *   4. onRemoveComment → removePlanComment
 *   5. onClose → closePlanPanel
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { PlanReviewPanelViewProps } from '../View'
import type { PlanComment } from '../../../../../../shared/types'

let viewProps: PlanReviewPanelViewProps | null = null
vi.mock('../View', () => ({
  PlanReviewPanelView: (props: PlanReviewPanelViewProps) => {
    viewProps = props
    return null
  }
}))

const ROUTE = 'route-plan'

function makeComment(overrides: Partial<PlanComment> = {}): PlanComment {
  return {
    id: 'c1',
    selectedText: 'foo',
    comment: 'comment text',
    lineNumber: 0,
    endLineNumber: 0,
    sectionIndex: 0,
    createdAt: Date.now(),
    ...overrides
  } as PlanComment
}

describe('PlanReviewPanel FC', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    viewProps = null
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore
      .getState()
      .openPlanPanel(ROUTE, 'some plan content\n\nsecond paragraph', 'req-1')
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  async function renderFC(): Promise<void> {
    const { PlanReviewPanel } = await import('../PlanReviewPanel')
    await act(async () => {
      render(React.createElement(PlanReviewPanel))
    })
  }

  it('renders an empty div when there is no plan review', async () => {
    useSessionStore.getState().closePlanPanel(ROUTE)

    const { container } = render(
      React.createElement((await import('../PlanReviewPanel')).PlanReviewPanel)
    )

    expect(container.firstChild?.nodeName).toBe('DIV')
    expect(viewProps).toBeNull()
  })

  it('onSaveComment adds the comment via store action', async () => {
    await renderFC()
    expect(viewProps).not.toBeNull()

    act(() => {
      viewProps!.onSaveComment(makeComment())
    })

    expect(useSessionStore.getState().sessions[ROUTE].planReview?.comments).toHaveLength(1)
  })

  it('onUpdateComment updates an existing comment', async () => {
    useSessionStore.getState().addPlanComment(ROUTE, makeComment({ id: 'c1' }))
    await renderFC()

    act(() => {
      viewProps!.onUpdateComment('c1', 'updated text')
    })

    const comment = useSessionStore
      .getState()
      .sessions[ROUTE].planReview?.comments.find((c) => c.id === 'c1')
    expect(comment?.comment).toBe('updated text')
  })

  it('onRemoveComment removes the comment', async () => {
    useSessionStore.getState().addPlanComment(ROUTE, makeComment({ id: 'c1' }))
    await renderFC()

    act(() => {
      viewProps!.onRemoveComment('c1')
    })

    expect(useSessionStore.getState().sessions[ROUTE].planReview?.comments).toHaveLength(0)
  })

  it('onClose closes the plan panel', async () => {
    await renderFC()

    act(() => {
      viewProps!.onClose()
    })

    expect(useSessionStore.getState().sessions[ROUTE].planReview).toBeNull()
  })
})
