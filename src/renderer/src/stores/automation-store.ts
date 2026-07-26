import { create } from 'zustand'
import type { Automation, AutomationRun, ChatMessage } from '../../../shared/types'
import { mergeContentBlocks } from '../utils/content-blocks'

export type DetailTab = 'configure' | 'runs' | 'permissions'

interface AutomationState {
  automations: Automation[]
  selectedAutomationId: string | null
  selectedRunId: string | null
  detailTab: DetailTab
  runs: Record<string, AutomationRun[]> // automationId → runs
  runMessages: ChatMessage[] | null // loaded for selected run
  notificationBadge: number
  streamingText: string
  isRunProcessing: boolean

  // Actions
  setAutomations: (automations: Automation[]) => void
  selectAutomation: (id: string | null) => void
  selectRun: (automationId: string, runId: string) => void
  clearRunSelection: () => void
  setDetailTab: (tab: DetailTab) => void
  setRuns: (automationId: string, runs: AutomationRun[]) => void
  updateRun: (automationId: string, run: AutomationRun) => void
  setRunMessages: (messages: ChatMessage[] | null) => void
  appendRunMessage: (automationId: string, message: ChatMessage) => void
  appendStreamingText: (text: string) => void
  clearStreamingText: () => void
  setIsRunProcessing: (v: boolean) => void
  incrementBadge: () => void
  clearBadge: () => void
}

export const useAutomationStore = create<AutomationState>((set) => ({
  automations: [],
  selectedAutomationId: null,
  selectedRunId: null,
  detailTab: 'configure',
  runs: {},
  runMessages: null,
  notificationBadge: 0,
  streamingText: '',
  isRunProcessing: false,

  setAutomations: (automations) => set({ automations }),

  selectAutomation: (id) =>
    set({
      selectedAutomationId: id,
      selectedRunId: null,
      runMessages: null,
      detailTab: 'configure'
    }),

  selectRun: (automationId, runId) =>
    set({ selectedAutomationId: automationId, selectedRunId: runId }),

  // Back from a run detail → return to Runs tab so the context stays intact.
  clearRunSelection: () => set({ selectedRunId: null, runMessages: null, detailTab: 'runs' }),

  setDetailTab: (tab) => set({ detailTab: tab }),

  setRuns: (automationId, runs) => set((s) => ({ runs: { ...s.runs, [automationId]: runs } })),

  updateRun: (automationId, run) =>
    set((s) => {
      const existing = s.runs[automationId] || []
      const idx = existing.findIndex((r) => r.id === run.id)
      const updated = idx >= 0 ? existing.map((r, i) => (i === idx ? run : r)) : [run, ...existing]

      // Also update the automation's lastRunAt/lastRunStatus in the list
      const automations = s.automations.map((a) => {
        if (a.id !== automationId) return a
        return {
          ...a,
          lastRunAt: run.startedAt,
          lastRunStatus: run.status === 'running' ? a.lastRunStatus : run.status
        }
      })

      return { runs: { ...s.runs, [automationId]: updated }, automations }
    }),

  setRunMessages: (messages) => set({ runMessages: messages }),

  appendRunMessage: (automationId, message) =>
    set((s) => {
      // Only append if viewing this automation's currently selected run
      if (automationId !== s.selectedAutomationId) return s
      // Don't leak a new run's stream into a DIFFERENT run being viewed. The
      // run-message IPC carries no runId (main-process, out of scope), so we
      // gate on "the selected run is the running run": when a specific
      // (finished/historical) run is selected while another run streams, skip
      // (M-RN1). selectedRunId === null (no specific run) keeps prior behavior.
      const runningRunId = s.runs[automationId]?.find((r) => r.status === 'running')?.id
      if (runningRunId && s.selectedRunId && s.selectedRunId !== runningRunId) return s
      if (!s.runMessages) return { runMessages: [message] }
      // Upsert by id (assistant partial messages share the same id)
      const idx = s.runMessages.findIndex((m) => m.id === message.id)
      if (idx >= 0) {
        const existing = s.runMessages[idx]
        const merged = {
          ...message,
          content: mergeContentBlocks(existing.content, message.content)
        }
        const updated = [...s.runMessages]
        updated[idx] = merged
        return { runMessages: updated }
      }
      return { runMessages: [...s.runMessages, message] }
    }),

  appendStreamingText: (text) => set((s) => ({ streamingText: s.streamingText + text })),

  clearStreamingText: () => set({ streamingText: '' }),

  setIsRunProcessing: (v) => set({ isRunProcessing: v }),

  incrementBadge: () => set((s) => ({ notificationBadge: s.notificationBadge + 1 })),

  clearBadge: () => set({ notificationBadge: 0 })
}))
