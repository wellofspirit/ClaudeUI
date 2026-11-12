/**
 * The app-settings schema: every key of `~/.claude/ui/settings.json` this build
 * knows, its type ({@link AppSettings}) and its default ({@link DEFAULT_SETTINGS}).
 *
 * The one declaration both sides read. The renderer merges a saved document over
 * the defaults (`stores/replica.ts`); core reads one key at a time through
 * `appSetting` (`src/core/services/app-settings.ts`), which resolves it with
 * {@link resolveAppSetting}. Neither side declares a default of its own, so the
 * value Settings shows is the value core runs with.
 *
 * The saved document is not this type: it may lack keys (an older build wrote
 * it, or nobody has saved yet) and may carry keys this build does not know (a
 * newer build wrote it). Both are kept as they are on disk; only the reads go
 * through the schema.
 */

import type { EngineId, VoiceLanguageCode } from './types'
import type { AutonomyMode, EffortLevel } from './model-capabilities'
import type { AgentColorId, AgentTypeColorOverrides } from './agent-type-colors'
import type { ContextPressureSetting } from './context-pressure'
import type { WorktreeProjectChoice } from './worktree-start'
import { DEFAULT_AUTONOMY_MODE } from './permission-modes'

export type ThemeId = 'dark' | 'light' | 'monokai'

/** See {@link AppSettings.newSessionModel}. */
export type NewSessionModel = 'last-picked' | 'configured-default'

export interface AppSettings {
  theme: ThemeId
  /**
   * The two agent-roster surfaces (ADR-073). The pill is the scroll-independent
   * door to the panel and stays while the session has any agent; the tab sits
   * on the composer's top-right corner and exists only while one is running.
   * Both default on; with both off the transcript card is the way in, as before.
   */
  showAgentPill: boolean
  showAgentTab: boolean
  expandToolCalls: boolean
  expandReadResults: boolean
  hideToolInput: boolean
  expandThinking: boolean
  searchCaseSensitive: boolean
  /** Find-in-chat skips content marked as tool output (TOOL_OUTPUT_SCOPE). */
  searchExcludeToolOutput: boolean
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
   * Per-model STARTING effort — Claude's (pi keeps its own in
   * `engineEffortDefaults`; opencode remembers none). Keyed by
   * `claudeEffortKey` (`shared/model-capabilities`): the family alias (`opus`, `sonnet`) for an alias row, else the resolved model id
   * (`claude-opus-4-7`, `claude-fable-5`). Written by the Settings table and by a
   * composer effort pick ("remembered per model"). When set, overrides the
   * cli.js-derived default for a session that has not started; at spawn the
   * resolved value freezes into the session's own `effort`, so a later change here
   * does not touch a running session.
   */
  modelEffortDefaults: Partial<Record<string, EffortLevel>>
  /**
   * The same starting effort for every other remembering engine (pi), keyed by
   * engine id then by the model's picker VALUE verbatim (pi's `provider/model` is
   * unique per provider, so no normalisation — and no collision with Claude's
   * `claudeEffortKey` namespace in `modelEffortDefaults`). Written by a composer
   * effort pick only, and only while `newSessionModel` is not `'configured-default'`
   * (there is no Settings table for it); read and written ONLY
   * through `savedEffortFor` / `rememberEffortPatch` (`shared/model-capabilities`),
   * which decide which engines remember. A session freezes the resolved value at
   * spawn, exactly as for Claude.
   */
  engineEffortDefaults: Partial<Record<EngineId, Partial<Record<string, EffortLevel>>>>
  /**
   * What a NEW session starts on, per engine (providers-v3 slice 9, owner
   * ruling 2026-09-23). `'last-picked'` — absent means this — is today's
   * behaviour: the model last picked on that engine wins over its configured
   * default. `'configured-default'` ignores that pick for seeding (it is still
   * recorded), so the configured default — or the engine's built-in one — seeds.
   * The same switch governs the effort a composer pick remembers
   * (`modelEffortDefaults` / `engineEffortDefaults`): under `'configured-default'`
   * an effort pick changes only its own session and writes neither map
   * (`carriesPicksIntoNewSessions`).
   */
  newSessionModel?: NewSessionModel
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
  /**
   * How many dispatched agents may run at once, across every session
   * (ADR-033, 2026-09-18). Unset means
   * `DEFAULT_MAX_CONCURRENT_DISPATCHES` (3); `0` means no limit.
   *
   * The one AppSettings key with NO entry in {@link DEFAULT_SETTINGS}, and
   * deliberately so: "unset" is a distinct state from "3" for the resolver
   * (`resolveDispatchMaxConcurrent` in `shared/dispatch-concurrency.ts` owns
   * the rule, shared with the dispatcher), and it is what lets the row's Reset
   * clear the key rather than bake today's default into every profile on disk.
   */
  dispatchMaxConcurrent?: number
  /**
   * Per-engine overrides of an agent type's tile colour (ADR-094): engine →
   * type name → palette colour id. A type with no entry is coloured by its
   * engine's own agent colour, else by a stable hash. Like
   * `dispatchMaxConcurrent`, absent from {@link DEFAULT_SETTINGS}: "no
   * override" is the unset state, and Reset deletes the key.
   */
  agentTypeColors?: AgentTypeColorOverrides
  /** The cross-engine dispatch tile's (the letter X) palette colour; unset is orange. */
  dispatchTileColor?: AgentColorId
  /**
   * What to do when a session's context crosses a threshold (session tools, slice 4). Absent from
   * {@link DEFAULT_SETTINGS}: unset is `off` with a 70 % threshold, and Reset deletes the key.
   * `normalizeContextPressure` (shared) owns the rules; the host applies it on save and on read.
   */
  contextPressure?: ContextPressureSetting
  /**
   * The session tools (the agent-facing `session_*` family and its guidance) on every engine.
   * Absent from {@link DEFAULT_SETTINGS}: unset is on, and Reset deletes the key. Read when a
   * session spawns, so turning it off applies to new sessions.
   */
  sessionTools?: boolean
  /**
   * "Start new sessions in a worktree": the global default. Absent from {@link DEFAULT_SETTINGS}:
   * unset is off, and Reset deletes the key. See `shared/worktree-start.ts`.
   */
  startInWorktree?: boolean
  /** Per-project override of {@link startInWorktree}, keyed by the sidebar group's project key; a missing key uses the default. */
  worktreeByProject?: Record<string, WorktreeProjectChoice>
  /**
   * Colour an agent's name in the roster, and the task card's model chip, by the
   * tier of the model it runs on (`shared/model-tier.ts`). On by default.
   */
  agentModelTierColors: boolean
}

/**
 * The default of every key that has one. A required key of {@link AppSettings}
 * must appear here (the compiler forces it); an optional key is absent on
 * purpose: unset is its own state, and the shared resolver named in the key's
 * comment owns what unset means.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  showAgentPill: true,
  showAgentTab: true,
  agentModelTierColors: true,
  expandToolCalls: true,
  expandReadResults: false,
  hideToolInput: false,
  expandThinking: false,
  searchCaseSensitive: false,
  searchExcludeToolOutput: false,
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
  engineEffortDefaults: {},
  mermaidTheme: 'auto',
  logLevel: 'warn',
  logFilter: '',
  mockupConnectAllowlist: '',
  mockupAllowHttp: false,
  toolOutputMaxChars: 5000,
  defaultAutonomyMode: DEFAULT_AUTONOMY_MODE
}

/**
 * One key of a saved settings document: the saved value, or the key's default.
 *
 * `saved` is whatever is on disk or in canonical state, so it is not trusted to
 * match the schema. A missing key takes the default, and so does a value whose
 * `typeof` differs from the default's (a hand-edited `"usageRefreshSecs": "fast"`
 * must not reach a timer). A key with no default is returned as saved, or
 * `undefined`: its resolver checks it.
 */
export function resolveAppSetting<K extends keyof AppSettings>(
  saved: unknown,
  key: K
): AppSettings[K] {
  const fallback = DEFAULT_SETTINGS[key]
  if (typeof saved !== 'object' || saved === null) return fallback
  const value = (saved as Record<string, unknown>)[key]
  if (value === undefined || value === null) return fallback
  if (fallback !== undefined && typeof value !== typeof fallback) return fallback
  return value as AppSettings[K]
}

/**
 * `sessionTools` as a switch. Unset is on; only an explicit `false` turns the
 * session tools off. The one statement of that rule, for the host and the
 * Settings row.
 */
export function sessionToolsEnabled(settings: Pick<AppSettings, 'sessionTools'>): boolean {
  return settings.sessionTools !== false
}
