import type { OpencodeConfigSettings } from './opencode'

export interface ProxySettings {
  enabled: boolean
  type: 'http' | 'socks5'
  hostname: string
  port: number
  username: string
  password: string
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
 *
 * The two jobs have their own switches (ADR-074 §9): `pinEnabled` gates
 * `model` and `renameEnabled` gates the three aliases. Each falls back to
 * `enabled` when absent, so a file written before the split behaves as it did;
 * `effectiveModelOverride` (shared/model-override.ts) is that rule. The UI
 * writes both flags and keeps `enabled = pinEnabled || renameEnabled` for
 * older builds reading the same file.
 */
export interface ModelOverrideSettings {
  enabled: boolean
  pinEnabled?: boolean
  renameEnabled?: boolean
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
  /** Claude session defaults (ADR-074 §8). Lives in engines/claude.json. */
  claudeConfig?: ClaudeEngineConfig
  /**
   * opencode only (ADR-097 S8): the built-in tools whose top-level
   * `{action,*,deny}` rule ClaudeUI's Tools switch wrote — the only rules the
   * switch ever removes again.
   */
  opencodeToolSwitches?: string[]
}

/**
 * ClaudeUI's OWN defaults for Claude sessions — NOT `~/.claude/settings.json`.
 *
 * cli.js reads `model` from its own settings, and so does the terminal `claude`;
 * writing there would change the terminal's default as a side effect. ClaudeUI
 * passes a session's model itself, so its default lives here and reaches only
 * sessions started from ClaudeUI (ADR-074 §8). Blank means "Claude's own
 * `default` alias", today's behaviour. A value here IS an explicit choice
 * (ADR-059): one the live model list no longer offers banners rather than
 * silently starting on something else.
 */
export interface ClaudeEngineConfig {
  /** A Claude picker value from `supportedModels()`: an alias (`opus`, `sonnet[1m]`, …; ADR-100). */
  defaultModel?: string
  /**
   * Whether cli.js may summarise a long (200K+ token) conversation left idle —
   * its `idleCompaction` setting (read as `ri("idleCompaction",!0)`,
   * `vendor/claude-cli/cli.js` 2.1.317). ClaudeUI's default is OFF: absent
   * means false, and the value is passed per spawn as `--settings` flag
   * settings, so the user's own `~/.claude/settings.json` (which the terminal
   * `claude` shares) is never touched.
   */
  idleCompaction?: boolean
  /**
   * Whether cli.js's built-in `cc-plugin-privacy@builtin` plugin asks before a
   * Web/Bash/Monitor/PowerShell call whose input holds the account email
   * address. ClaudeUI's default is ON: absent means true. cli.js reads the
   * plugin's switch (`enabledPlugins`, `defaultEnabled:!0`,
   * `enabledFromTrustedSettingsOnly:!0`) only from user, flag or policy
   * settings, so it is passed per spawn as `--settings` flag settings.
   */
  privacyEmailCheck?: boolean
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
  /**
   * ClaudeUI-private per-provider model allowlist (ADR-074 §1), keyed by pi
   * provider id with BARE model ids — opencode's `modelAllowlist` rule.
   *
   * Semantics by KEY PRESENCE (the array, not its length, is the gate):
   *   - key absent  → show ALL of that provider's models, including ones it
   *                   adds later.
   *   - key present → show ONLY the listed model ids (an empty array → none).
   *
   * The legacy global `string[]` of `<provider>/<modelId>` values is migrated
   * on read by `normalizePiModelAllowlist` (`shared/pi-model-allowlist.ts`).
   */
  modelAllowlist?: Record<string, string[]>
}

/**
 * Governs `dispatch_agent` calls targeting an engine (ADR-033). Lives in
 * `engines/<engineId>.json` (plane ③). Edited per engine in Settings ›
 * <engine> › Cross-engine dispatch — every field below is honoured in every
 * dispatch direction.
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
  /**
   * Absolute cap on ONE dispatched turn, in MILLISECONDS — the user's own
   * limit, applied in EVERY dispatch direction (Claude, opencode, pi).
   *
   * THERE IS NO BUILT-IN DEFAULT (ADR-033's 2026-09-18 amendment): undefined
   * and `0` both mean NO LIMIT. A dispatched agent then runs until it finishes,
   * the user stops it, the caller aborts it, `idleTimeoutMs` trips, or
   * `maxCostUsd` is reached. When set, the turn is interrupted on the target
   * (the target survives for a continuation in every direction except Claude,
   * whose process dies with the turn).
   */
  turnTimeoutMs?: number
  /**
   * Inactivity cap for one dispatched turn, in MILLISECONDS: how long the
   * target may show NO sign of life before the turn is interrupted. Applies in
   * EVERY dispatch direction, and like `turnTimeoutMs` has NO built-in default
   * — undefined and `0` both mean NO LIMIT (ADR-033's 2026-09-18 amendment).
   *
   * This is the liveness guard rather than the runaway guard: a working target
   * streams continuously (SSE events, SDK messages, pi RPC events, app-server
   * notifications), so this is the cap that should fire on a genuinely wedged
   * turn. A turn parked on an approval forwarded to the human counts as ALIVE.
   */
  idleTimeoutMs?: number
}

/**
 * Auto-mode (`auto`/`full` autonomy) LLM permission-gatekeeper config
 * (ADR-023, amended by `docs/automode-rework-plan.md`).
 *
 * Engine-neutral as of phase 4: read per engine from `engines/<engineId>.json`
 * by BOTH opencode and pi, which share the whole policy core
 * (`src/core/automode/`) and differ only in their permission intercept and
 * judge transport. Claude is the exception — cli.js ships its own classifier,
 * so none of this reaches it.
 */
export interface AutoModeConfig {
  /** Master switch. When false, `full` falls back to human approval prompts
   *  (the interim gated-like-default behavior). Defaults to true. */
  enabled?: boolean
  /** `providerID/modelID` for the judge. Defaults to the session's own model. */
  judgeModel?: string
  /**
   * Same `providerID/modelID` shape as {@link judgeModel}, per engine. When the primary judge
   * cannot produce a verdict (rate limit, outage, no route, the configured model gone) the WHOLE
   * classification is re-run on this model, so every verdict — the two-sample confirmation
   * included — comes from one model. Unset → the human decides, as before. A mode change never
   * triggers it.
   */
  fallbackJudgeModel?: string
  /**
   * A ChatGPT vault account id the fallback judge pays with (`authVault` account `id`, the one a
   * provider-account row names). Absent → the ACTIVE ChatGPT account. Read only when
   * {@link fallbackJudgeModel} routes through the ChatGPT subscription (`JudgeModelSupport.chatgpt`);
   * ignored otherwise. It lets the same model back itself up on a second subscription: a
   * fallback equal to the primary model is kept when this names a different account than the
   * active one. An account that is gone or signed out is no fallback — the call fails and the human
   * decides; it never falls back to the active account.
   */
  fallbackJudgeAccount?: string
  /** Two-stage classifier mode. Defaults to 'both'. */
  twoStageMode?: 'both' | 'fast' | 'thinking'
  // The three trust lists that used to live here moved to
  // {@link SharedAutoModeConfig} in ADR-065 phase 4 — they are the same values
  // for every engine, and keeping a copy per engine meant dropping a trusted
  // host from one judge and not the other. A read-time migration in
  // `ui-config.ts` unions the two engines' old lists into the shared file once.
}

/**
 * Whether ClaudeUI can make the auto-mode judge's model call for one picker
 * value itself (ADR-081 §3: no fallback to the engine) — one entry of
 * `ClaudeAPI.judgeModelSupport`. `reason` is user-facing copy. `chatgpt` is
 * true when the value routes through the ChatGPT subscription (even while the
 * active account is signed out, `ok: false`): the picker may then offer a
 * ChatGPT account to pay with (`AutoModeConfig.fallbackJudgeAccount`). Only
 * ever set to true: absent for every other route.
 */
export type JudgeModelSupport =
  { ok: true; chatgpt?: boolean } | { ok: false; reason: string; chatgpt?: boolean }

/**
 * The classifier trust lists, shared by every engine that runs ClaudeUI's own
 * judge — ONE file, `~/.claude/ui/automode.json` (ADR-065 § Shared trust lists).
 *
 * These are not per-engine settings and never were: they describe the user's
 * environment (which hosts, registries and resources are trusted), not how a
 * particular engine judges. OpencodeSession and PiSession DERIVE them into the
 * classifier environment at session start, alongside the per-engine
 * `AutoModeConfig` (judge model, two-stage mode, master switch), which stays in
 * `engines/<engineId>.json`. Claude cannot consume them — cli.js ships its own
 * classifier — which is why the settings badge reads "opencode · pi".
 *
 * Every slot defaults to EMPTY, and an empty slot means "nothing is trusted"
 * rather than "anything goes": the policy renders the restrictive fallback text
 * for it (see `EnvironmentInfo`). An empty list is therefore stored as an ABSENT
 * key — the sessions read them behind `?.length`, so `[]` is not a distinct
 * state and storing it would invent a second encoding of one meaning.
 *
 * The same file also carries the two judge guidance lists (ADR-083 §4,
 * `judgeAllow` / `judgeBlock`), under the same storage rules. Every entry of
 * all five lists is written verbatim into the judge's system prompt, and a
 * guidance entry becomes its own bullet line — which is why the IPC perimeter
 * refuses line breaks and other control characters in guidance entries, and
 * the environment builder drops any such entry a hand edit let through.
 */
export interface SharedAutoModeConfig {
  /** External domains/services the agent may send data to or fetch from. */
  trustedDomains?: string[]
  /** Package registries beyond the project manifest's default. */
  trustedRegistries?: string[]
  /** Production/protected target patterns. When set, they REPLACE the default
   *  'prod'/'production' name heuristic the policy would otherwise apply. */
  protectedPatterns?: string[]
  /**
   * The user's judge guidance (ADR-083 §4), in plain language: kinds of action
   * that are routine for this user ("creating and switching git branches").
   * Rendered as the User-Specified Allow exception — mandatory when it applies,
   * but never over the HARD rule, an adversarial rule or an explicit boundary.
   * This is cli.js's `autoMode.allow` for the opencode and pi judge. Unlike the
   * trust lists this is not about the environment but about the judge's
   * behaviour; it lives here because it is equally shared by every engine that
   * runs ClaudeUI's judge. Empty = absent, as for the lists above.
   */
  judgeAllow?: string[]
  /**
   * Kinds of action the user wants to approve personally ("running database
   * migrations"). Rendered as the User-Specified Block soft rule: the judge
   * blocks a matching action unless the user asked for it in the chat, and a
   * post-block "go ahead" clears it like any soft block. cli.js's
   * `autoMode.soft_deny`. Empty = absent.
   */
  judgeBlock?: string[]
  /**
   * ADR-084 §1: plainly read-only shell commands in the workspace skip the
   * judge. ON unless this is `false`; `true` is stored as an ABSENT key, so
   * the default and "on" are one encoding, as for the lists above.
   */
  readOnlyBypass?: boolean
  /**
   * ADR-091 part 6: how long a judge block holds for the user (Keep blocked /
   * Approve anyway) before it resolves as Keep blocked, in whole seconds,
   * clamped to [0, 600]. 0 — the default, stored as an ABSENT key — holds
   * nothing: the block is denied at once and the user can approve it
   * afterwards from the blocked review. Read live when a block arrives.
   */
  blockHoldSeconds?: number
  /**
   * Diagnostics: append every judge call's prompt and reply to `~/.claude/ui/logs/judge/`
   * (`core/automode/judge-capture.ts`). OFF unless `true`; `false` is stored as an ABSENT key,
   * like `readOnlyBypass: true`. Read per judge call, so a change binds the next call in every
   * running session.
   */
  captureJudgeReplies?: boolean
}

export interface VendorConfig {
  endpoint?: AnthropicEndpointSettings
  modelOverride?: ModelOverrideSettings
}
