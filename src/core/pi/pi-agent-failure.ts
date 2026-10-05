/**
 * Failure classification for host-run pi subagents (ADR-089, S1b): may a
 * model resume an agent whose run FAILED?
 *
 * The owner's ruling: yes only when the failure is environmental — pi's own
 * retryable errors (overloaded, rate limit, 5xx, timeouts, network), a crashed
 * child process, a rejected credential (401/403) or an exhausted quota — since
 * the same message can succeed later. Everything else (a context overflow, a
 * refused prompt, an error we do not recognise, a first launch that never ran)
 * is permanent: resuming it would only fail the same way, or deliver a
 * message with no task.
 *
 * PORTED PATTERNS. The message patterns below are copied from pi's own
 * classifiers so the host agrees with pi on what "retryable" means. Source
 * tree: `vendor/pi-src/packages/ai/src/utils/`, ported from pi 0.87.1
 * (`src/shared/harness-manifests/pi.json#tested`). A pin bump must re-diff
 * `overflow.ts` and `retry.ts` against the three blocks marked PORTED.
 *
 * Pure: no I/O, no imports beyond the shared status parse.
 */
import { isPiAuthStatus, piErrorStatusCode } from './pi-error-status'

export type PiAgentFailure = 'transient' | 'permanent'

/** What a failed run ended with — the four failure sources the host can tell apart. */
export type PiAgentFailureInput =
  /** pi's own turn error: `outcome.message`, which for a provider error is pi's `errorMessage`. */
  | { kind: 'turn-error'; message: string }
  /** Our own "pi child process exited unexpectedly" (or a dead transport): the child crashed. */
  | { kind: 'process-exit' }
  /** `launch()` failed ("Failed to start the agent: …"). `firstRun`: the agent never ran before. */
  | { kind: 'launch-failure'; firstRun: boolean }
  /** A `/cui-` prompt the runner refused to send. */
  | { kind: 'refused-command' }

// ── PORTED from vendor/pi-src/packages/ai/src/utils/overflow.ts (pi 0.87.1) ─
// OVERFLOW_PATTERNS, NON_OVERFLOW_PATTERNS and the Cerebras body-less case.
// The silent-overflow cases (usage vs. context window) are not message
// patterns and need the assistant message, so they are not ported.
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /range of input length should be/i, // DashScope / Qwen Token Plan
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i // Generic fallback
]

/** Cerebras answers an overflow with a body-less 400/413 (pi gates it on `provider === 'cerebras'`, which a bare message cannot know; the shape itself is distinctive enough). */
const CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i

/** Throttling text that also matches "too many tokens": never an overflow. */
const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors
  /rate limit/i, // Generic rate limiting
  /too many requests/i // Generic HTTP 429 style
]

// ── PORTED from vendor/pi-src/packages/ai/src/utils/retry.ts (pi 0.87.1) ────
function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.join('|'), 'i')
}

/** NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN: subscription / quota / billing limits. */
const PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
  // OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
  // Zen API. These are subscription/account limits, not transient throttles.
  'GoUsageLimitError',
  'FreeUsageLimitError',

  // OpenCode Go subscription-limit text asks users to enable available-balance
  // usage after rolling/weekly/monthly limits are reached.
  'Monthly usage limit reached',
  'available balance',

  // Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
  // quota/billing error code; the other strings cover common gateway wording.
  'insufficient_quota',
  'out of budget',
  'quota exceeded',
  'billing'
])

/** RETRYABLE_PROVIDER_ERROR_PATTERN: pi's own "restart the turn" errors. */
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  // Generic provider load, HTTP status, and server-side transient failures.
  'overloaded',
  'currently experiencing high demand',
  'rate.?limit',
  'too many requests',
  '429',
  '500',
  '502',
  '503',
  '504',
  '520',
  '524',
  'service.?unavailable',
  'server.?error',
  'internal.?error',

  // Wrapper/provider text for transient upstream failures, including OpenRouter
  // "Provider returned error" responses (#2264).
  'provider.?returned.?error',
  'exceeded request buffer limit while retrying upstream',

  // Network, proxy, and fetch transport failures. This includes OpenAI Codex
  // raw-fetch failures such as "upstream connect", "connection refused", and
  // "reset before headers" (#733), plus OpenRouter connection drops (#3317).
  'network.?error',
  'connection.?error',
  'connection.?refused',
  'connection.?lost',
  'other side closed',
  'fetch failed',
  'getaddrinfo',
  'ENOTFOUND',
  'EAI_AGAIN',
  'upstream.?connect',
  'reset before headers',
  'socket hang up',
  'socket connection was closed',
  'timed? out',
  'timeout',
  'terminated',

  // WebSocket transports can report close/error text instead of HTTP/fetch text.
  'websocket.?closed',
  'websocket.?error',

  // Premature stream endings from SDKs and transports. Anthropic can throw
  // "stream ended without ..." and "Anthropic stream ended before message_stop"
  // (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
  'ended without',
  'stream ended before message_stop',
  'stream ended before a terminal response event',
  'http2 request did not get a response',

  // Provider-requested retry delay cap failures should flow through the outer
  // retry policy so callers can surface/abort the backoff (#1123).
  'retry delay',

  // Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
  // stream exceptions (#6019).
  'you can retry your request',
  'try your request again',
  'please retry your request',

  // gRPC based providers (e.g. NVIDIA NIM)
  'ResourceExhausted'
])

/** pi's `isContextOverflow`, message-pattern half. */
function isContextOverflowMessage(message: string): boolean {
  if (NON_OVERFLOW_PATTERNS.some((p) => p.test(message))) return false
  return (
    OVERFLOW_PATTERNS.some((p) => p.test(message)) ||
    CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(message)
  )
}

/**
 * Whether a failed run may be resumed. First match wins:
 *
 *  1. context overflow → permanent (the history is the problem; a resume
 *     rebuilds the same context);
 *  2. a rejected credential (401/403, the anchored status parse the event
 *     mapper's sign-in dialog uses) → transient: the user can sign in again;
 *  3. quota / usage limits → transient: they reset or get topped up;
 *  4. pi's retryable provider / transport errors → transient;
 *  5. a crashed child process → transient;
 *  6. a launch failure: transient for a resume (the session file and the task
 *     exist), permanent for the FIRST run (nothing to resume — a resume would
 *     deliver a message with no task);
 *  7. a refused `/cui-` prompt, and anything unmatched → permanent.
 */
export function classifyPiAgentFailure(input: PiAgentFailureInput): PiAgentFailure {
  switch (input.kind) {
    case 'turn-error': {
      const { message } = input
      if (isContextOverflowMessage(message)) return 'permanent'
      if (isPiAuthStatus(piErrorStatusCode(message))) return 'transient'
      if (PROVIDER_LIMIT_ERROR_PATTERN.test(message)) return 'transient'
      if (RETRYABLE_PROVIDER_ERROR_PATTERN.test(message)) return 'transient'
      return 'permanent'
    }
    case 'process-exit':
      return 'transient'
    case 'launch-failure':
      return input.firstRun ? 'permanent' : 'transient'
    case 'refused-command':
      return 'permanent'
  }
}

/** A failure's one-line message for the refusal text: first line, at most 200 characters. */
export function failureSummary(message: string): string {
  return (message.split('\n', 1)[0] ?? '').trim().slice(0, 200)
}

/** Validates a persisted `failure` (history is data read back from disk): anything else is absent. */
export function parsePiAgentFailure(v: unknown): PiAgentFailure | undefined {
  return v === 'transient' || v === 'permanent' ? v : undefined
}
