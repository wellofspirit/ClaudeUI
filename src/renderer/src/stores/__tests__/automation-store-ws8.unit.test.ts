/**
 * WS8 guard test for automation run-message cross-contamination (M-RN1):
 * viewing a historical/finished run of an automation must NOT absorb the
 * messages streamed by a *different*, currently-running run of the same
 * automation. The run-message IPC carries no runId, so appendRunMessage gates
 * on "the selected run is the running run".
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useAutomationStore } from '../automation-store'
import type { AutomationRun, ChatMessage } from '../../../../shared/types'

function makeRun(id: string, status: AutomationRun['status']): AutomationRun {
  return { id, automationId: 'a1', startedAt: 0, finishedAt: null, status, totalCostUsd: 0 }
}

function makeMessage(id: string): ChatMessage {
  return { id, role: 'assistant', content: [{ type: 'text', text: id }], timestamp: 0 }
}

beforeEach(() => {
  useAutomationStore.setState({
    automations: [],
    selectedAutomationId: null,
    selectedRunId: null,
    detailTab: 'configure',
    runs: {},
    runMessages: null,
    notificationBadge: 0,
    streamingText: '',
    isRunProcessing: false
  })
})

describe('appendRunMessage — run isolation (M-RN1)', () => {
  it('does NOT append a running run message into a different, selected historical run', () => {
    useAutomationStore.setState({
      selectedAutomationId: 'a1',
      selectedRunId: 'run-old', // viewing a finished run
      runs: { a1: [makeRun('run-new', 'running'), makeRun('run-old', 'success')] },
      runMessages: []
    })

    useAutomationStore.getState().appendRunMessage('a1', makeMessage('from-new-run'))

    // Pre-fix, this leaked the new run's message into the old run's transcript.
    expect(useAutomationStore.getState().runMessages).toHaveLength(0)
  })

  it('appends when the selected run IS the running run', () => {
    useAutomationStore.setState({
      selectedAutomationId: 'a1',
      selectedRunId: 'run-new',
      runs: { a1: [makeRun('run-new', 'running')] },
      runMessages: []
    })

    useAutomationStore.getState().appendRunMessage('a1', makeMessage('m1'))
    expect(useAutomationStore.getState().runMessages).toHaveLength(1)
  })

  it('still ignores messages for a different automation', () => {
    useAutomationStore.setState({ selectedAutomationId: 'a1', runMessages: [] })
    useAutomationStore.getState().appendRunMessage('a2', makeMessage('m1'))
    expect(useAutomationStore.getState().runMessages).toHaveLength(0)
  })

  it('appends when no specific run is selected (selectedRunId null) — prior behavior', () => {
    useAutomationStore.setState({
      selectedAutomationId: 'a1',
      selectedRunId: null,
      runs: { a1: [makeRun('run-new', 'running')] },
      runMessages: []
    })
    useAutomationStore.getState().appendRunMessage('a1', makeMessage('m1'))
    expect(useAutomationStore.getState().runMessages).toHaveLength(1)
  })
})
