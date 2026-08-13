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
 * alias table at the time of writing (2.1.197):
 *   `opus` → `claude-opus-4-8`, `sonnet` → `claude-sonnet-5`,
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
      return 'claude-sonnet-5'
    case 'sonnet[1m]':
      return 'claude-sonnet-5'
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
    id.includes('sonnet-4-6') ||
    id.includes('sonnet-5')
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
    id.includes('sonnet-4-6') ||
    id.includes('sonnet-5')
  )
    return true
  if (id.includes('opus') || id.includes('sonnet') || id.includes('haiku')) return false
  return true
}

/**
 * Mirrors cli.js's xhigh gate (2.1.197): explicit true for fable-5, mythos-5,
 * opus-4-8, opus-4-7, sonnet-5; explicit false for sonnet-4-6 / haiku-4-5
 * (covered here by the legacy-family branch). Unknown families are assumed
 * modern and allowed, consistent with `supportsEffort`.
 */
export function supportsXhighEffort(model: string | undefined | null): boolean {
  const id = normaliseModelId(model)
  if (
    id.includes('opus-4-7') ||
    id.includes('opus-4-8') ||
    id.includes('fable-5') ||
    id.includes('mythos-5') ||
    id.includes('sonnet-5')
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
// Max output tokens
// ---------------------------------------------------------------------------

/**
 * Maximum output tokens a model can produce. Mirrors cli.js `N0e(e)`, which
 * returns `{default, upperLimit}` per base model; we expose the `upperLimit`
 * (the model's true output ceiling, achievable with the max-tokens override /
 * beta) so it lines up with the opencode side's `limit.output` semantic.
 *
 * Values are keyed on the canonical base id, so picker aliases are resolved
 * first (`haiku` → claude-haiku-4-5 → 64000, not the default). Unknown / future
 * ids fall back to cli.js's `tLd` default of 128000.
 */
export function maxOutputTokens(model: string | undefined | null): number {
  const id = normaliseModelId(canonicalizeModelValue(model))
  // 128K ceiling — Fable/Mythos 5, Sonnet 5, Opus 4.6/4.7/4.8, Sonnet 4.6
  if (
    id.includes('fable-5') ||
    id.includes('mythos-5') ||
    id.includes('sonnet-5') ||
    id.includes('opus-4-8') ||
    id.includes('opus-4-7') ||
    id.includes('opus-4-6') ||
    id.includes('sonnet-4-6')
  )
    return 128_000
  // 64K — Opus 4.5, Sonnet 4.0/4.5, Haiku 4.5, Claude 3.7 Sonnet
  if (
    id.includes('opus-4-5') ||
    id.includes('sonnet-4-5') ||
    id.includes('sonnet-4-0') ||
    id.includes('haiku-4-5') ||
    id.includes('3-7-sonnet')
  )
    return 64_000
  // 32K — Opus 4.1 / 4.0
  if (id.includes('opus-4-1') || id.includes('opus-4-0')) return 32_000
  // Legacy 3.x
  if (id.includes('3-5-sonnet') || id.includes('3-5-haiku') || id.includes('claude-3-sonnet'))
    return 8_192
  if (id.includes('claude-3-opus') || id.includes('claude-3-haiku')) return 4_096
  // Unknown / future — cli.js's tLd default.
  return 128_000
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
  'claude-opus-4-8',
  'claude-sonnet-5'
]

/**
 * Picker aliases that cli.js currently resolves to an implicit-1M base model:
 * "fable" → claude-fable-5, "opus" → claude-opus-4-8,
 * "sonnet" → claude-sonnet-5 (native-1M since 2.1.197).
 * Aliases track the latest model generation, so re-verify this set on
 * claudeCliVersion bumps.
 */
const IMPLICIT_1M_ALIASES = new Set(['fable', 'opus', 'sonnet'])

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
  /** Engine launch-param config surfaces (gate the Settings sections of the same
   *  name). `sandbox`/`proxy` are Claude cli.js launch params; opencode doesn't
   *  use them (it has its own provider config), so its flags are false and the
   *  Settings tab hides those sections. See ROADMAP #12. */
  sandbox: boolean
  proxy: boolean
  autonomyModes: AutonomyMode[]
  auth: { canDriveLogin: boolean; multiAccount: boolean }
  /**
   * ADR-033 (cross-engine dispatch) + ADR-030 (capability honesty): "this
   * engine can host the `dispatch_agent` tool AND at least one OTHER engine is
   * installed as a possible target." Both static constants below are `true`
   * (both directions' full path — tool visible → gated → dispatch → stream →
   * result — is shipped and live-verified per ADR-033's M1/M2 notes). The
   * HONEST per-session value is runtime-computed (target-engine-installed is
   * inherently asymmetric) — see `crossEngineDispatchAvailable()` in
   * `cross-engine-dispatcher.ts`, ANDed into `SessionStatus.capabilities` by
   * each engine session, not derived here (this module is shared/renderer-safe
   * and must not import main-process-only modules like OpencodeServerManager).
   */
  crossEngineDispatch: boolean
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
  sandbox: true,
  proxy: true,
  autonomyModes: ['plan', 'ask', 'autoEdit', 'full'],
  auth: { canDriveLogin: true, multiAccount: true },
  crossEngineDispatch: true
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
    maxOutput: maxOutputTokens(model?.value ?? null),
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
    sandbox: engine.sandbox,
    proxy: engine.proxy,
    autonomyModes: engine.autonomyModes,
    auth: engine.auth,
    crossEngineDispatch: engine.crossEngineDispatch,
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
 *
 * Canonicalizes the incoming value before building caps so that aliases like
 * 'sonnet' resolve to their current canonical id ('claude-sonnet-5') and the
 * id-based heuristics (effort, thinking, context window) key on that id rather
 * than the alias string. The 'default' alias has no canonicalization, preserving
 * its pass-through behaviour.
 */
export function resolveClaudeCapabilities(modelValue?: string | null): ResolvedCapabilities {
  const raw = modelValue ?? 'default'
  const canonical = canonicalizeModelValue(raw) || raw
  return resolveCapabilities(
    CLAUDE_ENGINE_CAPABILITIES,
    claudeModelCapabilities({ value: canonical })
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
 * fork:false / forkFromMessage:false — the end-to-end path is unwired:
 * `OpencodeClient.forkSession()` exists but has no production caller,
 * `OpencodeSession` ignores its `_resumeSessionAt`/`_forkSession` spawn params,
 * and fork-anchor resolution (`resolveForkAnchor`) is Claude-JSONL-only. See
 * engine-hardening-plan.md Item 1 / ADR-030 (capability honesty).
 */
export const OPENCODE_ENGINE_CAPABILITIES: EngineCapabilities = {
  voice: false,
  hostedMcp: true,
  backgroundTasks: false,
  subagents: true,
  plan: true,
  fork: false,
  forkFromMessage: false,
  steer: true,
  queue: true,
  slashCommands: true,
  skills: true,
  sideQuestion: true,
  interactiveApprovals: true,
  sandbox: false,
  proxy: false,
  autonomyModes: ['plan', 'ask', 'full'],
  auth: { canDriveLogin: true, multiAccount: false },
  crossEngineDispatch: true
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

/**
 * Seed ResolvedCapabilities for an opencode session from a discovered ModelInfo's
 * flat capability flags (renderer pre-spawn gating, before status.capabilities
 * becomes authoritative on connect). ModelInfo carries no limit/cost, so
 * contextWindow/promptCaching fall back to defaults until the session connects.
 */
export function resolveOpencodeCapabilitiesFromModel(
  m?: { vision?: boolean; toolCalling?: boolean }
): ResolvedCapabilities {
  return resolveOpencodeCapabilities(
    m ? { capabilities: { attachment: m.vision, toolcall: m.toolCalling } } : undefined
  )
}

/**
 * pi engine capabilities (ADR-030 capability honesty: every flag is false
 * except what a shipped milestone fully wires end-to-end). Flip plan for
 * later milestones (see the M1 kickoff spec's milestone list):
 *   - interactiveApprovals:true, autonomyModes: ['ask','autoEdit','full'] →
 *     SHIPPED in M2a via the approval-bridge extension (`pi.on('tool_call',
 *     …)`, verified in M0; PiBridgeHost + permission-engine.ts).
 *   - plan:true, autonomyModes includes 'plan' → SHIPPED in M5a: extension-
 *     enforced read-only autonomy. Unlike opencode's built-in `plan` agent,
 *     pi has no native plan mode — ClaudeUI's bridge extension
 *     (pi-bridge-source.ts) toggles pi's own active-tool set on
 *     `/cui-plan-enter`/`/cui-plan-exit` (dropping edit/write, adding a
 *     locally-executed `exit_plan` tool) while permission-engine.ts's
 *     `planModeBaseDecision` independently gates bash to a read-only
 *     allowlist and denies everything else — defense in depth, not either
 *     layer alone. The autonomy↔permission-mode mapping (settings-sections.tsx)
 *     already mapped 'plan'↔'plan' for every engine before this flip (verified
 *     against src/shared/__tests__/autonomy-mode.test.ts) — only the
 *     capability flags and the pi-side implementation were missing.
 *   - steer:true → SHIPPED in M2b: PiSession.run()'s busy path now sends
 *     `streamingBehavior:'steer'` (delivered after the current tool calls
 *     finish, before the next LLM call — verified, docs/protocol-pi/README.md).
 *     `queue` stays true alongside it: the two flags gate the SAME
 *     send-while-busy affordance (InputBox's queueEnabled derives from
 *     `capabilities.queue` only — `capabilities.steer` is read nowhere in the
 *     renderer, it is a pure ADR-030 honesty/documentation flag), and the
 *     renderer's queued-message UI resolves identically either way via the
 *     engine-neutral queue of record (ADR-053: core holds the item and forwards
 *     it as a `steer` at the next sub-turn boundary, then broadcasts the
 *     `consumed` transition on `session:queue-changed`).
 *   - slashCommands:true, skills:true → SHIPPED in M2b via `get_commands`
 *     (doStart(), once per spawn): emits `session:slash-commands` (all
 *     non-temporary-scope entries, '/'-prefixed) and `session:skills` (source
 *     === 'skill' entries, `skill:` prefix stripped) — same wire contract as
 *     OpencodeSession's listCommands/listSkills emission. `skills:true` is
 *     safe despite `discoverSkills` staying UNIMPLEMENTED here: SkillsDialog's
 *     only data path (`loadSkillDetails` IPC handler) already does
 *     `delegate?.discoverSkills?.(cwd) ?? scanSkills(cwd)` — the optional-call
 *     falls back to Claude's filesystem scanner instead of throwing.
 *     `session:skills` therefore only drives the TopBar Skills-button
 *     availability hint. M3 (shared skills) deliberately did NOT add
 *     `PiSession.discoverSkills` — the generic `scanSkills(cwd)` fallback
 *     already covers the SkillsDialog's directory listing adequately, and the
 *     actually-loaded skill set (M3's real deliverable) is driven by the
 *     bridge extension's `resources_discover` handler (`CLAUDEUI_PI_SKILL_DIRS`,
 *     computed in PiSession.doStart) feeding pi's OWN skill loader, which is
 *     what surfaces as `skill:<name>` in `get_commands` above — no second
 *     discovery path needed.
 *   - auth.canDriveLogin → flipped true in M6c. The "TUI-only, permanently
 *     false" note above is now obsolete for ONE vendor: `openai-codex`
 *     (ChatGPT). ClaudeUI's own auth vault (M6a AuthVault + M6b
 *     CredentialSync) now drives that vendor's OAuth login end-to-end —
 *     PiAuthProvider.oauthAuthorize/oauthCallback/cancelVendorOauth delegate
 *     to credentialSync.beginLogin/completeLogin/cancelLogin — and PiVendors.tsx
 *     surfaces a real in-app "Connect ChatGPT" flow (shared with opencode,
 *     same `authorizeVendorOAuth` store action) instead of a run-in-a-terminal
 *     hint. pi's OTHER subscription vendors (anthropic, github-copilot, xai,
 *     radius — PiAuthProvider.ts's PI_SUBSCRIPTION_VENDOR_IDS) remain
 *     undriven: `pi /login` in a terminal is still the only path for those,
 *     and PiVendors.tsx keeps the terminal hint for them. This flag itself
 *     has no renderer consumer (grepped: only this file, EngineAuthProvider.ts's
 *     doc comments, and PiAuthProvider.ts's doc comment reference it) — it is
 *     ADR-030 capability-honesty bookkeeping, not a UI gate. The actual
 *     per-vendor UI decision in PiVendors.tsx is a hardcoded
 *     `vendorId === 'openai-codex'` check, not a read of this flag, so
 *     flipping it does NOT wrongly enable driven login for pi's other
 *     subscription vendors.
 *   - hostedMcp → SHIPPED in M4a: the hosted render_mermaid/create_mockup/
 *     show_mockup tools are bridged through pi's extension API
 *     (pi.registerTool() in pi-bridge-source.ts, calling back over
 *     PiBridgeHost's POST /hosted-tool route to PiSession.handleHostedTool),
 *     auto-allowed via permission-engine.ts's PI_AUTO_ALLOW_HOSTED_TOOLS.
 *   - sideQuestion → SHIPPED: pi has no in-session, non-persisting "ask" RPC
 *     (prompt/steer/followUp all persist to the active branch) and no
 *     equivalent of Claude's in-session `side_question` control_request, so
 *     `/btw` is answered by a TRANSCRIPT-FED EPHEMERAL pi process instead of
 *     a blank one — PiSession.askSideQuestion builds a bounded context string
 *     from THIS session's own retained `messageHistory`, spawns an isolated
 *     `pi --mode rpc --no-session` process (the same bare spawn shape
 *     model-discovery.ts uses — no bridge/subagent/hosted env, so this
 *     ephemeral gets none of the live session's tool-call gating), sends one
 *     framing prompt telling the model it is observing and must not act, and
 *     reads `get_last_assistant_text` once `agent_settled` fires. Bounded
 *     overall timeout; null on any failure (binary missing, spawn error,
 *     rejected prompt, timeout) — the UI already handles null gracefully. See
 *     askSideQuestion's own doc comment for the full mechanism and the
 *     documented fidelity limitation (visible transcript only, never pi's
 *     in-flight internal state).
 *   - fork/forkFromMessage → SHIPPED in M5c: pi's `clone`/`fork` RPCs stand in
 *     for cli.js's `--resume-session-at`/`--fork-session` flags. `fork` has no
 *     stable id ClaudeUI can match a renderer message against (a live
 *     assistant ChatMessage.id is a uuid event-mapper.ts synthesizes, never
 *     persisted), so `resolveForkAnchor`'s pi branch (session-history.ts,
 *     delegating to pi-session-list.ts's `resolvePiForkAnchor`) resolves by
 *     POSITION instead — the store's `idx` into its own `messages` array,
 *     which is the SAME sequence pi-session-list.ts's `convertPiSessionEntries`
 *     produces from disk. PiSession.doStart, when `forkSession`, resumes the
 *     SOURCE then (BEFORE any set_model/effort application, so configuring
 *     the fork never mutates the source) either `fork {entryId}` (drop that
 *     user entry + everything after — verified against the real binary: this
 *     ALONE already creates a new file and leaves the source untouched, no
 *     preceding `clone` needed) or, when forking the LATEST message (no
 *     later user entry to drop), `clone` alone (duplicate the active branch
 *     at its current position). Either way it adopts the resulting NEW
 *     sessionId before continuing, and skips the stored-history replay (the
 *     renderer already has the correct truncated view from the store's own
 *     optimistic seed) — mirrors ClaudeSession's identical "forks excluded"
 *     cost-seeding posture.
 *   - backgroundTasks, voice →
 *     unwired; each becomes a dedicated follow-up once its RPC surface is
 *     wired the same way OpencodeSession's were.
 *   - subagents → SHIPPED in M5b: a SECOND ClaudeUI-owned extension
 *     (pi-subagent-source.ts, gated on CLAUDEUI_PI_SUBAGENTS) registers a
 *     `subagent` pi.registerTool() that spawns one child `pi --mode json -p`
 *     process per user-level agent definition (`~/.pi/agent/agents/*.md`,
 *     port of pi's own shipped example) and streams its progress through the
 *     SAME `session:subagent-*`/TaskCard pipeline the cross-engine dispatch
 *     target uses (event-mapper.ts's `subagent_update` MapperOutput →
 *     PiSession.dispatchOutput). Flipped true only because that full path —
 *     tool visible → gated ('task' kind) → child spawned → streamed →
 *     result rendered — is genuinely wired, not because pi has any NATIVE
 *     subagent concept (it has none; this is entirely a ClaudeUI construct,
 *     same posture as hostedMcp/crossEngineDispatch above).
 *   - sandbox, proxy → Claude cli.js launch-param concepts; pi has neither
 *     (see EngineCapabilities' own doc comment) — likely permanently false.
 *   - crossEngineDispatch → SHIPPED both directions: pi as a dispatch SOURCE
 *     (M4b — `dispatch_agent`, same registerTool mechanism as hostedMcp above,
 *     PiSession.handleDispatchAgent calling crossEngineDispatcher.dispatch()
 *     directly — NOT via MCP) AND pi as a dispatch TARGET (M4c —
 *     cross-engine-dispatcher.ts's engine guard accepts 'pi' as `req.engine`
 *     and routes it through `resolveAndRunPi`). The static `true` here is
 *     ANDed with the runtime `crossEngineDispatchAvailable('pi')` check at
 *     PiSession's `capabilities` getter (mirrors ClaudeSession/
 *     OpencodeSession's identical AND at session build — ADR-030/033 M4-A).
 */
export const PI_ENGINE_CAPABILITIES: EngineCapabilities = {
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
  sandbox: false,
  proxy: false,
  autonomyModes: ['ask', 'autoEdit', 'full', 'plan'],
  auth: { canDriveLogin: true, multiAccount: false },
  crossEngineDispatch: true
}

/**
 * Derive ModelCapabilities for a pi model. pi's reasoning is TWO things that
 * must not be conflated: `thinkingLevel` is a SESSION-WIDE off/low/…/max dial
 * (`set_thinking_level`), not a per-model thinking-MODE axis like Claude's
 * adaptive/enabled/disabled — so `reasoning.thinking` is never populated here
 * (no Adaptive picker for any pi model, ever). `reasoning.effort` DOES flip
 * per-model (M2b): when the catalog's `reasoning` fact is true, the model
 * accepts `set_thinking_level`. The caller may pass `effortLevels` (derived
 * by `model-discovery.ts`'s `effortLevelsFromModel` from the catalog's
 * `thinkingLevelMap` — verified probe, 2026-07-20: the map's keys ARE
 * xhigh/max support) to expose the model's actual tiers, including xhigh/max
 * where supported; omitting it falls back to the conservative low/medium/high
 * set (back-compat for callers that haven't traced a PiModel through yet).
 * toolCalling is always true — every pi model that can be selected has tool
 * support (pi has no text-only-model concept exposed via get_available_models).
 */
export function piModelCapabilities(
  m?: {
    vision?: boolean
    contextWindow?: number
    maxOutput?: number
    reasoning?: boolean
    effortLevels?: EffortLevel[]
  }
): ModelCapabilities {
  return {
    reasoning: m?.reasoning ? { effort: { levels: m.effortLevels ?? ['low', 'medium', 'high'] } } : {},
    vision: !!m?.vision,
    toolCalling: true,
    contextWindow: m?.contextWindow ?? 200_000,
    maxOutput: m?.maxOutput ?? 8192,
    promptCaching: true
  }
}

/**
 * Convenience: compute ResolvedCapabilities for a pi session from the fuller
 * PiModel-derived shape (vision/contextWindow/maxOutput) — PiSession's own
 * call site, once connected and the model catalog is warm.
 */
export function resolvePiCapabilities(
  m?: Parameters<typeof piModelCapabilities>[0]
): ResolvedCapabilities {
  return resolveCapabilities(PI_ENGINE_CAPABILITIES, piModelCapabilities(m))
}

/**
 * Seed ResolvedCapabilities for a pi session from a discovered ModelInfo's flat
 * capability flags (renderer pre-spawn gating, before status.capabilities
 * becomes authoritative on connect). ModelInfo carries no structured
 * contextWindow/maxOutput (model-discovery.ts encodes context size into the
 * description string instead), so those fall back to piModelCapabilities'
 * defaults until PiSession resolves the full PiModel post-connect. `reasoning`
 * is likewise not a ModelInfo field — PI_META.seedCapabilities derives it from
 * ModelInfo.supportsEffort (the flag model-discovery.ts already sets per the
 * catalog's `reasoning` fact) before calling this, and passes ModelInfo's own
 * `supportedEffortLevels` through as `effortLevels` (already carrying
 * xhigh/max per model via `effortLevelsFromModel` — model-discovery.ts) so
 * the pre-spawn seed and PiSession's post-connect resolve agree.
 */
export function resolvePiCapabilitiesFromModel(
  m?: Parameters<typeof piModelCapabilities>[0]
): ResolvedCapabilities {
  return resolvePiCapabilities(m)
}
