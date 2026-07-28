import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { mergeContentBlocks } from '../utils/content-blocks'
import { VOICE_LANGUAGES } from '../../../shared/types'
import { resolveClaudeCapabilities } from '../../../shared/model-capabilities'
import type { EffortLevel } from '../../../shared/model-capabilities'
import {
  engineMeta,
  OPENCODE_DEFAULT_MODEL,
  PI_DEFAULT_MODEL,
  FREE_OPENCODE_VENDOR_IDS
} from '../../../shared/engine-meta'
export { OPENCODE_DEFAULT_MODEL, PI_DEFAULT_MODEL } from '../../../shared/engine-meta'
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
  MeteringSnapshot,
  SlashCommandInfo,
  GitStatusData,
  GitBranchData,
  DiffComment,
  PlanComment,
  PlanReviewData,
  AccountUsage,
  AuthFlowState,
  VendorAuthMap,
  AccountsState,
  BlockUsageData,
  TerminalTab,
  WorktreeInfo,
  VoiceState,
  VoiceLanguageCode,
  ActiveView,
  PluginViewWithOwner,
  EngineId,
  ModelRef,
  EngineConfig,
  FileDiff,
  FileAttachment
} from '../../../shared/types'

/** Normalize cwd for use as a terminal group key (strip trailing slash). */
export function normalizeCwd(cwd: string): string {
  if (cwd.length > 1 && cwd.endsWith('/')) return cwd.slice(0, -1)
  return cwd || '.'
}

/**
 * Resolve a usable opencode picker VALUE against the currently-available
 * (discovered, provider-filtered) models. Mirrors the main-process
 * `resolveOpencodeSpawnModel` so the picker shows exactly what will spawn.
 *
 * Order: configured `preferred` if it is actually available → a free OpenCode
 * Zen model → the first available opencode model → null when opencode has no
 * usable models right now (all providers disabled, or not yet discovered).
 *
 * This is why a default that points at a disabled provider (e.g.
 * `opencode/mimo-v2.5-free` after disabling OpenCode Zen) no longer leaks into
 * the picker as a Claude-model fallback.
 */
export function resolveOpencodeModel(models: ModelInfo[], preferred?: string): string | null {
  const oc = models.filter((m) => m.engineId === 'opencode')
  if (oc.length === 0) return null
  if (preferred && oc.some((m) => m.value === preferred)) return preferred
  const free = oc.find((m) => FREE_OPENCODE_VENDOR_IDS.has(m.vendorId ?? ''))
  return (free ?? oc[0]).value
}

/**
 * The engine-configurable `perEngineDefault` to feed `engineMeta(engineId).
 * defaultModelValue(...)` — opencode's `opencodeDefaultModel` for 'opencode',
 * pi's `piDefaultModel` for 'pi', undefined for every other engine (claude's
 * defaultModelValue ignores the param entirely, so passing undefined is a
 * pure no-op for it — see engine-meta.ts's doc comments).
 *
 * Before this helper existed, BOTH call sites below passed
 * `state.opencodeDefaultModel` unconditionally regardless of `engineId` — a
 * latent bug for 'pi' (a fresh/reopened pi session would seed from opencode's
 * default model string instead of pi's own, since PI_DEFAULT_MODEL's fallback
 * in `defaultModelValue` never triggers while `opencodeDefaultModel` is
 * truthy, which it always is).
 */
function perEngineDefaultModel(
  engineId: EngineId,
  opencodeDefaultModel: string,
  piDefaultModel: string
): string | undefined {
  if (engineId === 'opencode') return opencodeDefaultModel
  if (engineId === 'pi') return piDefaultModel
  return undefined
}

function isModelForEngine(model: ModelInfo, engineId: EngineId): boolean {
  return (model.engineId ?? 'claude') === engineId
}

function resolveEngineDefaultModel(
  engineId: EngineId,
  models: ModelInfo[],
  opencodeDefaultModel: string,
  piDefaultModel: string
): string {
  if (engineId === 'opencode') {
    return (
      resolveOpencodeModel(models, opencodeDefaultModel) ??
      engineMeta(engineId).defaultModelValue(opencodeDefaultModel)
    )
  }
  if (engineId === 'pi') {
    const piModels = models.filter((model) => isModelForEngine(model, 'pi'))
    return (
      piModels.find((model) => model.value === piDefaultModel)?.value ??
      piModels[0]?.value ??
      engineMeta(engineId).defaultModelValue(piDefaultModel)
    )
  }
  return engineMeta(engineId).defaultModelValue()
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
      if (block.type !== 'tool_use' || !block.toolName || !TASK_TOOL_NAMES.has(block.toolName))
        continue
      const input = block.toolInput || {}

      if (block.toolName === 'TodoWrite') {
        hasTaskCalls = true
        tasks.clear()
        if (Array.isArray(input.todos)) {
          ;(input.todos as Record<string, unknown>[]).forEach((t, i) => {
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
        const idMatch =
          resultBlock?.type === 'tool_result' ? resultBlock.toolResult.match(/Task #(\w+)/) : null
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
  searchCaseSensitive: boolean
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
  usageRefreshSecs: number // how often to call the /usage API (background poll)
  analyticsRefreshSecs: number // how often to recalculate token analytics from JSONL changes
  sessionTimeoutMins: number // 0 = never auto-disconnect
  remoteFollowActions: boolean // follow remote client's session switches & messages
  voiceEnabled: boolean
  voiceLanguage: VoiceLanguageCode
  /**
   * Per-model default effort overrides. Keyed by canonical model id
   * (`claude-sonnet-5`, `claude-sonnet-4-6`, `claude-opus-4-7`,
   * `claude-opus-4-8`, `claude-fable-5`). When set, overrides the
   * cli.js-derived default for that model; a per-session explicit pick
   * still wins.
   */
  modelEffortDefaults: Partial<Record<string, EffortLevel>>
  mermaidTheme: 'auto' | 'dark' | 'default' | 'neutral' | 'forest' // mermaid diagram theme
  logLevel: 'debug' | 'info' | 'warn' | 'error' // global log level
  logFilter: string // per-source overrides: "UsageFetcher:debug,BlockUsage:debug"
  mockupConnectAllowlist: string // newline-separated origin allowlist for mockup iframe `connect-src`
  mockupAllowHttp: boolean // when true, mockup iframes may connect over plaintext http:/ws:
  /**
   * Maximum characters shown in a tool output before the "Show more" toggle
   * appears. 0 = no truncation. Default 5000.
   */
  toolOutputMaxChars: number
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  expandToolCalls: true,
  expandReadResults: false,
  hideToolInput: false,
  expandThinking: false,
  searchCaseSensitive: false,
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
  usageRefreshSecs: 120,
  analyticsRefreshSecs: 30,
  sessionTimeoutMins: 15,
  voiceEnabled: false,
  voiceLanguage: 'en' as VoiceLanguageCode,
  remoteFollowActions: true,
  modelEffortDefaults: {},
  mermaidTheme: 'auto',
  logLevel: 'warn',
  logFilter: '',
  mockupConnectAllowlist: '',
  mockupAllowHttp: false,
  toolOutputMaxChars: 5000
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

type PersistedSessionFields = {
  recentSessionIds: string[]
  pinnedSessionIds: string[]
  customTitles: Record<string, string>
  worktreeInfoMap: Record<string, WorktreeInfo>
  hiddenSessionIds: string[]
  hiddenProjectKeys: string[]
  /** Maps sessionId → { engineId, model? } for session engine persistence. */
  sessionEngines: Record<string, { engineId: EngineId; model?: ModelRef }>
}

/**
 * Persist the sidebar/session config to disk.
 * Pass the pre-change state + a patch of just the fields that changed — the helper
 * merges them so unrelated fields are never dropped from the saved file.
 */
function saveSessionConfig(
  state: PersistedSessionFields,
  patch?: Partial<PersistedSessionFields>
): void {
  const merged: PersistedSessionFields = { ...state, ...patch }
  window.api.saveSessionConfig({
    recentSessions: merged.recentSessionIds,
    pinnedSessions: merged.pinnedSessionIds,
    customTitles: merged.customTitles,
    worktreeInfoMap: merged.worktreeInfoMap,
    hiddenSessions: merged.hiddenSessionIds,
    hiddenProjects: merged.hiddenProjectKeys,
    sessionEngines: merged.sessionEngines
  })
}

/**
 * Hydrate the store from ~/.claude/ui/ config files.
 * Called once at startup; migrates from localStorage on first run.
 */
export async function hydrateConfigFromDisk(): Promise<void> {
  let [
    savedSettings,
    sessionConfig,
    slashCommands,
    loadedEngineConfig,
    opencodeSettings,
    piEngineConfig
  ] = await Promise.all([
    window.api.loadSettings(),
    window.api.loadSessionConfig(),
    window.api.loadSlashCommands(),
    window.api.loadEngineConfig('claude'),
    window.api
      .loadOpencodeSettings()
      .catch((): import('../../../shared/types').OpencodeConfigSettings => ({})),
    window.api
      .loadEngineConfig('pi')
      .catch((): import('../../../shared/types').EngineConfig => ({}))
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

  const saved = savedSettings as Partial<AppSettings>
  const settings: AppSettings =
    Object.keys(saved).length > 0
      ? {
          ...DEFAULT_SETTINGS,
          ...saved
        }
      : DEFAULT_SETTINGS

  // Validate voiceLanguage — unsupported codes (e.g. 'zh' removed in v0.2.97) fall back to 'en'
  if (settings.voiceLanguage && !VOICE_LANGUAGES.some((l) => l.code === settings.voiceLanguage)) {
    settings.voiceLanguage = 'en'
  }

  applyTheme(settings.theme)

  useSessionStore.setState({
    engineConfig: loadedEngineConfig,
    opencodeDefaultModel: opencodeSettings?.model || OPENCODE_DEFAULT_MODEL,
    piDefaultModel: piEngineConfig?.piConfig?.defaultModel || PI_DEFAULT_MODEL,
    settings,
    recentSessionIds: sessionConfig.recentSessions ?? [],
    pinnedSessionIds: sessionConfig.pinnedSessions ?? [],
    customTitles: sessionConfig.customTitles ?? {},
    worktreeInfoMap: sessionConfig.worktreeInfoMap ?? {},
    hiddenSessionIds: sessionConfig.hiddenSessions ?? [],
    hiddenProjectKeys: sessionConfig.hiddenProjects ?? [],
    sessionEngines: sessionConfig.sessionEngines ?? {},
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
  if (session.messages.length > 0 || session.sdkActive || session.draftText)
    return { sessions, recentSessionIds }
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
  /** Set on a freshly-forked ("branched off") session before its first send.
   *  Tells InputBox to spawn cli.js with `--resume <source> --resume-session-at
   *  <anchor> --fork-session`, minting a new branch seeded with messages 1..N.
   *  Read only while `!sdkActive`; the fork materializes lazily on first prompt. */
  forkOrigin: { sourceSessionId: string; anchorUuid: string } | null
  messages: ChatMessage[]
  streamingText: string
  streamingThinking: string
  thinkingStartedAt: number | null
  thinkingDurationMs: number | null
  /** Duration of the most-recently sealed thinking span awaiting attachment to
   *  the next committed thinking block (see addMessage). Decouples the seal point
   *  (appendStreamingText) from the block-commit point (addMessage) so each
   *  thinking block records its OWN duration instead of all reading one scalar. */
  pendingThinkingDurationMs: number | null
  /** True once the heavy arrays (messages, subagentMessages, bash/background
   *  outputs) have been evicted from memory for an inactive session. The entry
   *  is kept resident (draft/effort/engine preserved) and re-hydrated from disk
   *  on reselection via loadHistoricalSession. */
  evicted: boolean
  status: SessionStatus
  pendingApprovals: PendingApproval[]
  errors: string[]
  warnings: string[]
  todos: TodoItem[]
  taskProgressMap: Record<string, TaskProgress>
  taskNotifications: TaskNotification[]
  openedTaskToolUseIds: string[]
  rightPanel: 'none' | 'task' | 'git' | 'plan' | 'mockup'
  subagentMessages: Record<string, ChatMessage[]>
  subagentStreamingText: Record<string, string>
  subagentStreamingThinking: Record<string, string>
  bashOutputs: Record<string, { output: string; totalLines: number; totalBytes: number }>
  backgroundOutputs: Record<string, { tail: string; totalSize: number }>
  backgroundWatcherCounts: Record<string, number>
  stoppingTaskIds: string[]
  isWatching: boolean
  needsAttention: boolean
  permissionMode: PermissionMode
  /** null = use model default; non-null = user explicitly chose this tier */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  /** null = use model default; non-null = user explicitly chose this mode */
  thinkingMode: 'adaptive' | 'enabled' | 'disabled' | null
  /** null = opencode default (variant omitted); non-null = user chose a reasoning variant.
   *  Only meaningful for opencode models with reasoningVariants. Claude: always null. */
  reasoningVariant: string | null
  statusLine: StatusLineData | null
  /** Engine-neutral metering snapshot (Phase 7 Pass 2). Additive to statusLine. */
  metering: MeteringSnapshot | null
  queuedText: string
  draftText: string
  /** Per-session unsent attachments (mirrors draftText). Scoped so a file added
   *  in session A can never be sent from B, and is restored on return to A. */
  draftAttachments: FileAttachment[]
  selectedModel: string
  /** Engine chosen at session-creation time. Immutable after the session spawns. */
  selectedEngineId: EngineId
  // Worktree state
  worktreeInfo: WorktreeInfo | null
  // Git state
  isGitRepo: boolean
  gitStatus: GitStatusData | null
  gitBranches: GitBranchData | null
  gitSelectedFile: string | null
  gitFileDiff: {
    patch: string
    isBinary?: boolean
    oldContent?: string
    newContent?: string
  } | null
  gitCommitMessage: string
  gitFileFilter: 'staged' | 'unstaged' | 'all'
  gitReviewComments: DiffComment[]
  gitSyncOperation: 'idle' | 'fetching' | 'pulling' | 'pushing'
  gitSyncError: string | null
  gitLastFetchTime: number | null
  // Plan review state
  planReview: PlanReviewData | null
  // Mockup preview state
  mockupDir: string | null
  mockupTitle: string | null
  // Sandbox violation messages
  sandboxViolations: string[]
  // Voice input
  voiceState: VoiceState
  voiceInterimTranscript: string
  // BTW side question
  btwQuestion: string | null
  btwResponse: string | null
  btwLoading: boolean
  // Vendor auth required (opencode ProviderAuthError)
  vendorAuthRequired: { vendorId: string; message: string } | null
}

const EMPTY_SESSION_STATE: PerSessionState = {
  cwd: '',
  sdkActive: false,
  isHistorical: false,
  forkOrigin: null,
  messages: [],
  streamingText: '',
  streamingThinking: '',
  thinkingStartedAt: null,
  thinkingDurationMs: null,
  pendingThinkingDurationMs: null,
  evicted: false,
  // Full caps assumed for new sessions before the first status event.
  status: {
    state: 'idle',
    sessionId: null,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId: 'claude',
    capabilities: resolveClaudeCapabilities('default'),
    account: null
  },
  pendingApprovals: [],
  errors: [],
  warnings: [],
  todos: [],
  taskProgressMap: {},
  taskNotifications: [],
  openedTaskToolUseIds: [],
  rightPanel: 'none',
  subagentMessages: {},
  subagentStreamingText: {},
  subagentStreamingThinking: {},
  bashOutputs: {},
  backgroundOutputs: {},
  backgroundWatcherCounts: {},
  stoppingTaskIds: [],
  isWatching: false,
  needsAttention: false,
  permissionMode: 'default',
  effort: null,
  thinkingMode: null,
  reasoningVariant: null,
  statusLine: null,
  metering: null,
  queuedText: '',
  draftText: '',
  draftAttachments: [],
  selectedModel: 'default',
  selectedEngineId: 'claude' as EngineId,
  worktreeInfo: null,
  isGitRepo: false,
  gitStatus: null,
  gitBranches: null,
  gitSelectedFile: null,
  gitFileDiff: null,
  gitCommitMessage: '',
  gitFileFilter: 'all',
  gitReviewComments: [],
  gitSyncOperation: 'idle',
  gitSyncError: null,
  gitLastFetchTime: null,
  planReview: null,
  mockupDir: null,
  mockupTitle: null,
  sandboxViolations: [],
  voiceState: 'idle' as VoiceState,
  voiceInterimTranscript: '',
  btwQuestion: null,
  btwResponse: null,
  btwLoading: false,
  vendorAuthRequired: null
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
 * Insert into a module-level cache Map, evicting the oldest entries once `cap`
 * is exceeded. These caches live for the whole renderer process, so without a
 * bound they grow monotonically across a long-running session (RN8).
 *
 * Maps iterate in insertion order, so the first key is the oldest. Re-writing an
 * existing key deletes-then-sets it, which moves it to the back — a refresh
 * counts as recent, so a hot key can't be evicted just because it was first
 * seen long ago.
 */
function setCapped<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > cap) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

/**
 * Maps old (pre-rekey) routingIds → new (SDK session) IDs.
 * When the store rekeys a session, the main process may still send events
 * with the old routingId until it processes the rekey IPC round-trip.
 * This map lets setStatusLine (and potentially other handlers) resolve them.
 *
 * Bounded: only *recent* rekeys matter (the main process catches up within one
 * IPC round-trip), and stale ids die with their session.
 */
const REKEY_MAP_MAX = 200
const rekeyMap = new Map<string, string>()

/**
 * Resolve a possibly-stale (pre-rekey) routingId to the canonical session id.
 * When a session rekeys to its SDK id, the main process keeps emitting events
 * with the old routingId until it processes the rekey IPC round-trip. Resolving
 * at the event boundary (useClaudeEvents) makes ALL handlers — messages,
 * streams, approvals, tool results — target the same id, so a rekey can no
 * longer split-brain a session (xhigh#9). Returns the input unchanged when no
 * mapping applies (pre-rekey, or the mapped session no longer exists).
 */
export function resolveRoutingId(routingId: string): string {
  const mapped = rekeyMap.get(routingId)
  if (mapped && useSessionStore.getState().sessions[mapped]) return mapped
  return routingId
}

/**
 * Monotonic token for the in-flight vendor-OAuth `auto` flow. Each
 * authorizeVendorOAuth() captures the current token; cancelVendorOAuth()
 * bumps it. The long-lived `oauthCallback` await checks its captured token
 * before any post-await state-set, so a callback that resolves AFTER the user
 * cancelled (opencode's plugin times out server-side, but the promise may still
 * settle) cannot resurrect a stale waiting/error card. Module-level (not store
 * state) — it's control-flow bookkeeping, never rendered.
 */
let vendorOAuthFlowToken = 0

/**
 * Global git status cache keyed by cwd.
 * When polling updates arrive they're cached here so that newly-loaded
 * or switched-to sessions with the same cwd get instant git status
 * instead of waiting for the next poll cycle.
 *
 * Bounded (RN8): it's a convenience cache, and a miss just means the session
 * waits one poll cycle for its real status.
 */
const GIT_STATUS_CACHE_MAX = 100
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
 * Lets actions on routingIds that haven't been created yet (e.g. cross-window
 * IPC arriving before this renderer's createNewSession) bootstrap from incoming
 * events instead of dropping them on the floor.
 */
function ensureSession(
  sessions: Record<string, PerSessionState>,
  routingId: string
): Record<string, PerSessionState> {
  if (sessions[routingId]) return sessions
  return { ...sessions, [routingId]: createEmptySession('') }
}

/**
 * How many recently-viewed transcripts stay fully resident (besides the active
 * session, pinned sessions, and watched/running ones). Older on-disk
 * transcripts have their heavy arrays evicted and are re-hydrated on reselect.
 */
const MAX_RESIDENT_TRANSCRIPTS = 10

/**
 * Evict the heavy per-session arrays (messages / subagent messages / bash +
 * background outputs) for sessions that are neither active, recently-viewed,
 * pinned, watched, running, nor awaiting an approval — bounding renderer heap
 * (Opus B). The lightweight entry stays resident (draft, effort, model, engine,
 * status, todos), and the transcript re-hydrates from disk on reselection via
 * loadHistoricalSession (the `evicted` flag routes Sidebar.handleClickSession
 * back through the disk-load path). Only on-disk sessions are eligible, so an
 * evicted transcript is always reloadable — a fresh, not-yet-flushed session is
 * never touched. Returns the same map reference when nothing was evicted.
 */
function evictColdSessions(
  sessions: Record<string, PerSessionState>,
  activeSessionId: string | null,
  recentSessionIds: string[],
  pinnedSessionIds: string[],
  directories: DirectoryGroup[]
): Record<string, PerSessionState> {
  const keep = new Set<string>()
  if (activeSessionId) keep.add(activeSessionId)
  for (const id of recentSessionIds.slice(0, MAX_RESIDENT_TRANSCRIPTS)) keep.add(id)
  for (const id of pinnedSessionIds) keep.add(id)

  const onDisk = new Set<string>()
  for (const group of directories) {
    for (const s of group.sessions) onDisk.add(s.sessionId)
  }

  let changed = false
  const next: Record<string, PerSessionState> = {}
  for (const id in sessions) {
    const sess = sessions[id]
    const canEvict =
      !keep.has(id) &&
      !sess.evicted &&
      !sess.sdkActive &&
      !sess.isWatching &&
      sess.pendingApprovals.length === 0 &&
      sess.messages.length > 0 &&
      onDisk.has(id)
    if (canEvict) {
      changed = true
      next[id] = {
        ...sess,
        evicted: true,
        isHistorical: true,
        messages: [],
        streamingText: '',
        streamingThinking: '',
        subagentMessages: {},
        subagentStreamingText: {},
        subagentStreamingThinking: {},
        bashOutputs: {},
        backgroundOutputs: {},
        backgroundWatcherCounts: {}
      }
    } else {
      next[id] = sess
    }
  }
  return changed ? next : sessions
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
  /** Session IDs hidden from the sidebar (user can reveal via Show hidden toggle) */
  hiddenSessionIds: string[]
  /** Project keys hidden from the sidebar */
  hiddenProjectKeys: string[]
  /** Maps sessionId → { engineId, model? } for engine persistence across restarts. */
  sessionEngines: Record<string, { engineId: EngineId; model?: ModelRef }>

  /** Remembered engine choice — pre-fills engine for newly created sessions. */
  lastSelectedEngineId: EngineId
  /** Configurable opencode default model (engines/opencode.json `opencodeConfig.model`).
   *  The opencode-engine value `engineMeta('opencode').defaultModelValue()` resolves to. */
  opencodeDefaultModel: string
  /** Configurable pi default model (engines/pi.json `piConfig.defaultModel`, M3).
   *  The pi-engine value `engineMeta('pi').defaultModelValue()` resolves to. */
  piDefaultModel: string
  /** Bumped to force the model picker to re-fetch getEngineModels() — e.g. after
   *  an opencode provider/default-model change in Settings. */
  modelReloadNonce: number

  // Global (not per-session)
  engineConfig: EngineConfig
  settings: AppSettings
  availableModels: ModelInfo[]
  slashCommands: SlashCommandInfo[]
  customCommands: SlashCommandInfo[]
  sdkSkillNames: string[]
  accountUsage: AccountUsage | null
  blockUsage: BlockUsageData | null
  /** Native OAuth login-flow state (ADR-014). Null until first event/status. */
  authState: AuthFlowState | null
  /** Login status from session init: 'authenticated'|'none'|null (logged-in vs not).
   *  The oauth-vs-api-key distinction lives only in vendorAuth's billingType.
   *  See ADR-014 / Phase 4 (ADR-021). */
  authSource: string | null
  /** Vendor auth map from the engine auth probe (Phase 4). Null until first probe. */
  vendorAuth: VendorAuthMap | null
  /** Multi-account state (ADR-015). Null until first load/event. */
  accountsState: AccountsState | null
  /** Global vendor OAuth flow state (auto/loopback OAuth in progress). */
  vendorOAuth: {
    engineId: string
    vendorId: string
    stage: 'waiting' | 'error'
    instructions: string
  } | null
  activeView: ActiveView
  pluginViews: PluginViewWithOwner[]

  // Worktree (global)
  worktreeInfoMap: Record<string, WorktreeInfo>
  quitWorktrees: Array<{ routingId: string; worktreeInfo: WorktreeInfo }> | null

  // Terminal panel (grouped by cwd, survives session switching)
  terminalGroups: Record<string, { tabs: TerminalTab[]; activeTabId: string | null }>
  terminalPanelOpen: boolean
  terminalPanelHeight: number

  // Multi-session actions
  showWelcome: () => void
  switchSession: (routingId: string) => void
  createNewSession: (routingId: string, cwd: string, switchTo?: boolean) => void
  /** Set the remembered engine choice. Persisted in localStorage (lightweight). */
  setLastSelectedEngineId: (engineId: EngineId) => void
  /** Switch the active fresh session's engine and seed its effective default model. */
  setSelectedEngine: (engineId: EngineId) => void
  /** Update the configurable opencode default model (mirrors opencodeConfig.model). */
  setOpencodeDefaultModel: (model: string) => void
  /** Update the configurable pi default model (mirrors piConfig.defaultModel, M3). */
  setPiDefaultModel: (model: string) => void
  /** Force the model picker to re-fetch the engine model list. */
  reloadModels: () => void
  loadHistoricalSession: (
    routingId: string,
    messages: ChatMessage[],
    cwd: string,
    taskNotifications?: TaskNotification[],
    subagentMessages?: Record<string, ChatMessage[]>,
    statusLine?: StatusLineData | null,
    warnings?: string[]
  ) => void
  /** Fork ("branch off") a new session from an assistant message in `sourceRoutingId`.
   *  Resolves the disk anchor, seeds the new session with messages 1..N, and
   *  switches to it. The branch materializes on cli.js on first prompt send.
   *  Returns the new routingId, or null if the anchor could not be resolved. */
  forkFromMessage: (sourceRoutingId: string, messageId: string) => Promise<string | null>
  markSdkActive: (routingId: string) => void
  markSdkInactive: (routingId: string) => void
  setDirectories: (dirs: DirectoryGroup[]) => void
  addRecentSession: (routingId: string) => void
  removeRecentSession: (routingId: string) => void
  setCustomTitle: (sessionId: string, title: string | null) => void
  pinSession: (routingId: string) => void
  unpinSession: (routingId: string) => void
  reorderPinnedSessions: (ids: string[]) => void
  hideSession: (sessionId: string) => void
  unhideSession: (sessionId: string) => void
  hideProject: (projectKey: string) => void
  unhideProject: (projectKey: string) => void
  deleteSession: (sessionId: string, projectKey: string, engineId?: EngineId) => Promise<void>
  deleteProject: (projectKey: string) => Promise<void>

  // Per-session actions (all take routingId)
  addMessage: (routingId: string, message: ChatMessage) => void
  addUserMessage: (
    routingId: string,
    id: string,
    text: string,
    planContent?: string,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ) => void
  appendStreamingText: (routingId: string, text: string) => void
  appendStreamingThinking: (routingId: string, text: string) => void
  clearStreamingText: (routingId: string) => void
  setStatus: (routingId: string, status: SessionStatus) => void
  addPendingApproval: (routingId: string, approval: PendingApproval) => void
  removePendingApproval: (routingId: string, requestId: string) => void
  /**
   * Clear any approval whose `toolUseId` matches. Called when a tool_result
   * arrives so stale approvals — say, a backend race where the resolver
   * already fired but the store cleanup got lost — don't keep bleeding into
   * future cards. Distinct from removePendingApproval(requestId) because
   * consumers see tool_use_id first on tool_result events.
   */
  removePendingApprovalByToolUse: (routingId: string, toolUseId: string) => void
  clearPendingApprovals: (routingId: string) => void
  addError: (routingId: string, error: string) => void
  addWarning: (routingId: string, warning: string) => void
  removeWarning: (routingId: string, index: number) => void
  clearWarnings: (routingId: string) => void
  /**
   * Refusal-fallback retraction: remove the refused partial's messages and
   * clear any streamed text it left behind. Unknown ids are a no-op.
   */
  retractMessages: (routingId: string, messageIds: string[]) => void
  removeError: (routingId: string, index: number) => void
  clearErrors: (routingId: string) => void
  addSandboxViolation: (routingId: string, message: string) => void
  removeSandboxViolation: (routingId: string, index: number) => void
  appendToolResult: (
    routingId: string,
    toolUseId: string,
    result: string,
    isError: boolean,
    fileDiffs?: FileDiff[]
  ) => void
  setTodos: (routingId: string, todos: TodoItem[]) => void
  updateTaskProgress: (routingId: string, progress: TaskProgress) => void
  addTaskNotification: (routingId: string, notification: TaskNotification) => void
  bulkSetSubagentMessages: (
    routingId: string,
    subagentMessages: Record<string, ChatMessage[]>
  ) => void
  addSubagentMessage: (routingId: string, toolUseId: string, message: ChatMessage) => void
  appendSubagentMessageBatch: (
    routingId: string,
    toolUseId: string,
    messages: ChatMessage[]
  ) => void
  appendSubagentStreamingText: (routingId: string, toolUseId: string, text: string) => void
  appendSubagentStreamingThinking: (routingId: string, toolUseId: string, text: string) => void
  appendSubagentToolResult: (
    routingId: string,
    toolUseId: string,
    toolResultToolUseId: string,
    result: string,
    isError: boolean,
    fileDiffs?: FileDiff[]
  ) => void
  setBashOutput: (
    routingId: string,
    toolUseId: string,
    output: string,
    totalLines: number,
    totalBytes: number
  ) => void
  clearBashOutput: (routingId: string, toolUseId: string) => void
  setBackgroundOutput: (
    routingId: string,
    toolUseId: string,
    tail: string,
    totalSize: number
  ) => void
  watchBackgroundOutput: (routingId: string, toolUseId: string) => void
  unwatchBackgroundOutput: (routingId: string, toolUseId: string) => void
  openTaskPanel: (routingId: string, toolUseId: string) => void
  closeTaskPanel: (routingId: string) => void
  removeTaskFromPanel: (routingId: string, toolUseId: string) => void
  setTaskStopping: (routingId: string, toolUseId: string) => void
  clearTaskStopping: (routingId: string, toolUseId: string) => void
  setNeedsAttention: (routingId: string, value: boolean) => void
  setWatching: (routingId: string, watching: boolean) => void
  updateWatchedSession: (
    routingId: string,
    messages: ChatMessage[],
    taskNotifications: TaskNotification[]
  ) => void
  updateSettings: (partial: Partial<AppSettings>) => void
  setEngineConfig: (config: EngineConfig) => void
  applyExternalSettings: (settings: Record<string, unknown>) => void
  applyExternalSessionConfig: (config: {
    recentSessions?: string[]
    pinnedSessions?: string[]
    customTitles?: Record<string, string>
    worktreeInfoMap?: Record<string, WorktreeInfo>
    hiddenSessions?: string[]
    hiddenProjects?: string[]
    sessionEngines?: Record<string, { engineId: EngineId; model?: ModelRef }>
  }) => void
  applyRemoteSnapshot: (
    snapshot: import('../../../shared/remote-protocol').FullStateSnapshot
  ) => void
  setPermissionMode: (mode: PermissionMode, routingId?: string) => void
  changePermissionMode: (routingId: string, next: PermissionMode) => void
  setEffort: (
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null,
    routingId?: string
  ) => void
  setThinkingMode: (mode: 'adaptive' | 'enabled' | 'disabled' | null, routingId?: string) => void
  setReasoningVariant: (variant: string | null, routingId?: string) => void
  setStatusLine: (routingId: string, data: StatusLineData) => void
  setMetering: (routingId: string, data: MeteringSnapshot) => void
  appendQueuedText: (text: string) => void
  setQueuedText: (routingId: string, text: string) => void
  clearQueuedText: () => void
  consumeQueuedText: (routingId: string) => void
  setDraftText: (text: string) => void
  /** Append unsent attachments to a specific session (keyed by routingId — see impl). */
  addDraftAttachments: (routingId: string, attachments: FileAttachment[]) => void
  /** Remove one unsent attachment from a session by attachment id. */
  removeDraftAttachment: (routingId: string, id: string) => void
  /** Replace a session's unsent attachments (used to clear after a successful send). */
  setDraftAttachments: (routingId: string, attachments: FileAttachment[]) => void
  /** Set the active session's model picker value within its selected engine. */
  setSelectedModel: (model: string) => void
  setSlashCommands: (commands: SlashCommandInfo[]) => void
  setCustomCommands: (commands: SlashCommandInfo[]) => void
  setSdkSkillNames: (names: string[]) => void
  setAvailableModels: (models: ModelInfo[]) => void
  rekeySession: (oldId: string, newId: string) => void
  clearConversation: (routingId: string) => void
  // Worktree actions
  setWorktreeInfo: (routingId: string, info: WorktreeInfo | null) => void
  clearWorktreeInfo: (routingId: string) => void
  setQuitWorktrees: (
    sessions: Array<{ routingId: string; worktreeInfo: WorktreeInfo }> | null
  ) => void
  // Git actions
  setIsGitRepo: (routingId: string, value: boolean) => void
  setGitStatus: (routingId: string, status: GitStatusData) => void
  setGitBranches: (routingId: string, branches: GitBranchData) => void
  setGitSelectedFile: (routingId: string, filePath: string | null) => void
  setGitFileDiff: (
    routingId: string,
    diff: { patch: string; isBinary?: boolean; oldContent?: string; newContent?: string } | null
  ) => void
  setGitCommitMessage: (routingId: string, message: string) => void
  setGitFileFilter: (routingId: string, filter: 'staged' | 'unstaged' | 'all') => void
  selectNextGitFile: (routingId: string) => void
  openGitPanel: (routingId: string) => void
  closeGitPanel: (routingId: string) => void
  // Account usage
  setAccountUsage: (data: AccountUsage) => void
  // Native OAuth (ADR-014)
  setAuthState: (data: AuthFlowState) => void
  setAuthSource: (source: string) => void
  setVendorAuth: (map: VendorAuthMap) => void
  setAccountsState: (data: AccountsState) => void
  /** Mark every session SDK-inactive so the next send respawns cli.js (ADR-015). */
  respawnAllSessions: () => void
  signIn: () => Promise<void>
  submitOAuthCode: (code: string) => Promise<void>
  cancelSignIn: () => Promise<void>
  setVendorOAuth(
    state: {
      engineId: string
      vendorId: string
      stage: 'waiting' | 'error'
      instructions: string
    } | null
  ): void
  cancelVendorOAuth(): void
  setVendorAuthRequired(routingId: string, data: { vendorId: string; message: string } | null): void
  clearVendorAuthRequired(routingId: string): void
  authorizeVendorOAuth(
    engineId: EngineId,
    vendorId: string
  ): Promise<{ ok: boolean; needsPaste?: { url: string; method: number; instructions: string } }>
  /** Respawn the session's cli.js process (so it re-reads freshly-stored
   *  credentials) and resend a prompt. Used by the post-login Retry. */
  retrySend: (routingId: string, prompt: string) => Promise<void>
  // Block usage analytics
  setBlockUsage: (data: BlockUsageData) => void
  setActiveView: (view: ActiveView) => void
  setPluginViews: (views: PluginViewWithOwner[]) => void
  // Git sync operations
  setGitSyncOperation: (routingId: string, op: 'idle' | 'fetching' | 'pulling' | 'pushing') => void
  setGitSyncError: (routingId: string, error: string | null) => void
  setGitLastFetchTime: (routingId: string, time: number | null) => void
  // Diff review comments
  addDiffComment: (routingId: string, comment: DiffComment) => void
  removeDiffComment: (routingId: string, commentId: string) => void
  clearDiffComments: (routingId: string) => void
  // Plan review actions
  openPlanPanel: (routingId: string, planContent: string, approvalRequestId: string) => void
  closePlanPanel: (routingId: string) => void
  addPlanComment: (routingId: string, comment: PlanComment) => void
  updatePlanComment: (routingId: string, commentId: string, text: string) => void
  removePlanComment: (routingId: string, commentId: string) => void
  clearPlanComments: (routingId: string) => void
  // Mockup preview actions
  openMockupPanel: (routingId: string, directory: string, title?: string) => void
  closeMockupPanel: (routingId: string) => void
  // Terminal actions
  addTerminalTab: (tab: TerminalTab) => void
  closeTerminalTab: (id: string) => void
  removeTerminalTab: (id: string) => void
  setActiveTerminal: (id: string, cwd: string) => void
  setTerminalPanelOpen: (open: boolean) => void
  setTerminalPanelHeight: (height: number) => void
  removeTerminalGroup: (cwd: string) => void
  // Voice actions
  setVoiceState: (routingId: string, state: VoiceState) => void
  setVoiceInterimTranscript: (routingId: string, text: string) => void
  appendVoiceTranscript: (routingId: string, text: string, isFinal: boolean) => void
  clearVoiceTranscript: (routingId: string) => void
  // BTW side question actions
  setBtwQuestion: (routingId: string, question: string) => void
  setBtwResponse: (routingId: string, response: string | null) => void
  clearBtw: (routingId: string) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  activeSessionId: null,
  sessions: {},
  directories: [],
  recentSessionIds: [],
  pinnedSessionIds: [],
  customTitles: {},
  hiddenSessionIds: [],
  hiddenProjectKeys: [],
  sessionEngines: {},
  lastSelectedEngineId:
    ((localStorage.getItem('lastSelectedEngineId') ??
      localStorage.getItem('lastSelectedProvider')) as EngineId | null) ?? 'claude',
  opencodeDefaultModel: OPENCODE_DEFAULT_MODEL,
  piDefaultModel: PI_DEFAULT_MODEL,
  modelReloadNonce: 0,
  engineConfig: {},
  settings: DEFAULT_SETTINGS,
  availableModels: [],
  slashCommands: [],
  customCommands: [],
  sdkSkillNames: [],
  accountUsage: null,
  authState: null,
  authSource: null,
  vendorAuth: null,
  accountsState: null,
  vendorOAuth: null,
  blockUsage: null,
  activeView: { type: 'chat' } as ActiveView,
  pluginViews: [],
  worktreeInfoMap: {},
  quitWorktrees: null,
  terminalGroups: {},
  terminalPanelOpen: false,
  terminalPanelHeight: Number(localStorage.getItem('terminalPanelHeight')) || 280,

  showWelcome: () =>
    set((state) => {
      const cleaned = cleanupEmptySession(
        state.sessions,
        state.recentSessionIds,
        state.activeSessionId
      )
      if (cleaned.recentSessionIds !== state.recentSessionIds) {
        saveSessionConfig(state, { recentSessionIds: cleaned.recentSessionIds })
      }
      return { activeSessionId: null, activeView: { type: 'chat' } as ActiveView, ...cleaned }
    }),

  switchSession: (routingId) =>
    set((state) => {
      const cleaned = cleanupEmptySession(
        state.sessions,
        state.recentSessionIds,
        state.activeSessionId
      )
      if (cleaned.recentSessionIds !== state.recentSessionIds) {
        saveSessionConfig(state, { recentSessionIds: cleaned.recentSessionIds })
      }
      const withAttention = updateSession(cleaned.sessions, routingId, () => ({
        needsAttention: false
      }))
      // Bound the renderer heap (Opus B): evict the heavy transcript arrays of
      // cold, on-disk sessions on every switch. The active/recent/pinned/running/
      // watched sessions are always kept; an evicted session re-hydrates from
      // disk on reselect (Sidebar routes an evicted entry through
      // loadHistoricalSession rather than the resident fast-path).
      const sessions = evictColdSessions(
        withAttention,
        routingId,
        cleaned.recentSessionIds,
        state.pinnedSessionIds,
        state.directories
      )
      return {
        activeSessionId: routingId,
        activeView: { type: 'chat' } as ActiveView,
        sessions,
        recentSessionIds: cleaned.recentSessionIds
      }
    }),

  createNewSession: (routingId, cwd, switchTo = true) =>
    set((state) => {
      const recentSessionIds = [
        routingId,
        ...state.recentSessionIds.filter((id) => id !== routingId)
      ].slice(0, state.settings.maxRecentSessions)
      // Validate the remembered engine against what is ACTUALLY usable right now.
      // `availableModels` reflects post-discovery, provider-filtered reality. If the
      // remembered engine is opencode but it has no usable model — its provider was
      // disabled, discovery hasn't run yet, or opencode is unavailable — seeding it
      // would show a Claude model in the picker while routing send to a phantom
      // opencode model (the desync regression). Fall back to claude in that case.
      let engineId = state.lastSelectedEngineId
      let defaultModel = resolveEngineDefaultModel(
        engineId,
        state.availableModels,
        state.opencodeDefaultModel,
        state.piDefaultModel
      )
      if (
        engineId === 'opencode' &&
        !resolveOpencodeModel(state.availableModels, state.opencodeDefaultModel)
      ) {
        engineId = 'claude'
        defaultModel = 'default'
      }
      // Write model into sessionEngines so it can be seeded on reopen (spec §3).
      // Always write the entry so the engine is recorded; model is set on first model event.
      const sessionEngines = {
        ...state.sessionEngines,
        [routingId]: { engineId, model: engineMeta(engineId).decodeModelValue(defaultModel) }
      }
      saveSessionConfig(state, { recentSessionIds, sessionEngines })
      const newSession = createEmptySession(cwd)
      newSession.selectedEngineId = engineId
      newSession.selectedModel = defaultModel
      // Seed status.engineId/capabilities to match so they're correct before spawn
      newSession.status = {
        ...newSession.status,
        engineId,
        capabilities: engineMeta(engineId).seedCapabilities(
          defaultModel,
          state.availableModels.find(
            (m) => m.value === defaultModel && isModelForEngine(m, engineId)
          )
        )
      }
      return {
        ...(switchTo
          ? { activeSessionId: routingId, activeView: { type: 'chat' } as ActiveView }
          : {}),
        sessions: { ...state.sessions, [routingId]: newSession },
        recentSessionIds,
        sessionEngines
      }
    }),

  setLastSelectedEngineId: (engineId) => {
    localStorage.setItem('lastSelectedEngineId', engineId)
    set({ lastSelectedEngineId: engineId })
  },

  setSelectedEngine: (engineId) =>
    set((state) => {
      const id = state.activeSessionId
      const session = id ? state.sessions[id] : undefined
      if (!id || !session || session.sdkActive || session.status.sessionId || session.isHistorical)
        return {}
      if (session.selectedEngineId === engineId) return {}
      const model = resolveEngineDefaultModel(
        engineId,
        state.availableModels,
        state.opencodeDefaultModel,
        state.piDefaultModel
      )
      const modelInfo = state.availableModels.find(
        (candidate) => candidate.value === model && isModelForEngine(candidate, engineId)
      )
      const sessionEngines = {
        ...state.sessionEngines,
        [id]: { engineId, model: engineMeta(engineId).decodeModelValue(model) }
      }
      saveSessionConfig(state, { sessionEngines })
      localStorage.setItem('lastSelectedEngineId', engineId)
      return {
        sessions: updateSession(state.sessions, id, () => ({
          selectedEngineId: engineId,
          selectedModel: model,
          reasoningVariant: null,
          status: {
            ...session.status,
            engineId,
            capabilities: engineMeta(engineId).seedCapabilities(model, modelInfo)
          }
        })),
        sessionEngines,
        lastSelectedEngineId: engineId
      }
    }),

  setOpencodeDefaultModel: (model) =>
    set({ opencodeDefaultModel: model || OPENCODE_DEFAULT_MODEL }),

  setPiDefaultModel: (model) => set({ piDefaultModel: model || PI_DEFAULT_MODEL }),

  reloadModels: () => set((s) => ({ modelReloadNonce: s.modelReloadNonce + 1 })),

  loadHistoricalSession: (
    routingId,
    messages,
    cwd,
    taskNotifications?,
    subagentMessages?,
    statusLine?,
    warnings?
  ) =>
    set((state) => {
      // Re-hydrating an evicted entry: start from the resident (lightweight)
      // entry so draft / effort / thinking / permission mode survive the round
      // trip. A genuinely fresh load starts from a blank session.
      const prior = state.sessions[routingId]
      const base = prior?.evicted ? prior : createEmptySession(cwd)
      // Per-session model memory: restore the persisted model when present, so
      // reopening a session brings back the model you last used in it. The engine
      // is restored too (an opencode session reopens as opencode). When NO model
      // was persisted (fresh load), fall back to the session ENGINE's default —
      // engine-aware, never Claude's "default" on an opencode session (the bug).
      const persistedEntry = state.sessionEngines[routingId]
      const persistedEngineId = persistedEntry?.engineId ?? 'claude'
      const persistedModelRef = persistedEntry?.model
      // For opencode the picker value is "vendorId/modelId"; for claude it's the modelId.
      const persistedModel: string | undefined = persistedModelRef
        ? engineMeta(persistedEngineId).encodeModelValue(persistedModelRef)
        : undefined
      const selectedModel =
        persistedModel ??
        engineMeta(persistedEngineId).defaultModelValue(
          perEngineDefaultModel(persistedEngineId, state.opencodeDefaultModel, state.piDefaultModel)
        )
      // Engine identity for the LOCAL historical-load path (gpt#3): the restored
      // engine must also drive status.engineId + capabilities, otherwise a pi /
      // opencode session reopens with Claude defaults and fork/spawn resolution
      // uses Claude semantics. (The remote-snapshot path seeds these from the
      // snapshot's own status — untouched here.)
      const modelInfo = state.availableModels.find(
        (m) => m.value === selectedModel && isModelForEngine(m, persistedEngineId)
      )
      return {
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...base,
            cwd,
            messages,
            isHistorical: true,
            evicted: false,
            taskNotifications: taskNotifications ?? base.taskNotifications,
            subagentMessages: subagentMessages ?? base.subagentMessages,
            statusLine: statusLine ?? base.statusLine ?? null,
            warnings: warnings ?? base.warnings,
            worktreeInfo: state.worktreeInfoMap[routingId] ?? base.worktreeInfo ?? null,
            selectedEngineId: persistedEngineId,
            selectedModel,
            status: {
              ...base.status,
              engineId: persistedEngineId,
              capabilities: engineMeta(persistedEngineId).seedCapabilities(selectedModel, modelInfo)
            }
          }
        }
      }
    }),

  forkFromMessage: async (sourceRoutingId, messageId) => {
    const src = useSessionStore.getState().sessions[sourceRoutingId]
    if (!src) return null
    // Last-resort guard: MessageBubble already gates the Fork button on this
    // same flag, but resolveForkAnchor below is Claude-JSONL-only, so if a
    // stale/true capability flag ever reached here for a non-Claude engine it
    // would call into a path that can't work for it.
    if (!src.status.capabilities.forkFromMessage) {
      useSessionStore
        .getState()
        .addError(
          sourceRoutingId,
          'This engine does not support branching a session from a specific message.'
        )
      return null
    }
    // The on-disk session id: a rekeyed live session or a historical load both
    // carry it as the routingId; a still-streaming session exposes it on status.
    const sourceSessionId = src.status.sessionId ?? sourceRoutingId

    // The forked message's index in its own array — Claude's resolver ignores
    // this (it resolves by messageId, the JSONL-flushed uuid); pi's resolver
    // is POSITION-based instead (no stable id survives a live→disk round
    // trip — see resolveForkAnchor's/findPiForkAnchorEntryId's doc comments),
    // so it's computed BEFORE the anchor call (not after, as it used to be)
    // so it can be threaded through for that engine.
    const idx = src.messages.findIndex((m) => m.id === messageId)

    const result = await window.api.resolveForkAnchor(
      sourceSessionId,
      src.cwd,
      messageId,
      src.status.engineId,
      idx
    )
    if (!result?.anchorUuid) {
      // The message isn't flushed to the transcript yet (or vanished). Surface
      // it on the source session rather than silently doing nothing.
      useSessionStore
        .getState()
        .addError(
          sourceRoutingId,
          'Cannot branch from this message yet — it has not been saved to the transcript.'
        )
      return null
    }
    const anchorUuid = result.anchorUuid

    // Optimistically seed the branch with messages 1..N (deep-ish copy so edits
    // to one session never mutate the other). cli.js performs the same slice by
    // uuid when it materializes the fork, so the displayed history will match
    // (pi's own clone/fork RPCs perform the equivalent truncation on its side).
    const seeded = (idx >= 0 ? src.messages.slice(0, idx + 1) : src.messages).map((m) => ({
      ...m,
      content: m.content.map((b) => ({ ...b }))
    }))

    const newRoutingId = crypto.randomUUID()
    set((s) => {
      const recentSessionIds = [
        newRoutingId,
        ...s.recentSessionIds.filter((id) => id !== newRoutingId)
      ].slice(0, s.settings.maxRecentSessions)
      // Engine identity for the fork (gpt#3): the branch inherits the source's
      // engine, so its status.engineId/capabilities and the persisted
      // sessionEngines entry must match — otherwise the fork spawns Claude with
      // a pi/opencode model (InputBox.doSend reads selectedEngineId).
      const forkEngineId = src.selectedEngineId
      const sessionEngines = {
        ...s.sessionEngines,
        [newRoutingId]: {
          engineId: forkEngineId,
          model: engineMeta(forkEngineId).decodeModelValue(src.selectedModel)
        }
      }
      saveSessionConfig(s, { recentSessionIds, sessionEngines })
      const baseSession = createEmptySession(src.cwd)
      return {
        sessions: {
          ...s.sessions,
          [newRoutingId]: {
            ...baseSession,
            messages: seeded,
            // Render the seeded history immediately; the fork-spawn path in
            // InputBox (gated on forkOrigin) overrides the resume target.
            isHistorical: true,
            forkOrigin: { sourceSessionId, anchorUuid },
            // Inherit the source's engine/model/permission/effort/thinking choices.
            selectedEngineId: forkEngineId,
            selectedModel: src.selectedModel,
            permissionMode: src.permissionMode,
            effort: src.effort,
            thinkingMode: src.thinkingMode,
            reasoningVariant: src.reasoningVariant,
            status: {
              ...baseSession.status,
              engineId: src.status.engineId,
              capabilities: src.status.capabilities
            }
          }
        },
        activeSessionId: newRoutingId,
        activeView: { type: 'chat' } as ActiveView,
        recentSessionIds,
        sessionEngines
      }
    })
    return newRoutingId
  },

  markSdkActive: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        sdkActive: true,
        isHistorical: false
      }))
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
      const recentSessionIds = [
        routingId,
        ...state.recentSessionIds.filter((id) => id !== routingId)
      ].slice(0, state.settings.maxRecentSessions)
      saveSessionConfig(state, { recentSessionIds })
      return { recentSessionIds }
    }),

  removeRecentSession: (routingId) =>
    set((state) => {
      const recentSessionIds = state.recentSessionIds.filter((id) => id !== routingId)
      saveSessionConfig(state, { recentSessionIds })
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
      saveSessionConfig(state, { customTitles })
      return { customTitles }
    }),

  pinSession: (routingId) =>
    set((state) => {
      if (state.pinnedSessionIds.includes(routingId)) return state
      const pinnedSessionIds = [...state.pinnedSessionIds, routingId]
      const recentSessionIds = state.recentSessionIds.filter((id) => id !== routingId)
      saveSessionConfig(state, { pinnedSessionIds, recentSessionIds })
      return { pinnedSessionIds, recentSessionIds }
    }),

  unpinSession: (routingId) =>
    set((state) => {
      const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== routingId)
      const recentSessionIds = [
        routingId,
        ...state.recentSessionIds.filter((id) => id !== routingId)
      ].slice(0, state.settings.maxRecentSessions)
      saveSessionConfig(state, { pinnedSessionIds, recentSessionIds })
      return { pinnedSessionIds, recentSessionIds }
    }),

  reorderPinnedSessions: (ids) =>
    set((state) => {
      saveSessionConfig(state, { pinnedSessionIds: ids })
      return { pinnedSessionIds: ids }
    }),

  hideSession: (sessionId) =>
    set((state) => {
      if (state.hiddenSessionIds.includes(sessionId)) return state
      const hiddenSessionIds = [...state.hiddenSessionIds, sessionId]
      saveSessionConfig(state, { hiddenSessionIds })
      return { hiddenSessionIds }
    }),

  unhideSession: (sessionId) =>
    set((state) => {
      if (!state.hiddenSessionIds.includes(sessionId)) return state
      const hiddenSessionIds = state.hiddenSessionIds.filter((id) => id !== sessionId)
      saveSessionConfig(state, { hiddenSessionIds })
      return { hiddenSessionIds }
    }),

  hideProject: (projectKey) =>
    set((state) => {
      if (!projectKey || state.hiddenProjectKeys.includes(projectKey)) return state
      const hiddenProjectKeys = [...state.hiddenProjectKeys, projectKey]
      saveSessionConfig(state, { hiddenProjectKeys })
      return { hiddenProjectKeys }
    }),

  unhideProject: (projectKey) =>
    set((state) => {
      if (!state.hiddenProjectKeys.includes(projectKey)) return state
      const hiddenProjectKeys = state.hiddenProjectKeys.filter((k) => k !== projectKey)
      saveSessionConfig(state, { hiddenProjectKeys })
      return { hiddenProjectKeys }
    }),

  deleteSession: async (sessionId, projectKey, engineId) => {
    await window.api.deleteSession(sessionId, projectKey, engineId)
    // Also scrub any references to this session from persisted config + in-memory state
    useSessionStore.setState((state) => {
      const recentSessionIds = state.recentSessionIds.filter((id) => id !== sessionId)
      const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId)
      const hiddenSessionIds = state.hiddenSessionIds.filter((id) => id !== sessionId)
      const customTitles = { ...state.customTitles }
      delete customTitles[sessionId]
      const worktreeInfoMap = { ...state.worktreeInfoMap }
      delete worktreeInfoMap[sessionId]
      // The persisted engine/model row is keyed by routingId too — without this
      // it survives every delete and accumulates forever (RN8).
      const sessionEngines = { ...state.sessionEngines }
      delete sessionEngines[sessionId]
      const sessions = { ...state.sessions }
      delete sessions[sessionId]
      // Drop the session from its directory group; drop the group itself if now empty
      const directories = state.directories
        .map((g) =>
          g.sessions.some((s) => s.sessionId === sessionId)
            ? { ...g, sessions: g.sessions.filter((s) => s.sessionId !== sessionId) }
            : g
        )
        .filter((g) => g.sessions.length > 0)
      const activeSessionId = state.activeSessionId === sessionId ? null : state.activeSessionId
      saveSessionConfig(state, {
        recentSessionIds,
        pinnedSessionIds,
        hiddenSessionIds,
        customTitles,
        worktreeInfoMap,
        sessionEngines
      })
      return {
        recentSessionIds,
        pinnedSessionIds,
        hiddenSessionIds,
        customTitles,
        worktreeInfoMap,
        sessionEngines,
        sessions,
        directories,
        activeSessionId
      }
    })
  },

  deleteProject: async (projectKey) => {
    await window.api.deleteProject(projectKey)
    // Also delete any opencode sessions in this group so they don't reappear on the next poll.
    const opencodeSessions =
      useSessionStore
        .getState()
        .directories.find((g) => g.projectKey === projectKey)
        ?.sessions.filter((s) => s.engineId === 'opencode') ?? []
    if (opencodeSessions.length > 0) {
      await Promise.allSettled(
        opencodeSessions.map((s) => window.api.deleteSession(s.sessionId, projectKey, 'opencode'))
      )
    }
    // Collect all session IDs in this project (both on-disk group members and live in-memory
    // sessions sharing the project's cwd) so we can purge them from every piece of state.
    useSessionStore.setState((state) => {
      const group = state.directories.find((g) => g.projectKey === projectKey)
      const projectCwd = group?.cwd
      const projectSessionIds = new Set(group?.sessions.map((s) => s.sessionId) ?? [])
      if (projectCwd) {
        for (const [id, sess] of Object.entries(state.sessions)) {
          if (sess.cwd === projectCwd) projectSessionIds.add(id)
        }
      }
      const recentSessionIds = state.recentSessionIds.filter((id) => !projectSessionIds.has(id))
      const pinnedSessionIds = state.pinnedSessionIds.filter((id) => !projectSessionIds.has(id))
      const hiddenSessionIds = state.hiddenSessionIds.filter((id) => !projectSessionIds.has(id))
      const hiddenProjectKeys = state.hiddenProjectKeys.filter((k) => k !== projectKey)
      const customTitles = { ...state.customTitles }
      const worktreeInfoMap = { ...state.worktreeInfoMap }
      // Persisted engine/model rows are keyed by routingId — purge them with the
      // rest of the project's state so they can't accumulate forever (RN8).
      const sessionEngines = { ...state.sessionEngines }
      const sessions = { ...state.sessions }
      for (const id of projectSessionIds) {
        delete customTitles[id]
        delete worktreeInfoMap[id]
        delete sessionEngines[id]
        delete sessions[id]
      }
      const directories = state.directories.filter((g) => g.projectKey !== projectKey)
      const activeSessionId =
        state.activeSessionId && projectSessionIds.has(state.activeSessionId)
          ? null
          : state.activeSessionId
      saveSessionConfig(state, {
        recentSessionIds,
        pinnedSessionIds,
        hiddenSessionIds,
        hiddenProjectKeys,
        customTitles,
        worktreeInfoMap,
        sessionEngines
      })
      return {
        recentSessionIds,
        pinnedSessionIds,
        hiddenSessionIds,
        hiddenProjectKeys,
        customTitles,
        worktreeInfoMap,
        sessionEngines,
        sessions,
        directories,
        activeSessionId
      }
    })
  },

  addMessage: (routingId, message) =>
    set((state) => {
      const sessions = ensureSession(state.sessions, routingId)
      const session = sessions[routingId]

      const idx = session.messages.findIndex((m) => m.id === message.id)
      const hasNonThinking = message.content.some((b) => b.type === 'text' || b.type === 'tool_use')
      const sealedDuration =
        session.thinkingStartedAt && hasNonThinking ? Date.now() - session.thinkingStartedAt : null

      let committed: ChatMessage =
        idx < 0
          ? message
          : {
              ...message,
              content: mergeContentBlocks(session.messages[idx].content, message.content)
            }

      // Record the finished thinking span's duration on the block itself, so each
      // thinking block renders its OWN "Thought for Xs" instead of all reading a
      // single per-session scalar (Low). The span may seal here (all-in-one
      // message) or earlier in appendStreamingText (streaming), in which case the
      // duration was parked in pendingThinkingDurationMs and is consumed now.
      const durationToStamp = sealedDuration ?? session.pendingThinkingDurationMs
      let didStamp = false
      if (durationToStamp != null) {
        const content = committed.content.map((b) => {
          if (b.type === 'thinking' && b.durationMs == null) {
            didStamp = true
            return { ...b, durationMs: durationToStamp }
          }
          return b
        })
        if (didStamp) committed = { ...committed, content }
      }

      const updatedMessages =
        idx < 0
          ? [...session.messages, committed]
          : session.messages.map((m, i) => (i === idx ? committed : m))

      return {
        sessions: {
          ...sessions,
          [routingId]: {
            ...session,
            messages: updatedMessages,
            streamingText: '',
            ...(sealedDuration != null
              ? { streamingThinking: '', thinkingDurationMs: sealedDuration, thinkingStartedAt: null }
              : {}),
            // Keep the parked duration only if it wasn't attached to a block here.
            pendingThinkingDurationMs: didStamp ? null : durationToStamp
          }
        }
      }
    }),

  addUserMessage: (routingId, id, text, planContent?, attachments?) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const recentSessionIds = [
        routingId,
        ...state.recentSessionIds.filter((rid) => rid !== routingId)
      ].slice(0, state.settings.maxRecentSessions)
      saveSessionConfig(state, { recentSessionIds })

      const content: ContentBlock[] = []
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          if (att.mediaType === 'application/pdf') {
            content.push({
              type: 'document',
              mediaType: 'application/pdf',
              base64Data: att.base64Data,
              fileName: att.fileName
            })
          } else {
            content.push({
              type: 'image',
              mediaType: att.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              base64Data: att.base64Data,
              fileName: att.fileName
            })
          }
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
        const duration = Date.now() - session.thinkingStartedAt
        return {
          sessions: updateSession(sessions, routingId, () => ({
            streamingText: session.streamingText + text,
            streamingThinking: '',
            thinkingDurationMs: duration,
            // Park the sealed span's duration so the addMessage that finalizes
            // THIS thinking block stamps its own durationMs (per-block "Thought
            // for Xs"), not a shared per-session scalar. thinkingStartedAt is
            // nulled here, so without this the consuming addMessage has nothing
            // to read.
            pendingThinkingDurationMs: duration,
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
      sessions: updateSession(state.sessions, routingId, (s) => {
        const updates: Partial<PerSessionState> = {
          status,
          // Update top-level cwd when SDK reports a new working directory (e.g. worktree enter/exit)
          ...(status.cwd && status.cwd !== s.cwd ? { cwd: status.cwd } : {})
        }

        // When the turn ends (interrupt, error, natural completion), seal any
        // in-flight thinking state. Natural completions usually finalize via
        // appendStreamingText / addMessage before this point — this is the
        // safety net for paths (interrupt, abrupt termination) that never send
        // a closing message.
        if (status.state === 'idle') {
          if (s.thinkingStartedAt) {
            updates.streamingThinking = ''
            updates.thinkingDurationMs = Date.now() - s.thinkingStartedAt
            updates.thinkingStartedAt = null
          }

          // Foreground subagent buffers: if a Task tool is foreground (not
          // run_in_background) and still has a streaming buffer, the parent
          // going idle means the subagent is done (interrupted or finished).
          // Background tasks keep streaming after the parent idles, so leave
          // them alone.
          const subThinking = s.subagentStreamingThinking
          const subText = s.subagentStreamingText
          const toolUseIds = new Set([...Object.keys(subThinking), ...Object.keys(subText)])
          if (toolUseIds.size > 0) {
            const bgToolUseIds = new Set<string>()
            for (const msg of s.messages) {
              for (const block of msg.content) {
                if (
                  block.type === 'tool_use' &&
                  toolUseIds.has(block.toolUseId) &&
                  block.toolInput?.run_in_background
                ) {
                  bgToolUseIds.add(block.toolUseId)
                }
              }
            }
            let nextThinking = subThinking
            let nextText = subText
            for (const toolUseId of toolUseIds) {
              if (bgToolUseIds.has(toolUseId)) continue
              if (subThinking[toolUseId]) {
                if (nextThinking === subThinking) nextThinking = { ...subThinking }
                nextThinking[toolUseId] = ''
              }
              if (subText[toolUseId]) {
                if (nextText === subText) nextText = { ...subText }
                nextText[toolUseId] = ''
              }
            }
            if (nextThinking !== subThinking) updates.subagentStreamingThinking = nextThinking
            if (nextText !== subText) updates.subagentStreamingText = nextText
          }
        }

        return updates
      })
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

  removePendingApprovalByToolUse: (routingId, toolUseId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        pendingApprovals: s.pendingApprovals.filter((a) => a.toolUseId !== toolUseId)
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

  addWarning: (routingId, warning) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        warnings: [...s.warnings, warning]
      }))
    })),

  removeWarning: (routingId, index) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        warnings: s.warnings.filter((_, i) => i !== index)
      }))
    })),

  clearWarnings: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ warnings: [] }))
    })),

  retractMessages: (routingId, messageIds) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        messages:
          messageIds.length > 0 ? s.messages.filter((m) => !messageIds.includes(m.id)) : s.messages,
        streamingText: '',
        streamingThinking: '',
        thinkingStartedAt: null
      }))
    })),

  addSandboxViolation: (routingId, message) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        sandboxViolations: [...s.sandboxViolations, message]
      }))
    })),

  removeSandboxViolation: (routingId, index) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        sandboxViolations: s.sandboxViolations.filter((_, i) => i !== index)
      }))
    })),

  appendToolResult: (routingId, toolUseId, result, isError, fileDiffs) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const messages = [...session.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'assistant') {
          const hasToolUse = msg.content.some(
            (b) => b.type === 'tool_use' && b.toolUseId === toolUseId
          )
          if (hasToolUse) {
            // Idempotent: a replayed onToolResult (reconnect catchup / history
            // replay) must not append a second tool_result block for the same
            // toolUseId. The renderer only shows the first, so the duplicates
            // were invisible while still growing the message forever (RN10).
            // First result wins — no caller replaces an existing result.
            const alreadyHasResult = msg.content.some(
              (b) => b.type === 'tool_result' && b.toolUseId === toolUseId
            )
            if (alreadyHasResult) return state
            messages[i] = {
              ...msg,
              content: [
                ...msg.content,
                {
                  type: 'tool_result',
                  toolUseId,
                  toolResult: result,
                  isError,
                  ...(fileDiffs ? { fileDiffs } : {})
                }
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
        // Clear live bash output for this tool now that it's done
        const bashOutputs = notification.toolUseId
          ? (({ [notification.toolUseId]: _, ...rest }) => rest)(s.bashOutputs)
          : s.bashOutputs
        return {
          taskNotifications: [...s.taskNotifications, notification],
          stoppingTaskIds,
          bashOutputs
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
      const current = [...(session.subagentMessages[toolUseId] || [])]

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

  appendSubagentToolResult: (
    routingId,
    toolUseId,
    toolResultToolUseId,
    result,
    isError,
    fileDiffs
  ) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session) return state

      const msgs = session.subagentMessages[toolUseId] || []
      const updated = [...msgs]
      for (let i = updated.length - 1; i >= 0; i--) {
        const msg = updated[i]
        if (msg.role !== 'assistant') continue
        const hasToolUse = msg.content.some(
          (b) => b.type === 'tool_use' && b.toolUseId === toolResultToolUseId
        )
        if (hasToolUse) {
          updated[i] = {
            ...msg,
            content: [
              ...msg.content,
              {
                type: 'tool_result',
                toolUseId: toolResultToolUseId,
                toolResult: result,
                isError,
                ...(fileDiffs ? { fileDiffs } : {})
              }
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

  setBashOutput: (routingId, toolUseId, output, totalLines, totalBytes) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        bashOutputs: { ...s.bashOutputs, [toolUseId]: { output, totalLines, totalBytes } }
      }))
    })),

  clearBashOutput: (routingId, toolUseId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => {
        const { [toolUseId]: _, ...rest } = s.bashOutputs
        return { bashOutputs: rest }
      })
    })),

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
        return {
          openedTaskToolUseIds: updated,
          rightPanel: updated.length > 0 ? ('task' as const) : ('none' as const)
        }
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

  setEngineConfig: (config) => set({ engineConfig: config }),

  // Apply settings from an external source (another instance) — no save back to disk
  applyExternalSettings: (raw) =>
    set(() => {
      const settings = { ...DEFAULT_SETTINGS, ...(raw as Partial<AppSettings>) }
      applyTheme(settings.theme)
      return { settings }
    }),

  // Apply session config from an external source — no save back to disk.
  // Only overwrite a field when the payload GENUINELY carries it: the
  // file-watcher `config:sessions-changed` payload is the on-disk sessions.json
  // which strips sessionEngines (it lives in the DB), so `?? {}` would zero the
  // receiving instance's engine/model map on every external sync (H15). Treat a
  // missing key as "leave the current value intact".
  applyExternalSessionConfig: (config) =>
    set((state) => ({
      recentSessionIds:
        'recentSessions' in config ? (config.recentSessions ?? []) : state.recentSessionIds,
      pinnedSessionIds:
        'pinnedSessions' in config ? (config.pinnedSessions ?? []) : state.pinnedSessionIds,
      customTitles: 'customTitles' in config ? (config.customTitles ?? {}) : state.customTitles,
      worktreeInfoMap:
        'worktreeInfoMap' in config ? (config.worktreeInfoMap ?? {}) : state.worktreeInfoMap,
      hiddenSessionIds:
        'hiddenSessions' in config ? (config.hiddenSessions ?? []) : state.hiddenSessionIds,
      hiddenProjectKeys:
        'hiddenProjects' in config ? (config.hiddenProjects ?? []) : state.hiddenProjectKeys,
      sessionEngines:
        'sessionEngines' in config ? (config.sessionEngines ?? {}) : state.sessionEngines
    })),

  // Apply a full state snapshot from the remote server (initial sync)
  applyRemoteSnapshot: (snapshot) =>
    set(() => {
      // Rebuild per-session state from the snapshot
      const sessions: Record<string, PerSessionState> = {}
      for (const [id, snap] of Object.entries(snapshot.sessions)) {
        sessions[id] = {
          ...EMPTY_SESSION_STATE,
          cwd: snap.cwd,
          messages: snap.messages,
          streamingText: snap.streamingText,
          streamingThinking: snap.streamingThinking,
          status: snap.status,
          pendingApprovals: snap.pendingApprovals,
          todos: snap.todos,
          taskNotifications: snap.taskNotifications,
          taskProgressMap: snap.taskProgressMap,
          subagentMessages: snap.subagentMessages,
          subagentStreamingText: snap.subagentStreamingText,
          subagentStreamingThinking: snap.subagentStreamingThinking,
          // Coerce a stale 'localAuto' from an older (pre-removal) remote server —
          // that mode no longer exists on this client's PermissionMode union.
          permissionMode: (snap.permissionMode === 'localAuto'
            ? 'auto'
            : snap.permissionMode) as PermissionMode,
          effort: (snap.effort ?? null) as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null,
          thinkingMode: (snap.thinkingMode ?? null) as 'adaptive' | 'enabled' | 'disabled' | null,
          reasoningVariant: (snap.reasoningVariant ?? null) as string | null,
          statusLine: snap.statusLine,
          // H15 — hydrate the live engine identity so a remote first-send steers
          // the running session instead of respawning it as Claude (InputBox.doSend).
          sdkActive: snap.sdkActive ?? EMPTY_SESSION_STATE.sdkActive,
          selectedEngineId: snap.selectedEngineId ?? EMPTY_SESSION_STATE.selectedEngineId,
          selectedModel: snap.selectedModel ?? EMPTY_SESSION_STATE.selectedModel
        }
      }

      // Apply settings + theme
      const settings = { ...DEFAULT_SETTINGS, ...(snapshot.settings as Partial<AppSettings>) }
      applyTheme(settings.theme)

      return {
        sessions,
        directories: snapshot.directories,
        activeSessionId: snapshot.activeSessionId,
        settings,
        recentSessionIds: snapshot.recentSessionIds ?? [],
        pinnedSessionIds: snapshot.pinnedSessionIds ?? [],
        customTitles: snapshot.customTitles ?? {},
        worktreeInfoMap: snapshot.worktreeInfoMap ?? {},
        // H15 — hydrate the engine/model map + hidden lists so a subsequent save
        // from this client round-trips the real state, not an empty map.
        sessionEngines: snapshot.sessionEngines ?? {},
        hiddenSessionIds: snapshot.hiddenSessions ?? [],
        hiddenProjectKeys: snapshot.hiddenProjects ?? []
      }
    }),

  setPermissionMode: (mode, routingId) =>
    set((state) => {
      const id = routingId ?? state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ permissionMode: mode })) }
    }),

  // Centralizes the apply semantics for a permission-mode change, shared by
  // the desktop Shift+Tab handler and the mobile mode picker (any client that
  // lets the user pick a mode).
  //
  // Don't optimistically update for 'auto' on a LIVE session — the main
  // process may reject it and broadcast a fallback to 'default' instead.
  // Pre-spawn there is no main-side session to reject/broadcast anything
  // (manager.get() is a no-op), so update the store directly; the mode still
  // rides into spawn via createSession, and init-sync corrects it if the
  // account can't use auto.
  changePermissionMode: (routingId, next) => {
    const state = useSessionStore.getState()
    const session = state.sessions[routingId]
    const previous = session?.permissionMode ?? 'default'
    if (next !== 'auto' || !session?.sdkActive) state.setPermissionMode(next, routingId)
    window.api.setPermissionMode(routingId, next).catch(() => {
      // SDK rejected the mode change — revert to previous mode (the main
      // process already sent the reverted mode via session:permission-mode).
      state.setPermissionMode(previous, routingId)
    })
  },

  setEffort: (effort, routingId) =>
    set((state) => {
      const id = routingId ?? state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ effort })) }
    }),

  setThinkingMode: (mode, routingId) =>
    set((state) => {
      const id = routingId ?? state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ thinkingMode: mode })) }
    }),

  setReasoningVariant: (variant, routingId) =>
    set((state) => {
      const id = routingId ?? state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ reasoningVariant: variant })) }
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

  // Phase 7 Pass 2 — engine-neutral metering snapshot. Mirrors setStatusLine
  // (including the pre-rekey routingId fallback). Additive: does not touch
  // statusLine, so the Claude status-line rendering is unchanged.
  setMetering: (routingId, data) =>
    set((state) => {
      if (state.sessions[routingId]) {
        return { sessions: updateSession(state.sessions, routingId, () => ({ metering: data })) }
      }
      const newId = rekeyMap.get(routingId)
      if (newId && state.sessions[newId]) {
        return { sessions: updateSession(state.sessions, newId, () => ({ metering: data })) }
      }
      return {}
    }),

  appendQueuedText: (text) =>
    set((state) => {
      const id = state.activeSessionId
      if (!id) return {}
      return {
        sessions: updateSession(state.sessions, id, (s) => ({
          queuedText: s.queuedText ? s.queuedText + '\n' + text : text
        }))
      }
    }),

  setQueuedText: (routingId, text) =>
    set((state) => {
      if (!state.sessions[routingId]) return state
      return {
        sessions: updateSession(state.sessions, routingId, (s) => ({
          queuedText: s.queuedText ? s.queuedText + '\n' + text : text
        }))
      }
    }),

  clearQueuedText: () =>
    set((state) => {
      const id = state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ queuedText: '' })) }
    }),

  consumeQueuedText: (routingId) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (!session || !session.queuedText) return state
      const userMsg = {
        // crypto.randomUUID (not Date.now) so two steers within the same ms can't
        // collide into a duplicate React key (Low).
        id: `steer-${crypto.randomUUID()}`,
        role: 'user' as const,
        content: [{ type: 'text' as const, text: session.queuedText }],
        timestamp: Date.now()
      }
      return {
        sessions: {
          ...state.sessions,
          [routingId]: {
            ...session,
            messages: [...session.messages, userMsg],
            queuedText: ''
          }
        }
      }
    }),

  setDraftText: (text) =>
    set((state) => {
      const id = state.activeSessionId
      if (!id) return {}
      return { sessions: updateSession(state.sessions, id, () => ({ draftText: text })) }
    }),

  // Draft attachments are keyed by routingId (captured at drop time) rather than
  // read from activeSessionId, so an async file read that completes after the
  // user switches sessions lands on the session it was dropped into — never the
  // now-active one (gpt#14). Unknown ids are a no-op.
  addDraftAttachments: (routingId, attachments) =>
    set((state) => {
      if (!state.sessions[routingId] || attachments.length === 0) return {}
      return {
        sessions: updateSession(state.sessions, routingId, (s) => ({
          draftAttachments: [...s.draftAttachments, ...attachments]
        }))
      }
    }),

  removeDraftAttachment: (routingId, id) =>
    set((state) => {
      if (!state.sessions[routingId]) return {}
      return {
        sessions: updateSession(state.sessions, routingId, (s) => ({
          draftAttachments: s.draftAttachments.filter((a) => a.id !== id)
        }))
      }
    }),

  setDraftAttachments: (routingId, attachments) =>
    set((state) => {
      if (!state.sessions[routingId]) return {}
      return {
        sessions: updateSession(state.sessions, routingId, () => ({ draftAttachments: attachments }))
      }
    }),

  setSelectedModel: (model) =>
    set((state) => {
      const id = state.activeSessionId
      if (!id) return {}
      const session = state.sessions[id]
      const targetEngine = session?.selectedEngineId ?? 'claude'

      // Persist the engine-correct ModelRef into sessionEngines so it seeds
      // selectedModel + engine on reopen.
      const existing = state.sessionEngines[id]
      const modelRef = engineMeta(targetEngine).decodeModelValue(model)
      const sessionEngines = existing
        ? {
            ...state.sessionEngines,
            [id]: { ...existing, model: modelRef }
          }
        : state.sessionEngines
      if (existing) saveSessionConfig(state, { sessionEngines })

      // Always reset reasoningVariant on model change — different models have different variants.
      const patch: Partial<PerSessionState> = { selectedModel: model, reasoningVariant: null }

      return {
        sessions: updateSession(state.sessions, id, () => patch),
        sessionEngines
      }
    }),

  setSlashCommands: (commands) => set({ slashCommands: commands }),
  setCustomCommands: (commands) => set({ customCommands: commands }),
  setSdkSkillNames: (names) => set({ sdkSkillNames: names }),

  setAvailableModels: (models) => set({ availableModels: models }),

  setAccountUsage: (data) => set({ accountUsage: data }),

  // Native OAuth (ADR-014). signIn/submit return the "authorizing"/result
  // snapshot synchronously; the terminal transition arrives via onAuthState.
  setAuthState: (data) => set({ authState: data }),
  setAuthSource: (source) => set({ authSource: source }),
  setVendorAuth: (map) => set({ vendorAuth: map }),
  setAccountsState: (data) => set({ accountsState: data }),
  respawnAllSessions: () =>
    set((s) => ({
      sessions: Object.fromEntries(
        Object.entries(s.sessions).map(([id, sess]) => [id, { ...sess, sdkActive: false }])
      )
    })),
  signIn: async () => {
    set({ authState: { status: 'authorizing', account: null, error: null } })
    const result = await window.api.signIn()
    set({ authState: result })
  },
  submitOAuthCode: async (code) => {
    const result = await window.api.submitOAuthCode(code)
    set({ authState: result })
  },
  cancelSignIn: async () => {
    await window.api.cancelSignIn()
    set((s) => ({
      authState: s.authState ? { ...s.authState, status: 'idle', error: null } : null
    }))
  },
  setVendorOAuth: (state) => set({ vendorOAuth: state }),
  cancelVendorOAuth: () => {
    // Invalidate any in-flight `auto` flow so its late-resolving callback can't
    // re-set vendorOAuth after the user cancelled (SHOULD-FIX 4).
    vendorOAuthFlowToken++
    // Release the main-side server held open for the authorize → callback flow,
    // otherwise an abandoned (never-completed) flow leaks the opencode process.
    // Killing it also unblocks the pending callback long-poll.
    const engineId = useSessionStore.getState().vendorOAuth?.engineId as EngineId | undefined
    if (engineId) void window.api.vendorAuthOauthCancel(engineId).catch(() => {})
    set({ vendorOAuth: null })
  },
  setVendorAuthRequired: (routingId, data) =>
    set((s) => ({
      sessions: updateSession(s.sessions, routingId, () => ({ vendorAuthRequired: data }))
    })),
  clearVendorAuthRequired: (routingId) =>
    set((s) => ({
      sessions: updateSession(s.sessions, routingId, () => ({ vendorAuthRequired: null }))
    })),
  authorizeVendorOAuth: async (engineId, vendorId) => {
    try {
      const allOptions = await window.api.vendorAuthListOptions(engineId)
      const vendorOptions = allOptions[vendorId] ?? []
      const firstOAuthOption = vendorOptions.find((o) => o.type === 'oauth')
      if (!firstOAuthOption) return { ok: false }
      const methodIdx = vendorOptions.indexOf(firstOAuthOption)
      const result = await window.api.vendorAuthOauthAuthorize(engineId, vendorId, methodIdx)
      window.open(result.url, '_blank')
      if (result.method === 'auto') {
        // Capture the flow token AFTER authorize so a Cancel during authorize is
        // honored too. Any post-await state-set bails if the token moved.
        const token = ++vendorOAuthFlowToken
        const superseded = (): boolean => vendorOAuthFlowToken !== token
        useSessionStore.getState().setVendorOAuth({
          engineId,
          vendorId,
          stage: 'waiting',
          instructions: result.instructions
        })
        try {
          // Long-lived: opencode's vendor plugin hosts the loopback/device flow
          // and we await its completion WITHOUT supplying a code.
          const ok = await window.api.vendorAuthOauthCallback(engineId, vendorId, methodIdx)
          if (superseded()) return { ok: false }
          if (ok) {
            useSessionStore.getState().setVendorOAuth(null)
            // NOTE: do NOT write into the global `vendorAuth` map here — it is
            // Claude/anthropic-specific (AuthBanner reads vendorAuth.anthropic).
            // The opencode Settings section re-probes its own local state via
            // refresh(), and OpencodeAuthProvider.oauthCallback already
            // invalidates the model cache main-side. (REQUIRED 1.)
            return { ok: true }
          }
          useSessionStore.getState().setVendorOAuth({
            engineId,
            vendorId,
            stage: 'error',
            instructions: result.instructions
          })
          return { ok: false }
        } catch {
          if (superseded()) return { ok: false }
          useSessionStore.getState().setVendorOAuth({
            engineId,
            vendorId,
            stage: 'error',
            instructions: result.instructions
          })
          return { ok: false }
        }
      } else {
        // method === 'code': return needsPaste so the caller can show paste box
        return {
          ok: false,
          needsPaste: { url: result.url, method: methodIdx, instructions: result.instructions }
        }
      }
    } catch {
      return { ok: false }
    }
  },
  retrySend: async (routingId, prompt) => {
    const session = useSessionStore.getState().sessions[routingId]
    if (!session) return
    // Both engines cache vendor credentials for their process's lifetime, so a
    // post-login retry MUST respawn (createSession → session-manager cancels the
    // old session and spawns a fresh backend that re-reads the new credential):
    //   - Claude: the persistent cli.js process caches the OAuth token.
    //   - opencode: the `opencode serve` process caches the instantiated AI-SDK
    //     provider (auth baked in) for its lifetime — verified in opencode-src
    //     provider/provider.ts (InstanceState reads auth.all() once at init; the
    //     /oauth/callback + PUT /auth handlers persist to disk but never
    //     invalidate that cache). cancel() releases the server ref; when it's the
    //     last ref the process is killed, so the recreate spawns a fresh server
    //     that re-reads auth.json. Plain sendPrompt would re-hit the stale,
    //     still-401ing backend.
    // opencode sessions always pass routingId as resumeSessionId (the server resumes
    // the prior opencode session regardless of whether messages are preloaded locally).
    const isOpencode = session.selectedEngineId === 'opencode'
    const resumeId = session.messages.length > 0 || isOpencode ? routingId : undefined
    await window.api.createSession(
      routingId,
      session.cwd || '',
      session.effort ?? undefined,
      resumeId,
      session.permissionMode,
      session.selectedModel,
      session.thinkingMode ?? undefined,
      undefined,
      undefined,
      session.selectedEngineId
    )
    set((s) => ({ sessions: updateSession(s.sessions, routingId, () => ({ sdkActive: true })) }))
    await window.api.sendPrompt(routingId, prompt)
  },
  setBlockUsage: (data) => set({ blockUsage: data }),
  setActiveView: (view) => set({ activeView: view }),
  setPluginViews: (views) => set({ pluginViews: views }),

  rekeySession: (oldId, newId) => {
    // Record the mapping so events arriving with the old routingId can be resolved
    setCapped(rekeyMap, oldId, newId, REKEY_MAP_MAX)
    set((state) => {
      if (oldId === newId) return state
      const session = state.sessions[oldId]
      if (!session) return state
      const { [oldId]: _, ...rest } = state.sessions
      const sessions = { ...rest, [newId]: session }
      const activeSessionId = state.activeSessionId === oldId ? newId : state.activeSessionId
      const recentSessionIds = state.recentSessionIds.map((id) => (id === oldId ? newId : id))
      const pinnedSessionIds = state.pinnedSessionIds.map((id) => (id === oldId ? newId : id))
      const hiddenSessionIds = state.hiddenSessionIds.map((id) => (id === oldId ? newId : id))
      const customTitles = { ...state.customTitles }
      if (customTitles[oldId]) {
        customTitles[newId] = customTitles[oldId]
        delete customTitles[oldId]
      }
      const worktreeInfoMap = { ...state.worktreeInfoMap }
      if (worktreeInfoMap[oldId]) {
        worktreeInfoMap[newId] = worktreeInfoMap[oldId]
        delete worktreeInfoMap[oldId]
      }
      // Carry over persisted engine mapping to the canonical session ID
      const sessionEngines = { ...state.sessionEngines }
      if (sessionEngines[oldId]) {
        sessionEngines[newId] = sessionEngines[oldId]
        delete sessionEngines[oldId]
      } else {
        // Always record the engine + current model, defaulting to the session's choices
        const modelRef = engineMeta(session.selectedEngineId).decodeModelValue(
          session.selectedModel
        )
        sessionEngines[newId] = {
          engineId: session.selectedEngineId,
          model: modelRef
        }
      }
      saveSessionConfig(state, {
        recentSessionIds,
        pinnedSessionIds,
        hiddenSessionIds,
        customTitles,
        worktreeInfoMap,
        sessionEngines
      })
      return {
        sessions,
        activeSessionId,
        recentSessionIds,
        pinnedSessionIds,
        hiddenSessionIds,
        customTitles,
        worktreeInfoMap,
        sessionEngines
      }
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

  // Worktree actions
  setWorktreeInfo: (routingId, info) =>
    set((state) => {
      const worktreeInfoMap = { ...state.worktreeInfoMap }
      if (info) {
        worktreeInfoMap[routingId] = info
      } else {
        delete worktreeInfoMap[routingId]
      }
      saveSessionConfig(state, { worktreeInfoMap })
      return {
        worktreeInfoMap,
        sessions: updateSession(state.sessions, routingId, (s) => ({
          worktreeInfo: info,
          // Also update cwd to worktree path so git watcher restarts on the new directory
          ...(info && info.worktreePath && s.cwd !== info.worktreePath
            ? { cwd: info.worktreePath }
            : {})
        }))
      }
    }),

  clearWorktreeInfo: (routingId) =>
    set((state) => {
      const worktreeInfoMap = { ...state.worktreeInfoMap }
      delete worktreeInfoMap[routingId]
      saveSessionConfig(state, { worktreeInfoMap })
      return {
        worktreeInfoMap,
        sessions: updateSession(state.sessions, routingId, () => ({ worktreeInfo: null }))
      }
    }),

  setQuitWorktrees: (sessions) => set({ quitWorktrees: sessions }),

  // Git actions
  setIsGitRepo: (routingId, value) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ isGitRepo: value }))
    })),

  setGitStatus: (routingId, status) =>
    set((state) => {
      const session = state.sessions[routingId]
      if (session?.cwd) setCapped(gitStatusCache, session.cwd, status, GIT_STATUS_CACHE_MAX)
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
        return {
          sessions: updateSession(state.sessions, routingId, () => ({
            gitSelectedFile: null,
            gitFileDiff: null
          }))
        }
      }
      const next = session.gitStatus.files[0]?.path ?? null
      return {
        sessions: updateSession(state.sessions, routingId, () => ({
          gitSelectedFile: next,
          gitFileDiff: null
        }))
      }
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

  // Git sync operations
  setGitSyncOperation: (routingId, op) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ gitSyncOperation: op }))
    })),

  setGitSyncError: (routingId, error) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ gitSyncError: error }))
    })),

  setGitLastFetchTime: (routingId, time) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ gitLastFetchTime: time }))
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

  // Plan review actions
  openPlanPanel: (routingId, planContent, approvalRequestId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        rightPanel: 'plan' as const,
        planReview: { planContent, approvalRequestId, comments: [] }
      }))
    })),

  closePlanPanel: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        rightPanel: 'none' as const,
        planReview: null
      }))
    })),

  // Mockup preview actions
  openMockupPanel: (routingId, directory, title) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        rightPanel: 'mockup' as const,
        mockupDir: directory,
        mockupTitle: title || null
      }))
    })),

  closeMockupPanel: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({
        rightPanel: 'none' as const,
        mockupDir: null,
        mockupTitle: null
      }))
    })),

  addPlanComment: (routingId, comment) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        planReview: s.planReview
          ? { ...s.planReview, comments: [...s.planReview.comments, comment] }
          : null
      }))
    })),

  updatePlanComment: (routingId, commentId, text) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        planReview: s.planReview
          ? {
              ...s.planReview,
              comments: s.planReview.comments.map((c) =>
                c.id === commentId ? { ...c, comment: text } : c
              )
            }
          : null
      }))
    })),

  removePlanComment: (routingId, commentId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        planReview: s.planReview
          ? { ...s.planReview, comments: s.planReview.comments.filter((c) => c.id !== commentId) }
          : null
      }))
    })),

  clearPlanComments: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, (s) => ({
        planReview: s.planReview ? { ...s.planReview, comments: [] } : null
      }))
    })),

  // Terminal actions (grouped by cwd)
  addTerminalTab: (tab) =>
    set((state) => {
      const key = normalizeCwd(tab.cwd)
      const group = state.terminalGroups[key] ?? { tabs: [], activeTabId: null }
      return {
        terminalGroups: {
          ...state.terminalGroups,
          [key]: { tabs: [...group.tabs, tab], activeTabId: tab.id }
        }
      }
    }),

  closeTerminalTab: (id) => {
    window.api.killTerminal(id)
    set((state) => {
      const groups = { ...state.terminalGroups }
      for (const [key, group] of Object.entries(groups)) {
        const idx = group.tabs.findIndex((t) => t.id === id)
        if (idx === -1) continue
        const tabs = group.tabs.filter((t) => t.id !== id)
        const activeTabId =
          group.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : group.activeTabId
        groups[key] = { tabs, activeTabId }
        break
      }
      return { terminalGroups: groups }
    })
  },

  removeTerminalTab: (id) =>
    set((state) => {
      const groups = { ...state.terminalGroups }
      for (const [key, group] of Object.entries(groups)) {
        const idx = group.tabs.findIndex((t) => t.id === id)
        if (idx === -1) continue
        const tabs = group.tabs.filter((t) => t.id !== id)
        const activeTabId =
          group.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : group.activeTabId
        groups[key] = { tabs, activeTabId }
        break
      }
      return { terminalGroups: groups }
    }),

  setActiveTerminal: (id, cwd) =>
    set((state) => {
      const key = normalizeCwd(cwd)
      const group = state.terminalGroups[key]
      if (!group) return {}
      return {
        terminalGroups: { ...state.terminalGroups, [key]: { ...group, activeTabId: id } }
      }
    }),

  setTerminalPanelOpen: (open) => set({ terminalPanelOpen: open }),

  setTerminalPanelHeight: (height) => {
    localStorage.setItem('terminalPanelHeight', String(height))
    set({ terminalPanelHeight: height })
  },

  removeTerminalGroup: (cwd) =>
    set((state) => {
      const key = normalizeCwd(cwd)
      const { [key]: _, ...rest } = state.terminalGroups
      return { terminalGroups: rest }
    }),

  // Voice actions
  setVoiceState: (routingId, state) =>
    set((s) => ({
      sessions: updateSession(s.sessions, routingId, () => ({ voiceState: state }))
    })),

  setVoiceInterimTranscript: (routingId, text) =>
    set((s) => ({
      sessions: updateSession(s.sessions, routingId, () => ({ voiceInterimTranscript: text }))
    })),

  appendVoiceTranscript: (routingId, text, isFinal) =>
    set((s) => ({
      sessions: updateSession(s.sessions, routingId, (session) => {
        if (isFinal) {
          // Final transcript: append to draft text, clear interim
          const sep = session.draftText && !session.draftText.endsWith(' ') ? ' ' : ''
          return {
            draftText: session.draftText + sep + text,
            voiceInterimTranscript: ''
          }
        }
        // Interim transcript: just update the preview
        return { voiceInterimTranscript: text }
      })
    })),

  clearVoiceTranscript: (routingId) =>
    set((s) => ({
      sessions: updateSession(s.sessions, routingId, () => ({ voiceInterimTranscript: '' }))
    })),

  // BTW side question actions
  setBtwQuestion: (routingId, question) =>
    set((s) => ({
      sessions: updateSession(s.sessions, routingId, () => ({
        btwQuestion: question,
        btwResponse: null,
        btwLoading: true
      }))
    })),

  setBtwResponse: (routingId, response) =>
    set((s) => ({
      sessions: updateSession(s.sessions, routingId, () => ({
        btwResponse: response,
        btwLoading: false
      }))
    })),

  clearBtw: (routingId) =>
    set((s) => ({
      sessions: updateSession(s.sessions, routingId, () => ({
        btwQuestion: null,
        btwResponse: null,
        btwLoading: false
      }))
    }))
}))

// ---------------------------------------------------------------------------
// Terminal selectors (derive from active session's cwd)
// ---------------------------------------------------------------------------

function getActiveCwd(state: SessionState): string | null {
  const id = state.activeSessionId
  return id ? (state.sessions[id]?.cwd ?? null) : null
}

/** Terminal tabs for the active session's cwd. */
export function selectVisibleTerminalTabs(state: SessionState): TerminalTab[] {
  const cwd = getActiveCwd(state)
  if (!cwd) return []
  return state.terminalGroups[normalizeCwd(cwd)]?.tabs ?? []
}

/** Active terminal ID for the active session's cwd. */
export function selectActiveTerminalId(state: SessionState): string | null {
  const cwd = getActiveCwd(state)
  if (!cwd) return null
  return state.terminalGroups[normalizeCwd(cwd)]?.activeTabId ?? null
}

/** All terminal tabs across all cwd groups (for keeping xterm instances mounted). */
export function selectAllTerminalTabs(state: SessionState): TerminalTab[] {
  return Object.values(state.terminalGroups).flatMap((g) => g.tabs)
}

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
 * Returns the messages/streaming for the active session's main agent.
 * Uses useShallow for shallow equality to avoid infinite re-render loops.
 */
export function useFocusedAgentData(): FocusedAgentData {
  return useSessionStore(
    useShallow((state) => {
      const id = state.activeSessionId
      if (!id || !state.sessions[id]) {
        return {
          isMain: true,
          messages: EMPTY_MESSAGES,
          streamingText: '',
          streamingThinking: '',
          thinkingStartedAt: null
        }
      }
      const session = state.sessions[id]
      return {
        isMain: true,
        messages: session.messages,
        streamingText: session.streamingText,
        streamingThinking: session.streamingThinking,
        thinkingStartedAt: session.thinkingStartedAt
      }
    })
  )
}

// ---------------------------------------------------------------------------
// Remote state snapshot (called from main process via executeJavaScript)
// ---------------------------------------------------------------------------

/**
 * Build a serializable snapshot of the current Zustand state for remote clients.
 * Strips UI-only fields (draft text, git diffs, etc.) to keep the payload lean.
 */
export function getRemoteStateSnapshot(): {
  sessions: Record<
    string,
    {
      routingId: string
      cwd: string
      messages: ChatMessage[]
      streamingText: string
      streamingThinking: string
      status: SessionStatus
      pendingApprovals: PendingApproval[]
      todos: TodoItem[]
      taskNotifications: TaskNotification[]
      taskProgressMap: Record<string, TaskProgress>
      subagentMessages: Record<string, ChatMessage[]>
      subagentStreamingText: Record<string, string>
      subagentStreamingThinking: Record<string, string>
      permissionMode: string
      effort: string
      thinkingMode: string
      reasoningVariant: string | null
      statusLine: StatusLineData | null
      slashCommands: SlashCommandInfo[]
      customCommands: SlashCommandInfo[]
      sdkSkillNames: string[]
      sdkActive: boolean
      selectedEngineId: EngineId
      selectedModel: string
    }
  >
  directories: DirectoryGroup[]
  activeSessionId: string | null
  settings: Record<string, unknown>
  recentSessionIds: string[]
  pinnedSessionIds: string[]
  customTitles: Record<string, string>
  worktreeInfoMap: Record<string, WorktreeInfo>
  sessionEngines: Record<string, { engineId: EngineId; model?: ModelRef }>
  hiddenSessions: string[]
  hiddenProjects: string[]
} {
  const state = useSessionStore.getState()
  const sessions: Record<string, unknown> = {}

  for (const [id, s] of Object.entries(state.sessions)) {
    sessions[id] = {
      routingId: id,
      cwd: s.cwd,
      messages: s.messages,
      streamingText: s.streamingText,
      streamingThinking: s.streamingThinking,
      status: s.status,
      pendingApprovals: s.pendingApprovals,
      todos: s.todos,
      taskNotifications: s.taskNotifications,
      taskProgressMap: s.taskProgressMap,
      subagentMessages: s.subagentMessages,
      subagentStreamingText: s.subagentStreamingText,
      subagentStreamingThinking: s.subagentStreamingThinking,
      permissionMode: s.permissionMode,
      effort: s.effort,
      thinkingMode: s.thinkingMode,
      reasoningVariant: s.reasoningVariant,
      statusLine: s.statusLine,
      slashCommands: state.slashCommands,
      customCommands: state.customCommands,
      sdkSkillNames: state.sdkSkillNames,
      // H15 — a remote client needs the live engine identity so its first send
      // steers the running session instead of respawning it as Claude.
      sdkActive: s.sdkActive,
      selectedEngineId: s.selectedEngineId,
      selectedModel: s.selectedModel
    }
  }

  return {
    sessions: sessions as ReturnType<typeof getRemoteStateSnapshot>['sessions'],
    directories: state.directories,
    activeSessionId: state.activeSessionId,
    settings: state.settings as unknown as Record<string, unknown>,
    recentSessionIds: state.recentSessionIds,
    pinnedSessionIds: state.pinnedSessionIds,
    customTitles: state.customTitles,
    worktreeInfoMap: state.worktreeInfoMap,
    // H15 — carry the per-session engine/model map + hidden lists so a remote
    // client's save round-trips the real state instead of an empty map that
    // would wipe every session's engine mapping on the desktop.
    sessionEngines: state.sessionEngines,
    hiddenSessions: state.hiddenSessionIds,
    hiddenProjects: state.hiddenProjectKeys
  }
}
