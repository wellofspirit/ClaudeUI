export const ENGINE_IDS = ['claude', 'opencode', 'pi'] as const

export type EngineId = (typeof ENGINE_IDS)[number]

/**
 * Who a prompt handed to `sendPrompt` speaks for. `user` (the default) is text
 * the user typed; `host-instruction` is the host acting on the user's standing
 * setting or click (context pressure) — still a user-role row, labelled as the
 * host's. Items from other sessions or agents never go through `sendPrompt`:
 * they are delivered by `session-delivery` and render as notes.
 */
export type PromptOrigin = 'user' | 'host-instruction'

/** Open-ended union: known vendors are named; unknown ones fall through as plain strings. */
export type VendorId = 'anthropic' | 'openai' | 'google' | 'local' | (string & {})

/** Vendor-qualified model identity — the canonical key for model selection and persistence. */
export interface ModelRef {
  engineId: EngineId
  vendorId: VendorId
  /** Model name string, e.g. 'claude-opus-4-8', 'default' */
  modelId: string
}

/** Construct a Claude ModelRef (engine 'claude' is 1:1 with vendor 'anthropic'). */
export function claudeModel(modelId: string): ModelRef {
  return { engineId: 'claude', vendorId: 'anthropic', modelId }
}

/** Construct an opencode ModelRef (engine 'opencode', vendor = providerId). */
export function opencodeModel(vendorId: VendorId, modelId: string): ModelRef {
  return { engineId: 'opencode', vendorId, modelId }
}

/** Construct a pi ModelRef (engine 'pi', vendor = provider id, e.g. 'openai-codex'). */
export function piModel(vendorId: VendorId, modelId: string): ModelRef {
  return { engineId: 'pi', vendorId, modelId }
}

// ---------------------------------------------------------------------------
// Phase 4 identity types — declared here for vocabulary; wired in Phase 4
// ---------------------------------------------------------------------------

export type BillingType = 'subscription' | 'apiKey' | 'free' | 'unknown'

/**
 * Where a metered turn came from (ADR-071 §1). 'child' is a native subagent; 'dispatch' is a cross-engine dispatch (ADR-033), which
 * counts in dashboard totals but not in the dispatching session's headline.
 * 'judge' is an auto-mode judge call ClaudeUI made itself for the session named
 * by `parentRoutingId` (ADR-081 §5).
 */
export type UsageOrigin = 'session' | 'child' | 'dispatch' | 'judge'
