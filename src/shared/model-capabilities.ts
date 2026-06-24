/**
 * Model capability matrix, authoritative via SDK-provided `ModelInfo` fields
 * (`supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`)
 * with a model-id heuristic fallback for cases where the SDK omits them.
 *
 * SDK fields are preferred because ClaudeUI model values are aliases
 * (`default`, `sonnet`, `sonnet[1m]`, `haiku`) rather than canonical ids —
 * regex-based id matching cannot answer capability questions about an alias.
 *
 * See docs/model-capabilities.md for the customer-facing reference and the
 * appendix on how to re-derive the heuristic from cli.js when the SDK ships
 * a new model but omits the capability fields.
 */

export type ThinkingMode = 'adaptive' | 'enabled' | 'disabled'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Minimal ModelInfo shape this module needs. Intentionally structural so
 * callers can pass either the shared `ModelInfo` or the renderer's
 * `ModelDisplay` (which extends it).
 */
export interface ModelCapabilityInput {
  value: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly EffortLevel[]
  supportsAdaptiveThinking?: boolean
}

export const THINKING_MODES: readonly ThinkingMode[] = ['adaptive', 'enabled', 'disabled'] as const
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const

/**
 * Normalise a model identifier the same way cli.js does: strip date suffixes
 * (`-20250805`), version suffixes (`-v1`, `-v1:0`), and lowercase.
 */
function normaliseModelId(model: string | undefined | null): string {
  if (!model) return ''
  const lower = model.toLowerCase()
  const match = lower.match(/claude-[a-z0-9-]+/)
  let id = match ? match[0] : lower
  id = id.replace(/-v\d+(:\d+)?$/, '')
  id = id.replace(/-\d{8}$/, '')
  return id
}

/**
 * Map a model picker value to its canonical id. Mirrors cli.js's `i8_`
 * alias table at the time of writing (2.1.154):
 *   `opus` → `claude-opus-4-8`, `sonnet` → `claude-sonnet-4-6`,
 *   `haiku` → `claude-haiku-4-5`.
 *
 * The `default` alias intentionally has no mapping — it resolves at the cli.js
 * layer to whatever the user (or environment) has configured. Returns the
 * input unchanged for canonical ids that don't need translation.
 */
export function canonicalizeModelValue(value: string | undefined | null): string {
  if (!value) return ''
  switch (value) {
    case 'opus':
      return 'claude-opus-4-8'
    case 'opus[1m]':
      return 'claude-opus-4-8'
    case 'sonnet':
      return 'claude-sonnet-4-6'
    case 'sonnet[1m]':
      return 'claude-sonnet-4-6'
    case 'haiku':
      return 'claude-haiku-4-5'
    default:
      return normaliseModelId(value) || value
  }
}

/**
 * Models known NOT to support `effort: 'max'`. Mirrors cli.js `c8z` set.
 * Note: haiku is excluded by name elsewhere (it never supports `max`).
 */
const NO_MAX_EFFORT = new Set([
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet',
  'claude-sonnet-4',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-opus-4',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5'
])

// ---------------------------------------------------------------------------
// SDK-aware accessors — these are the preferred entry points. They take a
// full ModelInfo (or any object with the capability fields) and return SDK
// values directly; the id-based heuristics below are the fallback.
// ---------------------------------------------------------------------------

export function modelSupportsAdaptiveThinking(
  model: ModelCapabilityInput | undefined | null
): boolean {
  if (!model) return false
  if (typeof model.supportsAdaptiveThinking === 'boolean') return model.supportsAdaptiveThinking
  return supportsAdaptiveThinking(model.value)
}

export function modelSupportsEffort(model: ModelCapabilityInput | undefined | null): boolean {
  if (!model) return false
  if (typeof model.supportsEffort === 'boolean') return model.supportsEffort
  return supportsEffort(model.value)
}

export function modelSupportedEffortLevels(
  model: ModelCapabilityInput | undefined | null
): EffortLevel[] {
  if (!model) return []
  if (model.supportedEffortLevels && model.supportedEffortLevels.length > 0) {
    return [...model.supportedEffortLevels]
  }
  if (model.supportsEffort === false) return []
  return supportedEffortLevels(model.value)
}

export function modelDefaultEffort(model: ModelCapabilityInput | undefined | null): EffortLevel {
  const allowed = modelSupportedEffortLevels(model)
  // Use the id-based default first. Mirrors cli.js `YK6`, which since 2.1.154
  // returns 'xhigh' only for opus-4-7 — opus-4-8 supports xhigh but defaults
  // to 'high' (4.8-high is roughly 4.7-xhigh quality). A blanket
  // "xhigh allowed ⇒ xhigh default" rule would now over-select for 4.8 and
  // for the `default`/`opus` aliases that resolve to it.
  const fallback = defaultEffort(model?.value)
  if (allowed.includes(fallback)) return fallback
  if (allowed.includes('high')) return 'high'
  return allowed[allowed.length - 1] ?? 'high'
}

export function modelDefaultThinkingMode(
  model: ModelCapabilityInput | undefined | null
): ThinkingMode {
  return modelSupportsAdaptiveThinking(model) ? 'adaptive' : 'enabled'
}

export function modelResolveThinkingMode(
  model: ModelCapabilityInput | undefined | null,
  desired: ThinkingMode
): ThinkingMode {
  if (desired === 'disabled') return 'disabled'
  if (desired === 'adaptive' && !modelSupportsAdaptiveThinking(model)) return 'enabled'
  return desired
}

export function modelResolveEffort(
  model: ModelCapabilityInput | undefined | null,
  desired: EffortLevel
): EffortLevel | null {
  if (!modelSupportsEffort(model)) return null
  const allowed = modelSupportedEffortLevels(model)
  if (allowed.includes(desired)) return desired
  return modelDefaultEffort(model)
}

// ---------------------------------------------------------------------------
// Id-based heuristics — used when SDK capability fields are absent.
// Kept exported for tests and for future models the SDK hasn't labelled yet.
// ---------------------------------------------------------------------------

/** Mirrors cli.js `kh8`. */
export function supportsAdaptiveThinking(model: string | undefined | null): boolean {
  const id = normaliseModelId(model)
  if (
    id.includes('opus-4-8') ||
    id.includes('opus-4-7') ||
    id.includes('opus-4-6') ||
    id.includes('sonnet-4-6')
  )
    return true
  if (id.includes('opus') || id.includes('sonnet') || id.includes('haiku')) return false
  // Unknown family — assume modern, allow adaptive.
  return true
}

/** Mirrors cli.js `QI`. */
export function supportsEffort(model: string | undefined | null): boolean {
  const id = normaliseModelId(model)
  if (
    id.includes('opus-4-8') ||
    id.includes('opus-4-7') ||
    id.includes('opus-4-6') ||
    id.includes('sonnet-4-6')
  )
    return true
  if (id.includes('opus') || id.includes('sonnet') || id.includes('haiku')) return false
  return true
}

/**
 * Mirrors cli.js's xhigh gate (2.1.170): explicit true for fable-5, mythos-5,
 * opus-4-8, opus-4-7; explicit false for sonnet-4-6 / haiku-4-5 (covered here
 * by the legacy-family branch). Unknown families are assumed modern and
 * allowed, consistent with `supportsEffort`.
 */
export function supportsXhighEffort(model: string | undefined | null): boolean {
  const id = normaliseModelId(model)
  if (
    id.includes('opus-4-7') ||
    id.includes('opus-4-8') ||
    id.includes('fable-5') ||
    id.includes('mythos-5')
  ) {
    return true
  }
  if (id.includes('opus') || id.includes('sonnet') || id.includes('haiku')) return false
  return true
}

/** Mirrors cli.js `Ct6`. Haiku never supports max; legacy models in NO_MAX_EFFORT don't either. */
export function supportsMaxEffort(model: string | undefined | null): boolean {
  const id = normaliseModelId(model)
  if (id.includes('haiku')) return false
  return !NO_MAX_EFFORT.has(id)
}

/** Returns the set of effort levels this model accepts. Empty array means no picker. */
export function supportedEffortLevels(model: string | undefined | null): EffortLevel[] {
  if (!supportsEffort(model)) return []
  return EFFORT_LEVELS.filter((level) => {
    if (level === 'xhigh') return supportsXhighEffort(model)
    if (level === 'max') return supportsMaxEffort(model)
    return true
  })
}

/** Mirrors cli.js `YK6`. Opus 4.7 is the only model that defaults to xhigh. */
export function defaultEffort(model: string | undefined | null): EffortLevel {
  const id = normaliseModelId(model)
  if (id.includes('opus-4-7')) return 'xhigh'
  return 'high'
}

/**
 * Default thinking mode for a model: adaptive when supported, otherwise enabled.
 * Falls back to `disabled` only if the caller explicitly chooses it later.
 */
export function defaultThinkingMode(model: string | undefined | null): ThinkingMode {
  return supportsAdaptiveThinking(model) ? 'adaptive' : 'enabled'
}

/**
 * Coerce a user-chosen thinking mode into one the current model accepts.
 * `adaptive` falls back to `enabled` on legacy models. `disabled` is universal.
 */
export function resolveThinkingMode(
  model: string | undefined | null,
  desired: ThinkingMode
): ThinkingMode {
  if (desired === 'disabled') return 'disabled'
  if (desired === 'adaptive' && !supportsAdaptiveThinking(model)) return 'enabled'
  return desired
}

/**
 * Coerce a user-chosen effort into one the current model accepts. Unsupported
 * tiers fall back to the model's default. Returns `null` if the model has no
 * effort control at all.
 */
export function resolveEffort(
  model: string | undefined | null,
  desired: EffortLevel
): EffortLevel | null {
  if (!supportsEffort(model)) return null
  const allowed = supportedEffortLevels(model)
  if (allowed.includes(desired)) return desired
  return defaultEffort(model)
}

// ---------------------------------------------------------------------------
// Context window
// ---------------------------------------------------------------------------

export const CONTEXT_WINDOW_1M = 1_000_000
export const CONTEXT_WINDOW_DEFAULT = 200_000

/**
 * Base models that get a 1M window without a "[1m]" suffix — cli.js `UE()`.
 * Matched by substring like cli.js's normaliser, so dated ids and
 * provider-prefixed ids (Bedrock) resolve too.
 */
const IMPLICIT_1M_BASE_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-4-7',
  'claude-opus-4-8'
]

/**
 * Picker aliases that cli.js currently resolves to an implicit-1M base model:
 * "fable" → claude-fable-5, "opus" → claude-opus-4-8. Aliases track the latest
 * model generation, so re-verify this set on claudeCliVersion bumps.
 */
const IMPLICIT_1M_ALIASES = new Set(['fable', 'opus'])

/**
 * Resolve a model value (picker alias or full id) to its context-window size,
 * mirroring cli.js's `DR(model, betas)`. Does NOT honour the
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT` env override — that's a main-process concern
 * applied by `getContextWindowSize` in services/context-window.ts. The renderer
 * has no access to that env var, so it calls this directly.
 *
 * Crucially, resolution is keyed on the model VALUE, not the SDK-provided
 * description: implicit-1M models (Fable 5, Opus 4.8) carry no "1m" marker in
 * their description, so a description heuristic silently caps them at 200K.
 */
export function resolveContextWindow(modelValue: string | undefined | null): number {
  if (!modelValue) return CONTEXT_WINDOW_DEFAULT
  const value = modelValue.toLowerCase().trim()
  if (value.includes('[1m]')) return CONTEXT_WINDOW_1M
  if (IMPLICIT_1M_BASE_MODELS.some((base) => value.includes(base))) return CONTEXT_WINDOW_1M
  if (IMPLICIT_1M_ALIASES.has(value)) return CONTEXT_WINDOW_1M
  return CONTEXT_WINDOW_DEFAULT
}

// ---------------------------------------------------------------------------
// V2 Capability Model (Phase 2)
// ---------------------------------------------------------------------------

/** Supported autonomy modes per engine. */
export type AutonomyMode = 'plan' | 'ask' | 'autoEdit' | 'full'

/** Static per-engine capabilities (vendor-independent). */
export interface EngineCapabilities {
  voice: boolean
  hostedMcp: boolean
  backgroundTasks: boolean
  subagents: boolean
  plan: boolean
  fork: boolean
  forkFromMessage: boolean
  steer: boolean
  queue: boolean
  slashCommands: boolean
  skills: boolean
  sideQuestion: boolean
  interactiveApprovals: boolean
  autonomyModes: AutonomyMode[]
  auth: { canDriveLogin: boolean; multiAccount: boolean }
}

/**
 * Reasoning is TWO independent axes. A model may have both (Claude: thinking
 * modes AND effort tiers), one, or neither. Not a single-kind union.
 * ThinkingMode/EffortLevel come from this module (the single source of truth).
 */
export interface ReasoningCapability {
  /** Thinking mode picker (adaptive|enabled|disabled). Present when model supports thinking. */
  thinking?: { modes: readonly ThinkingMode[]; supportsBudget?: boolean }
  /** Effort tier picker. Present when model supports effort levels. */
  effort?: { levels: EffortLevel[] }
}

/** Per (engine, vendor, model) capabilities. */
export interface ModelCapabilities {
  reasoning: ReasoningCapability
  vision: boolean
  toolCalling: boolean
  contextWindow: number
  maxOutput: number
  promptCaching: boolean
}

/** What the UI consumes — merge of engine + model caps with AND-derived gates. */
export interface ResolvedCapabilities extends EngineCapabilities {
  reasoning: ReasoningCapability
  vision: boolean
  toolCalling: boolean
  contextWindow: number
  maxOutput: number
  promptCaching: boolean
  // AND-of-both derived gates
  canUseMcp: boolean // hostedMcp && toolCalling
  canUseSubagents: boolean // subagents && toolCalling
  isAgentCapable: boolean // toolCalling
}

/** Claude engine capabilities — all true, full autonomy modes. */
export const CLAUDE_ENGINE_CAPABILITIES: EngineCapabilities = {
  voice: true,
  hostedMcp: true,
  backgroundTasks: true,
  subagents: true,
  plan: true,
  fork: true,
  forkFromMessage: true,
  steer: true,
  queue: true,
  slashCommands: true,
  skills: true,
  sideQuestion: true,
  interactiveApprovals: true,
  autonomyModes: ['plan', 'ask', 'autoEdit', 'full'],
  auth: { canDriveLogin: true, multiAccount: true }
}

/**
 * Derive ModelCapabilities for a Claude model from the existing capability
 * helpers. This is the single normalizer — do not re-derive thinking/effort
 * in any other module.
 *
 * reasoning.thinking: present when modelSupportsAdaptiveThinking (THINKING_MODES with budget).
 * reasoning.effort: present when modelSupportsEffort (supported levels from modelSupportedEffortLevels).
 * Both may be present simultaneously (e.g. claude-opus-4-8 and claude-sonnet-4-6).
 */
export function claudeModelCapabilities(
  model: ModelCapabilityInput | undefined | null
): ModelCapabilities {
  const reasoning: ReasoningCapability = {}
  if (modelSupportsAdaptiveThinking(model)) {
    reasoning.thinking = { modes: THINKING_MODES, supportsBudget: true }
  }
  if (modelSupportsEffort(model)) {
    reasoning.effort = { levels: modelSupportedEffortLevels(model) }
  }
  return {
    reasoning,
    vision: true,
    toolCalling: true,
    contextWindow: resolveContextWindow(model?.value ?? null),
    maxOutput: 32768,
    promptCaching: true
  }
}

/**
 * Merge engine + model capabilities into ResolvedCapabilities.
 * Called on session start and on every model switch.
 */
export function resolveCapabilities(
  engine: EngineCapabilities,
  model: ModelCapabilities
): ResolvedCapabilities {
  return {
    // Engine fields (spread individually for explicit typing)
    voice: engine.voice,
    hostedMcp: engine.hostedMcp,
    backgroundTasks: engine.backgroundTasks,
    subagents: engine.subagents,
    plan: engine.plan,
    fork: engine.fork,
    forkFromMessage: engine.forkFromMessage,
    steer: engine.steer,
    queue: engine.queue,
    slashCommands: engine.slashCommands,
    skills: engine.skills,
    sideQuestion: engine.sideQuestion,
    interactiveApprovals: engine.interactiveApprovals,
    autonomyModes: engine.autonomyModes,
    auth: engine.auth,
    // Model fields
    reasoning: model.reasoning,
    vision: model.vision,
    toolCalling: model.toolCalling,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    promptCaching: model.promptCaching,
    // AND-derived gates
    canUseMcp: engine.hostedMcp && model.toolCalling,
    canUseSubagents: engine.subagents && model.toolCalling,
    isAgentCapable: model.toolCalling
  }
}

/**
 * Convenience: compute ResolvedCapabilities for a Claude session by model value string.
 * Primary entry point for ClaudeSession, store seeds, and test factories.
 */
export function resolveClaudeCapabilities(modelValue?: string | null): ResolvedCapabilities {
  return resolveCapabilities(
    CLAUDE_ENGINE_CAPABILITIES,
    claudeModelCapabilities({ value: modelValue ?? 'default' })
  )
}

/**
 * opencode engine capabilities — 8d.
 * hostedMcp:true (Phase 5c) means "this engine hosts ClaudeUI's injected tools"
 * (render_mermaid / create_mockup / show_mockup via the auto-loaded plugin). It
 * does NOT mean opencode exposes Claude's `.mcp.json` server-config UI — that
 * dialog (McpDialog) is scoped to engineId==='claude' in TopBar.tsx, so this flip
 * only enables our hosted tools, not the Claude MCP config surface.
 * queue+steer:true (Phase 8c) — opencode coalesces a mid-turn prompt into the
 * running loop (no server-side holdable queue), so send-while-busy = post-immediately
 * = steer. dequeue is a no-op (can't un-send once coalesced). voice deferred.
 * subagents:true (Phase 8d) — opencode's `task` tool spawns child sessions whose
 * transcripts stream on the shared SSE; the event-mapper routes them to
 * session:subagent-* events keyed by the parent task part's callID.
 */
export const OPENCODE_ENGINE_CAPABILITIES: EngineCapabilities = {
  voice: false,
  hostedMcp: true,
  backgroundTasks: false,
  subagents: true,
  plan: true,
  fork: true,
  forkFromMessage: true,
  steer: true,
  queue: true,
  slashCommands: true,
  skills: true,
  sideQuestion: true,
  interactiveApprovals: true,
  autonomyModes: ['plan', 'ask', 'full'],
  auth: { canDriveLogin: true, multiAccount: false }
}

/**
 * Derive ModelCapabilities for an opencode model from its discovered caps.
 * reasoning: empty object (opencode reasoning is a per-model boolean, not a
 * modes/levels control — no thinking/effort picker in 5b; follow-up phase).
 */
export function opencodeModelCapabilities(
  m?: {
    // Local structural type (a subset of opencode's protocol ModelCapabilities)
    // so shared/ stays self-contained — no import from main/.
    capabilities?: {
      attachment?: boolean
      toolcall?: boolean
      reasoning?: boolean
      input?: { image?: boolean }
    }
    limit?: { context?: number; output?: number }
    cost?: { cache?: { read: number; write: number } }
  }
): ModelCapabilities {
  const caps = m?.capabilities
  const limit = m?.limit
  const cost = m?.cost
  return {
    reasoning: {},
    vision: !!(caps?.attachment || caps?.input?.image),
    toolCalling: !!caps?.toolcall,
    contextWindow: limit?.context ?? 200_000,
    maxOutput: limit?.output ?? 8192,
    promptCaching: !!(cost?.cache)
  }
}

/**
 * Convenience: compute ResolvedCapabilities for an opencode session.
 */
export function resolveOpencodeCapabilities(
  m?: Parameters<typeof opencodeModelCapabilities>[0]
): ResolvedCapabilities {
  return resolveCapabilities(OPENCODE_ENGINE_CAPABILITIES, opencodeModelCapabilities(m))
}
