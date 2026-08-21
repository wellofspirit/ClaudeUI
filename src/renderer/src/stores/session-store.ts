import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { VOICE_LANGUAGES } from '../../../shared/types'
import { resolveClaudeCapabilities } from '../../../shared/model-capabilities'
import type { EffortLevel } from '../../../shared/model-capabilities'
import {
  DEFAULT_AUTONOMY_MODE,
  PERMISSION_TO_AUTONOMY,
  autoModeAvailableForEngine
} from '../../../shared/permission-modes'
import type { AutonomyMode } from '../../../shared/model-capabilities'
import {
  engineMeta,
  ENGINE_META,
  OPENCODE_DEFAULT_MODEL,
  PI_DEFAULT_MODEL,
  FREE_OPENCODE_VENDOR_IDS
} from '../../../shared/engine-meta'
export { OPENCODE_DEFAULT_MODEL, PI_DEFAULT_MODEL } from '../../../shared/engine-meta'
import type {
  ChatMessage,
  SessionStatus,
  PendingApproval,
  TodoItem,
  SentFile,
  QueuedItem,
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
  FileAttachment
} from '../../../shared/types'
/**
 * The replica owns every SEALED slice of this store (see `sealed-fields.ts`).
 *
 * Direction of the dependency, so the cycle below reads as intentional:
 * `replica.ts` imports this module for `useSessionStore` + the empty-state
 * constants, and this module imports the replica's SANCTIONED LOCAL WRITES.
 * Both directions are function calls made after both modules have evaluated —
 * nothing at either module's top level touches the other — so the ESM live
 * bindings resolve fine, and keeping the projection in one file is what lets the
 * lint brand name a single writer.
 */
import {
  seedColdSession,
  patchLocalSession,
  patchLocalApp,
  seedLocalApp,
  dropLocalSessions,
  evictLocalSessions,
  isLocallyCreated
} from './replica'

/** Normalize cwd for use as a terminal group key (strip trailing slash). */
export function normalizeCwd(cwd: string): string {
  if (cwd.length > 1 && cwd.endsWith('/')) return cwd.slice(0, -1)
  return cwd || '.'
}

type TerminalGroups = Record<string, { tabs: TerminalTab[]; activeTabId: string | null }>

/**
 * Drop one tab from whichever cwd group holds it, promoting the last remaining
 * tab when the active one goes. Shared by `closeTerminalTab` (the user closing
 * a viewer) and `removeTerminalTab` (the pty exited) — since terminals became a
 * shared pool the two do exactly the same thing to tab state, and the pty's
 * lifetime is no longer coupled to either.
 */
function dropTerminalTab(groups: TerminalGroups, id: string): { terminalGroups: TerminalGroups } {
  const next = { ...groups }
  for (const [key, group] of Object.entries(next)) {
    if (!group.tabs.some((t) => t.id === id)) continue
    const tabs = group.tabs.filter((t) => t.id !== id)
    const activeTabId =
      group.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : group.activeTabId
    next[key] = { tabs, activeTabId }
    break
  }
  return { terminalGroups: next }
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

/**
 * The per-engine default-model inputs `resolveEngineDefaultModel` needs, bundled
 * so the CONFIGURED flag always travels with the value it qualifies. Splitting
 * them (a raw string plus a boolean argument per engine) is how the two drift.
 */
export interface EngineDefaultModels {
  opencodeDefaultModel: string
  opencodeDefaultModelConfigured: boolean
  piDefaultModel: string
  piDefaultModelConfigured: boolean
}

/** Narrow a store snapshot to the default-model inputs. */
export function engineDefaultModels(state: {
  opencodeDefaultModel: string
  opencodeDefaultModelConfigured: boolean
  piDefaultModel: string
  piDefaultModelConfigured: boolean
}): EngineDefaultModels {
  return {
    opencodeDefaultModel: state.opencodeDefaultModel,
    opencodeDefaultModelConfigured: state.opencodeDefaultModelConfigured,
    piDefaultModel: state.piDefaultModel,
    piDefaultModelConfigured: state.piDefaultModelConfigured
  }
}

/**
 * The default model VALUE a fresh session on `engineId` should start from, or
 * `null` when the user's OWN configured default names a model that the engine no
 * longer offers.
 *
 * `null` is deliberately NOT a fallback signal: an explicit user-configured model
 * reference that has disappeared must surface as an error and leave the picker
 * unset, never resolve to a silent substitute (the substitute is how a no-vision
 * model got seeded onto a session whose picker showed a vision model). A BUILTIN
 * heuristic default carries no such promise, so the not-configured ladder keeps
 * falling back quietly.
 *
 * "No longer offers" requires a NON-EMPTY engine model list — an empty list means
 * discovery has not run (or every provider is off), which cannot distinguish a
 * stale reference from an unavailable engine, so the configured value passes
 * through unchanged exactly as the main-process spawn resolvers do.
 */
export function resolveEngineDefaultModel(
  engineId: EngineId,
  models: ModelInfo[],
  defaults: EngineDefaultModels
): string | null {
  if (engineId === 'opencode') {
    const oc = models.filter((model) => isModelForEngine(model, 'opencode'))
    if (defaults.opencodeDefaultModelConfigured && oc.length > 0) {
      return oc.some((model) => model.value === defaults.opencodeDefaultModel)
        ? defaults.opencodeDefaultModel
        : null
    }
    return (
      resolveOpencodeModel(models, defaults.opencodeDefaultModel) ??
      engineMeta(engineId).defaultModelValue(defaults.opencodeDefaultModel)
    )
  }
  if (engineId === 'pi') {
    const piModels = models.filter((model) => isModelForEngine(model, 'pi'))
    if (defaults.piDefaultModelConfigured && piModels.length > 0) {
      return piModels.some((model) => model.value === defaults.piDefaultModel)
        ? defaults.piDefaultModel
        : null
    }
    return (
      piModels.find((model) => model.value === defaults.piDefaultModel)?.value ??
      piModels[0]?.value ??
      engineMeta(engineId).defaultModelValue(defaults.piDefaultModel)
    )
  }
  return engineMeta(engineId).defaultModelValue()
}

/** The configured-but-missing default model for `engineId`, for error copy. */
function configuredDefaultModelOf(engineId: EngineId, defaults: EngineDefaultModels): string {
  return engineId === 'pi' ? defaults.piDefaultModel : defaults.opencodeDefaultModel
}

/**
 * The banner shown when an engine's CONFIGURED default model has vanished. Names
 * the model and the settings surface that owns it — an unactionable "model not
 * found" is what made the silent substitute look preferable in the first place.
 */
export function staleDefaultModelMessage(engineId: EngineId, model: string): string {
  return (
    `The configured ${engineMeta(engineId).label} default model "${model}" is no longer available. ` +
    `Pick a model in the picker, or change the default in Settings → Engines → ${engineMeta(engineId).label}.`
  )
}

/** localStorage key holding the last model picked for one engine. */
function lastSelectedModelKey(engineId: EngineId): string {
  return `lastSelectedModel:${engineId}`
}

/**
 * Load the per-engine model stickiness map. One plain-string key per engine
 * (matching `lastSelectedEngineId`'s style) rather than one JSON blob, so a
 * corrupt entry can only lose that engine's memory.
 */
function loadLastSelectedModels(): Partial<Record<EngineId, string>> {
  const out: Partial<Record<EngineId, string>> = {}
  for (const id of Object.keys(ENGINE_META) as EngineId[]) {
    const value = localStorage.getItem(lastSelectedModelKey(id))
    if (value) out[id] = value
  }
  return out
}

/**
 * Derived-state scanners moved to `shared/derive-session.ts` (SyncCore phase 4a):
 * todos / sentFiles are derived inside the shared reducer now, and core plus every
 * client replica must derive identically. Re-exported so existing import sites
 * (useClaudeEvents, tests) are unchanged.
 */
export { buildTodosFromMessages, buildSentFilesFromMessages } from '../../../shared/derive-session'
import { buildTodosFromMessages, buildSentFilesFromMessages } from '../../../shared/derive-session'

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
  /**
   * Autonomy mode new sessions start in, for every engine. Defaults to
   * {@link DEFAULT_AUTONOMY_MODE} ('full' → the classifier-gated `auto`).
   *
   * ClaudeUI-owned on purpose. This used to be read straight from
   * `~/.claude/settings.json permissions.defaultMode`, which meant Claude Code's
   * config silently governed opencode and pi sessions too, and that changing the
   * default in ClaudeUI rewrote the user's bare-CLI behaviour. Existing
   * `defaultMode` values are still honoured — once, as the seed for this
   * setting — but from then on the two are independent.
   */
  defaultAutonomyMode: AutonomyMode
}

/** Exported for the replica's settings projection (one merge base, not two). */
export const DEFAULT_SETTINGS: AppSettings = {
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
  toolOutputMaxChars: 5000,
  defaultAutonomyMode: DEFAULT_AUTONOMY_MODE
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
    piEngineConfig,
    userPermissions
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
      .catch((): import('../../../shared/types').EngineConfig => ({})),
    // `permissions.defaultMode` (user scope) seeds the mode of sessions created
    // in this app run. Remote-registered channel, so the web client hydrates
    // identically.
    window.api
      .loadClaudePermissions('user')
      .catch((): import('../../../shared/types').ClaudePermissions | null => null)
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
  // Always a fresh object: the normalization below (voiceLanguage validation,
  // defaultAutonomyMode seeding) MUTATES `settings`, and aliasing the
  // module-level DEFAULT_SETTINGS here would write those mutations into the
  // shared constant for the rest of the process.
  const settings: AppSettings =
    Object.keys(saved).length > 0
      ? {
          ...DEFAULT_SETTINGS,
          ...saved
        }
      : { ...DEFAULT_SETTINGS }

  // Validate voiceLanguage — unsupported codes (e.g. 'zh' removed in v0.2.97) fall back to 'en'
  if (settings.voiceLanguage && !VOICE_LANGUAGES.some((l) => l.code === settings.voiceLanguage)) {
    settings.voiceLanguage = 'en'
  }

  // One-time seed of `defaultAutonomyMode` for profiles that predate it.
  //
  // Upstream's rule when auto became the default was "pinned defaults are
  // preserved", and this is where we honour it: a user who had already written
  // `permissions.defaultMode` keeps that mode; a user who never expressed a
  // preference adopts the new auto default. Absence of the KEY (not a falsy
  // value) is what marks a pre-upgrade profile, so a later deliberate pick of
  // the same mode is never mistaken for "unset" and re-seeded.
  //
  // A `defaultMode` we have no session-level equivalent for (`bypassPermissions`,
  // `dontAsk`) seeds the new default instead. Every such mode is MORE permissive
  // than classifier-gated auto, so this only ever de-escalates.
  if (saved.defaultAutonomyMode === undefined) {
    const pinned = userPermissions?.defaultMode
      ? PERMISSION_TO_AUTONOMY[userPermissions.defaultMode]
      : undefined
    settings.defaultAutonomyMode = pinned ?? DEFAULT_AUTONOMY_MODE
    // Persist the seed so it happens exactly once — otherwise a later change to
    // Claude's `defaultMode` would re-seed and silently overwrite the user's
    // ClaudeUI pick.
    saveSettings(settings)
  }

  applyTheme(settings.theme)

  // View / host-local state this client owns outright.
  useSessionStore.setState({
    engineConfig: loadedEngineConfig,
    opencodeDefaultModel: opencodeSettings?.model || OPENCODE_DEFAULT_MODEL,
    // The `*Configured` flags keep "the user named this model" distinguishable
    // from "we fell back to the builtin constant" — the two resolve identically
    // while the model exists and must diverge the moment it does not.
    opencodeDefaultModelConfigured: !!opencodeSettings?.model,
    piDefaultModel: piEngineConfig?.piConfig?.defaultModel || PI_DEFAULT_MODEL,
    piDefaultModelConfigured: !!piEngineConfig?.piConfig?.defaultModel
  })
  // Replicated app-level state goes through the replica (SyncCore phase 4c), which
  // projects it into the store. Not a competing source of truth: the HOST seeds
  // canonical from these same files at the same point in boot
  // (`services/sync-seed.ts`), so this and the port's first `sync-full` write equal
  // values. It exists so the desktop has a theme and a sidebar BEFORE that
  // snapshot arrives — otherwise boot flashes defaults.
  seedLocalApp({
    settings: settings as unknown as Record<string, unknown>,
    autoModeDisabledBySettings: userPermissions?.disableAutoMode === 'disable',
    recentSessionIds: sessionConfig.recentSessions ?? [],
    pinnedSessionIds: sessionConfig.pinnedSessions ?? [],
    customTitles: sessionConfig.customTitles ?? {},
    worktreeInfoMap: sessionConfig.worktreeInfoMap ?? {},
    hiddenSessions: sessionConfig.hiddenSessions ?? [],
    hiddenProjects: sessionConfig.hiddenProjects ?? [],
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

/**
 * Remove a session from state if it has no messages (empty new session).
 *
 * `dropped` names the id so the caller can drop it from the REPLICA too — an
 * abandoned session lives only in this client (it never spawned, so no
 * `session:created` ever named it), and leaving it in canonical would let the
 * next projection resurrect it in the sidebar.
 *
 * **Only a session THIS CLIENT invented may be cleaned up** ({@link isLocallyCreated}).
 * "Empty" is a local judgement — no messages, no draft, not `sdkActive` — and it
 * does not distinguish an abandoned scratch session from a REAL host session that
 * was cancelled before its first prompt, or one whose transcript this client has
 * not projected yet. Dropping the second kind threw away state the host still had,
 * and post-F7 its later events are honest no-ops, so it did not come back: the
 * session was simply gone from this client until the next `sync-full`.
 *
 * Removing a session the host DOES know is the explicit-delete path's job
 * (`session:removed`), and that one is replicated.
 */
function cleanupEmptySession(
  sessions: Record<string, PerSessionState>,
  recentSessionIds: string[],
  routingId: string | null
): {
  sessions: Record<string, PerSessionState>
  recentSessionIds: string[]
  dropped: string | null
} {
  if (!routingId) return { sessions, recentSessionIds, dropped: null }
  const session = sessions[routingId]
  if (!session) return { sessions, recentSessionIds, dropped: null }
  if (!isLocallyCreated(routingId)) return { sessions, recentSessionIds, dropped: null }
  // Only clean up sessions with no messages and no active SDK
  if (session.messages.length > 0 || session.sdkActive || session.draftText)
    return { sessions, recentSessionIds, dropped: null }
  const { [routingId]: _, ...rest } = sessions
  return {
    sessions: rest,
    recentSessionIds: recentSessionIds.filter((id) => id !== routingId),
    dropped: routingId
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
  /**
   * Wall clock at the start of the currently-open thinking span, or null.
   *
   * PRESENTATION ONLY as of SyncCore phase 4c — it drives ThinkingBlock's live
   * "Thought for Ns" ticker and nothing else. The DURATION a finished block
   * renders now arrives on the block itself (`BaseSession.send` times the span and
   * the reducer stamps it), so the renderer no longer measures anything that ends
   * up in state: the two scalars that used to park a measured duration
   * (`thinkingDurationMs`, `pendingThinkingDurationMs`) are deleted.
   *
   * Written by the replica projection, derived from `streamingThinking`: stamped
   * when the buffer goes from empty to non-empty, cleared when it empties. One
   * place instead of the four writers (`appendStreamingThinking`,
   * `appendStreamingText`, `addMessage`, `setStatus`) that each had to remember
   * the same rule.
   */
  thinkingStartedAt: number | null
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
  /** Files delivered via SendUserFile. Derived from `messages` (so it survives
   *  resumption) and, unlike `todos`, never cleared when the turn ends. */
  sentFiles: SentFile[]
  taskProgressMap: Record<string, TaskProgress>
  taskNotifications: TaskNotification[]
  /**
   * Tasks that have received a `task_started` wire event but no matching
   * `task_notification` yet — keyed by toolUseId. This is the authoritative
   * "is this task actually still running" signal (see TaskStartedData):
   * Claude 2.1.219+ makes Agent/Task background-by-default and often omits
   * `run_in_background` on the tool_use input, so TaskCard can no longer
   * infer running-vs-complete from tool input + tool_result alone. A record
   * here means "running" regardless of tool_result/background-flag state;
   * only opencode/pi child sessions and historical transcripts (which never
   * emit task_started) fall back to the old heuristic.
   */
  activeTasks: Record<string, { taskId: string; taskType: string }>
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
  /** Queue of record, replicated from main (ADR-053). Only `queued` items live
   *  here — a consumed item has already become a chat message. */
  queuedItems: QueuedItem[]
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

/** Exported so the replica can build a store entry for a session it learns of first. */
export const EMPTY_SESSION_STATE: PerSessionState = {
  cwd: '',
  sdkActive: false,
  isHistorical: false,
  forkOrigin: null,
  messages: [],
  streamingText: '',
  streamingThinking: '',
  thinkingStartedAt: null,
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
  sentFiles: [],
  taskProgressMap: {},
  taskNotifications: [],
  activeTasks: {},
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
  queuedItems: [],
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

/**
 * The PermissionMode a fresh RUN of a session should start in: the configured
 * default (`settings.defaultAutonomyMode` → `defaultPermissionMode`), degraded
 * to 'default' when this engine or account cannot actually run auto — either
 * the launch-time model fetch says no Claude model supports it, or Claude
 * settings carry `disableAutoMode: "disable"`. Gating here (before spawn)
 * beats letting cli.js reject `--permission-mode auto` and snap the mode back
 * mid-session.
 *
 * Used by every path that starts a NEW RUN: createNewSession, reopening a
 * historical session, forking, and clearConversation. That set is deliberate —
 * cli.js applies `permissions.defaultMode` to resumed sessions too, so a
 * reopened session starting in the configured default is upstream parity, not
 * scope creep. Placeholder-entry paths (ensureSession's event bootstrap) stay
 * on plain 'default': they exist to catch stray events, and the real mode
 * arrives with the session's own sync.
 */
export function bootstrapPermissionMode(
  state: Pick<
    SessionState,
    'defaultPermissionMode' | 'availableModels' | 'autoModeDisabledBySettings'
  >,
  engineId: EngineId
): PermissionMode {
  if (state.defaultPermissionMode !== 'auto') return state.defaultPermissionMode
  const autoBlocked =
    !autoModeAvailableForEngine(engineId, state.availableModels) ||
    (engineId === 'claude' && state.autoModeDisabledBySettings)
  return autoBlocked ? 'default' : 'auto'
}

/**
 * `permissionMode` defaults to 'default' rather than reading the store, so the
 * paths that only need a placeholder entry (event bootstrap) are unaffected.
 * Paths that start a genuine fresh RUN pass `bootstrapPermissionMode(...)`.
 */
function createEmptySession(
  cwd: string,
  defaultPermissionMode: PermissionMode = 'default'
): PerSessionState {
  const cached = cwd ? gitStatusCache.get(cwd) : undefined
  return {
    ...EMPTY_SESSION_STATE,
    cwd,
    permissionMode: defaultPermissionMode,
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

/**
 * A rejected `window.api.*` invoke as displayable text. Deliberately verbatim:
 * the OAuth surfaces (ADR-057) classify the backend's own wording, so replacing
 * it with a friendly generic would break the outcome mapping.
 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : 'Unknown error'
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

/**
 * How many recently-viewed transcripts stay fully resident (besides the active
 * session, pinned sessions, and watched/running ones). Older on-disk
 * transcripts have their heavy arrays evicted and are re-hydrated on reselect.
 */
const MAX_RESIDENT_TRANSCRIPTS = 10

/**
 * Which sessions' heavy arrays should be evicted — bounding renderer heap
 * (Opus B). Eligible: neither active, recently-viewed, pinned, watched, running,
 * nor awaiting an approval, AND already on disk, so an evicted transcript is
 * always reloadable (a fresh, not-yet-flushed session is never touched).
 *
 * SyncCore phase 4c split the decision from the write. The heavy arrays are
 * SEALED, so the strip happens in the replica (`evictLocalSessions`) and the
 * projection carries it into the store; the `evicted` / `isHistorical` flags are
 * per-client view state and stay here. Stripping the store directly would have
 * been undone by the next projection — canonical on the HOST deliberately does
 * not evict (docs/architecture/sync-channels.md §Eviction), so its copy still has
 * the transcript.
 */
function coldSessionIds(
  sessions: Record<string, PerSessionState>,
  activeSessionId: string | null,
  recentSessionIds: string[],
  pinnedSessionIds: string[],
  directories: DirectoryGroup[]
): string[] {
  const keep = new Set<string>()
  if (activeSessionId) keep.add(activeSessionId)
  for (const id of recentSessionIds.slice(0, MAX_RESIDENT_TRANSCRIPTS)) keep.add(id)
  for (const id of pinnedSessionIds) keep.add(id)

  const onDisk = new Set<string>()
  for (const group of directories) {
    for (const s of group.sessions) onDisk.add(s.sessionId)
  }

  const cold: string[] = []
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
    if (canEvict) cold.push(id)
  }
  return cold
}

/**
 * The ONE vendor-OAuth flow state, shared by every surface that can start one
 * (the chat re-auth card, Settings › Providers, Shared providers).
 *
 * Three stages, two of them as old as the feature:
 *  - `waiting` — the DESKTOP `auto` drive: the host opened a browser and is
 *    blocked on its own loopback listener;
 *  - `error`   — the flow failed; `error` carries the backend's verbatim text
 *    for the ADR-057 outcome mapping (older callers only rendered a generic
 *    "Authentication failed", so the field is optional);
 *  - `paste`   — S4-UI: a REMOTE (web) client drives ADR-057's two-step
 *    paste-back instead. There is no host browser and no loopback to wait on,
 *    so `url` (what the client opens itself) and `method` (which vendor auth
 *    option the paste completes) are carried here. Never set on desktop.
 */
export interface VendorOAuthState {
  engineId: string
  vendorId: string
  stage: 'waiting' | 'error' | 'paste'
  instructions: string
  /** Authorize URL — `paste` stage only (the client opens it, not the host). */
  url?: string
  /** Index into the vendor's auth options, needed by `vendor-auth:oauth-callback`. */
  method?: number
  /**
   * Verbatim backend message — `error` stage only, and only for flows that
   * reached it through S4-UI's paths (the legacy desktop `auto` failure sets no
   * message and its surfaces still render their own generic text).
   */
  error?: string
}

export interface SessionState {
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
  /** Remembered MODEL choice, per engine — the model twin of `lastSelectedEngineId`.
   *  Persisted in localStorage; pre-fills the model for newly created sessions so a
   *  pick made on the welcome screen (where there is no session to write to) is not
   *  dropped. Heuristic stickiness, NOT user configuration: a stale entry falls back
   *  to the engine default silently. */
  lastSelectedModelByEngine: Partial<Record<EngineId, string>>
  /** Configurable opencode default model (engines/opencode.json `opencodeConfig.model`).
   *  The opencode-engine value `engineMeta('opencode').defaultModelValue()` resolves to. */
  opencodeDefaultModel: string
  /** True when {@link opencodeDefaultModel} came from the user's own opencode config
   *  rather than the builtin {@link OPENCODE_DEFAULT_MODEL}. An explicit user
   *  reference that no longer resolves must ERROR, never silently substitute; the
   *  builtin heuristic may keep falling back. */
  opencodeDefaultModelConfigured: boolean
  /** Configurable pi default model (engines/pi.json `piConfig.defaultModel`, M3).
   *  The pi-engine value `engineMeta('pi').defaultModelValue()` resolves to. */
  piDefaultModel: string
  /** The pi twin of {@link opencodeDefaultModelConfigured}. */
  piDefaultModelConfigured: boolean
  /** `settings.defaultAutonomyMode` mapped to a renderer PermissionMode. A
   *  SESSION-BOOTSTRAP concern only: it seeds the mode of sessions created from
   *  here on. Running sessions keep the mode they were spawned with (cli.js
   *  re-derives rules on a settings change but never the mode) — changing a live
   *  session's mode is `setPermissionMode`'s job. */
  defaultPermissionMode: PermissionMode
  /** `~/.claude/settings.json` sets `disableAutoMode: "disable"` (nested under
   *  `permissions` or top-level — cli.js honours both). Claude sessions must not
   *  be spawned with `--permission-mode auto` when this is set: cli.js would
   *  reject it. Claude-only — opencode and pi implement auto themselves and are
   *  not governed by Claude's settings file. */
  autoModeDisabledBySettings: boolean
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
  vendorOAuth: VendorOAuthState | null
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
  /**
   * Register a session ANOTHER client created (`session:created`). The reducer
   * already bootstrapped its replicated state; this adds the local registry
   * entries (recents + engine map) and optionally follows it.
   */
  registerRemoteSession: (routingId: string, switchTo: boolean) => void
  /** View-only: this session is a live run, not a historical transcript. */
  markSessionLive: (routingId: string) => void
  /**
   * Persist the CURRENT registry config to `sessions.json`. Used after a
   * reducer-owned rekey, where the renamed rows are already in the replica and
   * only the disk copy is behind.
   */
  persistSessionRegistry: () => void
  /** Record (and persist) a session's engine + model in the registry. */
  recordSessionEngine: (routingId: string, engineId: EngineId, model: string) => void
  /** Set the remembered engine choice. Persisted in localStorage (lightweight). */
  setLastSelectedEngineId: (engineId: EngineId) => void
  /** Switch the active fresh session's engine and seed its effective default model. */
  setSelectedEngine: (engineId: EngineId) => void
  /** Update the configurable opencode default model (mirrors opencodeConfig.model). */
  setOpencodeDefaultModel: (model: string) => void
  /** Update the configurable pi default model (mirrors piConfig.defaultModel, M3). */
  setPiDefaultModel: (model: string) => void
  /** Mirror a Settings-dialog `permissions.defaultMode` write so sessions created
   *  later in THIS app run pick it up without a restart. */
  setDefaultPermissionMode: (mode: PermissionMode) => void
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

  // -----------------------------------------------------------------------
  // Per-session actions (all take routingId)
  //
  // SyncCore phase 4c deleted every action that wrote a SEALED field — the
  // transcript, streams, status, approvals, todos/sentFiles, tasks, subagents,
  // the queue and per-session config are the replica fold's output now
  // (`stores/replica.ts`, `stores/sealed-fields.ts`). What survives here is view
  // state and the transient toast/banner slices whose channels carry no snapshot
  // field.
  // -----------------------------------------------------------------------
  /**
   * Retire an approval card THIS client just answered.
   *
   * The approval LIFECYCLE is event-driven (ADR-038) and the reducer owns it —
   * `session:approval-request` adds, `session:approval-dismiss` and
   * `session:tool-result` remove. What this covers is the gap between answering
   * and the engine's acknowledgement: `respondApproval` resolves a promise inside
   * cli.js and emits nothing, so without a local dismiss the card would sit under
   * the user's click until the tool finished (or forever, for a deny that yields
   * no tool_result). It goes through the replica so `pendingApprovals` still has
   * exactly one writer, and every incoming event converges on the same list.
   */
  dismissApproval: (routingId: string, requestId: string) => void
  addError: (routingId: string, error: string) => void
  addWarning: (routingId: string, warning: string) => void
  removeWarning: (routingId: string, index: number) => void
  clearWarnings: (routingId: string) => void
  removeError: (routingId: string, index: number) => void
  clearErrors: (routingId: string) => void
  addSandboxViolation: (routingId: string, message: string) => void
  removeSandboxViolation: (routingId: string, index: number) => void
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
  updateSettings: (partial: Partial<AppSettings>) => void
  setEngineConfig: (config: EngineConfig) => void
  /**
   * Pick a permission mode for a session. Fire-and-forget: the mode the pill
   * shows is whatever `session:permission-mode` says, so a mode the engine
   * rejects corrects itself instead of being optimistically shown and reverted.
   */
  changePermissionMode: (routingId: string, next: PermissionMode) => void
  setEffort: (
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null,
    routingId?: string
  ) => void
  setThinkingMode: (mode: 'adaptive' | 'enabled' | 'disabled' | null, routingId?: string) => void
  setReasoningVariant: (variant: string | null, routingId?: string) => void
  setDraftText: (text: string) => void
  /** Append unsent attachments to a specific session (keyed by routingId — see impl). */
  addDraftAttachments: (routingId: string, attachments: FileAttachment[]) => void
  /** Remove one unsent attachment from a session by attachment id. */
  removeDraftAttachment: (routingId: string, id: string) => void
  /** Replace a session's unsent attachments (used to clear after a successful send). */
  setDraftAttachments: (routingId: string, attachments: FileAttachment[]) => void
  /** Set the active session's model picker value within its selected engine. */
  setSelectedModel: (model: string) => void
  setCustomCommands: (commands: SlashCommandInfo[]) => void
  setAvailableModels: (models: ModelInfo[]) => void
  /**
   * "Start fresh". Async since the reset became a replicated event — await it
   * before spawning a replacement session, or the birth event can land BEFORE
   * the clear and be blanked by it.
   */
  clearConversation: (routingId: string) => Promise<void>
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
  setVendorOAuth(state: VendorOAuthState | null): void
  cancelVendorOAuth(): void
  setVendorAuthRequired(routingId: string, data: { vendorId: string; message: string } | null): void
  clearVendorAuthRequired(routingId: string): void
  authorizeVendorOAuth(
    engineId: EngineId,
    vendorId: string
  ): Promise<{
    ok: boolean
    needsPaste?: { url: string; method: number; instructions: string }
    /** Verbatim backend failure text (e.g. opencode's remote-`auto` refusal). */
    error?: string
  }>
  /**
   * Finish the `paste` stage: post the user's pasted string to
   * `vendor-auth:oauth-callback` VERBATIM (the backend parses URL-vs-code) and
   * fold the result back into `vendorOAuth`. Remote-only by construction — the
   * stage it consumes is never set on desktop.
   */
  submitVendorOAuthCode(pasted: string): Promise<{ ok: boolean; error?: string }>
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
  lastSelectedModelByEngine: loadLastSelectedModels(),
  opencodeDefaultModel: OPENCODE_DEFAULT_MODEL,
  opencodeDefaultModelConfigured: false,
  piDefaultModel: PI_DEFAULT_MODEL,
  piDefaultModelConfigured: false,
  // Pre-hydration seed only. `hydrate()` overwrites this from
  // `settings.defaultAutonomyMode` before any session can be created; 'default'
  // is the conservative placeholder for the window in between.
  defaultPermissionMode: 'default' as PermissionMode,
  autoModeDisabledBySettings: false,
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

  // Cleanup order (both actions below): the store `set` runs FIRST, then the
  // replica mutations. The projection those mutations trigger overlays sealed
  // fields onto whatever the store now holds — doing it the other way round would
  // have the `set` write back the pre-eviction transcript it captured.
  showWelcome: () => {
    const state = useSessionStore.getState()
    const cleaned = cleanupEmptySession(
      state.sessions,
      state.recentSessionIds,
      state.activeSessionId
    )
    set({
      activeSessionId: null,
      activeView: { type: 'chat' } as ActiveView,
      sessions: cleaned.sessions
    })
    if (cleaned.dropped) dropLocalSessions([cleaned.dropped])
    if (cleaned.recentSessionIds !== state.recentSessionIds) {
      patchLocalApp({ recentSessionIds: cleaned.recentSessionIds })
      saveSessionConfig(state, { recentSessionIds: cleaned.recentSessionIds })
    }
  },

  switchSession: (routingId) => {
    const state = useSessionStore.getState()
    const cleaned = cleanupEmptySession(
      state.sessions,
      state.recentSessionIds,
      state.activeSessionId
    )
    // Bound the renderer heap (Opus B): evict the heavy transcript arrays of
    // cold, on-disk sessions on every switch. The active/recent/pinned/running/
    // watched sessions are always kept; an evicted session re-hydrates from
    // disk on reselect (Sidebar routes an evicted entry through
    // loadHistoricalSession rather than the resident fast-path).
    const cold = coldSessionIds(
      cleaned.sessions,
      routingId,
      cleaned.recentSessionIds,
      state.pinnedSessionIds,
      state.directories
    )
    let sessions = updateSession(cleaned.sessions, routingId, () => ({ needsAttention: false }))
    for (const id of cold) {
      sessions = updateSession(sessions, id, () => ({
        evicted: true,
        isHistorical: true,
        bashOutputs: {},
        backgroundOutputs: {},
        backgroundWatcherCounts: {}
      }))
    }
    set({ activeSessionId: routingId, activeView: { type: 'chat' } as ActiveView, sessions })
    if (cleaned.dropped) dropLocalSessions([cleaned.dropped])
    if (cold.length > 0) evictLocalSessions(cold)
    if (cleaned.recentSessionIds !== state.recentSessionIds) {
      patchLocalApp({ recentSessionIds: cleaned.recentSessionIds })
      saveSessionConfig(state, { recentSessionIds: cleaned.recentSessionIds })
    }
  },

  createNewSession: (routingId, cwd, switchTo = true) => {
    const state = useSessionStore.getState()
    {
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
      const defaults = engineDefaultModels(state)
      // The user's last pick on THIS engine wins over the engine default — the
      // model twin of `lastSelectedEngineId`. Only when it is still offered:
      // stickiness is a heuristic, so a stale entry falls through quietly (the
      // configured-default error rule below still applies underneath it).
      const sticky = state.lastSelectedModelByEngine[engineId]
      const stickyAvailable =
        !!sticky &&
        state.availableModels.some((m) => m.value === sticky && isModelForEngine(m, engineId))
      // `null` = the user's CONFIGURED default named a model this engine no longer
      // offers. Seed the picker's unset state and say so, rather than substituting
      // a model whose capabilities differ from the one the user asked for.
      let defaultModel = stickyAvailable
        ? (sticky as string)
        : resolveEngineDefaultModel(engineId, state.availableModels, defaults)
      const staleDefault = defaultModel === null ? configuredDefaultModelOf(engineId, defaults) : null
      if (
        engineId === 'opencode' &&
        !resolveOpencodeModel(state.availableModels, state.opencodeDefaultModel)
      ) {
        // Distinct from the stale-default case above: opencode has NO usable model
        // at all, so there is no picker state to land in — fall back to claude.
        engineId = 'claude'
        defaultModel = 'default'
      }
      const seededModel = defaultModel ?? ''
      // Write model into sessionEngines so it can be seeded on reopen (spec §3).
      // Always write the entry so the engine is recorded; model is set on first model event.
      const sessionEngines = {
        ...state.sessionEngines,
        [routingId]: {
          engineId,
          // An unresolved model must not be encoded — `decodeModelValue('')` would
          // persist a phantom ModelRef that reopen would then restore.
          ...(seededModel ? { model: engineMeta(engineId).decodeModelValue(seededModel) } : {})
        }
      }
      // A session created here has not spawned, so NO event carries its engine,
      // model or permission mode — they exist nowhere but this client until the
      // first `session:config-changed` / `session:permission-mode`. Seeding the
      // replica is what stops the `session:created` that eventually arrives from
      // projecting `emptySession()`'s claude/default over the user's pick.
      patchLocalSession(
        routingId,
        {
          cwd,
          permissionMode: bootstrapPermissionMode(state, engineId),
          selectedEngineId: engineId,
          selectedModel: seededModel,
          // Seed status.engineId/capabilities to match so they're correct before spawn
          status: {
            ...EMPTY_SESSION_STATE.status,
            engineId,
            capabilities: engineMeta(engineId).seedCapabilities(
              seededModel,
              state.availableModels.find(
                (m) => m.value === seededModel && isModelForEngine(m, engineId)
              )
            )
          }
        },
        { create: true }
      )
      // After the session exists — `addError` writes through `updateSession`.
      if (staleDefault) {
        useSessionStore
          .getState()
          .addError(routingId, staleDefaultModelMessage(engineId, staleDefault))
      }
      patchLocalApp({ recentSessionIds, sessionEngines })
      saveSessionConfig(state, { recentSessionIds, sessionEngines })
      if (switchTo) {
        set({ activeSessionId: routingId, activeView: { type: 'chat' } as ActiveView })
      }
      // A brand-new session's git status is known from the cwd cache, and that is
      // view state the projection does not carry.
      const cached = cwd ? gitStatusCache.get(cwd) : undefined
      if (cached) {
        set((s) => ({
          sessions: updateSession(s.sessions, routingId, () => ({
            isGitRepo: true,
            gitStatus: cached
          }))
        }))
      }
    }
  },

  registerRemoteSession: (routingId, switchTo) => {
    const state = useSessionStore.getState()
    const recentSessionIds = [
      routingId,
      ...state.recentSessionIds.filter((id) => id !== routingId)
    ].slice(0, state.settings.maxRecentSessions)
    patchLocalApp({ recentSessionIds })
    saveSessionConfig(state, { recentSessionIds })
    if (switchTo) set({ activeSessionId: routingId, activeView: { type: 'chat' } as ActiveView })
  },

  markSessionLive: (routingId) =>
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ isHistorical: false }))
    })),

  persistSessionRegistry: () => {
    saveSessionConfig(useSessionStore.getState())
  },

  recordSessionEngine: (routingId, engineId, model) => {
    const state = useSessionStore.getState()
    const sessionEngines = {
      ...state.sessionEngines,
      [routingId]: { engineId, model: engineMeta(engineId).decodeModelValue(model) }
    }
    patchLocalApp({ sessionEngines })
    saveSessionConfig(state, { sessionEngines })
  },

  setLastSelectedEngineId: (engineId) => {
    localStorage.setItem('lastSelectedEngineId', engineId)
    set({ lastSelectedEngineId: engineId })
  },

  setSelectedEngine: (engineId) => {
    const state = useSessionStore.getState()
    const id = state.activeSessionId
    const session = id ? state.sessions[id] : undefined
    if (!id || !session || session.sdkActive || session.status.sessionId || session.isHistorical)
      return
    if (session.selectedEngineId === engineId) return
    const defaults = engineDefaultModels(state)
    const resolved = resolveEngineDefaultModel(engineId, state.availableModels, defaults)
    // A stale CONFIGURED default leaves the picker unset (and says why) instead of
    // handing the new engine a substitute model — same rule as `createNewSession`.
    const model = resolved ?? ''
    const modelInfo = state.availableModels.find(
      (candidate) => candidate.value === model && isModelForEngine(candidate, engineId)
    )
    const sessionEngines = {
      ...state.sessionEngines,
      [id]: {
        engineId,
        ...(model ? { model: engineMeta(engineId).decodeModelValue(model) } : {})
      }
    }
    localStorage.setItem('lastSelectedEngineId', engineId)
    set({ lastSelectedEngineId: engineId })
    // Pre-spawn only (guarded above), so no event exists to carry the switch —
    // the replica is where it has to live.
    patchLocalSession(id, {
      selectedEngineId: engineId,
      selectedModel: model,
      reasoningVariant: null,
      status: {
        ...session.status,
        engineId,
        capabilities: engineMeta(engineId).seedCapabilities(model, modelInfo)
      }
    })
    if (resolved === null) {
      useSessionStore
        .getState()
        .addError(id, staleDefaultModelMessage(engineId, configuredDefaultModelOf(engineId, defaults)))
    }
    patchLocalApp({ sessionEngines })
    saveSessionConfig(state, { sessionEngines })
  },

  setOpencodeDefaultModel: (model) =>
    set({
      opencodeDefaultModel: model || OPENCODE_DEFAULT_MODEL,
      opencodeDefaultModelConfigured: !!model
    }),

  setPiDefaultModel: (model) =>
    set({ piDefaultModel: model || PI_DEFAULT_MODEL, piDefaultModelConfigured: !!model }),

  setDefaultPermissionMode: (mode) => set({ defaultPermissionMode: mode }),

  reloadModels: () => set((s) => ({ modelReloadNonce: s.modelReloadNonce + 1 })),

  loadHistoricalSession: (
    routingId,
    messages,
    cwd,
    taskNotifications?,
    subagentMessages?,
    statusLine?,
    warnings?
  ) => {
    const state = useSessionStore.getState()
    {
      // Per-session model memory: restore the persisted model when present, so
      // reopening a session brings back the model you last used in it. The engine
      // is restored too (an opencode session reopens as opencode). When NO model
      // was persisted (fresh load), fall back to the session ENGINE's default —
      // engine-aware, never Claude's "default" on an opencode session (the bug).
      const persistedEntry = state.sessionEngines[routingId]
      const persistedEngineId = persistedEntry?.engineId ?? 'claude'
      // Re-hydrating an evicted entry: start from the resident (lightweight)
      // entry so draft / effort / thinking / permission mode survive the round
      // trip. A genuinely FRESH load is a new run of the session, and a new run
      // starts in the configured default mode — same rule cli.js applies to
      // `--resume` (`permissions.defaultMode` is read at every bootstrap, not
      // only for brand-new conversations). Without this, only never-before-seen
      // sessions got the auto default; every session reopened from the sidebar
      // silently started in 'default'.
      const prior = state.sessions[routingId]
      const base = prior?.evicted
        ? prior
        : createEmptySession(cwd, bootstrapPermissionMode(state, persistedEngineId))
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
      // Session identity + config: a LOCAL decision (which engine/model this
      // session reopens as comes from `sessionEngines`, not from any event), so it
      // is applied unconditionally.
      patchLocalSession(
        routingId,
        {
          cwd,
          permissionMode: base.permissionMode,
          selectedEngineId: persistedEngineId,
          selectedModel,
          status: {
            ...base.status,
            engineId: persistedEngineId,
            capabilities: engineMeta(persistedEngineId).seedCapabilities(selectedModel, modelInfo)
          }
        },
        { create: true }
      )
      // The transcript: on disk and NOWHERE in the event stream, because browsing
      // an old session spawns nothing for the host to emit. `seedColdSession` is
      // the one sanctioned local write for it, and it refuses to clobber a live
      // transcript (a slow disk read resolving mid-turn must not wipe the turn).
      seedColdSession(routingId, {
        cwd,
        messages,
        taskNotifications: taskNotifications ?? base.taskNotifications,
        subagentMessages: subagentMessages ?? base.subagentMessages,
        statusLine: statusLine ?? base.statusLine ?? null,
        // Derived from the transcript, with the same scanners the reducer uses —
        // which is what makes the todo widget and the Files widget survive
        // session resumption (neither is persisted separately). Deriving it HERE
        // rather than in the Sidebar is the difference between seeding the replica
        // and a client computing state (sync-core.md §"Clients never compute state").
        todos: buildTodosFromMessages(messages) ?? [],
        sentFiles: buildSentFilesFromMessages(messages) ?? []
      })
      // View-only half LAST: `updateSession` no-ops on an unknown id, so it has to
      // run after the seed has created the entry (a fresh sidebar click reaches
      // here with nothing resident).
      set((s) => ({
        sessions: updateSession(s.sessions, routingId, () => ({
          isHistorical: true,
          evicted: false,
          warnings: warnings ?? base.warnings
        }))
      }))
    }
  },

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
    {
      const s = useSessionStore.getState()
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
      // A fork is a new run: it starts in the configured default mode, gated
      // per the FORK's engine, not in whatever mode the source session held.
      patchLocalSession(
        newRoutingId,
        {
          cwd: src.cwd,
          messages: seeded,
          permissionMode: bootstrapPermissionMode(s, forkEngineId),
          // Inherit the source's engine/model/effort/thinking choices.
          selectedEngineId: forkEngineId,
          selectedModel: src.selectedModel,
          effort: src.effort,
          thinkingMode: src.thinkingMode,
          reasoningVariant: src.reasoningVariant,
          status: {
            ...EMPTY_SESSION_STATE.status,
            engineId: src.status.engineId,
            capabilities: src.status.capabilities
          }
        },
        { create: true }
      )
      patchLocalApp({ recentSessionIds, sessionEngines })
      saveSessionConfig(s, { recentSessionIds, sessionEngines })
      set((cur) => ({
        // Render the seeded history immediately; the fork-spawn path in
        // InputBox (gated on forkOrigin) overrides the resume target.
        sessions: updateSession(cur.sessions, newRoutingId, () => ({
          isHistorical: true,
          forkOrigin: { sourceSessionId, anchorUuid }
        })),
        activeSessionId: newRoutingId,
        activeView: { type: 'chat' } as ActiveView
      }))
    }
    return newRoutingId
  },

  markSdkActive: (routingId) => {
    // `sdkActive` is SEALED (`session:created` sets it, `session:status`
    // disconnected clears it). The UI still flips it optimistically on the paths
    // that spawn a session, so it goes through the replica; `isHistorical` is view
    // state and stays here.
    patchLocalSession(routingId, { sdkActive: true })
    set((state) => ({
      sessions: updateSession(state.sessions, routingId, () => ({ isHistorical: false }))
    }))
  },

  markSdkInactive: (routingId) => {
    patchLocalSession(routingId, { sdkActive: false })
  },

  // -----------------------------------------------------------------------
  // Registry config (recents / pins / titles / hidden / engine map)
  //
  // Two steps, in this order, at every site below: apply to the REPLICA (so the
  // sealed field has exactly one writer and the sidebar does not lag a round trip
  // behind the click), then persist through `config:save-sessions`, whose
  // `config:sessions-changed` echo reaches this client too since 4c and re-applies
  // the same whole-config replace. Applying locally first is not just latency:
  // `saveSessionConfig` merges from CURRENT state, so two rapid mutations would
  // otherwise both merge from a stale base and the second would revert the first.
  // -----------------------------------------------------------------------
  addRecentSession: (routingId) => {
    const state = useSessionStore.getState()
    // Don't add pinned sessions to recents — they have their own section
    if (state.pinnedSessionIds.includes(routingId)) return
    const recentSessionIds = [
      routingId,
      ...state.recentSessionIds.filter((id) => id !== routingId)
    ].slice(0, state.settings.maxRecentSessions)
    patchLocalApp({ recentSessionIds })
    saveSessionConfig(state, { recentSessionIds })
  },

  removeRecentSession: (routingId) => {
    const state = useSessionStore.getState()
    const recentSessionIds = state.recentSessionIds.filter((id) => id !== routingId)
    patchLocalApp({ recentSessionIds })
    saveSessionConfig(state, { recentSessionIds })
  },

  setCustomTitle: (sessionId, title) => {
    const state = useSessionStore.getState()
    const customTitles = { ...state.customTitles }
    if (title) {
      customTitles[sessionId] = title
    } else {
      delete customTitles[sessionId]
    }
    patchLocalApp({ customTitles })
    saveSessionConfig(state, { customTitles })
  },

  pinSession: (routingId) => {
    const state = useSessionStore.getState()
    if (state.pinnedSessionIds.includes(routingId)) return
    const pinnedSessionIds = [...state.pinnedSessionIds, routingId]
    const recentSessionIds = state.recentSessionIds.filter((id) => id !== routingId)
    patchLocalApp({ pinnedSessionIds, recentSessionIds })
    saveSessionConfig(state, { pinnedSessionIds, recentSessionIds })
  },

  unpinSession: (routingId) => {
    const state = useSessionStore.getState()
    const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== routingId)
    const recentSessionIds = [
      routingId,
      ...state.recentSessionIds.filter((id) => id !== routingId)
    ].slice(0, state.settings.maxRecentSessions)
    patchLocalApp({ pinnedSessionIds, recentSessionIds })
    saveSessionConfig(state, { pinnedSessionIds, recentSessionIds })
  },

  reorderPinnedSessions: (ids) => {
    const state = useSessionStore.getState()
    patchLocalApp({ pinnedSessionIds: ids })
    saveSessionConfig(state, { pinnedSessionIds: ids })
  },

  hideSession: (sessionId) => {
    const state = useSessionStore.getState()
    if (state.hiddenSessionIds.includes(sessionId)) return
    const hiddenSessions = [...state.hiddenSessionIds, sessionId]
    patchLocalApp({ hiddenSessions })
    saveSessionConfig(state, { hiddenSessionIds: hiddenSessions })
  },

  unhideSession: (sessionId) => {
    const state = useSessionStore.getState()
    if (!state.hiddenSessionIds.includes(sessionId)) return
    const hiddenSessions = state.hiddenSessionIds.filter((id) => id !== sessionId)
    patchLocalApp({ hiddenSessions })
    saveSessionConfig(state, { hiddenSessionIds: hiddenSessions })
  },

  hideProject: (projectKey) => {
    const state = useSessionStore.getState()
    if (!projectKey || state.hiddenProjectKeys.includes(projectKey)) return
    const hiddenProjects = [...state.hiddenProjectKeys, projectKey]
    patchLocalApp({ hiddenProjects })
    saveSessionConfig(state, { hiddenProjectKeys: hiddenProjects })
  },

  unhideProject: (projectKey) => {
    const state = useSessionStore.getState()
    if (!state.hiddenProjectKeys.includes(projectKey)) return
    const hiddenProjects = state.hiddenProjectKeys.filter((k) => k !== projectKey)
    patchLocalApp({ hiddenProjects })
    saveSessionConfig(state, { hiddenProjectKeys: hiddenProjects })
  },

  deleteSession: async (sessionId, projectKey, engineId) => {
    await window.api.deleteSession(sessionId, projectKey, engineId)
    // Also scrub any references to this session from persisted config + in-memory state
    const state = useSessionStore.getState()
    const recentSessionIds = state.recentSessionIds.filter((id) => id !== sessionId)
    const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId)
    const hiddenSessions = state.hiddenSessionIds.filter((id) => id !== sessionId)
    const customTitles = { ...state.customTitles }
    delete customTitles[sessionId]
    const worktreeInfoMap = { ...state.worktreeInfoMap }
    delete worktreeInfoMap[sessionId]
    // The persisted engine/model row is keyed by routingId too — without this
    // it survives every delete and accumulates forever (RN8).
    const sessionEngines = { ...state.sessionEngines }
    delete sessionEngines[sessionId]
    // Drop the session from its directory group; drop the group itself if now empty
    const directories = state.directories
      .map((g) =>
        g.sessions.some((s) => s.sessionId === sessionId)
          ? { ...g, sessions: g.sessions.filter((s) => s.sessionId !== sessionId) }
          : g
      )
      .filter((g) => g.sessions.length > 0)
    set((s) => {
      const sessions = { ...s.sessions }
      delete sessions[sessionId]
      return {
        sessions,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId
      }
    })
    dropLocalSessions([sessionId])
    patchLocalApp({
      recentSessionIds,
      pinnedSessionIds,
      hiddenSessions,
      customTitles,
      worktreeInfoMap,
      sessionEngines,
      directories
    })
    saveSessionConfig(state, {
      recentSessionIds,
      pinnedSessionIds,
      hiddenSessionIds: hiddenSessions,
      customTitles,
      worktreeInfoMap,
      sessionEngines
    })
  },

  deleteProject: async (projectKey) => {
    // Deletes the OTHER engines' sessions too. This action used to follow up with
    // its own `deleteSession` loop for opencode rows, because `deleteProjectFiles`
    // only removes Claude's files and the surviving opencode data re-created the
    // group on the next listing refresh. `handlers-core.deleteProject` does that
    // sweep main-side now (pi included), which is also the only way the REMOTE
    // surface ever got it — a phone has no such follow-up loop.
    await window.api.deleteProject(projectKey)
    // Collect all session IDs in this project (both on-disk group members and live in-memory
    // sessions sharing the project's cwd) so we can purge them from every piece of state.
    const state = useSessionStore.getState()
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
    const hiddenSessions = state.hiddenSessionIds.filter((id) => !projectSessionIds.has(id))
    const hiddenProjects = state.hiddenProjectKeys.filter((k) => k !== projectKey)
    const customTitles = { ...state.customTitles }
    const worktreeInfoMap = { ...state.worktreeInfoMap }
    // Persisted engine/model rows are keyed by routingId — purge them with the
    // rest of the project's state so they can't accumulate forever (RN8).
    const sessionEngines = { ...state.sessionEngines }
    for (const id of projectSessionIds) {
      delete customTitles[id]
      delete worktreeInfoMap[id]
      delete sessionEngines[id]
    }
    const directories = state.directories.filter((g) => g.projectKey !== projectKey)
    set((s) => {
      const sessions = { ...s.sessions }
      for (const id of projectSessionIds) delete sessions[id]
      return {
        sessions,
        activeSessionId:
          s.activeSessionId && projectSessionIds.has(s.activeSessionId) ? null : s.activeSessionId
      }
    })
    dropLocalSessions([...projectSessionIds])
    patchLocalApp({
      recentSessionIds,
      pinnedSessionIds,
      hiddenSessions,
      hiddenProjects,
      customTitles,
      worktreeInfoMap,
      sessionEngines,
      directories
    })
    saveSessionConfig(state, {
      recentSessionIds,
      pinnedSessionIds,
      hiddenSessionIds: hiddenSessions,
      hiddenProjectKeys: hiddenProjects,
      customTitles,
      worktreeInfoMap,
      sessionEngines
    })
  },

  dismissApproval: (routingId, requestId) => {
    const session = useSessionStore.getState().sessions[routingId]
    if (!session) return
    const pendingApprovals = session.pendingApprovals.filter((a) => a.requestId !== requestId)
    if (pendingApprovals.length === session.pendingApprovals.length) return
    patchLocalSession(routingId, { pendingApprovals })
  },

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

  updateSettings: (partial) => {
    const state = useSessionStore.getState()
    const settings = { ...state.settings, ...partial }
    // `settings` is SEALED (`config:settings-changed`), so the write goes through
    // the replica — which also applies the theme — and the save's echo re-applies
    // the same replace. Same rule as the registry-config actions above.
    patchLocalApp({ settings: settings as unknown as Record<string, unknown> })
    saveSettings(settings)
  },

  setEngineConfig: (config) => set({ engineConfig: config }),

  // Centralizes the apply semantics for a permission-mode change, shared by
  // the desktop Shift+Tab handler and the mobile mode picker (any client that
  // lets the user pick a mode).
  //
  // SyncCore phase 4c deleted the optimistic write AND its revert. Both halves
  // existed because the mode the pill showed was this client's guess: a LIVE
  // session's `auto` could be rejected, so the guess was skipped for that one
  // case and un-guessed in a `.catch`. The pill now renders `permissionMode`
  // straight from the replica, and EVERY path emits `session:permission-mode` —
  // the live session's own setter (including the reverted mode when the engine
  // says no) and, pre-spawn where there is no session object,
  // `handlers-core.setPermissionMode`'s echo. So there is nothing left to guess
  // and nothing left to undo.
  //
  // `causedBy` (ADR-051 contract 2) is the designed escape hatch if the
  // round-trip ever feels slow from a phone: tag the command, apply optimistically,
  // reconcile when the tagged event lands. NOT built — the owner decides after
  // living with the honest round trip.
  changePermissionMode: (routingId, next) => {
    void window.api.setPermissionMode(routingId, next).catch(() => {
      /* the engine's own broadcast is the source of truth for the applied mode */
    })
  },

  // Effort / thinking / reasoning-variant picks. Applied through the replica
  // because for effort + thinking there is NO event at all: the desktop picker
  // restarts the session instead of pushing a live setter, so the value's only
  // home until the respawn reads it is this client (see InputBox.restartSdkSession).
  // Where an IPC setter DOES exist (reasoning variant, model), its
  // `session:config-changed` echo re-applies the same per-field replace.
  setEffort: (effort, routingId) => {
    const id = routingId ?? useSessionStore.getState().activeSessionId
    if (id) patchLocalSession(id, { effort })
  },

  setThinkingMode: (mode, routingId) => {
    const id = routingId ?? useSessionStore.getState().activeSessionId
    if (id) patchLocalSession(id, { thinkingMode: mode })
  },

  setReasoningVariant: (variant, routingId) => {
    const id = routingId ?? useSessionStore.getState().activeSessionId
    if (id) patchLocalSession(id, { reasoningVariant: variant })
  },

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

  setSelectedModel: (model) => {
    const state = useSessionStore.getState()
    const id = state.activeSessionId
    const session = id ? state.sessions[id] : undefined
    // With no active session the picker is the WELCOME picker, which edits
    // `lastSelectedEngineId` (InputBox's `effectiveEngineId`) — that is the engine
    // this pick belongs to.
    const targetEngine = id ? (session?.selectedEngineId ?? 'claude') : state.lastSelectedEngineId

    // Per-engine stickiness, recorded for BOTH picker surfaces so "new session uses
    // my last model" behaves the same however the pick was made. Previously the
    // no-session branch returned early and the welcome pick was simply lost.
    localStorage.setItem(lastSelectedModelKey(targetEngine), model)
    set((s) => ({
      lastSelectedModelByEngine: { ...s.lastSelectedModelByEngine, [targetEngine]: model }
    }))

    if (!id) return

    // Persist the engine-correct ModelRef into sessionEngines so it seeds
    // selectedModel + engine on reopen.
    const existing = state.sessionEngines[id]
    const modelRef = engineMeta(targetEngine).decodeModelValue(model)
    // Pre-spawn, NOTHING re-seeds `status.capabilities` for a model switch: the
    // backend's `setModel` → `session:status` only exists once a session has
    // started, so an un-started session kept the capabilities of the model it was
    // created with (a no-vision seed silently swallowed pasted images even after
    // the user picked a vision model). Mirrors `setSelectedEngine`. A STARTED
    // session is left alone — its engine's own re-emitted status is authoritative.
    const reseedCapabilities = !!session && !session.status.sessionId
    const modelInfo = reseedCapabilities
      ? state.availableModels.find((m) => m.value === model && isModelForEngine(m, targetEngine))
      : undefined
    // Always reset reasoningVariant on model change — different models have different variants.
    patchLocalSession(id, {
      selectedModel: model,
      reasoningVariant: null,
      ...(reseedCapabilities && session
        ? {
            status: {
              ...session.status,
              capabilities: engineMeta(targetEngine).seedCapabilities(model, modelInfo)
            }
          }
        : {})
    })
    if (existing) {
      const sessionEngines = { ...state.sessionEngines, [id]: { ...existing, model: modelRef } }
      patchLocalApp({ sessionEngines })
      saveSessionConfig(state, { sessionEngines })
    }
  },

  setCustomCommands: (commands) => set({ customCommands: commands }),

  setAvailableModels: (models) => set({ availableModels: models }),

  setAccountUsage: (data) => set({ accountUsage: data }),

  // Native OAuth (ADR-014). signIn/submit return the "authorizing"/result
  // snapshot synchronously; the terminal transition arrives via onAuthState.
  setAuthState: (data) => set({ authState: data }),
  setAuthSource: (source) => set({ authSource: source }),
  setVendorAuth: (map) => set({ vendorAuth: map }),
  setAccountsState: (data) => set({ accountsState: data }),
  respawnAllSessions: () => {
    for (const id of Object.keys(useSessionStore.getState().sessions)) {
      patchLocalSession(id, { sdkActive: false })
    }
  },
  signIn: async () => {
    set({ authState: { status: 'authorizing', account: null, error: null } })
    // A rejected invoke used to leave the UI stuck on "authorizing" forever.
    // Harmless on desktop (AuthManager.signIn never rejects), but a remote
    // caller can be refused by the capability gate, and S4-UI's paste flow reads
    // `manualUrl` off this very state — so surface the failure instead.
    try {
      set({ authState: await window.api.signIn() })
    } catch (err) {
      set({ authState: { status: 'error', account: null, error: errorText(err) } })
    }
  },
  submitOAuthCode: async (code) => {
    try {
      set({ authState: await window.api.submitOAuthCode(code) })
    } catch (err) {
      set({ authState: { status: 'error', account: null, error: errorText(err) } })
    }
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
      // ADR-057 / S4-UI: a REMOTE client can neither reach the host's loopback
      // nor be sent to a page by the host, so BOTH methods become the two-step
      // paste-back — and the open is the flow component's own user-gesture
      // `window.open`, not this post-await one (which every mobile browser
      // blocks). Desktop is untouched: same open, same `auto` loopback drive.
      if (window.api.platform === 'web') {
        useSessionStore.getState().setVendorOAuth({
          engineId,
          vendorId,
          stage: 'paste',
          instructions: result.instructions,
          url: result.url,
          method: methodIdx
        })
        return {
          ok: false,
          needsPaste: { url: result.url, method: methodIdx, instructions: result.instructions }
        }
      }
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
    } catch (err) {
      // The message matters now: `vendor-auth:oauth-authorize` refuses
      // opencode's `auto` method for a remote caller, and that refusal IS the
      // mockup's desktop-only outcome. Previously swallowed entirely.
      const message = errorText(err)
      if (window.api.platform === 'web') {
        useSessionStore
          .getState()
          .setVendorOAuth({ engineId, vendorId, stage: 'error', instructions: '', error: message })
      }
      return { ok: false, error: message }
    }
  },
  submitVendorOAuthCode: async (pasted) => {
    const flow = useSessionStore.getState().vendorOAuth
    if (!flow || flow.stage !== 'paste' || flow.method === undefined) {
      return { ok: false, error: 'No sign-in is in progress. Start again from step 1.' }
    }
    const { engineId, vendorId, method, instructions } = flow
    // A failed paste is TERMINAL for the flow, not a retryable field error:
    // CodexLoginFlow.completeFromPastedInput() calls terminate() on every
    // failure path (missing code, state mismatch, exchange error), so the
    // host-held PKCE verifier is already gone. Dropping to `error` — which the
    // surfaces render as an outcome plus their own start-over affordance — is
    // therefore the honest state, and it is what the mockup's "Start again from
    // step 1" means. Leaving the paste field up would invite the user to retype
    // a code into a flow that can no longer accept one.
    const fail = (message: string): { ok: false; error: string } => {
      useSessionStore
        .getState()
        .setVendorOAuth({ engineId, vendorId, stage: 'error', instructions, error: message })
      return { ok: false, error: message }
    }
    try {
      // VERBATIM (trimmed by the caller): the backend decides URL-vs-code and
      // applies the shape-dependent CSRF rule (ADR-057).
      const ok = await window.api.vendorAuthOauthCallback(
        engineId as EngineId,
        vendorId,
        method,
        pasted
      )
      if (!ok) return fail('The vendor rejected that sign-in. Start again from step 1.')
      useSessionStore.getState().setVendorOAuth(null)
      return { ok: true }
    } catch (err) {
      return fail(errorText(err))
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
    patchLocalSession(routingId, { sdkActive: true })
    await window.api.sendPrompt(routingId, prompt)
  },
  setBlockUsage: (data) => set({ blockUsage: data }),
  setActiveView: (view) => set({ activeView: view }),
  setPluginViews: (views) => set({ pluginViews: views }),

  clearConversation: async (routingId) => {
    const state = useSessionStore.getState()
    const session = state.sessions[routingId]
    if (!session) return
    // The SEALED half is no longer written here. It used to be a local
    // `patchLocalSession`, which meant the clear existed only in the clearing
    // client's replica: canonical kept the whole transcript, every other client
    // kept showing it, and the next `sync-full` handed it back to the client that
    // had just cleared it. Now this is an invoke, main emits the replicated
    // `session:conversation-cleared`, and the fold blanks the same field set
    // everywhere — including here, over the in-process MessagePort, which is why
    // the originator still sees it clear immediately.
    //
    // The MODE has to travel with it: a cleared conversation's next message is a
    // new RUN, so it starts in the configured default, and resolving that default
    // needs `availableModels` + the auto-mode gate — client state no reducer and
    // no main-process handler can see.
    await window.api.clearConversation(
      routingId,
      bootstrapPermissionMode(state, session.selectedEngineId)
    )
    // The VIEW half (drafts, panels, toasts, fork origin) is per-client and dies
    // here, as it always did.
    set((s) => ({
      sessions: updateSession(s.sessions, routingId, () => ({
        isHistorical: false,
        evicted: false,
        forkOrigin: null,
        errors: [],
        warnings: [],
        sandboxViolations: [],
        openedTaskToolUseIds: [],
        rightPanel: 'none' as const,
        bashOutputs: {},
        backgroundOutputs: {},
        backgroundWatcherCounts: {},
        stoppingTaskIds: [],
        draftText: '',
        draftAttachments: [],
        planReview: null,
        mockupDir: null,
        mockupTitle: null,
        vendorAuthRequired: null
      }))
    }))
  },

  // Worktree actions. `worktreeInfoMap` is SEALED (`config:sessions-changed`), and
  // the per-session `worktreeInfo` is projected from it — one map, one writer, so
  // the reducer's worktree-EXIT rule (drop the entry when cwd returns to
  // `originalCwd`) can no longer disagree with a second code path.
  setWorktreeInfo: (routingId, info) => {
    const state = useSessionStore.getState()
    const worktreeInfoMap = { ...state.worktreeInfoMap }
    if (info) {
      worktreeInfoMap[routingId] = info
    } else {
      delete worktreeInfoMap[routingId]
    }
    patchLocalApp({ worktreeInfoMap })
    // Also update cwd to the worktree path so the git watcher restarts on the new
    // directory. The host learns the same cwd from the engine's next status.
    if (info?.worktreePath && state.sessions[routingId]?.cwd !== info.worktreePath) {
      patchLocalSession(routingId, { cwd: info.worktreePath })
    }
    saveSessionConfig(state, { worktreeInfoMap })
  },

  clearWorktreeInfo: (routingId) => {
    const state = useSessionStore.getState()
    const worktreeInfoMap = { ...state.worktreeInfoMap }
    delete worktreeInfoMap[routingId]
    patchLocalApp({ worktreeInfoMap })
    saveSessionConfig(state, { worktreeInfoMap })
  },

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

  /**
   * Closing a tab DETACHES this surface; it no longer kills the pty.
   *
   * Terminals are a shared per-cwd pool — the shell behind this tab may also be
   * open on a phone, and closing a viewer must never take it away from another
   * viewer. The detach itself rides the XTermInstance unmount (which is the
   * thing that actually holds the attachment), so this action is now pure tab
   * state, identical to {@link removeTerminalTab}. A pty still dies on its own
   * `exit`, on an explicit `terminal:kill`, on the cold-session sweep
   * (`killTerminalsByCwd`), and with the window.
   */
  closeTerminalTab: (id) => set((state) => dropTerminalTab(state.terminalGroups, id)),

  removeTerminalTab: (id) => set((state) => dropTerminalTab(state.terminalGroups, id)),

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
