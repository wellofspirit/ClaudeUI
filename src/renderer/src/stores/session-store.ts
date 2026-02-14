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
  ModelInfo,
  DirectoryGroup
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

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite'])

/**
 * Scan messages for TaskCreate/TaskUpdate/TodoWrite tool calls and build the
 * final TodoItem[] state. Returns null if no relevant tool calls found.
 */
export function buildTodosFromMessages(messages: ChatMessage[]): TodoItem[] | null {
  const tasks = new Map<string, TodoItem>()
  let hasTaskCalls = false

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || !block.toolName || !TASK_TOOL_NAMES.has(block.toolName)) continue
      const input = block.toolInput || {}

      if (block.toolName === 'TodoWrite') {
        hasTaskCalls = true
        tasks.clear()
        if (Array.isArray(input.todos)) {
          (input.todos as Record<string, unknown>[]).forEach((t, i) => {
            tasks.set(String(i), {
              content: String(t.content || ''),
              status: (t.status as TodoItem['status']) || 'pending',
              activeForm: String(t.activeForm || '')
            })
          })
        }
      } else if (block.toolName === 'TaskCreate') {
        hasTaskCalls = true
        // New batch: if all existing tasks are completed/empty, start fresh
        if (tasks.size > 0) {
          const allDone = Array.from(tasks.values()).every((t) => t.status === 'completed')
          if (allDone) tasks.clear()
        }
        // Extract ID from the tool_result in the same message
        const resultBlock = msg.content.find(
          (b) => b.type === 'tool_result' && b.toolUseId === block.toolUseId
        )
        const idMatch = resultBlock?.toolResult?.match(/Task #(\w+)/)
        const id = idMatch ? idMatch[1] : block.toolUseId || String(tasks.size)
        tasks.set(id, {
          content: String(input.subject || ''),
          status: 'pending',
          activeForm: String(input.activeForm || '')
        })
      } else if (block.toolName === 'TaskUpdate') {
        hasTaskCalls = true
        const id = String(input.taskId || '')
        const existing = tasks.get(id)
        if (existing) {
          if (input.status === 'deleted') {
            tasks.delete(id)
          } else if (input.status) {
            existing.status = input.status as TodoItem['status']
          }
          if (input.subject) existing.content = String(input.subject)
          if (input.activeForm) existing.activeForm = String(input.activeForm)
        }
      }
    }
  }

  if (!hasTaskCalls) return null
  return Array.from(tasks.values())
}

const SETTINGS_KEY = 'claudeui-settings'

export interface AppSettings {
  expandToolCalls: boolean
  hideToolInput: boolean
  expandThinking: boolean
  maxRecentSessions: number
}

const DEFAULT_SETTINGS: AppSettings = {
  expandToolCalls: true,
  hideToolInput: false,
  expandThinking: false,
  maxRecentSessions: 5
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

const CUSTOM_TITLES_KEY = 'claudeui-custom-titles'
const RECENT_SESSIONS_KEY = 'claudeui-recent-sessions'
const PINNED_SESSIONS_KEY = 'claudeui-pinned-sessions'

function loadRecentSessions(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SESSIONS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveRecentSessions(ids: string[]): void {
  localStorage.setItem(RECENT_SESSIONS_KEY, JSON.stringify(ids))
}

function loadPinnedSessions(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_SESSIONS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function savePinnedSessions(ids: string[]): void {
  localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(ids))
}

function loadCustomTitles(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CUSTOM_TITLES_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveCustomTitles(titles: Record<string, string>): void {
  localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify(titles))
}

/** Remove a session from state if it has no messages (empty new session) */
function cleanupEmptySession(
  sessions: Record<string, PerSessionState>,
  recentSessionIds: string[],
  routingId: string | null
): { sessions: Record<string, PerSessionState>; recentSessionIds: string[] } {
  if (!routingId) return { sessions, recentSessionIds }
  const session = sessions[routingId]
  if (!session) return { sessions, recentSessionIds }
  // Only clean up sessions with no messages and no active SDK
  if (session.messages.length > 0 || session.sdkActive) return { sessions, recentSessionIds }
  const { [routingId]: _, ...rest } = sessions
  return {
    sessions: rest,
    recentSessionIds: recentSessionIds.filter((id) => id !== routingId)
  }
}

/** Per-session state — everything that varies between sessions */
export interface PerSessionState {
  cwd: string
  sdkActive: boolean
  isHistorical: boolean
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
  isWatching: boolean
  needsAttention: boolean
  permissionMode: PermissionMode
  effort: 'low' | 'medium' | 'high'
  draftText: string
  selectedModel: string
}

const EMPTY_SESSION_STATE: PerSessionState = {
  cwd: '',
  sdkActive: false,
  isHistorical: false,
  messages: [],
  streamingText: '',
  streamingThinking: '',
  thinkingStartedAt: null,
  thinkingDurationMs: null,
  status: { state: 'idle', sessionId: null, model: null, cwd: null, totalCostUsd: 0 },
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
  isWatching: false,
  needsAttention: false,
  permissionMode: 'default',
  effort: 'medium',
  draftText: '',
  selectedModel: 'default'
}

function createEmptySession(cwd: string): PerSessionState {
  return { ...EMPTY_SESSION_STATE, cwd }
}

/** Helper to update a specific session's state */
function updateSession(
  sessions: Record<string, PerSessionState>,
  routingId: string,
  updater: (s: PerSessionState) => Partial<PerSessionState>
): Record<string, PerSessionState> {
  const session = sessions[routingId]
  if (!session) return sessions
  return { ...sessions, [routingId]: { ...session, ...updater(session) } }
}

interface SessionState {
  // Multi-session
  activeSessionId: string | null
  sessions: Record<string, PerSessionState>

  // Sidebar data
  directories: DirectoryGroup[]
  recentSessionIds: string[]
  pinnedSessionIds: string[]
  customTitles: Record<string, string>

  // Global (not per-session)
  settings: AppSettings
  availableModels: ModelInfo[]

  // Multi-session actions
  showWelcome: () => void
  switchSession: (routingId: string) => void
  createNewSession: (routingId: string, cwd: string) => void
  loadHistoricalSession: (routingId: string, messages: ChatMessage[], cwd: string, taskNotifications?: TaskNotification[]) => void
  markSdkActive: (routingId: string) => void
  markSdkInactive: (routingId: string) => void
  setDirectories: (dirs: DirectoryGroup[]) => void
  addRecentSession: (routingId: string) => void
  removeRecentSession: (routingId: string) => void
  setCustomTitle: (sessionId: string, title: string | null) => void
  pinSession: (routingId: string) => void
  unpinSession: (routingId: string) => void
  reorderPinnedSessions: (ids: string[]) => void

  // Per-session actions (all take routingId)
  addMessage: (routingId: string, message: ChatMessage) => void
  addUserMessage: (routingId: string, id: string, text: string, planContent?: string) => void
  appendStreamingText: (routingId: string, text: string) => void
  appendStreamingThinking: (routingId: string, text: string) => void
  clearStreamingText: (routingId: string) => void
  setStatus: (routingId: string, status: SessionStatus) => void
  addPendingApproval: (routingId: string, approval: PendingApproval) => void
  removePendingApproval: (routingId: string, requestId: string) => void
  clearPendingApprovals: (routingId: string) => void
  addError: (routingId: string, error: string) => void
  removeError: (routingId: string, index: number) => void
  clearErrors: (routingId: string) => void
  appendToolResult: (routingId: string, toolUseId: string, result: string, isError: boolean) => void
  setTodos: (routingId: string, todos: TodoItem[]) => void
  updateTaskProgress: (routingId: string, progress: TaskProgress) => void
  addTaskNotification: (routingId: string, notification: TaskNotification) => void
  addSubagentMessage: (routingId: string, toolUseId: string, message: ChatMessage) => void
  appendSubagentStreamingText: (routingId: string, toolUseId: string, text: string) => void
  appendSubagentStreamingThinking: (routingId: string, toolUseId: string, text: string) => void
  appendSubagentToolResult: (routingId: string, toolUseId: string, toolResultToolUseId: string, result: string, isError: boolean) => void
  setBackgroundOutput: (routingId: string, toolUseId: string, tail: string, totalSize: number) => void
  watchBackgroundOutput: (routingId: string, toolUseId: string) => void
  unwatchBackgroundOutput: (routingId: string, toolUseId: string) => void
  openTaskPanel: (routingId: string, toolUseId: string) => void
  closeTaskPanel: (routingId: string) => void
  removeTaskFromPanel: (routingId: string, toolUseId: string) => void
  setTaskStopping: (routingId: string, toolUseId: string) => void
  clearTaskStopping: (routingId: string, toolUseId: string) => void
  setNeedsAttention: (routingId: string, value: boolean) => void
  setWatching: (routingId: string, watching: boolean) => void
  updateWatchedSession: (routingId: string, messages: ChatMessage[], taskNotifications: TaskNotification[]) => void
  updateSettings: (partial: Partial<AppSettings>) => void
  setPermissionMode: (mode: PermissionMode, routingId?: string) => void
  setEffort: (effort: 'low' | 'medium' | 'high', routingId?: string) => void
  setDraftText: (text: string) => void
  setSelectedModel: (model: string) => void
  setAvailableModels: (models: ModelInfo[]) => void
  clearConversation: (routingId: string) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  activeSessionId: null,
  sessions: {},
  directories: [],
  recentSessionIds: loadRecentSessions(),
  pinnedSessionIds: loadPinnedSessions(),
  customTitles: loadCustomTitles(),
  settings: loadSettings(),
  availableModels: [],

  showWelcome: () =>
    set((state) => {
      const cleaned = cleanupEmptySession(state.sessions, state.recentSessionIds, state.activeSessionId)
      if (cleaned.recentSessionIds !== state.recentSessionIds) saveRecentSessions(cleaned.recentSessionIds)
      return { activeSessionId: null, ...cleaned }
    }),

  switchSession: (routingId) =>
    set((state) => {
      const cleaned = cleanupEmptySession(state.sessions, state.recentSessionIds, state.activeSessionId)
      if (cleaned.recentSessionIds !== state.recentSessionIds) saveRecentSessions(cleaned.recentSessionIds)
      return {
        activeSessionId: routingId,
        sessions: updateSession(cleaned.sessions, routingId, () => ({ needsAttention: false })),
        recentSessionIds: cleaned.recentSessionIds
      }
    }),

  createNewSession: (routingId, cwd) =>
    set((state) => {
      const recentSessionIds = [routingId, ...state.recentSessionIds.filter((id) => id !== routingId)].slice(0, state.settings.maxRecentSessions)
      saveRecentSessions(recentSessionIds)
      return {
        activeSessionId: routingId,
        sessions: { ...state.sessions, [routingId]: createEmptySession(cwd) },
        recentSessionIds
      }
    }),

  loadHistoricalSession: (routingId, messages, cwd, taskNotifications?) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [routingId]: {
          ...createEmptySession(cwd),
          messages,
          isHistorical: true,
          taskNotifications: taskNotifications || []
        }
      }
    })),

  markSdkActive: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ sdkActive: true, isHistorical: false }))
    })),

  markSdkInactive: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ sdkActive: false }))
    })),

  setDirectories: (dirs) => set({ directories: dirs }),

  addRecentSession: (routingId) =>
    set((state) => {
      // Don't add pinned sessions to recents — they have their own section
      if (state.pinnedSessionIds.includes(routingId)) return state
      const recentSessionIds = [routingId, ...state.recentSessionIds.filter((id) => id !== routingId)].slice(0, state.settings.maxRecentSessions)
      saveRecentSessions(recentSessionIds)
      return { recentSessionIds }
    }),

  removeRecentSession: (routingId) =>
    set((state) => {
      const recentSessionIds = state.recentSessionIds.filter((id) => id !== routingId)
      saveRecentSessions(recentSessionIds)
      return { recentSessionIds }
    }),

  setCustomTitle: (sessionId, title) =>
    set((state) => {
      const customTitles = { ...state.customTitles }
      if (title) {
        customTitles[sessionId] = title
      } else {
        delete customTitles[sessionId]
      }
      saveCustomTitles(customTitles)
      return { customTitles }
    }),

  pinSession: (routingId) =>
    set((state) => {
      if (state.pinnedSessionIds.includes(routingId)) return state
      const pinnedSessionIds = [...state.pinnedSessionIds, routingId]
      savePinnedSessions(pinnedSessionIds)
      // Remove from recents to free the slot
      const recentSessionIds = state.recentSessionIds.filter((id) => id !== routingId)
      saveRecentSessions(recentSessionIds)
      return { pinnedSessionIds, recentSessionIds }
    }),

  unpinSession: (routingId) =>
    set((state) => {
      const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== routingId)
      savePinnedSessions(pinnedSessionIds)
      // Add back to recents so it doesn't disappear
      const recentSessionIds = [routingId, ...state.recentSessionIds.filter((id) => id !== routingId)].slice(0, state.settings.maxRecentSessions)
      saveRecentSessions(recentSessionIds)
      return { pinnedSessionIds, recentSessionIds }
    }),

  reorderPinnedSessions: (ids) =>
    set(() => {
      savePinnedSessions(ids)
      return { pinnedSessionIds: ids }
    }),

  addMessage: (routingId, message) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const idx = session.messages.findIndex((m) => m.id === message.id)
      const hasNonThinking = message.content.some(
        (b) => b.type === 'text' || b.type === 'tool_use'
      )
      const thinkingUpdate =
        session.thinkingStartedAt && hasNonThinking
          ? {
              streamingThinking: '',
              thinkingDurationMs: Date.now() - session.thinkingStartedAt,
              thinkingStartedAt: null
            }
          : {}

      let updatedMessages: ChatMessage[]
      if (idx < 0) {
        updatedMessages = [...session.messages, message]
      } else {
        const existing = session.messages[idx]
        const merged = {
          ...message,
          content: mergeContentBlocks(existing.content, message.content)
        }
        updatedMessages = session.messages.map((m, i) => (i === idx ? merged : m))
      }

      return {
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...session,
            messages: updatedMessages,
            streamingText: '',
            ...thinkingUpdate
          }
        }
      }
    }),

  addUserMessage: (routingId, id, text, planContent?) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const recentSessionIds = [routingId, ...state.recentSessionIds.filter((rid) => rid !== routingId)].slice(0, state.settings.maxRecentSessions)
      saveRecentSessions(recentSessionIds)

      return {
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...session,
            messages: [
              ...session.messages,
              {
                id,
                role: 'user' as const,
                content: [{ type: 'text' as const, text }],
                timestamp: Date.now(),
                ...(planContent ? { planContent } : {})
              }
            ]
          }
        },
        recentSessionIds
      }
    }),

  appendStreamingText: (routingId, text) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      if (session.thinkingStartedAt) {
        return {
          sessions: updateSession(state.sessions, routingId, (s) => ({
            streamingText: s.streamingText + text,
            streamingThinking: '',
            thinkingDurationMs: Date.now() - s.thinkingStartedAt!,
            thinkingStartedAt: null
          }))
        }
      }
      return {
        sessions: updateSession(state.sessions, routingId, (s) => ({
          streamingText: s.streamingText + text
        }))
      }
    }),

  appendStreamingThinking: (routingId, text) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        streamingThinking: s.streamingThinking + text,
        thinkingStartedAt: s.thinkingStartedAt ?? Date.now()
      }))
    })),

  clearStreamingText: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        streamingText: '',
        streamingThinking: '',
        thinkingStartedAt: null,
        thinkingDurationMs: null
      }))
    })),

  setStatus: (routingId, status) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ status }))
    })),

  addPendingApproval: (routingId, approval) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        pendingApprovals: [...s.pendingApprovals, approval]
      }))
    })),

  removePendingApproval: (routingId, requestId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        pendingApprovals: s.pendingApprovals.filter((a) => a.requestId !== requestId)
      }))
    })),

  clearPendingApprovals: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ pendingApprovals: [] }))
    })),

  addError: (routingId, error) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        errors: [...s.errors, error]
      }))
    })),

  removeError: (routingId, index) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        errors: s.errors.filter((_, i) => i !== index)
      }))
    })),

  clearErrors: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ errors: [] }))
    })),

  appendToolResult: (routingId, toolUseId, result, isError) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const messages = [...session.messages]
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
      return {
        sessions: { ...state.sessions, [routingId]: { ...session, messages } }
      }
    }),

  setTodos: (routingId, todos) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ todos }))
    })),

  updateTaskProgress: (routingId, progress) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        taskProgressMap: { ...s.taskProgressMap, [progress.toolUseId]: progress }
      }))
    })),

  addTaskNotification: (routingId, notification) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => {
        const stoppingTaskIds = notification.toolUseId
          ? s.stoppingTaskIds.filter((id) => id !== notification.toolUseId)
          : s.stoppingTaskIds
        return {
          taskNotifications: [...s.taskNotifications, notification],
          stoppingTaskIds
        }
      })
    })),

  addSubagentMessage: (routingId, toolUseId, message) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const existing = session.subagentMessages[toolUseId] || []
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
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...session,
            subagentMessages: { ...session.subagentMessages, [toolUseId]: updated },
            subagentStreamingText: { ...session.subagentStreamingText, [toolUseId]: '' },
            subagentStreamingThinking: { ...session.subagentStreamingThinking, [toolUseId]: '' }
          }
        }
      }
    }),

  appendSubagentStreamingText: (routingId, toolUseId, text) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        subagentStreamingText: {
          ...s.subagentStreamingText,
          [toolUseId]: (s.subagentStreamingText[toolUseId] || '') + text
        },
        subagentStreamingThinking: {
          ...s.subagentStreamingThinking,
          [toolUseId]: ''
        }
      }))
    })),

  appendSubagentStreamingThinking: (routingId, toolUseId, text) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        subagentStreamingThinking: {
          ...s.subagentStreamingThinking,
          [toolUseId]: (s.subagentStreamingThinking[toolUseId] || '') + text
        }
      }))
    })),

  appendSubagentToolResult: (routingId, toolUseId, toolResultToolUseId, result, isError) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const msgs = session.subagentMessages[toolUseId] || []
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
      return {
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...session,
            subagentMessages: { ...session.subagentMessages, [toolUseId]: updated }
          }
        }
      }
    }),

  setBackgroundOutput: (routingId, toolUseId, tail, totalSize) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        backgroundOutputs: { ...s.backgroundOutputs, [toolUseId]: { tail, totalSize } }
      }))
    })),

  watchBackgroundOutput: (routingId, toolUseId) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const count = (session.backgroundWatcherCounts[toolUseId] || 0) + 1
      window.api.watchBackground(routingId, toolUseId)
      return {
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...session,
            backgroundWatcherCounts: { ...session.backgroundWatcherCounts, [toolUseId]: count }
          }
        }
      }
    }),

  unwatchBackgroundOutput: (routingId, toolUseId) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const count = (session.backgroundWatcherCounts[toolUseId] || 1) - 1
      if (count <= 0) {
        window.api.unwatchBackground(routingId, toolUseId)
        const { [toolUseId]: _, ...restOutputs } = session.backgroundOutputs
        const { [toolUseId]: __, ...restCounts } = session.backgroundWatcherCounts
        return {
          sessions: {
            ...state.sessions,
            [routingId]: {
              ...session,
              backgroundOutputs: restOutputs,
              backgroundWatcherCounts: restCounts
            }
          }
        }
      }
      return {
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...session,
            backgroundWatcherCounts: { ...session.backgroundWatcherCounts, [toolUseId]: count }
          }
        }
      }
    }),

  openTaskPanel: (routingId, toolUseId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        openedTaskToolUseIds: s.openedTaskToolUseIds.includes(toolUseId)
          ? s.openedTaskToolUseIds
          : [...s.openedTaskToolUseIds, toolUseId],
        taskPanelOpen: true
      }))
    })),

  closeTaskPanel: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        openedTaskToolUseIds: [],
        taskPanelOpen: false
      }))
    })),

  removeTaskFromPanel: (routingId, toolUseId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => {
        const updated = s.openedTaskToolUseIds.filter((id) => id !== toolUseId)
        return { openedTaskToolUseIds: updated, taskPanelOpen: updated.length > 0 }
      })
    })),

  setTaskStopping: (routingId, toolUseId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => {
        if (s.stoppingTaskIds.includes(toolUseId)) return {}
        return { stoppingTaskIds: [...s.stoppingTaskIds, toolUseId] }
      })
    })),

  clearTaskStopping: (routingId, toolUseId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        stoppingTaskIds: s.stoppingTaskIds.filter((id) => id !== toolUseId)
      }))
    })),

  setNeedsAttention: (routingId, value) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ needsAttention: value }))
    })),

  setWatching: (routingId, watching) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ isWatching: watching }))
    })),

  updateWatchedSession: (routingId, messages, taskNotifications) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ messages, taskNotifications }))
    })),

  updateSettings: (partial) =>
    set((state) => {
      const settings = { ...state.settings, ...partial }
      saveSettings(settings)
      return { settings }
    }),

  setPermissionMode: (mode, routingId) =>
    set((state) => {
      const id = routingId ?? state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ permissionMode: mode })) }
    }),

  setEffort: (effort, routingId) =>
    set((state) => {
      const id = routingId ?? state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ effort })) }
    }),

  setDraftText: (text) =>
    set((state) => {
      const id = state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ draftText: text })) }
    }),

  setSelectedModel: (model) =>
    set((state) => {
      const id = state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ selectedModel: model })) }
    }),

  setAvailableModels: (models) => set({ availableModels: models }),

  clearConversation: (routingId) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state
      return {
        sessions: {
          ...state.sessions,
          [routingId]: { ...createEmptySession(session.cwd), sdkActive: session.sdkActive }
        }
      }
    })
}))

/**
 * Selector hook for the active session. Components use this to read per-session
 * state without needing to know the routingId.
 */
export function useActiveSession<T>(selector: (s: PerSessionState) => T): T {
  return useSessionStore((state) => {
    const id = state.activeSessionId
    if (!id || !state.sessions[id]) return selector(EMPTY_SESSION_STATE)
    return selector(state.sessions[id])
  })
}
