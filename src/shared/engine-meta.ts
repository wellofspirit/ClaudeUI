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
import { claudeModel, opencodeModel } from './types'
import type { EngineCapabilities, ResolvedCapabilities } from './model-capabilities'
import {
  CLAUDE_ENGINE_CAPABILITIES,
  OPENCODE_ENGINE_CAPABILITIES,
  resolveClaudeCapabilities,
  resolveOpencodeCapabilitiesFromModel
} from './model-capabilities'

/**
 * The hard-coded opencode fallback model VALUE (a free, no-auth OpenCode Zen
 * model). Used when a session/engine has no configured or remembered model.
 * Moved here from the renderer store so EngineMeta can own it; the store
 * re-exports it for existing importers.
 */
export const OPENCODE_DEFAULT_MODEL = 'opencode/mimo-v2.5-free'

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
 * The engine descriptor table. `satisfies Record<EngineId, EngineMeta>` makes a
 * new EngineId a compile error until its meta is added.
 */
export const ENGINE_META = {
  claude: CLAUDE_META,
  opencode: OPENCODE_META
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
