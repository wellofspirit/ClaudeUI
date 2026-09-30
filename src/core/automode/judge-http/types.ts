/**
 * The contract of ClaudeUI's own auto-mode judge transport (ADR-081).
 *
 * `classify()` (`../classifier.ts`) builds the prompt and parses the verdict;
 * this module family makes the ONE model call in between, over plain `fetch`,
 * for the opencode and pi engines. The pieces:
 *
 * - {@link ResolvedJudgeRoute}: everything one call needs — endpoint, wire,
 *   model, headers (credential included) and the route's {@link JudgeCaps}.
 *   Produced per call by the route resolver (slice S2), so a rotated key or a
 *   refreshed token applies to the next call.
 * - `caps.ts` derives {@link JudgeCaps}; `wire-chat.ts` / `wire-responses.ts`
 *   build the body and read the stream; `transport.ts` ties them together.
 *
 * Nothing here imports vault, shared-provider or engine code: the resolver hands
 * in a finished route and this layer only spends it.
 */

export type JudgeWire = 'chat' | 'responses'
export type JudgeRouteKind =
  'chatgpt' | 'openai' | 'openrouter' | 'custom-chat' | 'custom-responses'

/**
 * What one route's endpoint accepts, declared once per route instead of being
 * scattered as model checks through the body builders (ADR-081 §4).
 */
export interface JudgeCaps {
  /** Body field for the output cap; 'none' = never send one (enforce client-side only). */
  outputCap: 'none' | 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'
  /** Send `stop`. When false, stop strings are still enforced client-side. */
  supportsStop: boolean
  /** Temperature to send, or null to omit. */
  temperature: number | null
  /** Where the system prompt goes: chat `system` / `developer` message, or Responses `instructions`. */
  systemChannel: 'system' | 'developer' | 'instructions'
  /** Send `prompt_cache_key` = the judge cache key (see `judgeCacheKey`). */
  promptCacheKey: boolean
  /** Put `cache_control: {type:'ephemeral'}` on the system content part (chat only). */
  cacheMarkerOnSystem: boolean
  /** Header carrying the cache key for affinity, e.g. 'session-id' (ChatGPT) or 'x-session-id' (OpenRouter). */
  affinityHeader: string | null
  /** Constant body fields merged in after `stream` and before the reasoning fields. Byte-stable. */
  extraBody: Readonly<Record<string, unknown>>
  /**
   * Output tokens added to the SERVER-side cap for endpoints that count
   * reasoning against it (OpenAI's `max_completion_tokens`), so a stage that
   * reasons does not spend its whole budget thinking and return empty text.
   * The client-side text cap stays at the request's own `maxTokens` — only the
   * wire value grows. Absent = 0 (ADR-083 §2).
   */
  reasoningHeadroom?: number
  /** Per-stage reasoning fields (merged after extraBody); {} = send nothing. */
  reasoning: {
    fast: Readonly<Record<string, unknown>>
    thinking: Readonly<Record<string, unknown>>
  }
}

/** One response's token usage, normalized across both wires. */
export interface JudgeUsageSample {
  /** Total prompt/input tokens as the provider reports them. */
  inputTokens: number
  /** Subset of `inputTokens` served from cache. */
  cachedInputTokens: number
  /** Output tokens, reasoning included. */
  outputTokens: number
  /** Subset of `outputTokens`. */
  reasoningTokens: number
  /** Provider-reported cost (OpenRouter), else null. */
  costUsd: number | null
}

/**
 * Who pays for a route's calls — what a judge usage row is attributed to
 * (ADR-081 §5). Credential-free by construction: `accountKey` is ADR-071 §3's
 * key (a digest for an API key), `accountLabel` its display half.
 */
export interface JudgeRouteAccount {
  /** The engine-native provider id the judge model names (`openrouter`, `openai-codex`, …). */
  vendorId: string
  /** The vault account id (ChatGPT), else null. */
  accountId: string | null
  accountKey: string
  accountLabel: string | null
  billingType: 'subscription' | 'apiKey'
}

/** Everything needed to make ONE call. Holds credential material — never log or serialize it. */
export interface ResolvedJudgeRoute {
  kind: JudgeRouteKind
  wire: JudgeWire
  /** Full endpoint URL. */
  url: string
  /** Wire model id. */
  model: string
  /** Includes Authorization when there is a credential. */
  headers: Readonly<Record<string, string>>
  caps: JudgeCaps
  /** Human-readable, credential-free, for logs and errors, e.g. "openrouter · z-ai/glm-4.6". */
  label: string
  account: JudgeRouteAccount
  /**
   * The catalog's output ceiling for the model, when it states one. A request's
   * `maxTokens` above it is clamped to it: a provider may reject a cap larger
   * than the model's own.
   */
  maxOutputTokens?: number
  /** ChatGPT only: force a token refresh and return a fresh route, or null when that failed. */
  reauthorize?: () => Promise<ResolvedJudgeRoute | null>
}

export type JudgeRouteResult =
  | { ok: true; route: ResolvedJudgeRoute }
  /** `reason` is user-facing copy. */
  | { ok: false; code: JudgeRouteUnavailableCode; reason: string }

export type JudgeRouteUnavailableCode =
  /** Engine-owned credential (Copilot, pi OAuth vendors, native keys). */
  | 'no-shared-provider'
  /** anthropic-messages, google, bedrock, … */
  | 'unsupported-protocol'
  | 'no-credential'
  | 'no-base-url'
  | 'provider-disabled'
  /** No token / no workspace id. */
  | 'chatgpt-unavailable'

/** The per-call reader output, shared by both wires. */
export interface JudgeStreamResult {
  text: string
  usage: JudgeUsageSample | null
  finish: 'stop' | 'length'
}

/** Options every wire reader takes. */
export interface JudgeStreamOptions {
  /** Cut the text at the first occurrence of any of these (exclusive), client-side. */
  stopSequences?: string[]
  /** Hard budget on accumulated text; exceeding it aborts the call. */
  maxChars: number
  /**
   * Called every time a usage payload is parsed (latest wins). Lets the
   * transport still report what the provider billed when the reader throws
   * AFTER usage arrived — the return value is lost on a throw.
   */
  onUsageSeen?: (usage: JudgeUsageSample) => void
}

/**
 * A judge call failed on the wire: a non-2xx status, an error event, a stream
 * that ended early or carried no text. Never retried (ADR-081 §4) — the one 401
 * retry happens before any of these is thrown. The message is credential-free
 * by construction: it is built from response bodies and our own copy, never
 * from request headers.
 */
export class JudgeWireError extends Error {
  readonly status?: number
  readonly code?: string
  readonly retryable = false as const

  constructor(message: string, opts: { status?: number; code?: string } = {}) {
    super(message)
    this.name = 'JudgeWireError'
    if (opts.status !== undefined) this.status = opts.status
    if (opts.code !== undefined) this.code = opts.code
  }
}
