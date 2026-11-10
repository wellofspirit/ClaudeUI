import type { EngineId, VendorId } from './engine'

export interface ModelInfo {
  value: string
  /** Concrete model id an alias resolves to, straight off cli.js's
   *  `supportedModels()` (e.g. `default` → `claude-opus-5[1m]`). Present on
   *  Claude rows only; absent on every other engine's catalog. Aliases are
   *  opaque to `resolveContextWindow`, so this is what sizes their window. */
  resolvedModel?: string
  displayName: string
  description: string
  /** Capability flags surfaced by the SDK's `supportedModels()`. Authoritative. */
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
  supportsAdaptiveThinking?: boolean
  /** Whether the 'auto' permission mode is usable with this model/account.
   *  From the initialize response's models[]; absent on older CLIs — treat
   *  absence as supported (auto mode is default-available on subscriptions). */
  supportsAutoMode?: boolean
  /** Engine that owns this model entry. Defaults to 'claude' when absent (legacy). */
  engineId?: EngineId
  /** Vendor id within the engine. */
  vendorId?: VendorId
  /** Whether this model supports vision/image input. */
  vision?: boolean
  /** Whether this model supports tool calling. */
  toolCalling?: boolean
  /** Available reasoning effort variant names for opencode models (from model.variants).
   *  Non-empty only when the model's capabilities.reasoning === true and variants are present.
   *  Claude models always have this undefined/empty — picker hidden. */
  reasoningVariants?: string[]
  /** true when the model belongs to a credential-free zen gateway provider
   *  (FREE_OPENCODE_VENDOR_IDS) AND the catalog reports zero input+output cost —
   *  i.e. an actual free tier (e.g. opencode zen's *-free models). Deliberately
   *  NOT set from cost alone: subscription/OAuth-authenticated providers (e.g.
   *  openai) report zeroed catalog costs for models the user pays for elsewhere,
   *  which is a pricing-catalog blind spot, not free-ness. */
  free?: boolean
}

/** Grouped model list for the engine-aware picker. */
export interface EngineModelGroup {
  engineId: EngineId
  vendorId: VendorId
  vendorName: string
  models: ModelInfo[]
}
