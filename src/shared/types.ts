import type { ResolvedCapabilities } from './model-capabilities'
import type {
  ConfigurableHarnessId,
  SharedProviderDefinition,
  SharedProviderModel,
  SharedProviderStatus
} from './shared-provider'

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

/** SDK sends "Agent" (canonical, v0.2.63+) or "Task" (alias for backward compat) */
export function isAgentTool(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task'
}

/**
 * A single file's unified diff, surfaced by opencode's apply_patch/edit tool
 * results (`metadata.files[]` / `metadata.filediff` — see
 * src/main/opencode/event-mapper.ts `extractFileDiffs`). Lets the fileEdit kind
 * body render real per-file diff cards instead of a generic JSON/text dump.
 */
export interface FileDiff {
  /** Relative-to-worktree path when the engine provides one (apply_patch); otherwise the raw (often absolute) file path. */
  path: string
  /** Unified diff text (already trimmed by opencode's `trimDiff`). */
  patch: string
  additions?: number
  deletions?: number
  /** 'move' = apply_patch rename (patch headers carry the old/new paths); edit/write never produce it. */
  changeType?: 'add' | 'update' | 'delete' | 'move'
}

/**
 * An image an ENGINE returned from a tool call — Read on a .png, a screenshot
 * tool, an MCP tool rendering something. Distinct from the `image` ContentBlock,
 * which is an image the USER attached to a prompt: these hang off the
 * `tool_result` block that produced them, feed the image viewer's "Tool results"
 * gallery, and are never sent back up as prompt input.
 *
 * Field names are load-bearing — the gallery reader
 * (renderer/components/shared/ImageViewer/gallery.ts) builds
 * `data:<mediaType>;base64,<base64Data>` from them verbatim, so the media type
 * is narrowed to what an `<img src>` will actually render.
 *
 * Producers must OMIT the carrying `images` key when there is nothing to carry
 * (never `images: []`) — the renderer's gallery/tab visibility is driven by
 * presence.
 */
export interface ToolResultImage {
  mediaType: ImageMediaType
  base64Data: string
  /** Only when the engine supplies one (opencode file parts); Claude transcripts carry none. */
  fileName?: string
}

/** The image media types the `image` ContentBlock and `ToolResultImage` model. */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

/**
 * Runtime companion to `ImageMediaType` — the single allowlist every engine
 * adapter filters through before emitting an image to the renderer (there used
 * to be one hand-rolled copy per adapter). Anything outside it (image/svg+xml,
 * image/tiff, image/bmp, …) is DROPPED rather than widened: the renderer builds
 * `data:<mediaType>;base64,…` verbatim, so an unrenderable type would surface as
 * a broken image in the chat and the viewer.
 */
export const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
])

/** Narrowing guard for `IMAGE_MEDIA_TYPES` — use instead of casting a string. */
export function isImageMediaType(mediaType: unknown): mediaType is ImageMediaType {
  return typeof mediaType === 'string' && IMAGE_MEDIA_TYPES.has(mediaType)
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; toolInput?: Record<string, unknown> }
  | {
      type: 'tool_result'
      toolUseId: string
      toolResult: string
      isError?: boolean
      fileDiffs?: FileDiff[]
      images?: ToolResultImage[]
    }
  | { type: 'thinking'; text: string; durationMs?: number }
  | { type: 'cli_command'; commandName: string; commandArgs?: string; commandOutput?: string }
  | { type: 'api_error'; errorType: string; errorMessage: string }
  | { type: 'compact_separator'; text?: string }
  | {
      type: 'image'
      mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      base64Data: string
      fileName?: string
    }
  | { type: 'document'; mediaType: 'application/pdf'; base64Data: string; fileName?: string }

export interface FileAttachment {
  id: string
  fileName: string
  fileType: 'image' | 'pdf'
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf'
  base64Data: string
  previewUrl: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentBlock[]
  timestamp: number
  planContent?: string
}

export type EngineId = 'claude' | 'opencode' | 'pi'

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
 * Resolved tri-state auth status for a single (engine, vendor) pair.
 * 'authenticated'   — engine has confirmed valid credentials
 * 'unauthenticated' — engine has confirmed no / expired credentials
 * 'unknown'         — not yet probed (e.g. first render before init completes)
 */
export type AuthState = 'authenticated' | 'unauthenticated' | 'unknown'

/** Per-(engine, vendor) auth probe result.  Used by EngineAuthProvider.probe(). */
export interface AuthStatus {
  authState: AuthState
  billingType: BillingType
  label?: string // email / org / 'ChatGPT Plus'
  requiresLogin?: boolean // delegated engines: "run <engine> login"
  notInstalled?: boolean
  error?: string
}

/** Map from VendorId string to its auth status; returned by EngineAuthProvider.probe().
 *  Engines only include vendors they know about (Claude: { anthropic: ... };
 *  opencode: one entry per configured provider). */
export type VendorAuthMap = Record<string, AuthStatus>

/**
 * A single auth method option for a vendor, as returned by GET /provider/auth.
 * The array index of the option is the `method` arg for OAuth authorize/callback.
 */
export interface VendorAuthOption {
  type: 'api' | 'oauth'
  label: string
  prompts?: Array<{ type: string; key: string; message: string; secret?: boolean }>
}

/**
 * Read-only snapshot of the M6a/M6b auth vault's Codex (ChatGPT) credential —
 * CredentialSync.getStatus(). Drives PiVendors.tsx's (M6c) "Connect ChatGPT"
 * UI. NEVER carries token material (access/refresh).
 */
export interface PiAuthStatus {
  connected: boolean
  email?: string
  accountId?: string
  expiresAt?: number
  needsReauth: boolean
}

/** Resolved account descriptor held on the session. Populated by ClaudeAuthProvider.probe(). */
export interface AccountRef {
  engineId: EngineId
  vendorId: VendorId
  billingType: BillingType
  authState: AuthState
  label?: string
  accountId?: string
}

export interface SessionStatus {
  state: 'idle' | 'running' | 'error' | 'disconnected'
  sessionId: string | null
  /** Vendor-qualified model identity. Null until the engine reports a model. */
  model: ModelRef | null
  cwd: string | null
  totalCostUsd: number
  engineId: EngineId
  capabilities: ResolvedCapabilities
  /** Resolved account descriptor from the engine auth provider. Null until probed. */
  account: AccountRef | null
}

export interface PermissionSuggestion {
  type: string // 'addRules' | 'replaceRules' | 'removeRules' | 'setMode' | 'addDirectories' | 'removeDirectories'
  rules?: { toolName: string; ruleContent?: string }[]
  behavior?: string // 'allow' | 'deny' | 'ask'
  destination: string // 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  mode?: string
  directories?: string[]
}

export interface PendingApproval {
  requestId: string
  /**
   * cli.js-assigned tool_use id for the invocation being prompted. The
   * correct binding key between an approval and its tool_use block —
   * matching on toolName+input alone is lossy (repeated identical calls
   * all collapse to the same approval and get the UI shown on every
   * historical card).
   */
  toolUseId?: string
  toolName: string
  input: Record<string, unknown>
  /**
   * opencode only: the matched argument(s) the engine evaluated its permission
   * ruleset against (`permission.asked`'s `patterns` — the command, path, or
   * subagent type). Needed host-side to re-match the ask against the
   * user-authored rules, which outrank the auto-mode classifier (ADR-023 G9).
   */
  patterns?: string[]
  suggestions?: PermissionSuggestion[]
  decisionReason?: string
  blockedPath?: string
}

export interface SessionResult {
  totalCostUsd: number
  durationMs: number
  result: string
  sessionId?: string | null
}

// ---------------------------------------------------------------------------
// Plugin session event types (ADR-005)
// All session events forwarded to plugins are wrapped in this shape.
// ---------------------------------------------------------------------------

/** Base envelope for all session events forwarded to plugins. */
export interface PluginSessionEvent {
  routingId: string
  sessionId: string | null
}

/** session:message event as seen by plugins. */
export interface PluginMessageEvent extends PluginSessionEvent {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentBlock[]
  timestamp: number
  planContent?: string
}

/** session:result event as seen by plugins. */
export interface PluginResultEvent extends PluginSessionEvent {
  totalCostUsd: number
  durationMs: number
  result: string
}

/** session:stream event as seen by plugins. */
export interface PluginStreamEvent extends PluginSessionEvent {
  type: 'text' | 'thinking'
  text: string
}

export type ApprovalDecision = 'allow' | 'allowForSession' | 'deny'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto'

export interface ProxySettings {
  enabled: boolean
  type: 'http' | 'socks5'
  hostname: string
  port: number
  username: string
  password: string
  /**
   * When true, cli.js's subprocesses (Bash tool, MCP, LSP, shell-snapshot) also
   * route through the proxy. When false (default), only cli.js's own Anthropic
   * API calls are proxied — git/curl/npm/etc. spawned by Claude stay direct.
   */
  proxySubprocesses?: boolean
}

/**
 * Custom Anthropic API endpoint config. When `enabled`, `baseUrl` is exposed to
 * cli.js spawns as `ANTHROPIC_BASE_URL` and `authToken` as `ANTHROPIC_AUTH_TOKEN`,
 * letting users redirect traffic to a self-hosted gateway, LM Studio, or any
 * Anthropic-compatible endpoint.
 */
export interface AnthropicEndpointSettings {
  enabled: boolean
  baseUrl: string
  authToken: string
}

/**
 * Model override config. When `enabled`, the user-supplied model names are
 * exposed to cli.js spawns as the matching Anthropic env vars:
 *   - `model`       → ANTHROPIC_MODEL              (primary model selection)
 *   - `sonnetModel` → ANTHROPIC_DEFAULT_SONNET_MODEL
 *   - `opusModel`   → ANTHROPIC_DEFAULT_OPUS_MODEL
 *   - `haikuModel`  → ANTHROPIC_DEFAULT_HAIKU_MODEL
 * Empty fields are skipped, so partial overrides leave cli.js's defaults
 * intact for the unset families. Useful when pointing cli.js at a custom
 * gateway whose model identifiers differ from Anthropic's canonical ones
 * (e.g. LM Studio, OpenRouter).
 */
export interface ModelOverrideSettings {
  enabled: boolean
  model: string
  sonnetModel: string
  opusModel: string
  haikuModel: string
}

export interface SandboxSettings {
  enabled: boolean
  autoAllowBashIfSandboxed: boolean
  allowUnsandboxedCommands: boolean
  network: {
    restrictNetwork: boolean
    allowLocalBinding: boolean
    allowedDomains: string[]
    allowManagedDomainsOnly: boolean
    allowAllUnixSockets: boolean
    allowUnixSockets: string[]
  }
  filesystem: {
    allowWrite: string[]
    denyWrite: string[]
    denyRead: string[]
  }
  excludedCommands: string[]
}

// ---------------------------------------------------------------------------
// opencode native config passthrough (stored in engines/opencode.json)
// ---------------------------------------------------------------------------

/** Per-provider customization injected via OPENCODE_CONFIG_CONTENT. Credentials stay in auth.json. */
export interface OpencodeProviderSettings {
  name?: string
  baseURL?: string
  /** Native provider adapter package (provider.npm). */
  npm?: string
  models?: { id: string; name?: string }[]
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
}

export interface OpencodeAgentDetail extends OpencodeAgentSummary {
  description?: string
  prompt?: string
  temperature?: number
  topP?: number
  steps?: number
  reasoningEffort?: string
  restrict: boolean
  permission?: Record<string, 'allow' | 'ask' | 'deny'>
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
   *                   "Add provider" flow always writes a key, so a newly-added
   *                   provider never auto-floods the picker.
   */
  modelAllowlist?: Record<string, string[]>
}

/**
 * A single leaf edit against opencode's raw config file, applied by the
 * schema-driven settings editor via jsonc-parser modify(). `value` absent (or
 * undefined) means DELETE the leaf at `path`; otherwise SET it. Paths use raw
 * opencode key names verbatim (e.g. ['provider','ec2','models','qwen3.6:27b','attachment']).
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

/**
 * One provider in the opencode catalog (the full models.dev set, ~146 providers),
 * surfaced to the settings UI so users can add any supported provider — including
 * ones with no custom auth loader (e.g. openrouter, authed by a plain API key).
 * Lightweight by design: the per-provider model list is fetched separately
 * (getOpencodeProviderModels) so this list stays cheap even with hundreds of
 * models per provider.
 */
/** opencode's own provenance label for a configured provider (`/config/providers`). */
export type OpencodeProviderSource = 'env' | 'config' | 'custom' | 'api'

/** What Remove would actually destroy. `null` when Remove is unavailable. */
export type ProviderRemoveKind = 'credential' | 'declaration' | 'both'

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
   * 'authenticated' — currently usable (configured / has credentials, i.e. present
   *   in /config/providers); 'free' — bundled, needs no credentials; 'unauthenticated'
   *   — supported but not yet set up.
   */
  authState: 'authenticated' | 'unauthenticated' | 'free'
  /**
   * Auth methods the provider supports. 'oauth' when a custom OAuth loader exists
   * (from /provider/auth); 'api' for a plain API key. Providers absent from the
   * auth catalog still accept a generic API key, so this defaults to ['api'].
   */
  authMethods: ('api' | 'oauth')[]
  /** Number of models the provider exposes in the catalog (for the picker hint). */
  modelCount: number
  /**
   * True when the id sits in opencode's `disabled_providers`. Disabled providers
   * still belong in the "Added providers" list (rendered in a disabled state);
   * they are NOT addable rows. opencode omits them from GET /provider entirely,
   * so these entries are re-synthesized — see discoverOpencodeProviderCatalog.
   */
  disabled: boolean
  /**
   * opencode's own provenance label from /config/providers ('env' | 'config' |
   * 'custom' | 'api'), absent for providers that aren't currently configured.
   *
   * Used for MESSAGE WORDING ONLY — never to decide which actions are offered
   * (see provider-actions.ts). Read from /config/providers and never from
   * /provider, whose `all` hardcodes source:'custom' for unconnected entries.
   */
  source?: OpencodeProviderSource
  /** Env var names opencode reads a key from, for the blocked-removal tooltip. */
  envVarNames?: string[]
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
}

export interface EngineConfig {
  sandbox?: SandboxSettings
  proxy?: ProxySettings
  /** Auto-mode (LLM permission gatekeeper) settings — opencode and pi. See ADR-023. */
  autoMode?: AutoModeConfig
  /** opencode native config passthrough (injected at spawn via OPENCODE_CONFIG_CONTENT). */
  opencodeConfig?: OpencodeConfigSettings
  /** Cross-engine dispatch INTO this engine (ADR-033). */
  dispatch?: DispatchConfig
  /** pi engine-configurable settings (M3). Lives in engines/pi.json. */
  piConfig?: PiConfig
}

/**
 * pi engine-configurable settings (M3). Mirrors opencode's `opencodeConfig.model`
 * seam (engine-meta.ts's `defaultModelValue(perEngineDefault)`), but pi has no
 * native-config-passthrough schema to mirror opencode's `OpencodeConfigSettings`.
 */
export interface PiConfig {
  /** Default model picker VALUE (`"<provider>/<modelId>"`) for new pi sessions.
   *  Free-text (validated against discoverPiModels() with a warning, not a hard
   *  block — so a model pi has locally that ClaudeUI hasn't discovered yet still
   *  works). Falls back to PI_DEFAULT_MODEL when unset/empty. */
  defaultModel?: string
  /** ClaudeUI-private visible-model allowlist using full `<provider>/<modelId>`
   * picker values. Undefined exposes every authenticated pi model; a present
   * array exposes only its entries, including none when the array is empty. */
  modelAllowlist?: string[]
}

/**
 * Governs `dispatch_agent` calls targeting an engine (ADR-033). Lives in
 * `engines/<engineId>.json` (plane ③). Edited in Settings › opencode ›
 * Cross-engine dispatch (the Claude-side twin ships with M2).
 */
export interface DispatchConfig {
  /** When non-empty, only these models may be requested for dispatched agents. */
  allowedModels?: string[]
  /** Model used when the caller doesn't request one. */
  defaultModel?: string
  /**
   * Per-dispatch-target cumulative cost cap in USD (ADR-033 M4-C). When set, a
   * continuation turn on a target whose tracked cumulative cost has already
   * met/exceeded this value is rejected with an isError (the target survives —
   * raising the cap or starting a fresh dispatch both work). Undefined = no cap.
   */
  maxCostUsd?: number
}

/**
 * Auto-mode (`auto`/`full` autonomy) LLM permission-gatekeeper config
 * (ADR-023, amended by `docs/automode-rework-plan.md`).
 *
 * Engine-neutral as of phase 4: read per engine from `engines/<engineId>.json`
 * by BOTH opencode and pi, which share the whole policy core
 * (`src/main/automode/`) and differ only in their permission intercept and
 * judge transport. Claude is the exception — cli.js ships its own classifier,
 * so none of this reaches it.
 */
export interface AutoModeConfig {
  /** Master switch. When false, `full` falls back to human approval prompts
   *  (the interim gated-like-default behavior). Defaults to true. */
  enabled?: boolean
  /** `providerID/modelID` for the judge. Defaults to the session's own model. */
  judgeModel?: string
  /** Two-stage classifier mode. Defaults to 'both'. */
  twoStageMode?: 'both' | 'fast' | 'thinking'
  /** Trust lists fed to the classifier's Environment section (phase 2 of
   *  `docs/automode-rework-plan.md`). Every slot defaults to EMPTY, and an empty
   *  slot means "nothing is trusted" rather than "anything goes" — the policy
   *  renders the restrictive fallback text for it (see `EnvironmentInfo`).
   *  External domains/services the agent may send data to. */
  trustedDomains?: string[]
  /** Package registries beyond the project manifest's default. */
  trustedRegistries?: string[]
  /** Production/protected target patterns. When set, they REPLACE the default
   *  'prod'/'production' name heuristic the policy would otherwise apply. */
  protectedPatterns?: string[]
}

export interface VendorConfig {
  endpoint?: AnthropicEndpointSettings
  modelOverride?: ModelOverrideSettings
}

// ---------------------------------------------------------------------------
// Claude permissions (allow/deny/ask rules from settings.json files)
// ---------------------------------------------------------------------------

export interface ClaudePermissions {
  allow: string[]
  deny: string[]
  ask: string[]
  additionalDirectories: string[]
  defaultMode: string | undefined
}

export type PermissionScope = 'user' | 'project' | 'local'

// AskUserQuestion tool types
export interface AskUserQuestionOption {
  label: string
  description: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[]
}

export interface StreamDelta {
  type: 'text' | 'thinking'
  text: string
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm: string
}

/**
 * A file the agent handed to the user via Claude Code's `SendUserFile` tool.
 *
 * Derived from the transcript (see `buildSentFilesFromMessages`), never stored
 * on its own — so it rebuilds for free on session resumption, exactly like
 * todos. Unlike todos it is never cleared when the turn ends.
 *
 * `path` is the raw path as it appeared in the tool input: cli.js accepts both
 * absolute and cwd-relative paths, so the renderer resolves it against the
 * session cwd before handing it to the shell IPC. The display name (basename)
 * is derived in the UI, not stored.
 */
export interface SentFile {
  path: string
  caption?: string
  display?: 'render' | 'attach'
  toolUseId: string
  /** Present when the paired tool_result was an error (missing file, UNC, URL, …). */
  error?: string
}

export interface TaskProgress {
  toolUseId: string
  toolName: string
  parentToolUseId: string | null
  elapsedTimeSeconds: number
}

/**
 * Emitted the moment cli.js spawns a Task/Agent (or background Bash) — mirrors
 * `session:task-notification`'s payload conventions but for the START edge.
 * Claude 2.1.219+ makes Agent/Task tasks background-by-default and the tool_use
 * input usually omits `run_in_background`, so the renderer can no longer infer
 * "is this task actually still running" from tool input alone (an immediate
 * "Async agent launched successfully" tool_result would otherwise read as
 * complete). This event is the authoritative "task exists and is running"
 * signal; task-notification is the authoritative terminal signal. A task with
 * no task-started record (opencode/pi child sessions, historical transcripts)
 * falls back to the pre-existing tool_result/background-flag heuristic.
 */
export interface TaskStartedData {
  toolUseId: string
  taskId: string
  taskType: string
}

export interface TaskNotification {
  taskId: string
  toolUseId: string | null
  status: 'completed' | 'failed' | 'stopped'
  outputFile: string
  summary: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
}

export interface SubagentStreamDelta {
  toolUseId: string
  type: 'text' | 'thinking'
  text: string
}

export interface SubagentMessageData {
  toolUseId: string
  message: ChatMessage
}

export interface SubagentMessageBatchData {
  toolUseId: string
  messages: ChatMessage[]
}

export interface SubagentToolResultData {
  toolUseId: string
  toolResultToolUseId: string
  result: string
  isError: boolean
  fileDiffs?: FileDiff[]
  /** Images the tool returned (see ToolResultImage). Omitted when there are none. */
  images?: ToolResultImage[]
}

export interface BackgroundOutput {
  toolUseId: string
  tail: string
  totalSize: number
  done: boolean
}

export interface BashOutputData {
  toolUseId: string
  output: string
  totalLines: number
  totalBytes: number
}

export interface WatchUpdate {
  routingId: string
  messages: ChatMessage[]
  taskNotifications: TaskNotification[]
  statusLine?: StatusLineData | null
}

export interface ModelInfo {
  value: string
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

export interface SessionInfo {
  sessionId: string
  cwd: string
  projectKey: string
  title: string
  timestamp: number
  lastActivityAt: number
  /** cli.js-generated session title (from `{type:"ai-title"}` JSONL records). */
  aiTitle?: string | null
  /** Which engine produced this session. Defaults to 'claude' when absent (legacy records). */
  engineId?: EngineId
}

export interface DirEntry {
  name: string
  isDirectory: boolean
}

export interface DirectoryGroup {
  cwd: string
  projectKey: string
  folderName: string
  sessions: SessionInfo[]
}

// ---------------------------------------------------------------------------
// Domain-specific API interfaces (composed into ClaudeAPI)
// ---------------------------------------------------------------------------

export interface ForkAnchorResult {
  /** JSONL line uuid to pass to cli.js `--resume-session-at`, or null if the
   *  message could not be resolved on disk (e.g. not yet flushed). */
  anchorUuid: string | null
  reason?: string
}

interface SessionAPI {
  platform: string
  pickFolder(): Promise<string | null>
  createSession(
    routingId: string,
    cwd: string,
    effort?: string,
    resumeSessionId?: string,
    permissionMode?: string,
    model?: string,
    thinkingMode?: string,
    resumeSessionAt?: string,
    forkSession?: boolean,
    engineId?: EngineId
  ): Promise<void>
  rekeySession(oldId: string, newId: string): Promise<void>
  /** Resolve the fork ("branch off") anchor for an engine session. Claude:
   *  `messageId` (the renderer's ChatMessage.id) resolves to a JSONL line
   *  uuid; `messageIndex` is unused. pi: no stable id exists, so `messageIndex`
   *  (the message's position in the store's `messages` array) resolves to a
   *  pi entryId (or the clone-latest sentinel) instead; `messageId` is unused.
   *  Returns { anchorUuid: null, reason } on failure. */
  resolveForkAnchor(
    sessionId: string,
    cwd: string,
    messageId: string,
    engineId: EngineId,
    messageIndex: number
  ): Promise<ForkAnchorResult>
  sendPrompt(
    routingId: string,
    prompt: string,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ): Promise<void>
  cancelSession(routingId: string): Promise<void>
  interruptSession(routingId: string): Promise<void>
  respondApproval(
    routingId: string,
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): Promise<void>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  listDirectories(): Promise<DirectoryGroup[]>
  /** Fetch the global opencode session list (all cwds). Best-effort: returns [] on error. */
  listOpencodeSessionsGlobal(): Promise<SessionInfo[]>
  /** Load a persisted opencode session's transcript as ChatMessage[] (read-only,
   *  for painting history on sidebar click). Best-effort: returns [] on error. */
  loadOpencodeHistory(sessionId: string): Promise<ChatMessage[]>
  /** Fetch the global pi session list (all cwds, read from ~/.pi/agent/sessions).
   *  Best-effort: returns [] on error. */
  listPiSessionsGlobal(): Promise<SessionInfo[]>
  /** Load a persisted pi session's transcript as ChatMessage[] (read-only,
   *  for painting history on sidebar click). Best-effort: returns [] on error. */
  loadPiHistory(sessionId: string): Promise<ChatMessage[]>
  loadSessionHistory(
    sessionId: string,
    projectKey: string
  ): Promise<{
    messages: ChatMessage[]
    taskNotifications: TaskNotification[]
    customTitle: string | null
    agentIdToToolUseId: Record<string, string>
    statusLine: StatusLineData | null
    taskPrompts: Record<string, string>
    warnings: string[]
  }>
  loadSubagentHistory(
    sessionId: string,
    projectKey: string,
    agentId: string
  ): Promise<ChatMessage[]>
  buildSubagentFileMap(
    sessionId: string,
    projectKey: string,
    taskPrompts: Record<string, string>
  ): Promise<Record<string, string>>
  loadBackgroundOutput(
    projectKey: string,
    taskId: string,
    outputFile?: string
  ): Promise<{ content: string | null; purged: boolean }>
  onSessionCreated(
    cb: (routingId: string, data: { cwd: string; resumeSessionId?: string }) => void
  ): () => void
  onUserMessage(
    cb: (
      routingId: string,
      data: {
        prompt: string
        attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
        queued?: boolean
      }
    ) => void
  ): () => void
  onMessage(cb: (routingId: string, msg: ChatMessage) => void): () => void
  onStreamEvent(cb: (routingId: string, delta: StreamDelta) => void): () => void
  onApprovalRequest(cb: (routingId: string, approval: PendingApproval) => void): () => void
  /** Externally-resolved approval (e.g. opencode's deny-cascade on a dispatch target, ADR-033) — remove the card. */
  onApprovalDismiss(cb: (routingId: string, data: { requestId: string }) => void): () => void
  onStatus(cb: (routingId: string, status: SessionStatus) => void): () => void
  onResult(cb: (routingId: string, result: SessionResult) => void): () => void
  onError(cb: (routingId: string, error: string) => void): () => void
  onVendorAuthRequired(cb: (routingId: string, data: { vendorId: string; message: string }) => void): () => void
  onWarning(cb: (routingId: string, warning: string) => void): () => void
  /** Refusal-fallback retraction — remove these messages from the transcript (docs/protocol/04-system-subtypes.md §4.20) */
  onMessagesRetracted(cb: (routingId: string, data: { messageIds: string[] }) => void): () => void
  onToolResult(
    cb: (
      routingId: string,
      data: {
        toolUseId: string
        result: string
        isError: boolean
        fileDiffs?: FileDiff[]
        /** Images the tool returned (see ToolResultImage). Omitted when there are none. */
        images?: ToolResultImage[]
      }
    ) => void
  ): () => void
  onMaximizeChange(cb: (isMaximized: boolean) => void): () => void
  onTaskProgress(cb: (routingId: string, data: TaskProgress) => void): () => void
  onTaskNotification(cb: (routingId: string, data: TaskNotification) => void): () => void
  /** Task exists and is running — see TaskStartedData for why this is needed. */
  onTaskStarted(cb: (routingId: string, data: TaskStartedData) => void): () => void
  onSubagentStream(cb: (routingId: string, data: SubagentStreamDelta) => void): () => void
  onSubagentMessage(cb: (routingId: string, data: SubagentMessageData) => void): () => void
  onSubagentMessageBatch(
    cb: (routingId: string, data: SubagentMessageBatchData) => void
  ): () => void
  onSubagentToolResult(cb: (routingId: string, data: SubagentToolResultData) => void): () => void
  onPermissionMode(cb: (routingId: string, mode: PermissionMode) => void): () => void
  onSandboxViolation(cb: (routingId: string, message: string) => void): () => void
  onBashOutput(cb: (routingId: string, data: BashOutputData) => void): () => void
  onBackgroundOutput(cb: (routingId: string, data: BackgroundOutput) => void): () => void
  watchBackground(routingId: string, toolUseId: string): Promise<void>
  unwatchBackground(routingId: string, toolUseId: string): Promise<void>
  readBackgroundRange(
    routingId: string,
    toolUseId: string,
    offset: number,
    length: number
  ): Promise<string>
  /** `isDispatch` marks a cross-engine dispatch card's stop (ADR-033 M3):
   *  the handler routes it to the dispatcher with a durable stop-intent
   *  (armIfUnknown) instead of ever falling through to the session path —
   *  the renderer can show "running" before dispatch() is even invoked. */
  stopTask(
    routingId: string,
    toolUseId: string,
    isDispatch?: boolean
  ): Promise<{ success: boolean; error?: string }>
  backgroundTask(
    routingId: string,
    toolUseId: string
  ): Promise<{ success: boolean; error?: string }>
  dequeueMessage(routingId: string, value: string): Promise<{ removed: number }>
  askSideQuestion(routingId: string, question: string): Promise<string | null>
  onSteerConsumed(cb: (routingId: string, data: { prompt: string }) => void): () => void
  setPermissionMode(routingId: string, mode: string): Promise<void>
  setModel(routingId: string, model: string): Promise<void>
  setEffort(routingId: string, effort: string): Promise<void>
  setThinkingMode(routingId: string, mode: string): Promise<void>
  setReasoningVariant(routingId: string, variant: string | null): Promise<void>
  getModels(): Promise<ModelInfo[]>
  getEngineModels(): Promise<EngineModelGroup[]>
  /** Full opencode provider catalog (~146 providers) for the settings provider manager.
   *  Returns [] when opencode isn't installed or discovery fails. */
  getOpencodeProviders(): Promise<OpencodeProviderCatalogEntry[]>
  /** Toggle opencode's `disabled_providers` veto. Reversible; destroys nothing. */
  setOpencodeProviderDisabled(providerId: string, disabled: boolean): Promise<void>
  /**
   * Destructive: deletes the credential and/or provider declaration ClaudeUI owns,
   * then clears the id from `disabled_providers` and the model allowlist. Pass the
   * `removeKind` from the entry's resolved `actions` — never a widened value.
   */
  removeOpencodeProvider(providerId: string, kind: ProviderRemoveKind): Promise<void>
  /** All catalog models for a single opencode provider (for the model-allowlist dialog). */
  getOpencodeProviderModels(providerId: string): Promise<OpencodeCatalogModel[]>
  /** Unfiltered authenticated pi catalog for the model-allowlist dialog. */
  getPiModelCatalogGroups(): Promise<EngineModelGroup[]>
  /** Deterministic "is this engine installed?" check (binary on disk). Does NOT
   *  spawn a server, so transient runtime failures can't read as "not installed". */
  engineIsInstalled(engineId: EngineId): Promise<boolean>
  generateTitle(conversationText: string): Promise<string | null>
  generateCommitMessage(diff: string): Promise<string | null>
  writeCustomTitle(sessionId: string, projectKey: string, title: string): Promise<void>
  getPlanContent(routingId: string): Promise<string | null>
  getSessionLogPath(routingId: string): Promise<string | null>
  watchSession(routingId: string, sessionId: string, projectKey: string): Promise<void>
  unwatchSession(routingId: string): Promise<void>
  onWatchUpdate(cb: (data: WatchUpdate) => void): () => void
  onDirectoriesChanged(cb: () => void): () => void
  onSlashCommands(cb: (routingId: string, commands: SlashCommandInfo[]) => void): () => void
  onSkills(cb: (routingId: string, names: string[]) => void): () => void
  /** Login status from session init: 'authenticated' | 'none' (logged-in vs not).
   *  The oauth-vs-api-key distinction now lives only in the auth probe's
   *  billingType (via OAuthAccount). See ADR-014 / Phase 4 (ADR-021). */
  onAuthSource(cb: (routingId: string, source: string) => void): () => void
  onStatusLine(cb: (routingId: string, data: StatusLineData) => void): () => void
  /** Engine-neutral metering snapshot (Phase 7 Pass 2). Emitted alongside
   *  onStatusLine; both engines send it. The status line itself is unchanged. */
  onMetering(cb: (routingId: string, data: MeteringSnapshot) => void): () => void
  onPlanSteps(cb: (routingId: string, todos: TodoItem[]) => void): () => void
  onSettingsChanged(cb: (settings: Record<string, unknown>) => void): () => void
  onSessionConfigChanged(cb: (config: UISessionConfig) => void): () => void
  loadSettings(): Promise<Record<string, unknown>>
  saveSettings(settings: Record<string, unknown>): Promise<void>
  loadSessionConfig(): Promise<UISessionConfig>
  saveSessionConfig(config: UISessionConfig): Promise<void>
  /** Permanently delete a session's JSONL + subagent directory from disk (claude), or via HTTP API (opencode) */
  deleteSession(sessionId: string, projectKey: string, engineId?: EngineId): Promise<void>
  /** Permanently delete an entire Claude project directory (all sessions) from disk */
  deleteProject(projectKey: string): Promise<void>
  loadSlashCommands(): Promise<SlashCommandInfo[]>
  saveSlashCommands(commands: SlashCommandInfo[]): Promise<void>
  scanCustomCommands(cwd: string): Promise<string[]>
  loadSkillDetails(cwd: string): Promise<SkillInfo[]>
  onBeforeQuit(cb: () => void): () => void
  confirmQuit(): Promise<void>
  /** Cancel a pending quit prompt: clears the fallback timer, leaves services running. */
  cancelQuit(): Promise<void>
  testProxyConnection(
    proxy: ProxySettings
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }>
  loadEngineConfig(engineId: string): Promise<EngineConfig>
  saveEngineConfig(engineId: string, config: EngineConfig): Promise<void>
  loadVendorConfig(vendorId: string): Promise<VendorConfig>
  saveVendorConfig(vendorId: string, config: VendorConfig): Promise<void>
  /** Load opencode's engine-native config from opencode's own global config file. */
  loadOpencodeSettings(): Promise<OpencodeConfigSettings>
  /** Save opencode's engine-native config to opencode's own global config file. */
  saveOpencodeSettings(settings: OpencodeConfigSettings): Promise<void>
  /** Read opencode's config file verbatim (no projection) for the schema-driven editor. */
  readOpencodeNativeRaw(): Promise<OpencodeNativeRaw>
  /** Apply leaf patches to opencode's config file, preserving comments + siblings. */
  patchOpencodeNative(patches: RawConfigPatch[]): Promise<void>
  listOpencodeAgents(cwd?: string): Promise<OpencodeAgentSummary[]>
  readOpencodeAgent(name: string, scope: OpencodeAgentScope, cwd?: string): Promise<OpencodeAgentDetail | null>
  saveOpencodeAgent(input: OpencodeAgentInput, cwd?: string): Promise<void>
  deleteOpencodeAgent(name: string, scope: OpencodeAgentScope, cwd?: string): Promise<void>
  setOpencodeAgentDisabled(name: string, scope: OpencodeAgentScope, cwd: string | undefined, disabled: boolean): Promise<void>
  generateOpencodeAgent(description: string, cwd?: string): Promise<{ identifier: string; whenToUse: string; systemPrompt: string }>
  logError(source: string, message: string): void
}

interface SharedProviderAPI {
  listSharedProviders(): Promise<SharedProviderDefinition[]>
  getSharedProviderStatuses(): Promise<SharedProviderStatus[]>
  listSharedProviderModels(id: string): Promise<SharedProviderModel[]>
  saveSharedProvider(definition: SharedProviderDefinition): Promise<void>
  removeSharedProvider(id: string): Promise<void>
  setSharedProviderRoute(
    id: string,
    harness: ConfigurableHarnessId,
    enabled: boolean
  ): Promise<void>
  setSharedProviderApiKey(id: string, key: string): Promise<void>
  syncSharedProvider(id: string): Promise<void>
  disconnectSharedProvider(id: string): Promise<void>
  setSharedProviderDefaultModel(
    id: string,
    harness: ConfigurableHarnessId,
    modelId?: string
  ): Promise<void>
}

interface GitAPI {
  gitCheckRepo(cwd: string): Promise<boolean>
  gitGetStatus(cwd: string): Promise<GitStatusData>
  gitGetBranches(cwd: string): Promise<GitBranchData>
  gitCheckout(cwd: string, branch: string): Promise<void>
  gitCreateBranch(cwd: string, name: string): Promise<void>
  gitGetFilePatch(
    cwd: string,
    filePath: string,
    staged: boolean,
    ignoreWhitespace: boolean
  ): Promise<{ patch: string; isBinary?: boolean }>
  gitGetFileContents(
    cwd: string,
    filePath: string,
    staged: boolean
  ): Promise<{ oldContent: string; newContent: string }>
  gitStageFile(cwd: string, filePath: string): Promise<void>
  gitUnstageFile(cwd: string, filePath: string): Promise<void>
  gitDiscardFile(cwd: string, filePath: string): Promise<void>
  gitStageAll(cwd: string): Promise<void>
  gitUnstageAll(cwd: string): Promise<void>
  gitCommit(cwd: string, message: string): Promise<string>
  gitPush(cwd: string): Promise<void>
  gitPushWithUpstream(cwd: string, branch: string): Promise<void>
  gitPull(cwd: string): Promise<{ summary: string }>
  gitFetch(cwd: string): Promise<void>
  gitStartWatching(cwd: string): Promise<void>
  gitStopWatching(cwd: string): Promise<void>
  onGitStatusUpdate(cb: (data: { cwd: string; status: GitStatusData }) => void): () => void
}

interface McpAPI {
  mcpServerStatus(routingId: string): Promise<McpServerInfo[]>
  mcpToggleServer(routingId: string, serverName: string, enabled: boolean): Promise<void>
  mcpReconnectServer(routingId: string, serverName: string): Promise<void>
  mcpSetServers(
    routingId: string,
    servers: Record<string, McpServerConfig>
  ): Promise<McpSetServersResult>
  loadMcpServers(scope: McpServerScope, cwd?: string): Promise<Record<string, McpServerConfig>>
  saveMcpServers(
    scope: McpServerScope,
    servers: Record<string, McpServerConfig>,
    cwd?: string
  ): Promise<void>
  removeMcpServer(scope: McpServerScope, serverName: string, cwd?: string): Promise<void>
  mcpReadDisabled(cwd: string): Promise<string[]>
  mcpToggleDisabled(cwd: string, serverName: string, enabled: boolean): Promise<void>
  onMcpServers(
    cb: (routingId: string, servers: Array<{ name: string; status: string }>) => void
  ): () => void
  loadClaudePermissions(scope: PermissionScope, cwd?: string): Promise<ClaudePermissions>
  saveClaudePermissions(
    scope: PermissionScope,
    permissions: ClaudePermissions,
    cwd?: string
  ): Promise<void>
  /** Whether Claude Code honors this workspace's project/local ALLOW rules
   *  (~/.claude.json#projects[cwd].hasTrustDialogAccepted). Untrusted → cli.js
   *  silently drops them; deny/ask and user-scope allows still apply. */
  isWorkspaceTrusted(cwd: string): Promise<boolean>
  /** Transcript retention window (cleanupPeriodDays). undefined = not set (CLI default of 30). */
  getCleanupPeriodDays(): Promise<number | undefined>
  setCleanupPeriodDays(days: number): Promise<void>
}

interface TerminalAPI {
  createTerminal(cwd: string): Promise<string>
  writeTerminal(id: string, data: string): Promise<void>
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>
  killTerminal(id: string): Promise<void>
  killTerminalsByCwd(cwd: string): Promise<string[]>
  onTerminalData(cb: (data: { terminalId: string; data: string }) => void): () => void
  onTerminalExit(cb: (data: { terminalId: string; code: number }) => void): () => void
}

interface AutomationAPI {
  listAutomations(): Promise<Automation[]>
  saveAutomation(automation: Automation): Promise<void>
  deleteAutomation(id: string): Promise<void>
  runAutomationNow(id: string): Promise<void>
  toggleAutomation(id: string, enabled: boolean): Promise<void>
  listAutomationRuns(automationId: string): Promise<AutomationRun[]>
  loadAutomationRunHistory(automationId: string, runId: string): Promise<ChatMessage[]>
  cancelAutomationRun(automationId: string): Promise<void>
  dismissAutomationRun(automationId: string, runId: string): Promise<void>
  sendAutomationMessage(automationId: string, prompt: string): Promise<void>
  onAutomationRunUpdate(
    cb: (data: { automationId: string; run: AutomationRun }) => void
  ): () => void
  onAutomationsChanged(cb: (automations: Automation[]) => void): () => void
  onAutomationRunMessage(
    cb: (data: { automationId: string; message: ChatMessage }) => void
  ): () => void
  onAutomationStreamEvent(
    cb: (data: { automationId: string; type: string; text: string }) => void
  ): () => void
  onAutomationProcessing(
    cb: (data: { automationId: string; isProcessing: boolean }) => void
  ): () => void
}

interface FileAPI {
  listDir(dirPath: string): Promise<{ entries: DirEntry[]; isRoot: boolean; resolvedPath: string }>
  openInVSCode(cwd: string): Promise<void>
  /**
   * Open a local file with the OS default handler. Optional: only the desktop
   * preload provides it — the remote web client has no local filesystem, so
   * callers must guard with `window.api?.openPath?.(…)` and hide the
   * affordance when it is absent. Resolves with `{ error }` on failure.
   */
  openPath?(filePath: string): Promise<{ error?: string }>
  /** Reveal a local file in the OS file manager. Optional — see {@link FileAPI.openPath}. */
  showInFolder?(filePath: string): Promise<{ error?: string }>
  /**
   * Resolve an image `src` for a file delivered by `SendUserFile` (ADR-043 §4).
   * One member, two transports:
   *  - desktop preload → IPC that reads the file and returns a `data:` URL;
   *  - web adapter → an authenticated same-origin `/sent-file?...&inline=1` URL.
   *
   * `sessionKey` is the session's routingId: the remote transport needs it to
   * look up that session's allowlisted files server-side. The desktop transport
   * ignores it — `filePath` is already the cwd-resolved absolute path and main
   * re-validates it. Optional, like the shell members: callers must probe.
   */
  getSentFilePreview?(
    sessionKey: string,
    filePath: string
  ): Promise<{ src: string } | { error: string }>
  createWorktree(cwd: string, name: string): Promise<WorktreeInfo>
  getWorktreeStatus(worktreePath: string, originalHead: string): Promise<WorktreeStatus>
  removeWorktree(worktreePath: string, branch: string, gitRoot: string): Promise<void>
  listWorktrees(cwd: string): Promise<WorktreeEntry[]>
}

/** Engine-routed per-vendor auth API (opencode's multi-vendor auth model). */
interface VendorAuthAPI {
  /** Probe all vendors for a given engine. */
  vendorAuthProbe(engineId: EngineId): Promise<VendorAuthMap>
  /** List per-vendor auth options (GET /provider/auth). */
  vendorAuthListOptions(engineId: EngineId): Promise<Record<string, VendorAuthOption[]>>
  /**
   * Which vendor ids have stored credentials in the engine's own auth store
   * (read-only file peek — ids + credential kind only, never key material).
   */
  vendorAuthListKeys(engineId: EngineId): Promise<Record<string, 'api' | 'oauth'>>
  /** Set an API key for a vendor. */
  vendorAuthSetKey(engineId: EngineId, vendorId: string, key: string): Promise<void>
  /** Start an OAuth flow for a vendor. Returns the URL to open + instructions. */
  vendorAuthOauthAuthorize(
    engineId: EngineId,
    vendorId: string,
    method: number,
    inputs?: Record<string, string>
  ): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }>
  /** Submit the OAuth code (paste-code flow). Omit code for auto/loopback flow. */
  vendorAuthOauthCallback(
    engineId: EngineId,
    vendorId: string,
    method: number,
    code?: string
  ): Promise<boolean>
  /** Remove auth credentials for a vendor. */
  vendorAuthRemove(engineId: EngineId, vendorId: string): Promise<void>
  /**
   * Abandon an in-flight vendor OAuth flow, releasing resources held open across
   * the authorize → callback handshake (e.g. the loopback-hosting server). Safe
   * to call with no active flow.
   */
  vendorAuthOauthCancel(engineId: EngineId): Promise<void>
}

interface AccountAPI {
  fetchAccountUsage(): Promise<AccountUsage>
  onAccountUsage(cb: (data: AccountUsage) => void): () => void
  fetchBlockUsage(): Promise<BlockUsageData>
  onBlockUsage(cb: (data: BlockUsageData) => void): () => void
  /** Filter usage analytics to one account email (null = all accounts) */
  setUsageAccountFilter(account: string | null): Promise<void>
  // --- Native Anthropic OAuth (ADR-014) ---
  /** Start the subscription login flow: opens the browser and awaits the
   *  loopback redirect. Resolves once cli.js has stored fresh credentials. */
  signIn(): Promise<AuthFlowState>
  /** Manual fallback: submit the authorization code pasted by the user.
   *  `state` is recovered internally from the login URL. */
  submitOAuthCode(code: string): Promise<AuthFlowState>
  /** Abort an in-flight login flow. */
  cancelSignIn(): Promise<void>
  /** Subscribe to login-flow state transitions. */
  onAuthState(cb: (state: AuthFlowState) => void): () => void
  // --- Multiple-account support (ADR-015) ---
  /** Current accounts + active id + enabled flag. */
  getAccounts(): Promise<AccountsState>
  /** Toggle multi-account (file-based credential) mode. */
  setMultiAccountEnabled(enabled: boolean): Promise<AccountsState>
  /** Create a new account and start its login flow (resolves once login starts). */
  addAccount(): Promise<AccountsState>
  /** Make an existing account active (sessions respawn against it). */
  switchAccount(id: string): Promise<AccountsState>
  /** Delete a persisted account and its credentials. */
  deleteAccount(id: string): Promise<AccountsState>
  /** Subscribe to account list / active / enabled changes. */
  onAccountsChanged(cb: (state: AccountsState) => void): () => void
  /** Fired when the active account changed — renderer should respawn sessions. */
  onAccountRespawnSessions(cb: () => void): () => void
  /**
   * Fetch opencode's live /config/providers price table, persist it, and register
   * it as supplemental pricing so equivalentCostUsd resolves opencode model costs.
   * Desktop-only (spawns a local opencode server). Phase 9b.
   */
  refreshPrices(): Promise<{ count: number; refreshedAt: number }>
  /**
   * Aggregate cross-engine dispatched usage (ADR-033 M4-B) by (targetEngine,
   * targetModel), all-time. Backs UsageView's "Delegated" section.
   */
  fetchDispatchedUsage(): Promise<DispatchedUsageSummary[]>
}

export interface NetworkInterfaceInfo {
  name: string // e.g. "Wi-Fi", "Ethernet", "Tailscale"
  address: string // e.g. "192.168.1.100"
  priority: number // lower = more preferred (1 = LAN, 9 = CGNAT/VPN)
}

/** Sanitized remote-server config — NEVER carries password_salt/password_hash/kdf_params. */
export interface RemoteConfig {
  port: number
  bindHost: string | null
  autostart: boolean
  tlsMode: number
  /**
   * Pinned `tailscale serve` HTTPS port (ADR-042), 1–65535, default 443. The
   * ONLY port TLS mode will bind — there is no fallback walk. The last-serve
   * cleanup record (`last_serve_*`) is deliberately NOT exposed: it is internal
   * bookkeeping for the startup reconciliation.
   */
  tlsHttpsPort: number
  passwordSet: boolean
  passwordUpdatedAt: number | null
}

interface RemoteAPI {
  getNetworkInterfaces(): Promise<NetworkInterfaceInfo[]>
  startRemoteServer(opts?: {
    port?: number
    host?: string
    tunnel?: boolean
  }): Promise<{ port: number; token: string; lanUrl: string }>
  stopRemoteServer(): Promise<void>
  getRemoteStatus(): Promise<RemoteStatus>
  onRemoteStatus(cb: (status: RemoteStatus) => void): () => void
  /** Persisted remote-server config (fixed port, bind host, autostart, tls
   *  placeholder, password status). Main-only — never reachable via the
   *  remote WS dispatcher (RemoteDispatcher.BLOCKED). */
  getRemoteConfig(): Promise<RemoteConfig>
  /** Partial update of the persisted config; returns the fresh sanitized config. */
  setRemoteConfig(partial: {
    port?: number
    bindHost?: string | null
    autostart?: boolean
    tlsMode?: number
    tlsHttpsPort?: number
  }): Promise<RemoteConfig>
  /**
   * Re-run `tailscale serve` enablement for the running server with
   * `force: true` — it CLAIMS the pinned HTTPS port, overwriting whatever
   * handler currently holds it (ADR-042). The user's deliberate "my bookmark
   * wins" action, surfaced by the serve-failure banner. Main-only (in
   * `RemoteDispatcher.BLOCKED`): a remote client must never mutate the serve
   * config of the server it is connected through.
   */
  forceReserve(): Promise<void>
  /** Provision a new remote-access password. Throws (min length 12) on validation failure. */
  setRemotePassword(password: string): Promise<void>
  /** Clear the remote-access password credential. */
  clearRemotePassword(): Promise<void>
  /**
   * Probe the local Tailscale installation (Phase 3 TLS mode). The result is
   * designed to be user-facing: the failure variants carry an actionable
   * `message` the Settings UI renders verbatim. Main-only — in
   * `RemoteDispatcher.BLOCKED`, because it discloses the node's DNS name and
   * the owner's login.
   */
  detectTailscale(): Promise<TailscaleDetection>
}

/**
 * States {@link TailscaleDetection} can report, and the value carried by
 * `RemoteStatus.tls.detection`. Declared here (not in the main-only
 * `tailscale-manager.ts`) because both the renderer and the web client need it;
 * `tailscale-manager.ts` imports it, so the two can never drift.
 */
export type RemoteTlsDetection =
  | 'ok'
  | 'not-installed'
  | 'daemon-down'
  | 'logged-out'
  | 'https-disabled'
  | 'no-operator'
  | 'error'

/** Outcome of probing the local `tailscale` CLI (`TailscaleManager.detect()`). */
export type TailscaleDetection =
  | {
      state: 'ok'
      binaryPath: string
      version: string
      /** `Self.DNSName` with the trailing dot stripped, e.g. `box.tailXXXX.ts.net`. */
      dnsName: string
      /** `CertDomains` from `status --json`; may legitimately be `[]` when the
       *  tailnet has the `https` node capability but no cert issued yet. */
      certDomains: string[]
      /**
       * Lowercased `LoginName` of the user who owns this node
       * (`User[Self.UserID].LoginName`), or null when it cannot be determined —
       * a tagged node, or a status payload with no matching `User` entry. Null
       * disables tailnet-identity auth entirely (fail closed): it is the ONLY
       * login the remote server will accept from a `Tailscale-User-Login`
       * header.
       */
      ownerLogin: string | null
    }
  | {
      state: Exclude<RemoteTlsDetection, 'ok'>
      /** Actionable, user-facing. Safe to render verbatim in the UI. */
      message: string
      binaryPath?: string
      /** Raw diagnostic (stderr tail / BackendState / parse error). Not for the UI. */
      detail?: string
    }

export type TunnelState =
  | 'stopped'
  | 'starting'
  | 'downloading'
  | 'connected'
  | 'error'
  | 'restarting'

/**
 * Auth methods the remote server accepts on a connection. `'token'` is the
 * per-start random bearer token from the URL fragment; `'password'` is the
 * scrypt proof derived from the user's persisted credential;
 * `'tailnet-identity'` is the spoof-stripped `Tailscale-User-Login` header a
 * `tailscale serve` proxy attaches, accepted for the node owner's login only.
 */
export type RemoteAuthMethod = 'token' | 'password' | 'tailnet-identity'

/**
 * Why a `tailscale serve` mutation failed. Declared here (not in the main-only
 * `tailscale-manager.ts`) because it travels to the renderer inside
 * {@link RemoteTlsStatus.serveError}; `tailscale-manager.ts` imports it as its
 * `ServeFailureReason`, so the two can never drift.
 */
export type RemoteServeFailureReason =
  /** `detect()` did not return `ok` (Tailscale missing / logged out / certs off / …). */
  | 'not-ready'
  /** The PINNED HTTPS port is held by a serve config that is not ours (ADR-042). */
  | 'port-occupied'
  /** The CLI exited non-zero (or timed out). */
  | 'exec-failed'
  /** The CLI exited 0 but the config did not actually land. */
  | 'verify-failed'

/**
 * `tailscale serve` state for the running server (Phase 3). All-null fields
 * with a non-null object mean "TLS mode is on but serve is not up yet" — read
 * `serveError` / `detectionMessage` for why.
 */
export interface RemoteTlsStatus {
  /** Mirrors the `tls_mode` the server was STARTED with: 1 = tailscale-serve. */
  mode: number
  /**
   * The HTTPS port serve is CONFIRMED listening on, null until up. Since
   * ADR-042 this is always {@link RemoteTlsStatus.pinnedHttpsPort} when
   * non-null — there is no candidate walk any more.
   */
  httpsPort: number | null
  /**
   * The pinned HTTPS port this run will bind (`remote_config.tls_https_port`,
   * default 443). Known even while serve is down, which is exactly when the UI
   * needs to name the port that failed.
   */
  pinnedHttpsPort: number
  /**
   * The most recent `tailscale serve` failure while TLS mode was requested, or
   * null when serve is healthy. Rendered by the app-level serve banner; the
   * `reason` decides whether "Force re-serve" can plausibly fix it
   * (`port-occupied` → yes, by overwriting the occupant).
   */
  serveError: { reason: RemoteServeFailureReason; message: string } | null
  /** `https://<dnsName>[:port]` — the URL to hand the user. Replaces `lanUrl`. */
  url: string | null
  /** Last `detect()` state, so the UI can distinguish "not installed" from "certs off". */
  detection: RemoteTlsDetection | null
  /**
   * Most recent actionable TLS failure message — either the detection message
   * or the `tailscale serve` failure — renderable verbatim. Null while serve is
   * healthy.
   */
  detectionMessage: string | null
}

export interface RemoteStatus {
  running: boolean
  port: number | null
  token: string | null
  lanUrl: string | null
  tunnelUrl: string | null
  tunnelState: TunnelState | null
  tunnelError: string | null
  connectedClients: number
  clientIps: string[]
  /**
   * Tailnet logins of the connected clients, parallel to `clientIps`. A `null`
   * entry means that client authenticated with the token or the password.
   */
  clientLogins: (string | null)[]
  /** `tailscale serve` state, or null when the running server is not in TLS mode. */
  tls: RemoteTlsStatus | null
  /** Message from the most recent failed `start()` listen attempt (e.g.
   *  EADDRINUSE), or null if the last start succeeded / no start has failed
   *  since the last stop(). Surfaces autostart failures, which are otherwise
   *  invisible (no modal open to report them to). */
  lastError: string | null
  /** Methods this running server will accept: always `'token'`, plus
   *  `'password'` when a credential is provisioned AND the server is not in
   *  tunnel (E2E) mode, plus `'tailnet-identity'` when `tailscale serve` is up
   *  and the node owner's login is known. Empty when not running. Derived
   *  exactly the same way as `/remote/auth-info`'s `methods`. */
  authMethods: RemoteAuthMethod[]
}

// ---------------------------------------------------------------------------
// Voice input types
// ---------------------------------------------------------------------------

export type VoiceLanguageCode =
  | 'en'
  | 'es'
  | 'fr'
  | 'ja'
  | 'de'
  | 'pt'
  | 'it'
  | 'ko'
  | 'hi'
  | 'id'
  | 'ru'
  | 'pl'
  | 'tr'
  | 'nl'
  | 'uk'
  | 'el'
  | 'cs'
  | 'da'
  | 'sv'
  | 'no'

export interface VoiceLanguageOption {
  code: VoiceLanguageCode
  label: string
}

// Supported languages match the SDK's normalizeLanguageForSTT valid code set.
// Deepgram silently fails (connects but never transcribes) for unsupported codes.
export const VOICE_LANGUAGES: VoiceLanguageOption[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'ja', label: 'Japanese' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'ko', label: 'Korean' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ru', label: 'Russian' },
  { code: 'pl', label: 'Polish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'nl', label: 'Dutch' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'el', label: 'Greek' },
  { code: 'cs', label: 'Czech' },
  { code: 'da', label: 'Danish' },
  { code: 'sv', label: 'Swedish' },
  { code: 'no', label: 'Norwegian' }
]

export interface VoiceTranscript {
  text: string
  isFinal: boolean
}

export type VoiceState = 'idle' | 'connecting' | 'recording' | 'processing'

interface VoiceAPI {
  voiceStartServer(routingId: string): Promise<void>
  voiceStopServer(routingId: string): Promise<void>
  voiceStartRecording(routingId: string, language: string): Promise<void>
  voiceStopRecording(routingId: string): Promise<void>
  onVoiceTranscript(cb: (routingId: string, data: VoiceTranscript) => void): () => void
  onVoiceState(cb: (routingId: string, state: VoiceState) => void): () => void
  onVoiceError(cb: (routingId: string, error: string) => void): () => void
}

export interface ClaudeAPI
  extends
    SessionAPI,
    GitAPI,
    McpAPI,
    TerminalAPI,
    AutomationAPI,
    FileAPI,
    AccountAPI,
    VendorAuthAPI,
    RemoteAPI,
    VoiceAPI,
    SharedProviderAPI,
    PluginAPI {
  /** Relay a log message from the renderer to the main process logger */
  logRelay(level: string, source: string, message: string): void
  /** App + SDK version info for display in Settings */
  getVersionInfo(): Promise<{ appVersion: string; sdkVersion: string; cliVersion: string }>
  /** Open the standalone log viewer window */
  openLogViewer(): Promise<void>
  /** Absolute path to the vendored pi binary (locatePiBinary()), or null if not
   *  found. Settings › pi's subscription hint block (`pi /login`). */
  getPiBinaryPath(): Promise<string | null>
  /** Read-only Codex (ChatGPT) auth-vault connection status (M6c). Drives
   *  PiVendors.tsx's "Connect ChatGPT" UI — never returns token material. */
  getPiAuthStatus(): Promise<PiAuthStatus>
}

// ---------------------------------------------------------------------------
// Account usage types (5hr / 7-day rate windows)
// ---------------------------------------------------------------------------

export interface RateWindow {
  usedPercent: number // 0-100
  resetsAt: string | null // ISO8601 timestamp
}

export interface ExtraUsage {
  isEnabled: boolean
  monthlyLimit: number | null // null = unlimited, otherwise in cents (divide by 100 for dollars)
  usedCredits: number // in cents (divide by 100 for dollars)
  utilization: number // percentage 0-100
}

export interface AccountUsage {
  fiveHour: RateWindow
  sevenDay: RateWindow | null
  sevenDaySonnet: RateWindow | null
  sevenDayOpus: RateWindow | null
  extraUsage: ExtraUsage | null
  planName: string | null // e.g. "claude_max_5x"
  fetchedAt: number // Date.now()
  error: string | null
}

// ---------------------------------------------------------------------------
// Native Anthropic OAuth (subscription "Log in with Claude") — see ADR-014
// ---------------------------------------------------------------------------

/** Account info returned by cli.js after a successful OAuth token exchange. */
export interface OAuthAccount {
  email: string | null
  organization: string | null
  subscriptionType: string | null // e.g. "max", "pro"
  tokenSource?: string | null
  apiKeySource?: string | null
  apiProvider?: string | null
}

// --- Multiple-account support (ADR-015) ---

export interface AccountInfo {
  id: string
  email: string | null
  subscriptionType: string | null
  organization: string | null
  createdAt: number
}

export interface AccountsState {
  /** Multi-account mode (file-based credentials via SKIP_SECURESTORAGE). */
  enabled: boolean
  activeId: string | null
  accounts: AccountInfo[]
}

export type AuthFlowStatus = 'idle' | 'authorizing' | 'success' | 'error'

/**
 * Broadcast to the renderer on every transition of the native login flow (ADR-014).
 * Renamed from AuthState in Phase 4 to free that name for the resolved tri-state.
 */
export interface AuthFlowState {
  status: AuthFlowStatus
  account: OAuthAccount | null
  error: string | null
}

/**
 * Engine-neutral session-level status metrics (cost, tokens, duration),
 * refreshed on every turn. `totalDurationMs` is the accumulated ACTIVE
 * (turn-processing) duration of COMPLETED turns, in milliseconds — idle time
 * between turns (waiting on the user) never counts, and both engines share
 * this semantic. Pair with `turnStartedAtMs` to reconstruct the live,
 * in-flight total while a turn is still running:
 *   totalDurationMs + (turnStartedAtMs ? Date.now() - turnStartedAtMs : 0)
 */
export interface StatusLineData {
  totalCostUsd: number
  totalDurationMs: number
  totalApiDurationMs: number
  totalInputTokens: number
  totalOutputTokens: number
  cachedTokens: number
  totalTokens: number
  contextWindowSize: number
  usedPercentage: number | null
  remainingPercentage: number | null
  /** Epoch ms when the currently in-flight turn started; null/undefined when idle. */
  turnStartedAtMs?: number | null
  /** Per-model cost breakdown (Slice B). Sums to totalCostUsd (± float). Always
   *  emitted once cost is known; the renderer hides the breakdown when a single
   *  non-dispatched entry would just repeat the headline Cost figure. */
  modelCosts?: ModelCostEntry[]
}

/**
 * One session-cost line attributed to a model (Slice B — per-model session cost
 * breakdown, durable across reloads). Sorted/labelled in the renderer (TopBar).
 * ADR-033 cross-engine dispatch (Slice C) adds rows with `dispatched: true` for
 * spend that happened in a dispatched call to a different engine.
 */
export interface ModelCostEntry {
  /** 'claude' | 'opencode' (Slice C adds dispatch target engines) */
  engineId: EngineId
  /** Raw model id, e.g. 'claude-fable-5' */
  modelId: string
  costUsd: number
  /** true when this spend happened in a cross-engine dispatched call (Slice C). */
  dispatched?: boolean
}

/**
 * MeteringSnapshot — engine-neutral session-level usage metric (foundation §3,
 * Phase 7 Pass 2). Emitted by BOTH engines on `session:metering` ALONGSIDE the
 * existing StatusLineData (which is unchanged — behavior-preserving for the
 * Claude status line). The headline metric is `equivalentCostUsd` (tokens ×
 * the internal pricing table); `engineReportedCostUsd` is the engine's own cost
 * (real spend for apiKey accounts). `window` is present only for subscription
 * accounts that expose a usage provider (Claude); apiKey/free get a cumulative
 * meter with no window. Per-billingType behavior is driven by `billingType`.
 */
export interface MeteringSnapshot {
  engineId: EngineId
  vendorId: VendorId
  billingType: BillingType
  tokens: {
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
    total: number
  }
  /** tokens × internal pricing — the primary metric; null when the model is unpriced. */
  equivalentCostUsd: number | null
  /** cli.js total_cost_usd / opencode info.cost — real spend when billingType==='apiKey'. */
  engineReportedCostUsd?: number
  contextWindow: { used: number; size: number }
  /** Subscription-only; absent for apiKey/free/unknown. */
  window?: {
    usedPercent: number
    resetsAt: string | null
    /** The WLS capacity projection (subscription windows with a usage provider). */
    projection?: { maxTokens: number; costUsd: number }
  }
}

// ---------------------------------------------------------------------------
// Block usage types (ccusage-inspired token tracking per 5hr window)
// ---------------------------------------------------------------------------

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface ModelTokenBreakdown {
  model: string
  tokens: TokenCounts
  costUsd: number
  requestCount: number
}

export interface UsageBlock {
  id: string // ISO string of floored start time
  startTime: number // epoch ms, floored to hour
  endTime: number // startTime + 5hrs
  actualEndTime: number // timestamp of last entry
  isActive: boolean
  tokens: TokenCounts
  costUsd: number
  requestCount: number
  models: ModelTokenBreakdown[]
  burnRate: { tokensPerMin: number; costPerHour: number } | null
  projectedUsage: { tokens: number; costUsd: number } | null
  /** Final API usage % when this block ended (from last snapshot). Used for accurate display. */
  finalApiPercent: number | null
  /** Whether the block boundary came from an observed API window (resets_at)
   *  rather than the floorToHour fallback. */
  windowAligned?: boolean
}

/** A single point-in-time snapshot, stored every poll cycle */
export interface UsageSnapshot {
  timestamp: number // when this snapshot was taken
  apiUsagePercent: number // 5hr API usage % at this moment
  apiResetAt: string | null // when the 5hr window resets
  activeBlockId: string | null // which block is active
  /** Cumulative totals for the active block at this point in time */
  blockTokens: TokenCounts | null
  blockCostUsd: number
  blockRequestCount: number
  /** Per-model cumulative totals for the active block */
  blockModels: ModelTokenBreakdown[]
  burnRate: { tokensPerMin: number; costPerHour: number } | null
  /** Projected window capacity at this snapshot (from WLS regression) */
  projectedUsage: { tokens: number; costUsd: number } | null
}

/** Entry-derived daily summary — computed from deduplicated JSONL entries. */
export interface DailySummary {
  totalTokens: number
  costUsd: number
  models: Record<string, number> // model → total tokens
  blockCount: number
  requestCount: number
}

/** Daily file format: ~/.claude/ui/usage/YYYY-MM-DD.json */
export interface DailyUsageFile {
  date: string // YYYY-MM-DD
  snapshots: UsageSnapshot[] // time-series, one per poll cycle
  /** Completed blocks that overlapped with this day */
  completedBlocks: UsageBlock[]
  /** Authoritative daily totals computed from deduplicated JSONL entries.
   *  Added to fix overlapping-block double-counting — once persisted, this
   *  is used instead of summing completedBlocks. */
  dailySummary?: DailySummary
}

/** Data pushed to renderer for display */
export interface BlockUsageData {
  currentBlock: UsageBlock | null
  recentBlocks: UsageBlock[] // last 48hrs of completed blocks
  /** Today's time-series snapshots for intra-block analysis */
  todaySnapshots: UsageSnapshot[]
  /** Daily aggregates for 30-day chart */
  dailyHistory: Array<{
    date: string
    totalTokens: number // sum of all 4 token types
    costUsd: number
    models: Record<string, number> // model → totalTokens
    peakApiPercent: number // highest API % seen that day
    blockCount: number // number of blocks that day
  }>
  /** Distinct account emails seen in the account log (for the filter UI) */
  accounts: string[]
  /** Active account filter (email), or null for all accounts */
  accountFilter: string | null
  /**
   * Per-engine usage breakdown over the scan window (Phase 7 Pass 2).
   * Sourced from usage_event across ALL engines — this is how opencode usage
   * surfaces in the dashboard. Absent/empty when only Claude has data.
   */
  perEngine?: EngineUsageSummary[]
}

/** Per-engine usage summary for the dashboard (Phase 7 Pass 2 / Phase 9b). */
export interface EngineUsageSummary {
  engineId: string
  tokens: TokenCounts
  costUsd: number
  requestCount: number
  /** Per-model breakdown within this engine, sorted by total tokens desc (Phase 9b). */
  models: ModelTokenBreakdown[]
}

/**
 * One (targetEngine, targetModel) aggregate of cross-engine dispatched usage
 * (ADR-033 M4-B) — the operational DB's `dispatched_usage` table grouped by
 * target. Backs UsageView's "Delegated" section.
 */
export interface DispatchedUsageSummary {
  targetEngine: string
  targetModel: string
  dispatches: number
  totalTokens: number
  costUsd: number
}

// ---------------------------------------------------------------------------
// Automation types (scheduled cron-job system)
// ---------------------------------------------------------------------------

export interface AutomationSchedule {
  type: 'interval' | 'cron'
  intervalMs?: number
  cronExpression?: string
}

export interface Automation {
  id: string
  name: string
  prompt: string
  cwd: string
  schedule: AutomationSchedule
  permissions: { allow: string[]; deny: string[] }
  model?: string
  effort?: string
  thinkingMode?: 'adaptive' | 'enabled' | 'disabled'
  permissionMode?: 'default' | 'auto'
  enabled: boolean
  lastRunAt: number | null
  lastRunStatus: 'success' | 'error' | null
  createdAt: number
}

export interface AutomationRun {
  id: string
  automationId: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'success' | 'error'
  totalCostUsd: number
  error?: string
  resultSummary?: string
  /** SDK session ID — used to locate the project JSONL for message history */
  sessionId?: string
  /** SDK project key (cwd with /.\\ replaced by -) — used with sessionId to load history */
  projectKey?: string
}

// ---------------------------------------------------------------------------
// Worktree types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  worktreePath: string
  worktreeBranch: string
  worktreeName: string
  originalCwd: string
  gitRoot: string
  originalHeadCommit: string
  createdAt: number
}

export interface WorktreeStatus {
  uncommittedFiles: number
  commitsAhead: number
  files: string[]
}

export interface WorktreeEntry {
  name: string
  path: string
  branch: string
  exists: boolean
}

// ---------------------------------------------------------------------------
// UI session config
// ---------------------------------------------------------------------------

export interface UISessionConfig {
  recentSessions?: string[]
  pinnedSessions?: string[]
  customTitles?: Record<string, string>
  worktreeInfoMap?: Record<string, WorktreeInfo>
  /** Session IDs the user has chosen to hide from the sidebar */
  hiddenSessions?: string[]
  /** Project keys the user has chosen to hide from the sidebar */
  hiddenProjects?: string[]
  /**
   * Engine + model per session. Maps sessionId → { engineId, model? }.
   * Absent keys are treated as claude. The entry is written at session-creation
   * time, updated whenever the user switches model, and carried over on rekey.
   * On reopen, the optional `model` field seeds `selectedModel` so the last
   * model choice is restored (Phase 1 behavior addition).
   */
  sessionEngines?: Record<string, { engineId: EngineId; model?: ModelRef }>
}

export interface SlashCommandInfo {
  name: string
  description?: string
}

// ---------------------------------------------------------------------------
// Skill types (skills management dialog)
// ---------------------------------------------------------------------------

export type SkillSource = 'project' | 'user' | 'plugin' | 'bundled'

export interface SkillInfo {
  name: string
  displayName?: string
  description: string
  source: SkillSource
  pluginName?: string
  path: string // filesystem path to SKILL.md (empty for bundled)
  content: string // markdown body (no frontmatter)
}

// ---------------------------------------------------------------------------
// MCP Server types (MCP server management dialog)
// ---------------------------------------------------------------------------

export type McpServerScope = 'user' | 'project' | 'local' | 'claudeai' | 'managed'
export type McpServerConnectionStatus =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'pending'
  | 'disabled'
  | 'not_started'
export type McpServerTransport = 'stdio' | 'sse' | 'http'

export interface McpServerToolInfo {
  name: string
  description?: string
  annotations?: {
    readOnly?: boolean
    destructive?: boolean
    openWorld?: boolean
  }
}

export interface McpServerConfig {
  type?: McpServerTransport
  // stdio transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  // sse/http transport
  url?: string
  headers?: Record<string, string>
}

export interface McpServerInfo {
  name: string
  status: McpServerConnectionStatus
  serverInfo?: { name: string; version: string }
  error?: string
  config?: McpServerConfig
  scope?: McpServerScope
  tools?: McpServerToolInfo[]
}

export interface McpSetServersResult {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

// ---------------------------------------------------------------------------
// Diff review comment types
// ---------------------------------------------------------------------------

export interface DiffComment {
  id: string
  filePath: string
  lineNumber: number
  /** End line when a range is selected (inclusive). Equals lineNumber for single-line. */
  endLineNumber: number
  side: 'old' | 'new'
  lineContent: string
  comment: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// Plan review comment types
// ---------------------------------------------------------------------------

export interface PlanComment {
  id: string
  /** The exact text the user highlighted in the rendered plan */
  selectedText: string
  /** 1-based start line of the selection in the raw plan markdown */
  lineNumber: number
  /** 1-based end line (inclusive). Equals lineNumber for single-line selections. */
  endLineNumber: number
  /** Index of the plan section this comment belongs to (for UI placement) */
  sectionIndex: number
  comment: string
  createdAt: number
}

export interface PlanReviewData {
  planContent: string
  approvalRequestId: string
  comments: PlanComment[]
}

// ---------------------------------------------------------------------------
// Terminal types
// ---------------------------------------------------------------------------

export interface TerminalTab {
  id: string
  title: string
  cwd: string
}

// ---------------------------------------------------------------------------
// Git integration types
// ---------------------------------------------------------------------------

export interface GitFileStatus {
  path: string
  index: string // staged status: ' '|'M'|'A'|'D'|'R'|'?'|'!'
  working: string // working tree status
}

export interface GitStatusData {
  branch: string
  ahead: number
  behind: number
  trackingBranch: string | null
  files: GitFileStatus[]
  staged: string[]
  unstaged: string[]
  untracked: string[]
  linesAdded: number
  linesRemoved: number
  /**
   * True when the untracked-file line-count pass hit its file-count or byte
   * budget, so `linesAdded` undercounts. The files themselves are still listed.
   */
  lineCountsTruncated?: boolean
  /** True when `files`/`staged`/`unstaged`/`untracked` were capped for IPC. */
  filesTruncated?: boolean
}

export interface GitBranchData {
  current: string
  local: string[]
  remote: string[]
  tracking: Record<string, string>
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

export type ActiveView =
  | { type: 'chat' }
  | { type: 'usage' }
  | { type: 'automations' }
  | { type: 'plugin'; pluginId: string }

// ---------------------------------------------------------------------------
// Plugin system types
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void
}

export interface PluginViewConfig {
  /** Unique view ID (defaults to plugin ID if only one view) */
  id: string
  /** Label shown in sidebar */
  label: string
  /** SVG icon string for sidebar NavItem */
  icon?: string
  /** Absolute path to HTML file for the webview */
  htmlFile: string
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  enabled: boolean
  views: PluginViewConfig[]
  error?: string
}

export interface ClaudeUIPlugin {
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

export interface PluginContext {
  /** Plugin ID */
  id: string
  /** Filesystem path to plugin directory */
  pluginDir: string
  /** Data directory for plugin persistence (~/.claude/ui/plugins/<id>/data/) */
  dataDir: string
  /** Config directory (~/.claude/ui/plugins/<id>/) */
  configDir: string
  /** Debug mode (CLAUDEUI_PLUGIN_DEBUG=1) */
  debug: boolean
  /** Namespaced logger */
  logger: {
    info(message: string): void
    warn(message: string, err?: unknown): void
    error(message: string, err?: unknown): void
    debug(message: string): void
  }
  // Core services — typed as `any` here since main-process classes
  // are not importable from shared types. Actual implementations
  // provide the real SessionManager / AutomationManager instances.
  /** Session manager — create/get/cancel sessions */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions: any
  /** Automation manager */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  automations: any
  /** Main window reference */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  window: any
  /** Raw ipcMain for advanced use cases */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcMain: any
  /** SDK query escape hatch */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdkQuery: any
  /** Subscribe to session/app events (same payloads as IPC events) */
  on(event: string, handler: (...args: unknown[]) => void): Disposable
  /** Emit custom events (auto-namespaced to plugin:<id>:<event>) */
  emit(event: string, ...args: unknown[]): void
  /** Register an IPC handler (auto-namespaced to plugin:<id>:<channel>) */
  registerIpcHandler(channel: string, handler: (...args: unknown[]) => unknown): Disposable
  /** Register a remote handler (auto-namespaced to plugin:<id>:<channel>) */
  registerRemoteHandler(channel: string, handler: (...args: unknown[]) => unknown): Disposable
  /** Register a UI view that replaces the chat panel */
  registerView(config: Omit<PluginViewConfig, 'id'> & { id?: string }): Disposable
}

export type PluginViewWithOwner = PluginViewConfig & { pluginId: string }

interface PluginAPI {
  listPlugins(): Promise<PluginInfo[]>
  reloadPlugin(id: string): Promise<void>
  getPluginViews(): Promise<PluginViewWithOwner[]>
  getPluginPreloadPath(): Promise<string>
  onPluginViewsChanged(cb: (views: PluginViewWithOwner[]) => void): () => void

  // Mockup preview
  readMockupHtml(cwd: string, directory: string): Promise<string>
  watchMockup(cwd: string, directory: string): Promise<void>
  unwatchMockup(cwd: string, directory: string): Promise<void>
  onMockupFileChanged(cb: (directory: string) => void): () => void
  /**
   * The iframe `src` for a mockup preview. Platform-specific transport:
   * desktop returns a `mockup-asset://` URL (privileged Electron protocol);
   * the web client returns an HTTP URL on the remote server. Synchronous —
   * it's a pure URL builder.
   */
  getMockupPreviewUrl(cwd: string, directory: string, opts?: { dark?: boolean }): string
}
