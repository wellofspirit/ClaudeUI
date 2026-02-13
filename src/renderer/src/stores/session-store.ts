import { create } from 'zustand'
import type {
  ChatMessage,
  SessionStatus,
  PendingApproval,
  ContentBlock,
  TodoItem,
  TaskProgress,
  TaskNotification,
  PermissionMode,
  ModelInfo
} from '../../../shared/types'

/**
 * Merges content blocks when upserting an assistant message by ID.
 * The SDK sends partial messages that may not include all previously accumulated
 * content blocks. This function preserves tool_use and tool_result blocks from the
 * old message that aren't present in the incoming update.
 */
function mergeContentBlocks(
  oldBlocks: ContentBlock[],
  newBlocks: ContentBlock[]
): ContentBlock[] {
  // Index what's in the new message
  const newToolUseIds = new Set(
    newBlocks.filter((b) => b.type === 'tool_use' && b.toolUseId).map((b) => b.toolUseId)
  )
  const newToolResultIds = new Set(
    newBlocks.filter((b) => b.type === 'tool_result' && b.toolUseId).map((b) => b.toolUseId)
  )
  const newThinkingCount = newBlocks.filter((b) => b.type === 'thinking').length
  const newHasText = newBlocks.some((b) => b.type === 'text')

  // Collect preserved old blocks in their original order (maintains interleaving)
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

  // Preserved blocks (from earlier turns, in original order) first,
  // then new blocks in their natural interleaved order from the SDK
  return [...preserved, ...newBlocks]
}

const RECENT_DIRS_KEY = 'claudeui-recent-dirs'

function loadRecentDirs(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_DIRS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveRecentDirs(dirs: string[]): void {
  localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs))
}

function addToRecent(dir: string, existing: string[]): string[] {
  const filtered = existing.filter((d) => d !== dir)
  const updated = [dir, ...filtered].slice(0, 20)
  saveRecentDirs(updated)
  return updated
}

interface SessionState {
  cwd: string | null
  recentDirs: string[]
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  thinkingStartedAt: number | null
  thinkingDurationMs: number | null
  status: SessionStatus
  pendingApprovals: PendingApproval[]
  errors: string[]
  todos: TodoItem[]
  taskProgressMap: Record<string, TaskProgress>
  taskNotifications: TaskNotification[]
  openedTaskToolUseIds: string[]
  taskPanelOpen: boolean
  subagentMessages: Record<string, ChatMessage[]>
  subagentStreamingText: Record<string, string>
  subagentStreamingThinking: Record<string, string>
  backgroundOutputs: Record<string, { tail: string; totalSize: number }>
  backgroundWatcherCounts: Record<string, number>
  stoppingTaskIds: string[]
  permissionMode: PermissionMode
  effort: 'low' | 'medium' | 'high'
  availableModels: ModelInfo[]

  setCwd: (cwd: string | null) => void
  openDirectory: (cwd: string) => void
  addMessage: (message: ChatMessage) => void
  addUserMessage: (id: string, text: string, planContent?: string) => void
  appendStreamingText: (text: string) => void
  appendStreamingThinking: (text: string) => void
  clearStreamingText: () => void
  setStatus: (status: SessionStatus) => void
  addPendingApproval: (approval: PendingApproval) => void
  removePendingApproval: (requestId: string) => void
  clearPendingApprovals: () => void
  addError: (error: string) => void
  removeError: (index: number) => void
  clearErrors: () => void
  appendToolResult: (toolUseId: string, result: string, isError: boolean) => void
  setTodos: (todos: TodoItem[]) => void
  updateTaskProgress: (progress: TaskProgress) => void
  addTaskNotification: (notification: TaskNotification) => void
  addSubagentMessage: (toolUseId: string, message: ChatMessage) => void
  appendSubagentStreamingText: (toolUseId: string, text: string) => void
  appendSubagentStreamingThinking: (toolUseId: string, text: string) => void
  appendSubagentToolResult: (toolUseId: string, toolResultToolUseId: string, result: string, isError: boolean) => void
  setBackgroundOutput: (toolUseId: string, tail: string, totalSize: number) => void
  watchBackgroundOutput: (toolUseId: string) => void
  unwatchBackgroundOutput: (toolUseId: string) => void
  openTaskPanel: (toolUseId: string) => void
  closeTaskPanel: () => void
  removeTaskFromPanel: (toolUseId: string) => void
  setTaskStopping: (toolUseId: string) => void
  clearTaskStopping: (toolUseId: string) => void
  setPermissionMode: (mode: PermissionMode) => void
  setEffort: (effort: 'low' | 'medium' | 'high') => void
  setAvailableModels: (models: ModelInfo[]) => void
  clearConversation: () => void
}

export const useSessionStore = create<SessionState>((set) => ({
  cwd: null,
  recentDirs: loadRecentDirs(),
  messages: [],
  streamingText: '',
  streamingThinking: '',
  thinkingStartedAt: null,
  thinkingDurationMs: null,
  status: {
    state: 'idle',
    sessionId: null,
    model: null,
    cwd: null,
    totalCostUsd: 0
  },
  pendingApprovals: [],
  errors: [],
  todos: [],
  taskProgressMap: {},
  taskNotifications: [],
  openedTaskToolUseIds: [],
  taskPanelOpen: false,
  subagentMessages: {},
  subagentStreamingText: {},
  subagentStreamingThinking: {},
  backgroundOutputs: {},
  backgroundWatcherCounts: {},
  stoppingTaskIds: [],
  permissionMode: 'default',
  effort: 'medium',
  availableModels: [],

  setCwd: (cwd) => set({ cwd }),

  openDirectory: (cwd) =>
    set((state) => {
      const alreadyExists = state.recentDirs.includes(cwd)
      const recentDirs = alreadyExists
        ? state.recentDirs
        : [cwd, ...state.recentDirs].slice(0, 20)
      if (!alreadyExists) saveRecentDirs(recentDirs)
      return { cwd, messages: [], streamingText: '', streamingThinking: '', thinkingStartedAt: null, thinkingDurationMs: null, errors: [], pendingApprovals: [], recentDirs, todos: [], taskProgressMap: {}, taskNotifications: [], openedTaskToolUseIds: [], taskPanelOpen: false, subagentMessages: {}, subagentStreamingText: {}, subagentStreamingThinking: {}, backgroundOutputs: {}, backgroundWatcherCounts: {} }
    }),

  addMessage: (message) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === message.id)

      // Finalize thinking if message has non-thinking content (text or tool_use)
      const hasNonThinking = message.content.some(
        (b) => b.type === 'text' || b.type === 'tool_use'
      )
      const thinkingUpdate =
        state.thinkingStartedAt && hasNonThinking
          ? {
              streamingThinking: '',
              thinkingDurationMs: Date.now() - state.thinkingStartedAt,
              thinkingStartedAt: null
            }
          : {}

      if (idx < 0) {
        return { messages: [...state.messages, message], streamingText: '', ...thinkingUpdate }
      }

      // Merge content blocks to preserve tool_use/tool_result from previous partials
      const existing = state.messages[idx]
      const merged = {
        ...message,
        content: mergeContentBlocks(existing.content, message.content)
      }

      return {
        messages: state.messages.map((m, i) => (i === idx ? merged : m)),
        streamingText: '',
        ...thinkingUpdate
      }
    }),

  addUserMessage: (id, text, planContent?) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id,
          role: 'user' as const,
          content: [{ type: 'text' as const, text }],
          timestamp: Date.now(),
          ...(planContent ? { planContent } : {})
        }
      ],
      recentDirs: state.cwd ? addToRecent(state.cwd, state.recentDirs) : state.recentDirs
    })),

  appendStreamingText: (text) =>
    set((state) => {
      // If we were thinking, finalize the thinking duration
      if (state.thinkingStartedAt) {
        return {
          streamingText: state.streamingText + text,
          streamingThinking: '',
          thinkingDurationMs: Date.now() - state.thinkingStartedAt,
          thinkingStartedAt: null
        }
      }
      return { streamingText: state.streamingText + text }
    }),

  appendStreamingThinking: (text) =>
    set((state) => ({
      streamingThinking: state.streamingThinking + text,
      thinkingStartedAt: state.thinkingStartedAt ?? Date.now()
    })),

  clearStreamingText: () =>
    set({ streamingText: '', streamingThinking: '', thinkingStartedAt: null, thinkingDurationMs: null }),

  setStatus: (status) => set({ status }),

  addPendingApproval: (approval) =>
    set((state) => ({ pendingApprovals: [...state.pendingApprovals, approval] })),

  removePendingApproval: (requestId) =>
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.requestId !== requestId)
    })),

  clearPendingApprovals: () => set({ pendingApprovals: [] }),

  addError: (error) => set((state) => ({ errors: [...state.errors, error] })),
  removeError: (index) => set((state) => ({ errors: state.errors.filter((_, i) => i !== index) })),
  clearErrors: () => set({ errors: [] }),

  appendToolResult: (toolUseId, result, isError) =>
    set((state) => {
      const messages = [...state.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'assistant') {
          const hasToolUse = msg.content.some(
            (b: ContentBlock) => b.type === 'tool_use' && b.toolUseId === toolUseId
          )
          if (hasToolUse) {
            messages[i] = {
              ...msg,
              content: [
                ...msg.content,
                { type: 'tool_result', toolUseId, toolResult: result, isError }
              ]
            }
            break
          }
        }
      }
      return { messages }
    }),

  setTodos: (todos) => set({ todos }),

  updateTaskProgress: (progress) =>
    set((state) => ({
      taskProgressMap: { ...state.taskProgressMap, [progress.toolUseId]: progress }
    })),

  addTaskNotification: (notification) =>
    set((state) => {
      // Clear stopping state for this task when notification arrives
      const stoppingTaskIds = notification.toolUseId
        ? state.stoppingTaskIds.filter((id) => id !== notification.toolUseId)
        : state.stoppingTaskIds
      return {
        taskNotifications: [...state.taskNotifications, notification],
        stoppingTaskIds
      }
    }),

  addSubagentMessage: (toolUseId, message) =>
    set((state) => {
      const existing = state.subagentMessages[toolUseId] || []
      const idx = existing.findIndex((m) => m.id === message.id)
      let updated: ChatMessage[]
      if (idx < 0) {
        updated = [...existing, message]
      } else {
        const merged = {
          ...message,
          content: mergeContentBlocks(existing[idx].content, message.content)
        }
        updated = existing.map((m, i) => (i === idx ? merged : m))
      }
      return {
        subagentMessages: { ...state.subagentMessages, [toolUseId]: updated },
        subagentStreamingText: { ...state.subagentStreamingText, [toolUseId]: '' },
        subagentStreamingThinking: { ...state.subagentStreamingThinking, [toolUseId]: '' }
      }
    }),

  appendSubagentStreamingText: (toolUseId, text) =>
    set((state) => ({
      subagentStreamingText: {
        ...state.subagentStreamingText,
        [toolUseId]: (state.subagentStreamingText[toolUseId] || '') + text
      },
      subagentStreamingThinking: {
        ...state.subagentStreamingThinking,
        [toolUseId]: ''
      }
    })),

  appendSubagentStreamingThinking: (toolUseId, text) =>
    set((state) => ({
      subagentStreamingThinking: {
        ...state.subagentStreamingThinking,
        [toolUseId]: (state.subagentStreamingThinking[toolUseId] || '') + text
      }
    })),

  appendSubagentToolResult: (toolUseId, toolResultToolUseId, result, isError) =>
    set((state) => {
      const msgs = state.subagentMessages[toolUseId] || []
      const updated = [...msgs]
      for (let i = updated.length - 1; i >= 0; i--) {
        const msg = updated[i]
        if (msg.role !== 'assistant') continue
        const hasToolUse = msg.content.some(
          (b: ContentBlock) => b.type === 'tool_use' && b.toolUseId === toolResultToolUseId
        )
        if (hasToolUse) {
          updated[i] = {
            ...msg,
            content: [
              ...msg.content,
              { type: 'tool_result', toolUseId: toolResultToolUseId, toolResult: result, isError }
            ]
          }
          break
        }
      }
      return { subagentMessages: { ...state.subagentMessages, [toolUseId]: updated } }
    }),

  setBackgroundOutput: (toolUseId, tail, totalSize) =>
    set((state) => ({
      backgroundOutputs: { ...state.backgroundOutputs, [toolUseId]: { tail, totalSize } }
    })),

  watchBackgroundOutput: (toolUseId) =>
    set((state) => {
      const count = (state.backgroundWatcherCounts[toolUseId] || 0) + 1
      window.api.watchBackground(toolUseId)
      return { backgroundWatcherCounts: { ...state.backgroundWatcherCounts, [toolUseId]: count } }
    }),

  unwatchBackgroundOutput: (toolUseId) =>
    set((state) => {
      const count = (state.backgroundWatcherCounts[toolUseId] || 1) - 1
      if (count <= 0) {
        window.api.unwatchBackground(toolUseId)
        const { [toolUseId]: _, ...restOutputs } = state.backgroundOutputs
        const { [toolUseId]: __, ...restCounts } = state.backgroundWatcherCounts
        return { backgroundOutputs: restOutputs, backgroundWatcherCounts: restCounts }
      }
      return { backgroundWatcherCounts: { ...state.backgroundWatcherCounts, [toolUseId]: count } }
    }),

  openTaskPanel: (toolUseId) =>
    set((state) => ({
      openedTaskToolUseIds: state.openedTaskToolUseIds.includes(toolUseId)
        ? state.openedTaskToolUseIds
        : [...state.openedTaskToolUseIds, toolUseId],
      taskPanelOpen: true
    })),

  closeTaskPanel: () =>
    set({ openedTaskToolUseIds: [], taskPanelOpen: false }),

  removeTaskFromPanel: (toolUseId) =>
    set((state) => {
      const updated = state.openedTaskToolUseIds.filter((id) => id !== toolUseId)
      return { openedTaskToolUseIds: updated, taskPanelOpen: updated.length > 0 }
    }),

  setTaskStopping: (toolUseId) =>
    set((state) => {
      if (state.stoppingTaskIds.includes(toolUseId)) return state
      return { stoppingTaskIds: [...state.stoppingTaskIds, toolUseId] }
    }),

  clearTaskStopping: (toolUseId) =>
    set((state) => ({
      stoppingTaskIds: state.stoppingTaskIds.filter((id) => id !== toolUseId)
    })),

  setPermissionMode: (mode) => set({ permissionMode: mode }),

  setEffort: (effort) => set({ effort }),

  setAvailableModels: (models) => set({ availableModels: models }),

  clearConversation: () =>
    set({
      messages: [],
      streamingText: '',
      streamingThinking: '',
      thinkingStartedAt: null,
      thinkingDurationMs: null,
      errors: [],
      pendingApprovals: [],
      todos: [],
      taskProgressMap: {},
      taskNotifications: [],
      openedTaskToolUseIds: [],
      taskPanelOpen: false,
      subagentMessages: {},
      subagentStreamingText: {},
      subagentStreamingThinking: {},
      backgroundOutputs: {},
      backgroundWatcherCounts: {},
      stoppingTaskIds: []
    })
}))
