import { create } from 'zustand'
import type { Automation, AutomationRun, ChatMessage, ContentBlock } from '../../../shared/types'

/**
 * Merges content blocks when upserting an assistant message by ID.
 * The SDK sends partial messages that may not include all previously accumulated
 * content blocks. This function preserves tool_use and tool_result blocks from the
 * old message that aren't present in the incoming update.
 * (Mirrors the same logic in session-store.ts)
 */
function mergeContentBlocks(
  oldBlocks: ContentBlock[],
  newBlocks: ContentBlock[]
): ContentBlock[] {
  const newToolUseIds = new Set(
    newBlocks.filter((b) => b.type === 'tool_use' && b.toolUseId).map((b) => b.toolUseId)
  )
  const newToolResultIds = new Set(
    newBlocks.filter((b) => b.type === 'tool_result' && b.toolUseId).map((b) => b.toolUseId)
  )
  const newThinkingCount = newBlocks.filter((b) => b.type === 'thinking').length
  const newHasText = newBlocks.some((b) => b.type === 'text')

  const droppedThinkingCount = Math.max(
    0,
    oldBlocks.filter((b) => b.type === 'thinking').length - newThinkingCount
  )
  let thinkingsSeen = 0
  const preserved: ContentBlock[] = []

  for (const b of oldBlocks) {
    if (b.type === 'tool_use' && b.toolUseId && !newToolUseIds.has(b.toolUseId)) {
      preserved.push(b)
    } else if (b.type === 'tool_result' && b.toolUseId && !newToolResultIds.has(b.toolUseId)) {
      preserved.push(b)
    } else if (b.type === 'thinking') {
      if (thinkingsSeen < droppedThinkingCount) {
        preserved.push(b)
      }
      thinkingsSeen++
    } else if (b.type === 'text' && !newHasText) {
      preserved.push(b)
    }
  }

  return [...preserved, ...newBlocks]
}

interface AutomationState {
  automations: Automation[]
  selectedAutomationId: string | null
  selectedRunId: string | null
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
  runs: {},
  runMessages: null,
  notificationBadge: 0,
  streamingText: '',
  isRunProcessing: false,

  setAutomations: (automations) => set({ automations }),

  selectAutomation: (id) =>
    set({ selectedAutomationId: id, selectedRunId: null, runMessages: null }),

  selectRun: (automationId, runId) =>
    set({ selectedAutomationId: automationId, selectedRunId: runId }),

  clearRunSelection: () =>
    set({ selectedRunId: null, runMessages: null }),

  setRuns: (automationId, runs) =>
    set((s) => ({ runs: { ...s.runs, [automationId]: runs } })),

  updateRun: (automationId, run) =>
    set((s) => {
      const existing = s.runs[automationId] || []
      const idx = existing.findIndex((r) => r.id === run.id)
      const updated = idx >= 0
        ? existing.map((r, i) => (i === idx ? run : r))
        : [run, ...existing]

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

  appendStreamingText: (text) =>
    set((s) => ({ streamingText: s.streamingText + text })),

  clearStreamingText: () => set({ streamingText: '' }),

  setIsRunProcessing: (v) => set({ isRunProcessing: v }),

  incrementBadge: () => set((s) => ({ notificationBadge: s.notificationBadge + 1 })),

  clearBadge: () => set({ notificationBadge: 0 })
}))
