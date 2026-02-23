import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
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
  DirectoryGroup,
  StatusLineData,
  SlashCommandInfo,
  TeammateInfo,
  GitStatusData,
  GitBranchData,
  DiffComment,
  AccountUsage,
  BlockUsageData,
  TerminalTab
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

export type ThemeId = 'dark' | 'light' | 'monokai'

export interface AppSettings {
  theme: ThemeId
  expandToolCalls: boolean
  expandReadResults: boolean
  hideToolInput: boolean
  expandThinking: boolean
  diffViewSplit: boolean
  diffIgnoreWhitespace: boolean
  diffWrapLines: boolean
  chatWidthMode: 'px' | 'percent'
  chatWidthPx: number
  chatWidthPercent: number
  maxRecentSessions: number
  chatFontScale: number
  uiFontScale: number
  statusLineAlign: 'left' | 'center' | 'right'
  statusLineTemplate: string
  gitPanelLayout: 'single' | 'double'
  gitCommitMode: 'commit' | 'commit-push'
  usageRefreshSecs: number
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  expandToolCalls: true,
  expandReadResults: false,
  hideToolInput: false,
  expandThinking: false,
  diffViewSplit: false,
  diffIgnoreWhitespace: false,
  diffWrapLines: false,
  chatWidthMode: 'percent',
  chatWidthPx: 740,
  chatWidthPercent: 80,
  maxRecentSessions: 5,
  chatFontScale: 1,
  uiFontScale: 1,
  statusLineAlign: 'center',
  statusLineTemplate: 'In: {in} / Out: {out} / Total: {total} · {used}% context used',
  gitPanelLayout: 'single',
  gitCommitMode: 'commit' as const,
  usageRefreshSecs: 120
}

export function applyTheme(theme: ThemeId): void {
  if (theme === 'dark') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
}

// ---------------------------------------------------------------------------
// Persistent config via ~/.claude/ui/ (through main-process IPC)
// ---------------------------------------------------------------------------

/**
 * Persist settings to disk. Must be passed the actual data to save — never
 * re-read from getState() because callers may be inside a set() callback
 * where the store hasn't committed yet.
 */
function saveSettings(settings: AppSettings): void {
  window.api.saveSettings(settings as unknown as Record<string, unknown>)
}

function saveSessionConfig(recentSessionIds: string[], pinnedSessionIds: string[], customTitles: Record<string, string>): void {
  window.api.saveSessionConfig({
    recentSessions: recentSessionIds,
    pinnedSessions: pinnedSessionIds,
    customTitles: customTitles
  })
}

/**
 * Hydrate the store from ~/.claude/ui/ config files.
 * Called once at startup; migrates from localStorage on first run.
 */
export async function hydrateConfigFromDisk(): Promise<void> {
  let [savedSettings, sessionConfig, slashCommands] = await Promise.all([
    window.api.loadSettings(),
    window.api.loadSessionConfig(),
    window.api.loadSlashCommands()
  ])

  // One-time migration from localStorage → disk
  const MIGRATION_FLAG = 'claudeui-migrated-to-disk'
  if (!localStorage.getItem(MIGRATION_FLAG)) {
    const migratedSettings = tryParseLocalStorage<Record<string, unknown>>('claudeui-settings')
    const migratedRecent = tryParseLocalStorage<string[]>('claudeui-recent-sessions')
    const migratedPinned = tryParseLocalStorage<string[]>('claudeui-pinned-sessions')
    const migratedTitles = tryParseLocalStorage<Record<string, string>>('claudeui-custom-titles')

    if (migratedSettings) {
      savedSettings = migratedSettings
      await window.api.saveSettings(savedSettings)
    }
    if (migratedRecent || migratedPinned || migratedTitles) {
      sessionConfig = {
        recentSessions: migratedRecent ?? sessionConfig.recentSessions,
        pinnedSessions: migratedPinned ?? sessionConfig.pinnedSessions,
        customTitles: migratedTitles ?? sessionConfig.customTitles
      }
      await window.api.saveSessionConfig(sessionConfig)
    }
    localStorage.setItem(MIGRATION_FLAG, '1')
  }

  const settings: AppSettings = Object.keys(savedSettings).length > 0
    ? { ...DEFAULT_SETTINGS, ...(savedSettings as Partial<AppSettings>) }
    : DEFAULT_SETTINGS

  applyTheme(settings.theme)

  useSessionStore.setState({
    settings,
    recentSessionIds: sessionConfig.recentSessions ?? [],
    pinnedSessionIds: sessionConfig.pinnedSessions ?? [],
    customTitles: sessionConfig.customTitles ?? {},
    slashCommands: slashCommands ?? []
  })
}

function tryParseLocalStorage<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
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
  if (session.messages.length > 0 || session.sdkActive || session.draftText) return { sessions, recentSessionIds }
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
  rightPanel: 'none' | 'task' | 'git'
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
  statusLine: StatusLineData | null
  queuedText: string
  queuedMessageUuid: string
  draftText: string
  selectedModel: string
  teamName: string | null
  teammates: Record<string, TeammateInfo>  // keyed by toolUseId
  focusedAgentId: string | null            // null = main agent
  // Git state
  isGitRepo: boolean
  gitStatus: GitStatusData | null
  gitBranches: GitBranchData | null
  gitSelectedFile: string | null
  gitFileDiff: { patch: string; oldContent?: string; newContent?: string } | null
  gitCommitMessage: string
  gitFileFilter: 'staged' | 'unstaged' | 'all'
  gitReviewComments: DiffComment[]
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
  rightPanel: 'none',
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
  statusLine: null,
  queuedText: '',
  queuedMessageUuid: '',
  draftText: '',
  selectedModel: 'default',
  teamName: null,
  teammates: {},
  focusedAgentId: null,
  isGitRepo: false,
  gitStatus: null,
  gitBranches: null,
  gitSelectedFile: null,
  gitFileDiff: null,
  gitCommitMessage: '',
  gitFileFilter: 'all',
  gitReviewComments: []
}

function createEmptySession(cwd: string): PerSessionState {
  const cached = cwd ? gitStatusCache.get(cwd) : undefined
  return {
    ...EMPTY_SESSION_STATE,
    cwd,
    ...(cached ? { isGitRepo: true, gitStatus: cached } : {})
  }
}

/**
 * Maps old (pre-rekey) routingIds → new (SDK session) IDs.
 * When the store rekeys a session, the main process may still send events
 * with the old routingId until it processes the rekey IPC round-trip.
 * This map lets setStatusLine (and potentially other handlers) resolve them.
 */
const rekeyMap = new Map<string, string>()

/**
 * Global git status cache keyed by cwd.
 * When polling updates arrive they're cached here so that newly-loaded
 * or switched-to sessions with the same cwd get instant git status
 * instead of waiting for the next poll cycle.
 */
const gitStatusCache = new Map<string, GitStatusData>()

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

/**
 * Ensure a session exists for this routingId, creating an empty one if needed.
 * Used by team-related actions so the teams-view window (separate renderer with
 * its own empty store) can bootstrap from incoming IPC events.
 */
function ensureSession(
  sessions: Record<string, PerSessionState>,
  routingId: string
): Record<string, PerSessionState> {
  if (sessions[routingId]) return sessions
  return { ...sessions, [routingId]: createEmptySession('') }
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
  slashCommands: SlashCommandInfo[]
  accountUsage: AccountUsage | null
  blockUsage: BlockUsageData | null
  showUsageView: boolean

  // Terminal panel (global, survives session switching)
  terminalTabs: TerminalTab[]
  activeTerminalId: string | null
  terminalPanelOpen: boolean
  terminalPanelHeight: number

  // Multi-session actions
  showWelcome: () => void
  switchSession: (routingId: string) => void
  createNewSession: (routingId: string, cwd: string) => void
  loadHistoricalSession: (routingId: string, messages: ChatMessage[], cwd: string, taskNotifications?: TaskNotification[], subagentMessages?: Record<string, ChatMessage[]>, statusLine?: StatusLineData | null) => void
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
  addUserMessage: (routingId: string, id: string, text: string, planContent?: string, attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>) => void
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
  bulkSetSubagentMessages: (routingId: string, subagentMessages: Record<string, ChatMessage[]>) => void
  addSubagentMessage: (routingId: string, toolUseId: string, message: ChatMessage) => void
  appendSubagentMessageBatch: (routingId: string, toolUseId: string, messages: ChatMessage[]) => void
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
  applyExternalSettings: (settings: Record<string, unknown>) => void
  applyExternalSessionConfig: (config: { recentSessions?: string[]; pinnedSessions?: string[]; customTitles?: Record<string, string> }) => void
  setPermissionMode: (mode: PermissionMode, routingId?: string) => void
  setEffort: (effort: 'low' | 'medium' | 'high', routingId?: string) => void
  setStatusLine: (routingId: string, data: StatusLineData) => void
  appendQueuedText: (text: string, uuid: string) => void
  clearQueuedText: () => void
  setDraftText: (text: string) => void
  setSelectedModel: (model: string) => void
  setSlashCommands: (commands: SlashCommandInfo[]) => void
  setAvailableModels: (models: ModelInfo[]) => void
  rekeySession: (oldId: string, newId: string) => void
  clearConversation: (routingId: string) => void
  setTeamName: (routingId: string, teamName: string) => void
  clearTeam: (routingId: string) => void
  addTeammate: (routingId: string, info: TeammateInfo) => void
  updateTeammateStatus: (routingId: string, toolUseId: string, status: TeammateInfo['status']) => void
  setFocusedAgent: (routingId: string, toolUseId: string | null) => void
  addTeammateUserMessage: (routingId: string, toolUseId: string, id: string, text: string) => void
  // Git actions
  setIsGitRepo: (routingId: string, value: boolean) => void
  setGitStatus: (routingId: string, status: GitStatusData) => void
  setGitBranches: (routingId: string, branches: GitBranchData) => void
  setGitSelectedFile: (routingId: string, filePath: string | null) => void
  setGitFileDiff: (routingId: string, diff: { patch: string; oldContent?: string; newContent?: string } | null) => void
  setGitCommitMessage: (routingId: string, message: string) => void
  setGitFileFilter: (routingId: string, filter: 'staged' | 'unstaged' | 'all') => void
  selectNextGitFile: (routingId: string) => void
  openGitPanel: (routingId: string) => void
  closeGitPanel: (routingId: string) => void
  // Account usage
  setAccountUsage: (data: AccountUsage) => void
  // Block usage analytics
  setBlockUsage: (data: BlockUsageData) => void
  setShowUsageView: (show: boolean) => void
  // Diff review comments
  addDiffComment: (routingId: string, comment: DiffComment) => void
  removeDiffComment: (routingId: string, commentId: string) => void
  clearDiffComments: (routingId: string) => void
  // Terminal actions
  addTerminalTab: (tab: TerminalTab) => void
  closeTerminalTab: (id: string) => void
  removeTerminalTab: (id: string) => void
  setActiveTerminal: (id: string) => void
  setTerminalPanelOpen: (open: boolean) => void
  setTerminalPanelHeight: (height: number) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  activeSessionId: null,
  sessions: {},
  directories: [],
  recentSessionIds: [],
  pinnedSessionIds: [],
  customTitles: {},
  settings: DEFAULT_SETTINGS,
  availableModels: [],
  slashCommands: [],
  accountUsage: null,
  blockUsage: null,
  showUsageView: false,
  terminalTabs: [],
  activeTerminalId: null,
  terminalPanelOpen: false,
  terminalPanelHeight: Number(localStorage.getItem('terminalPanelHeight')) || 280,

  showWelcome: () =>
    set((state) => {
      const cleaned = cleanupEmptySession(state.sessions, state.recentSessionIds, state.activeSessionId)
      if (cleaned.recentSessionIds !== state.recentSessionIds) {
        saveSessionConfig(cleaned.recentSessionIds, state.pinnedSessionIds, state.customTitles)
      }
      return { activeSessionId: null, ...cleaned }
    }),

  switchSession: (routingId) =>
    set((state) => {
      const cleaned = cleanupEmptySession(state.sessions, state.recentSessionIds, state.activeSessionId)
      if (cleaned.recentSessionIds !== state.recentSessionIds) {
        saveSessionConfig(cleaned.recentSessionIds, state.pinnedSessionIds, state.customTitles)
      }
      return {
        activeSessionId: routingId,
        sessions: updateSession(cleaned.sessions, routingId, () => ({ needsAttention: false })),
        recentSessionIds: cleaned.recentSessionIds
      }
    }),

  createNewSession: (routingId, cwd) =>
    set((state) => {
      const recentSessionIds = [routingId, ...state.recentSessionIds.filter((id) => id !== routingId)].slice(0, state.settings.maxRecentSessions)
      saveSessionConfig(recentSessionIds, state.pinnedSessionIds, state.customTitles)
      return {
        activeSessionId: routingId,
        sessions: { ...state.sessions, [routingId]: createEmptySession(cwd) },
        recentSessionIds
      }
    }),

  loadHistoricalSession: (routingId, messages, cwd, taskNotifications?, subagentMessages?, statusLine?) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [routingId]: {
          ...createEmptySession(cwd),
          messages,
          isHistorical: true,
          taskNotifications: taskNotifications || [],
          subagentMessages: subagentMessages || {},
          statusLine: statusLine ?? null
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
      saveSessionConfig(recentSessionIds, state.pinnedSessionIds, state.customTitles)
      return { recentSessionIds }
    }),

  removeRecentSession: (routingId) =>
    set((state) => {
      const recentSessionIds = state.recentSessionIds.filter((id) => id !== routingId)
      saveSessionConfig(recentSessionIds, state.pinnedSessionIds, state.customTitles)
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
      saveSessionConfig(state.recentSessionIds, state.pinnedSessionIds, customTitles)
      return { customTitles }
    }),

  pinSession: (routingId) =>
    set((state) => {
      if (state.pinnedSessionIds.includes(routingId)) return state
      const pinnedSessionIds = [...state.pinnedSessionIds, routingId]
      const recentSessionIds = state.recentSessionIds.filter((id) => id !== routingId)
      saveSessionConfig(recentSessionIds, pinnedSessionIds, state.customTitles)
      return { pinnedSessionIds, recentSessionIds }
    }),

  unpinSession: (routingId) =>
    set((state) => {
      const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== routingId)
      const recentSessionIds = [routingId, ...state.recentSessionIds.filter((id) => id !== routingId)].slice(0, state.settings.maxRecentSessions)
      saveSessionConfig(recentSessionIds, pinnedSessionIds, state.customTitles)
      return { pinnedSessionIds, recentSessionIds }
    }),

  reorderPinnedSessions: (ids) =>
    set((state) => {
      saveSessionConfig(state.recentSessionIds, ids, state.customTitles)
      return { pinnedSessionIds: ids }
    }),

  addMessage: (routingId, message) =>
    set((state) => {
      const sessions = ensureSession(state.sessions, routingId)
      const session = sessions[routingId]

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
          ...sessions,
          [routingId]: {
            ...session,
            messages: updatedMessages,
            streamingText: '',
            ...thinkingUpdate
          }
        }
      }
    }),

  addUserMessage: (routingId, id, text, planContent?, attachments?) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const recentSessionIds = [routingId, ...state.recentSessionIds.filter((rid) => rid !== routingId)].slice(0, state.settings.maxRecentSessions)
      saveSessionConfig(recentSessionIds, state.pinnedSessionIds, state.customTitles)

      const content: ContentBlock[] = []
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          const blockType = att.mediaType === 'application/pdf' ? 'document' as const : 'image' as const
          content.push({ type: blockType, mediaType: att.mediaType as ContentBlock['mediaType'], base64Data: att.base64Data, fileName: att.fileName })
        }
      }
      if (text) {
        content.push({ type: 'text' as const, text })
      }

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
                content,
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
      const sessions = ensureSession(state.sessions, routingId)
      const session = sessions[routingId]

      if (session.thinkingStartedAt) {
        return {
          sessions: updateSession(sessions, routingId, (s) => ({
            streamingText: s.streamingText + text,
            streamingThinking: '',
            thinkingDurationMs: Date.now() - s.thinkingStartedAt!,
            thinkingStartedAt: null
          }))
        }
      }
      return {
        sessions: updateSession(sessions, routingId, (s) => ({
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

  bulkSetSubagentMessages: (routingId, subagentMessages) =>
    set((state) => {
      const sessions = ensureSession(state.sessions, routingId)
      return {
        sessions: updateSession(sessions, routingId, (s) => ({
          subagentMessages: { ...s.subagentMessages, ...subagentMessages }
        }))
      }
    }),

  addSubagentMessage: (routingId, toolUseId, message) =>
    set((state) => {
      const sessions = ensureSession(state.sessions, routingId)
      const session = sessions[routingId]

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
          ...sessions,
          [routingId]: {
            ...session,
            subagentMessages: { ...session.subagentMessages, [toolUseId]: updated },
            subagentStreamingText: { ...session.subagentStreamingText, [toolUseId]: '' },
            subagentStreamingThinking: { ...session.subagentStreamingThinking, [toolUseId]: '' }
          }
        }
      }
    }),

  appendSubagentMessageBatch: (routingId, toolUseId, messages) =>
    set((state) => {
      const sessions = ensureSession(state.sessions, routingId)
      const session = sessions[routingId]
      let current = [...(session.subagentMessages[toolUseId] || [])]

      for (const message of messages) {
        const idx = current.findIndex((m) => m.id === message.id)
        if (idx < 0) {
          current.push(message)
        } else {
          current[idx] = {
            ...message,
            content: mergeContentBlocks(current[idx].content, message.content)
          }
        }
      }

      return {
        sessions: {
          ...sessions,
          [routingId]: {
            ...session,
            subagentMessages: { ...session.subagentMessages, [toolUseId]: current },
            subagentStreamingText: { ...session.subagentStreamingText, [toolUseId]: '' },
            subagentStreamingThinking: { ...session.subagentStreamingThinking, [toolUseId]: '' }
          }
        }
      }
    }),

  appendSubagentStreamingText: (routingId, toolUseId, text) =>
    set((state) => {
      const sessions = ensureSession(state.sessions, routingId)
      return {
        sessions: updateSession(sessions, routingId, (s) => ({
          subagentStreamingText: {
            ...s.subagentStreamingText,
            [toolUseId]: (s.subagentStreamingText[toolUseId] || '') + text
          },
          subagentStreamingThinking: {
            ...s.subagentStreamingThinking,
            [toolUseId]: ''
          }
        }))
      }
    }),

  appendSubagentStreamingThinking: (routingId, toolUseId, text) =>
    set((state) => {
      const sessions = ensureSession(state.sessions, routingId)
      return {
        sessions: updateSession(sessions, routingId, (s) => ({
          subagentStreamingThinking: {
            ...s.subagentStreamingThinking,
            [toolUseId]: (s.subagentStreamingThinking[toolUseId] || '') + text
          }
        }))
      }
    }),

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
        rightPanel: 'task' as const
      }))
    })),

  closeTaskPanel: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        openedTaskToolUseIds: [],
        rightPanel: 'none' as const
      }))
    })),

  removeTaskFromPanel: (routingId, toolUseId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => {
        const updated = s.openedTaskToolUseIds.filter((id) => id !== toolUseId)
        return { openedTaskToolUseIds: updated, rightPanel: updated.length > 0 ? 'task' as const : 'none' as const }
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
      if (partial.theme) applyTheme(partial.theme)
      return { settings }
    }),

  // Apply settings from an external source (another instance) — no save back to disk
  applyExternalSettings: (raw) =>
    set(() => {
      const settings = { ...DEFAULT_SETTINGS, ...(raw as Partial<AppSettings>) }
      applyTheme(settings.theme)
      return { settings }
    }),

  // Apply session config from an external source — no save back to disk
  applyExternalSessionConfig: (config) =>
    set(() => ({
      recentSessionIds: config.recentSessions ?? [],
      pinnedSessionIds: config.pinnedSessions ?? [],
      customTitles: config.customTitles ?? {}
    })),

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

  setStatusLine: (routingId, data) =>
    set((state) => {
      // Direct match — fast path
      if (state.sessions[routingId]) {
        return { sessions: updateSession(state.sessions, routingId, () => ({ statusLine: data })) }
      }
      // Fallback: the routingId may be a pre-rekey client ID. After the store
      // rekeys (session:status triggers rekeySession), subsequent events from
      // the main process may still carry the old routingId until the main
      // process processes the rekey IPC round-trip. Use the rekey map.
      const newId = rekeyMap.get(routingId)
      if (newId && state.sessions[newId]) {
        return { sessions: updateSession(state.sessions, newId, () => ({ statusLine: data })) }
      }
      return {}
    }),

  appendQueuedText: (text, uuid) =>
    set((state) => {
      const id = state.activeSessionId
      if (!id) return {}
      return {
        sessions: updateSession(state.sessions, id, () => ({
          queuedText: text,
          queuedMessageUuid: uuid
        }))
      }
    }),

  clearQueuedText: () =>
    set((state) => {
      const id = state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ queuedText: '', queuedMessageUuid: '' })) }
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

  setSlashCommands: (commands) => set({ slashCommands: commands }),

  setAvailableModels: (models) => set({ availableModels: models }),

  setAccountUsage: (data) => set({ accountUsage: data }),
  setBlockUsage: (data) => set({ blockUsage: data }),
  setShowUsageView: (show) => set({ showUsageView: show }),

  rekeySession: (oldId, newId) => {
    // Record the mapping so events arriving with the old routingId can be resolved
    rekeyMap.set(oldId, newId)
    set((state) => {
      if (oldId === newId) return state
      const session = state.sessions[oldId]
      if (!session) return state
      const { [oldId]: _, ...rest } = state.sessions
      const sessions = { ...rest, [newId]: session }
      const activeSessionId = state.activeSessionId === oldId ? newId : state.activeSessionId
      const recentSessionIds = state.recentSessionIds.map((id) => (id === oldId ? newId : id))
      const pinnedSessionIds = state.pinnedSessionIds.map((id) => (id === oldId ? newId : id))
      const customTitles = { ...state.customTitles }
      if (customTitles[oldId]) {
        customTitles[newId] = customTitles[oldId]
        delete customTitles[oldId]
      }
      saveSessionConfig(recentSessionIds, pinnedSessionIds, customTitles)
      return { sessions, activeSessionId, recentSessionIds, pinnedSessionIds, customTitles }
    })
  },

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
    }),

  setTeamName: (routingId, teamName) =>
    set((state) => {
      const sessions = ensureSession(state.sessions, routingId)
      return { sessions: updateSession(sessions, routingId, () => ({ teamName })) }
    }),

  clearTeam: (routingId) =>
    set((state) => {
      const sessions = ensureSession(state.sessions, routingId)
      return {
        sessions: updateSession(sessions, routingId, () => ({
          teamName: null,
          teammates: {},
          focusedAgentId: null
        }))
      }
    }),

  addTeammate: (routingId, info) =>
    set((state) => {
      const sessions = ensureSession(state.sessions, routingId)
      return {
        sessions: updateSession(sessions, routingId, (s) => ({
          teammates: { ...s.teammates, [info.toolUseId]: info }
        }))
      }
    }),

  updateTeammateStatus: (routingId, toolUseId, status) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state
      const teammate = session.teammates[toolUseId]
      if (!teammate) return state
      return {
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...session,
            teammates: {
              ...session.teammates,
              [toolUseId]: { ...teammate, status }
            }
          }
        }
      }
    }),

  setFocusedAgent: (routingId, toolUseId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ focusedAgentId: toolUseId }))
    })),

  addTeammateUserMessage: (routingId, toolUseId, id, text) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state
      const existing = session.subagentMessages[toolUseId] || []
      const userMsg: ChatMessage = {
        id,
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: Date.now()
      }
      return {
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...session,
            subagentMessages: { ...session.subagentMessages, [toolUseId]: [...existing, userMsg] }
          }
        }
      }
    }),

  // Git actions
  setIsGitRepo: (routingId, value) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ isGitRepo: value }))
    })),

  setGitStatus: (routingId, status) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (session?.cwd) gitStatusCache.set(session.cwd, status)
      return { sessions: updateSession(state.sessions, routingId, () => ({ gitStatus: status })) }
    }),

  setGitBranches: (routingId, branches) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ gitBranches: branches }))
    })),

  setGitSelectedFile: (routingId, filePath) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        gitSelectedFile: filePath,
        gitFileDiff: null
      }))
    })),

  setGitFileDiff: (routingId, diff) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ gitFileDiff: diff }))
    })),

  setGitCommitMessage: (routingId, message) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ gitCommitMessage: message }))
    })),

  setGitFileFilter: (routingId, filter) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ gitFileFilter: filter }))
    })),

  selectNextGitFile: (routingId) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session?.gitStatus) {
        return { sessions: updateSession(state.sessions, routingId, () => ({
          gitSelectedFile: null, gitFileDiff: null
        })) }
      }
      const next = session.gitStatus.files[0]?.path ?? null
      return { sessions: updateSession(state.sessions, routingId, () => ({
        gitSelectedFile: next, gitFileDiff: null
      })) }
    }),

  openGitPanel: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        rightPanel: 'git' as const
      }))
    })),

  closeGitPanel: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        rightPanel: 'none' as const
      }))
    })),

  // Diff review comments
  addDiffComment: (routingId, comment) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        gitReviewComments: [...s.gitReviewComments, comment]
      }))
    })),

  removeDiffComment: (routingId, commentId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        gitReviewComments: s.gitReviewComments.filter((c) => c.id !== commentId)
      }))
    })),

  clearDiffComments: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        gitReviewComments: []
      }))
    })),

  // Terminal actions
  addTerminalTab: (tab) =>
    set((state) => ({
      terminalTabs: [...state.terminalTabs, tab],
      activeTerminalId: tab.id
    })),

  closeTerminalTab: (id) => {
    window.api.killTerminal(id)
    set((state) => {
      const tabs = state.terminalTabs.filter((t) => t.id !== id)
      const activeTerminalId =
        state.activeTerminalId === id
          ? (tabs[tabs.length - 1]?.id ?? null)
          : state.activeTerminalId
      return { terminalTabs: tabs, activeTerminalId }
    })
  },

  removeTerminalTab: (id) =>
    set((state) => {
      const tabs = state.terminalTabs.filter((t) => t.id !== id)
      const activeTerminalId =
        state.activeTerminalId === id
          ? (tabs[tabs.length - 1]?.id ?? null)
          : state.activeTerminalId
      return { terminalTabs: tabs, activeTerminalId }
    }),

  setActiveTerminal: (id) => set({ activeTerminalId: id }),

  setTerminalPanelOpen: (open) => set({ terminalPanelOpen: open }),

  setTerminalPanelHeight: (height) => {
    localStorage.setItem('terminalPanelHeight', String(height))
    set({ terminalPanelHeight: height })
  }
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

export interface FocusedAgentData {
  isMain: boolean
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  thinkingStartedAt: number | null
}

const EMPTY_MESSAGES: ChatMessage[] = []

/**
 * Returns the messages/streaming for whichever agent tab is focused.
 * When focusedAgentId is null → main agent. Otherwise → subagent messages.
 * Uses useShallow for shallow equality to avoid infinite re-render loops.
 */
export function useFocusedAgentData(): FocusedAgentData {
  return useSessionStore(useShallow((state) => {
    const id = state.activeSessionId
    if (!id || !state.sessions[id]) {
      return { isMain: true, messages: EMPTY_MESSAGES, streamingText: '', streamingThinking: '', thinkingStartedAt: null }
    }
    const session = state.sessions[id]
    const focused = session.focusedAgentId
    if (!focused) {
      return {
        isMain: true,
        messages: session.messages,
        streamingText: session.streamingText,
        streamingThinking: session.streamingThinking,
        thinkingStartedAt: session.thinkingStartedAt
      }
    }
    return {
      isMain: false,
      messages: session.subagentMessages[focused] || EMPTY_MESSAGES,
      streamingText: session.subagentStreamingText[focused] || '',
      streamingThinking: session.subagentStreamingThinking[focused] || '',
      thinkingStartedAt: null // subagent thinking tracked separately
    }
  }))
}
