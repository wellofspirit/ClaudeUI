/**
 * EngineMeta — the per-engine descriptor table. Collapses the per-engine
 * `engineId === 'opencode' ? … : <claude>` ternaries that were scattered across
 * the store, db, and settings into one declarative table. Adding a new EngineId
 * union member is a COMPILE ERROR here (via `satisfies Record<EngineId, EngineMeta>`)
 * until its meta is filled in — turning the "add-an-engine" checklist into type errors.
 *
 * Renderer-only per-engine concerns (SVG logo, tool-name maps) live in the
 * renderer near their consumers (they must not pull React into shared/).
 */
import type { EngineId, VendorId, ModelRef, ModelInfo } from './types'
import { claudeModel, opencodeModel, piModel } from './types'
import type { EngineCapabilities, ResolvedCapabilities } from './model-capabilities'
import {
  CLAUDE_ENGINE_CAPABILITIES,
  OPENCODE_ENGINE_CAPABILITIES,
  PI_ENGINE_CAPABILITIES,
  resolveClaudeCapabilities,
  resolveOpencodeCapabilitiesFromModel,
  resolvePiCapabilitiesFromModel
} from './model-capabilities'

/**
 * The hard-coded opencode fallback model VALUE (a free, no-auth OpenCode Zen
 * model). Used when a session/engine has no configured or remembered model.
 * Moved here from the renderer store so EngineMeta can own it; the store
 * re-exports it for existing importers.
 */
export const OPENCODE_DEFAULT_MODEL = 'opencode/mimo-v2.5-free'

/**
 * The hard-coded pi fallback model VALUE. `openai-codex` is pi's provider id
 * for the ChatGPT-subscription flow (shares opencode's Codex OAuth client —
 * see docs/protocol-pi/README.md "Auth"). A per-engine configurable default
 * (mirroring opencode's opencodeConfig.model) shipped in M3 — Settings'
 * PiDefaultModelSection + session-store's `piDefaultModel` — and takes
 * precedence via `defaultModelValue`'s `perEngineDefault` param below; this
 * constant remains the fallback when that's unset/empty.
 */
export const PI_DEFAULT_MODEL = 'openai-codex/gpt-5.6-luna'

/** Free/bundled opencode vendors (OpenCode Zen) that never require auth credentials. */
export const FREE_OPENCODE_VENDOR_IDS: ReadonlySet<string> = new Set(['opencode', 'zen'])

export interface EngineMeta {
  id: EngineId
  /** Human display label (e.g. group headers). Claude → 'Claude', opencode → 'opencode'. */
  label: string
  /** Static, vendor-independent engine capabilities. */
  capabilities: EngineCapabilities
  /**
   * Fallback vendor id used ONLY when hydrating a persisted record that predates
   * vendor tracking (db.ts rowToMeta legacy rows). NOT a general "preferred
   * vendor" — it preserves the historical default (claude→anthropic, opencode→openai).
   */
  defaultVendorId: VendorId
  /**
   * Default model picker VALUE for a fresh session on this engine.
   * @param perEngineDefault engine-configurable default (opencode: opencodeConfig.model). Claude ignores it.
   */
  defaultModelValue(perEngineDefault?: string): string
  /** Encode a ModelRef into this engine's picker-value string convention. */
  encodeModelValue(ref: ModelRef): string
  /** Decode a picker-value string into a ModelRef. opencode splits on the FIRST '/' only. */
  decodeModelValue(value: string): ModelRef
  /**
   * Seed ResolvedCapabilities pre-spawn. Claude derives from the model VALUE
   * string (ignores modelInfo); opencode derives from the discovered ModelInfo's
   * flat flags (ignores modelValue; undefined → engine defaults).
   */
  seedCapabilities(modelValue: string, modelInfo?: ModelInfo): ResolvedCapabilities
}

const CLAUDE_META: EngineMeta = {
  id: 'claude',
  label: 'Claude',
  capabilities: CLAUDE_ENGINE_CAPABILITIES,
  defaultVendorId: 'anthropic',
  defaultModelValue: () => 'default',
  encodeModelValue: (ref) => ref.modelId,
  decodeModelValue: (value) => claudeModel(value),
  seedCapabilities: (modelValue) => resolveClaudeCapabilities(modelValue)
}

const OPENCODE_META: EngineMeta = {
  id: 'opencode',
  label: 'opencode',
  capabilities: OPENCODE_ENGINE_CAPABILITIES,
  defaultVendorId: 'openai',
  defaultModelValue: (perEngineDefault) => perEngineDefault || OPENCODE_DEFAULT_MODEL,
  encodeModelValue: (ref) => `${ref.vendorId}/${ref.modelId}`,
  decodeModelValue: (value) => {
    const slash = value.indexOf('/')
    return slash >= 0
      ? opencodeModel(value.slice(0, slash), value.slice(slash + 1))
      : opencodeModel('opencode', value)
  },
  seedCapabilities: (_modelValue, modelInfo) => resolveOpencodeCapabilitiesFromModel(modelInfo)
}

/**
 * pi's picker-value convention mirrors opencode's exactly (`"<provider>/<modelId>"`,
 * split on the FIRST '/', fallback vendor when no slash) — see
 * docs/protocol-pi/README.md / the M1 kickoff spec's "Architecture decisions".
 */
const PI_META: EngineMeta = {
  id: 'pi',
  label: 'pi',
  capabilities: PI_ENGINE_CAPABILITIES,
  defaultVendorId: 'openai-codex',
  defaultModelValue: (perEngineDefault) => perEngineDefault || PI_DEFAULT_MODEL,
  encodeModelValue: (ref) => `${ref.vendorId}/${ref.modelId}`,
  decodeModelValue: (value) => {
    const slash = value.indexOf('/')
    return slash >= 0
      ? piModel(value.slice(0, slash), value.slice(slash + 1))
      : piModel('openai-codex', value)
  },
  // ModelInfo has no `reasoning` field of its own — derive it from
  // supportsEffort (the flag model-discovery.ts sets from the catalog's
  // `reasoning: boolean` fact per model, M2b) so seeded capabilities agree
  // with the effort picker the SAME ModelInfo drives in the renderer. Pass
  // ModelInfo's own `supportedEffortLevels` through as `effortLevels` too —
  // it already carries xhigh/max per model (model-discovery.ts's
  // `effortLevelsFromModel`, derived from the catalog's `thinkingLevelMap`) —
  // so the pre-spawn seed doesn't stay capped at low/med/high while the
  // picker it's seeding from shows xhigh/max.
  seedCapabilities: (_modelValue, modelInfo) =>
    resolvePiCapabilitiesFromModel(
      modelInfo
        ? {
            ...modelInfo,
            reasoning: modelInfo.supportsEffort,
            effortLevels: modelInfo.supportedEffortLevels
          }
        : undefined
    )
}

/**
 * The engine descriptor table. `satisfies Record<EngineId, EngineMeta>` makes a
 * new EngineId a compile error until its meta is added.
 */
export const ENGINE_META = {
  claude: CLAUDE_META,
  opencode: OPENCODE_META,
  pi: PI_META
} satisfies Record<EngineId, EngineMeta>

/** Look up an engine's meta. Throws on an unregistered id (mirrors EngineRegistry). */
export function engineMeta(id: EngineId): EngineMeta {
  const meta: EngineMeta | undefined = ENGINE_META[id as keyof typeof ENGINE_META]
  if (!meta) {
    throw new Error(
      `No EngineMeta registered for engine "${id}". Registered: [${Object.keys(ENGINE_META).join(', ')}]`
    )
  }
  return meta
}
