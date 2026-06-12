/**
 * Layer 2: Component tests for AskUserQuestionBlock FC.
 *
 * Tested flows:
 *   1. onSubmit → respondApproval('allow', answers) + removePendingApproval
 *   2. onDeny → respondApproval('deny') + removePendingApproval
 *   3. Post-submit, isCompleted flips to true
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { makePendingApproval } from '@test/factories/messages'
import type { AskUserQuestionBlockViewProps } from '../View'
import type { ContentBlock } from '../../../../../../shared/types'

let viewProps: AskUserQuestionBlockViewProps
vi.mock('../View', () => ({
  AskUserQuestionBlockView: (props: AskUserQuestionBlockViewProps) => {
    viewProps = props
    return null
  }
}))

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

function makeBlock(): ToolUseBlock {
  return {
    type: 'tool_use',
    toolUseId: 'tu-1',
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [
        {
          header: 'Color',
          question: 'Pick a color',
          options: [{ label: 'red' }, { label: 'blue' }],
          multiSelect: false
        }
      ]
    }
  } as unknown as ToolUseBlock
}

const ROUTE = 'route-ask'

describe('AskUserQuestionBlock FC', () => {
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
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  async function renderFC(approval = makePendingApproval({ requestId: 'req-1' })): Promise<void> {
    useSessionStore.getState().addPendingApproval(ROUTE, approval)
    const { AskUserQuestionBlock } = await import('../AskUserQuestionBlock')
    await act(async () => {
      render(React.createElement(AskUserQuestionBlock, { block: makeBlock(), approval } as any))
    })
  }

  it('onSubmit calls respondApproval with answers', async () => {
    await renderFC()

    await act(async () => {
      await viewProps.onSubmit({ 'Pick a color': 'red' })
    })

    expect(respondCalls).toHaveLength(1)
    expect(respondCalls[0].decision).toBe('allow')
    expect(respondCalls[0].answers).toEqual({ 'Pick a color': 'red' })
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('onDeny calls respondApproval with deny', async () => {
    await renderFC()

    await act(async () => {
      await viewProps.onDeny()
    })

    expect(respondCalls).toHaveLength(1)
    expect(respondCalls[0].decision).toBe('deny')
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('sets isCompleted=true after submit', async () => {
    await renderFC()
    expect(viewProps.isCompleted).toBe(false)

    await act(async () => {
      await viewProps.onSubmit({ 'Pick a color': 'blue' })
    })

    expect(viewProps.isCompleted).toBe(true)
  })
})
