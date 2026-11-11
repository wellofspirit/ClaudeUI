// ---------------------------------------------------------------------------
// opencode native config passthrough (stored in engines/opencode.json)
// ---------------------------------------------------------------------------

/** Per-provider customization injected via OPENCODE_CONFIG_CONTENT. Credentials stay in auth.json. */
export interface OpencodeProviderSettings {
  name?: string
  baseURL?: string
  /** Native provider adapter package (provider.npm). */
  npm?: string
  models?: OpencodeProviderModelSettings[]
}

/**
 * One declared model in opencode's config (`provider.<id>.models.<id>`), as
 * ClaudeUI reads and writes it. Beyond the name, the fields a declared model
 * needs for opencode to know what it can do (ADR-074 slice 10): `reasoning`,
 * `attachment`, `tool_call`, `modalities.input` and `limit` — opencode reads a
 * config-only model's missing capability as false and its missing limit as 0.
 *
 * Each capability field is a LEAF the writer sets only when given and changed:
 * a caller that does not model it (the opencode provider pane) leaves it as the
 * file has it, so a hand edit survives an unrelated save.
 */
export interface OpencodeProviderModelSettings {
  id: string
  name?: string
  reasoning?: boolean
  attachment?: boolean
  /** Native `tool_call`. */
  toolCall?: boolean
  /** Native `modalities.input`; `modalities.output` is never touched. */
  inputModalities?: string[]
  /** Native `limit.context` / `limit.output`; `limit.input` is never touched. */
  limit?: { context: number; output: number }
}

/** Per-agent override injected via OPENCODE_CONFIG_CONTENT. */
export interface OpencodeAgentSettings {
  model?: string
  temperature?: number
}

// ─── opencode agent types ─────────────────────────────────────────────────────

export type OpencodeAgentScope = 'global' | 'project'

export type OpencodeAgentMode = 'primary' | 'subagent' | 'all'

export interface OpencodeAgentSummary {
  name: string
  kind: 'custom' | 'builtin'
  mode: OpencodeAgentMode
  scope: OpencodeAgentScope | null
  model?: string
  color?: string
  overridden?: boolean
  disabled?: boolean
  hidden?: boolean
  /** opencode 2.x: the agent's OWN permission rules, in file order. */
  rules?: { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }[]
}

/**
 * One agent type an engine can spawn, for the type tile's settings (ADR-094).
 * `source` says where it comes from: the engine itself, the user's own agent
 * files, or the project's. `nativeColor` is the colour the engine's own agent
 * definition names (Claude Code's `color` frontmatter, opencode's `color`), when
 * it has one — the tile maps it to the nearest palette colour.
 */
export interface AgentTypeInfo {
  type: string
  source: 'builtin' | 'user' | 'project'
  nativeColor?: string
  /**
   * The model the type's definition DECLARES for this engine, as the definition
   * spells it (an alias or an id, `provider/id` on opencode and pi). Absent when
   * the type inherits its parent's model, and for every built-in whose model the
   * engine fixes elsewhere. Read-only; Settings shows it beside the type.
   */
  model?: string
  /**
   * Why the type will not run as declared (opencode: an `effort` that is not a
   * variant of the declared model). Only the async catalog read sets it.
   */
  warning?: string
}

export interface OpencodeAgentDetail extends OpencodeAgentSummary {
  description?: string
  prompt?: string
  temperature?: number
  topP?: number
  steps?: number
  /** opencode 2.x: the agent model's VARIANT (`model: p/m#<variant>`). */
  reasoningEffort?: string
  restrict: boolean
  /** One effect per opencode 2.x action (shell, edit, read, …). */
  permission?: Record<string, 'allow' | 'ask' | 'deny'>
  /** Permission rules the grid cannot show; a save keeps them. */
  extraRules?: number
  /** The file is in the opencode 1.x shape; saving moves it to the 2.x shape. */
  legacy?: boolean
}

export interface OpencodeAgentInput {
  name: string
  scope: OpencodeAgentScope
  mode: OpencodeAgentMode
  model?: string
  description?: string
  prompt?: string
  temperature?: number
  topP?: number
  steps?: number
  reasoningEffort?: string
  color?: string
  hidden?: boolean
  disable?: boolean
  permission?: Record<string, 'allow' | 'ask' | 'deny'>
  /** The agent this save replaces (a rename or a scope move): its unmodelled fields carry over. */
  previous?: { name: string; scope: OpencodeAgentScope }
}

/**
 * opencode-native config stored in engines/opencode.json under `opencodeConfig`.
 * These fields are injected via OPENCODE_CONFIG_CONTENT at spawn (deep-merge, only
 * set fields injected — never clobbers the user's own opencode.jsonc).
 * API credentials stay in auth.json; never inject apiKey here.
 */
export interface OpencodeConfigSettings {
  /** Default model in "provider/model" format, e.g. "anthropic/claude-sonnet-4-6" */
  model?: string
  /** Small/fast model in "provider/model" format */
  smallModel?: string
  /** Provider ids to disable */
  disabledProviders?: string[]
  /** Provider ids to enable (allowlist — others are ignored when set) */
  enabledProviders?: string[]
  /** Custom provider definitions keyed by provider id (base URL + optional model list) */
  providers?: Record<string, OpencodeProviderSettings>
  /** Per-agent model/temperature overrides keyed by agent name */
  agents?: Record<string, OpencodeAgentSettings>
  /**
   * Per-provider visible-model allowlist, keyed by provider id. Values are bare
   * model ids (NOT "provider/model"). Filtered ClaudeUI-side in discovery so the
   * model picker isn't flooded by providers exposing hundreds of models
   * (e.g. openrouter ships 300+).
   *
   * Semantics by KEY PRESENCE (the array, not its length, is the gate):
   *   - key absent  → show ALL of that provider's models (legacy / externally-authed
   *                   providers keep working unchanged).
   *   - key present → show ONLY the listed model ids (an empty array → none). The
   *                   "Add provider" flow writes `[]` for a catalog over 50
   *                   models, so a newly-added gateway never floods the picker.
   *
   * READ-ONLY on this object (ADR-074 §2): `config:load-opencode-settings`
   * reports it, `config:save-opencode-settings` ignores it, and its one writer
   * is `models:set-provider-allowlist` (`setProviderModelAllowlist`).
   */
  modelAllowlist?: Record<string, string[]>
}

/**
 * A single leaf edit against an engine's OWN raw config file, applied via
 * jsonc-parser modify() by opencode's schema-driven settings editor and by the
 * curated pi Configuration panes. `value` absent (or undefined) means DELETE the
 * leaf at `path`; otherwise SET it. Paths use that engine's key names verbatim
 * (e.g. ['provider','ec2','models','qwen3.6:27b','attachment'] for opencode,
 * ['compaction','reserveTokens'] for pi).
 */
export interface RawConfigPatch {
  path: (string | number)[]
  value?: unknown
}

/** Raw (non-projected) opencode config read + its resolved file path. */
export interface OpencodeNativeRaw {
  config: Record<string, unknown>
  path: string
}

/** Raw pi settings read (`~/.pi/agent/settings.json`) + its resolved file path. */
export interface PiNativeRaw {
  config: Record<string, unknown>
  path: string
  /**
   * The file's text exactly as stored, minus any UTF-8 BOM, and '' when the file
   * is absent or unreadable. The Raw config pane edits THIS rather than a
   * re-serialisation of `config`, so the user's own formatting survives a round
   * trip — and a file too broken to parse can still be shown and repaired. The
   * BOM is stripped because it is an encoding marker rather than content the
   * user should have to see; the writer puts the file's own BOM back.
   */
  text: string
}

/** Raw pi model catalog read (`~/.pi/agent/models.json`) + its resolved path. */
export interface PiModelsRaw {
  config: Record<string, unknown>
  path: string
  /** The file's bytes minus any BOM; '' when absent or unreadable. */
  text: string
  /**
   * The `providers.<id>` keys the shared-provider projection currently owns
   * (`PiSharedProviderAdapter`). The editor must show these read-only: a raw
   * write into one is reverted by the next provider sync, and turns the user's
   * next provider save into a "changed outside ClaudeUI" refusal. The writer
   * rejects such a patch outright — this is what lets the UI say so first.
   */
  managedProviderIds: string[]
}

/**
 * One provider in the opencode catalog (the full models.dev set, ~146 providers),
 * surfaced to the settings UI so users can add any supported provider — including
 * ones with no custom auth loader (e.g. openrouter, authed by a plain API key).
 * Lightweight by design: the per-provider model list is fetched separately
 * (getOpencodeProviderModels) so this list stays cheap even with hundreds of
 * models per provider.
 */
/** Where opencode gets a usable provider's credential (`model-discovery.ts` `provenance`, from `/api/integration` connections). */
export type OpencodeProviderSource = 'env' | 'config' | 'custom' | 'api' | 'external'

/** What Remove deletes; `settings` clears a disabled-only entry and picker curation. */
export type ProviderRemoveKind = 'credential' | 'declaration' | 'both' | 'settings'

/**
 * Which actions the opencode provider row may offer for one provider. Computed
 * in main by `resolveProviderActions` (see main/opencode/provider-actions.ts for
 * the full rationale) and carried to the renderer so the row never re-derives it.
 *
 * Note the absence of a `canDisable`: Disable is ALWAYS available, because
 * `disabled_providers` is the one veto that works against every way opencode can
 * derive a provider into existence.
 */
export interface ProviderActions {
  /** Every non-free provider — the generic /auth path accepts a plain key. */
  canSetCredential: boolean
  /** Only a declaration in the single global config file ClaudeUI writes. */
  canEditDeclaration: boolean
  canRemove: boolean
  removeKind: ProviderRemoveKind | null
  /** Present iff `!canRemove` — tooltip for the greyed trash icon. */
  blockedReason?: string
}

export interface OpencodeProviderCatalogEntry {
  id: string
  name: string
  /**
   * 'authenticated' — currently usable (configured / has credentials, i.e. listed
   *   by `GET /api/provider`); 'free' — bundled, needs no credentials; 'unauthenticated'
   *   — supported but not yet set up.
   */
  authState: 'authenticated' | 'unauthenticated' | 'free'
  /**
   * Auth methods the provider supports. 'oauth' when its integration offers an
   * OAuth method (`GET /api/integration`); 'api' for a plain API key. Providers absent from the
   * auth catalog still accept a generic API key, so this defaults to ['api'].
   */
  authMethods: ('api' | 'oauth')[]
  /** Number of models the provider exposes in the catalog (for the picker hint). */
  modelCount: number
  /**
   * True when the id sits in opencode's `disabled_providers`. Disabled providers
   * still belong in the "Added providers" list (rendered in a disabled state);
   * they are NOT addable rows. opencode omits them from its provider list,
   * so these entries are re-synthesized — see discoverOpencodeProviderCatalog.
   */
  disabled: boolean
  /**
   * Where opencode gets the provider's credential ('env' | 'config' | 'custom' |
   * 'api'), derived from its integration's connections (`GET /api/integration`);
   * absent for providers that aren't currently usable.
   *
   * Used for MESSAGE WORDING ONLY — never to decide which actions are offered
   * (see provider-actions.ts).
   */
  source?: OpencodeProviderSource
  /** Env var names opencode reads a key from, for the blocked-removal tooltip. */
  envVarNames?: string[]
  /**
   * Declared in opencode's config with its own adapter package or base URL — a
   * custom endpoint rather than a catalog vendor (ADR-074 §7's subtitle).
   */
  declaredEndpoint?: true
  /** Which row actions are legitimately available. See provider-actions.ts. */
  actions: ProviderActions
  /**
   * Set when an ENABLED shared-provider route vends this vendor id (today
   * `chatgpt` → `openai`). Removing such a credential is undone by the vault's
   * next feed, so the row must warn and offer to disable the route instead.
   * Decorated at the IPC boundary, not in discovery (import-cycle avoidance).
   */
  sharedProviderClaim?: { id: string; name: string }
}

/** A single catalog model for the per-provider model-allowlist dialog. */
export interface OpencodeCatalogModel {
  id: string
  name: string
  /** ISO date string when present in the catalog (sort newest-first). */
  releaseDate?: string
  toolCalling?: boolean
  reasoning?: boolean
  /** Same zen-gated free derivation as ModelInfo.free — see its doc comment. */
  free?: boolean
  /**
   * What a declared COPY of this model needs (ADR-074 slice 10: a second key
   * for a catalog provider declares its models as a custom endpoint): limits,
   * image input, and the endpoint the catalog serves it from. Each absent when
   * the catalog does not say.
   */
  contextWindow?: number
  maxTokens?: number
  vision?: boolean
  /** The provider's own base URL when opencode's catalog sets one, else this model's. */
  apiUrl?: string
  /** The AI SDK package opencode speaks to this model with — which API it is. */
  apiNpm?: string
}
