import { describe, it, expect, beforeEach } from 'vitest'
import { useAutomationStore } from '../automation-store'
import type { AutomationRun, ChatMessage, Automation } from '../../../../shared/types'

function makeAutomation(id: string, overrides?: Partial<Automation>): Automation {
  return {
    id,
    name: `Test ${id}`,
    prompt: 'test prompt',
    cwd: '/test',
    enabled: true,
    schedule: { type: 'interval', intervalMs: 60000 },
    ...overrides,
  } as Automation
}

function makeRun(id: string, automationId: string, overrides?: Partial<AutomationRun>): AutomationRun {
  return {
    id,
    automationId,
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    totalCostUsd: 0,
    ...overrides,
  }
}

function makeMessage(id: string, role: 'user' | 'assistant' = 'assistant'): ChatMessage {
  return {
    id,
    role,
    content: [{ type: 'text', text: `Message ${id}` }],
    timestamp: Date.now(),
  }
}

describe('useAutomationStore', () => {
  beforeEach(() => {
    // Reset store state
    useAutomationStore.setState({
      automations: [],
      selectedAutomationId: null,
      selectedRunId: null,
      detailTab: 'configure',
      runs: {},
      runMessages: null,
      notificationBadge: 0,
      streamingText: '',
      isRunProcessing: false,
    })
  })

  describe('setAutomations', () => {
    it('sets the automation list', () => {
      const automations = [makeAutomation('a1'), makeAutomation('a2')]
      useAutomationStore.getState().setAutomations(automations)
      expect(useAutomationStore.getState().automations).toHaveLength(2)
    })
  })

  describe('selectAutomation', () => {
    it('sets selected automation and clears run selection', () => {
      useAutomationStore.setState({ selectedRunId: 'r1', runMessages: [makeMessage('m1')] })
      useAutomationStore.getState().selectAutomation('a1')

      const state = useAutomationStore.getState()
      expect(state.selectedAutomationId).toBe('a1')
      expect(state.selectedRunId).toBeNull()
      expect(state.runMessages).toBeNull()
    })

    it('allows null to deselect', () => {
      useAutomationStore.getState().selectAutomation(null)
      expect(useAutomationStore.getState().selectedAutomationId).toBeNull()
    })

    it('resets detailTab to configure on selection change', () => {
      useAutomationStore.setState({ detailTab: 'runs' })
      useAutomationStore.getState().selectAutomation('a1')
      expect(useAutomationStore.getState().detailTab).toBe('configure')
    })
  })

  describe('updateRun', () => {
    it('inserts a new run', () => {
      const run = makeRun('r1', 'a1')
      useAutomationStore.getState().updateRun('a1', run)

      expect(useAutomationStore.getState().runs['a1']).toHaveLength(1)
      expect(useAutomationStore.getState().runs['a1'][0].id).toBe('r1')
    })

    it('updates an existing run by id', () => {
      const run1 = makeRun('r1', 'a1', { status: 'running' })
      useAutomationStore.getState().updateRun('a1', run1)

      const run1Updated = { ...run1, status: 'success' as const, finishedAt: Date.now() }
      useAutomationStore.getState().updateRun('a1', run1Updated)

      const runs = useAutomationStore.getState().runs['a1']
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('success')
    })

    it('prepends new runs', () => {
      useAutomationStore.getState().updateRun('a1', makeRun('r1', 'a1'))
      useAutomationStore.getState().updateRun('a1', makeRun('r2', 'a1'))

      const runs = useAutomationStore.getState().runs['a1']
      expect(runs).toHaveLength(2)
      expect(runs[0].id).toBe('r2') // newest first
    })

    it('updates automation lastRunAt and lastRunStatus', () => {
      useAutomationStore.setState({
        automations: [makeAutomation('a1')],
      })

      const run = makeRun('r1', 'a1', { status: 'success', startedAt: 12345 })
      useAutomationStore.getState().updateRun('a1', run)

      const auto = useAutomationStore.getState().automations.find(a => a.id === 'a1')
      expect(auto?.lastRunAt).toBe(12345)
      expect(auto?.lastRunStatus).toBe('success')
    })

    it('does not update lastRunStatus for running state', () => {
      useAutomationStore.setState({
        automations: [makeAutomation('a1', { lastRunStatus: 'success' })],
      })

      const run = makeRun('r1', 'a1', { status: 'running' })
      useAutomationStore.getState().updateRun('a1', run)

      const auto = useAutomationStore.getState().automations.find(a => a.id === 'a1')
      expect(auto?.lastRunStatus).toBe('success') // preserved
    })
  })

  describe('appendRunMessage', () => {
    it('appends a new message when viewing the automation', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'a1',
        runMessages: [],
      })

      useAutomationStore.getState().appendRunMessage('a1', makeMessage('m1'))
      expect(useAutomationStore.getState().runMessages).toHaveLength(1)
    })

    it('ignores messages for a different automation', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'a1',
        runMessages: [],
      })

      useAutomationStore.getState().appendRunMessage('a2', makeMessage('m1'))
      expect(useAutomationStore.getState().runMessages).toHaveLength(0)
    })

    it('upserts messages by id (partial updates)', () => {
      const msg1 = makeMessage('m1')
      useAutomationStore.setState({
        selectedAutomationId: 'a1',
        runMessages: [msg1],
      })

      const msg1Updated: ChatMessage = {
        ...msg1,
        content: [{ type: 'text', text: 'Updated text' }],
      }
      useAutomationStore.getState().appendRunMessage('a1', msg1Updated)

      const messages = useAutomationStore.getState().runMessages!
      expect(messages).toHaveLength(1)
      // Content should be merged via mergeContentBlocks
    })

    it('creates runMessages array if null', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'a1',
        runMessages: null,
      })

      useAutomationStore.getState().appendRunMessage('a1', makeMessage('m1'))
      expect(useAutomationStore.getState().runMessages).toHaveLength(1)
    })
  })

  describe('streaming text', () => {
    it('appends streaming text', () => {
      useAutomationStore.getState().appendStreamingText('Hello ')
      useAutomationStore.getState().appendStreamingText('world')
      expect(useAutomationStore.getState().streamingText).toBe('Hello world')
    })

    it('clears streaming text', () => {
      useAutomationStore.setState({ streamingText: 'some text' })
      useAutomationStore.getState().clearStreamingText()
      expect(useAutomationStore.getState().streamingText).toBe('')
    })
  })

  describe('badge', () => {
    it('increments badge', () => {
      useAutomationStore.getState().incrementBadge()
      useAutomationStore.getState().incrementBadge()
      expect(useAutomationStore.getState().notificationBadge).toBe(2)
    })

    it('clears badge', () => {
      useAutomationStore.setState({ notificationBadge: 5 })
      useAutomationStore.getState().clearBadge()
      expect(useAutomationStore.getState().notificationBadge).toBe(0)
    })
  })

  describe('clearRunSelection', () => {
    it('clears run selection and messages', () => {
      useAutomationStore.setState({
        selectedRunId: 'r1',
        runMessages: [makeMessage('m1')],
      })

      useAutomationStore.getState().clearRunSelection()
      const state = useAutomationStore.getState()
      expect(state.selectedRunId).toBeNull()
      expect(state.runMessages).toBeNull()
    })

    it('lands on the Runs tab so the user returns to the list that launched them', () => {
      useAutomationStore.setState({ selectedRunId: 'r1', detailTab: 'configure' })
      useAutomationStore.getState().clearRunSelection()
      expect(useAutomationStore.getState().detailTab).toBe('runs')
    })
  })

  describe('setDetailTab', () => {
    it('swaps the active detail tab', () => {
      useAutomationStore.getState().setDetailTab('runs')
      expect(useAutomationStore.getState().detailTab).toBe('runs')
      useAutomationStore.getState().setDetailTab('permissions')
      expect(useAutomationStore.getState().detailTab).toBe('permissions')
    })
  })
})
