/**
 * Per-route capability derivation for the HTTP judge (ADR-081 §4).
 *
 * Each route declares what its endpoint accepts ({@link JudgeCaps}) so the body
 * builders never branch on model ids themselves. Everything here is pure: the
 * route kind and model id in, a fresh caps object out.
 */

import { createHash } from 'node:crypto'
import type { JudgeRequest } from '../classifier'
import type { JudgeCaps, JudgeRouteKind, JudgeWire, ResolvedJudgeRoute } from './types'

/** Which wire a route kind speaks. */
export function wireForKind(kind: JudgeRouteKind): JudgeWire {
  return kind === 'chatgpt' || kind === 'custom-responses' ? 'responses' : 'chat'
}

/** Model ids reach us either bare (`gpt-5`) or OpenRouter-style (`openai/gpt-5`). */
function bareOpenAIId(id: string): string {
  return id.toLowerCase().replace(/^openai\//, '')
}

/**
 * An OpenAI reasoning model: `o<digit>…`, or `gpt-N…` with N ≥ 5 and no `-chat`
 * segment (`gpt-5-chat-latest` is the non-reasoning chat snapshot). Reasoning
 * models reject `stop` and a non-default temperature, and take their system
 * prompt in the `developer` role.
 */
export function isOpenAIReasoningModel(id: string): boolean {
  const bare = bareOpenAIId(id)
  if (/^o\d/.test(bare)) return true
  const m = bare.match(/^gpt-(\d+)/)
  if (!m || Number(m[1]) < 5) return false
  return !/-chat(?:-|$)/.test(bare)
}

/**
 * The cheapest reasoning effort a model accepts: `none` from gpt-5.1 on (and
 * every later major), `minimal` on the original gpt-5 family, `low` for
 * anything else (the o-series). Only meaningful for a reasoning model.
 */
export function lowestReasoningEffort(id: string): 'none' | 'minimal' | 'low' {
  const bare = bareOpenAIId(id)
  const m = bare.match(/^gpt-(\d+)(?:\.(\d+))?/)
  if (m) {
    const major = Number(m[1])
    const minor = m[2] === undefined ? 0 : Number(m[2])
    if (major >= 6) return 'none'
    if (major === 5) return minor >= 1 ? 'none' : 'minimal'
  }
  return 'low'
}

/**
 * Derive a route's caps. `flags.reasoning` is the engine catalog's reasoning
 * bit for the model (the resolver supplies it; only OpenRouter reads it — the
 * OpenAI routes recognise their reasoning models by id).
 */
export function capsFor(
  kind: JudgeRouteKind,
  model: string,
  flags: { reasoning?: boolean } = {}
): JudgeCaps {
  switch (kind) {
    case 'chatgpt':
      // The Codex backend rejects `max_output_tokens` at any value and its own
      // request type has no stop or temperature (ADR-081 §4): the cap and the
      // stop sequence are enforced client-side only.
      return {
        outputCap: 'none',
        supportsStop: false,
        temperature: null,
        systemChannel: 'instructions',
        promptCacheKey: true,
        cacheMarkerOnSystem: false,
        affinityHeader: 'session-id',
        extraBody: {
          store: false,
          include: ['reasoning.encrypted_content'],
          text: { verbosity: 'low' }
        },
        reasoning: {
          fast: { reasoning: { effort: lowestReasoningEffort(model) } },
          thinking: { reasoning: { effort: 'low' } }
        }
      }

    case 'openai': {
      // Caps are per ROUTE, not per stage: OpenAI accepts a temperature on a
      // reasoning model only at effort `none`, which stage 2 never uses, so a
      // reasoning model gets none at all.
      const reasoning = isOpenAIReasoningModel(model)
      return {
        outputCap: 'max_completion_tokens',
        supportsStop: !reasoning,
        temperature: reasoning ? null : 0,
        systemChannel: reasoning ? 'developer' : 'system',
        promptCacheKey: true,
        cacheMarkerOnSystem: false,
        affinityHeader: null,
        extraBody: { store: false, stream_options: { include_usage: true } },
        reasoning: reasoning
          ? {
              fast: { reasoning_effort: lowestReasoningEffort(model) },
              thinking: { reasoning_effort: 'low' }
            }
          : { fast: {}, thinking: {} }
      }
    }

    case 'openrouter': {
      // A reasoning model left to reason spends the whole budget thinking and
      // returns empty text (observed on the retired opencode-fork judge path) —
      // switch it off.
      const off = flags.reasoning ? { reasoning: { enabled: false } } : {}
      return {
        outputCap: 'max_tokens',
        supportsStop: true,
        temperature: /claude|anthropic/i.test(model) ? null : 0,
        systemChannel: 'system',
        promptCacheKey: false,
        cacheMarkerOnSystem: model.startsWith('anthropic/'),
        affinityHeader: 'x-session-id',
        extraBody: { usage: { include: true }, stream_options: { include_usage: true } },
        reasoning: { fast: off, thinking: off }
      }
    }

    case 'custom-chat':
      return {
        outputCap: 'max_tokens',
        supportsStop: true,
        temperature: 0,
        systemChannel: 'system',
        promptCacheKey: false,
        cacheMarkerOnSystem: false,
        affinityHeader: null,
        extraBody: { stream_options: { include_usage: true } },
        reasoning: { fast: {}, thinking: {} }
      }

    case 'custom-responses':
      return {
        outputCap: 'max_output_tokens',
        supportsStop: false,
        temperature: null,
        systemChannel: 'instructions',
        promptCacheKey: true,
        cacheMarkerOnSystem: false,
        affinityHeader: null,
        extraBody: { store: false },
        reasoning: { fast: {}, thinking: {} }
      }
  }
}

/**
 * The reasoning fields for one stage. A request without a stage (a caller other
 * than `classify()`, which always sets one) gets the `thinking` fields: the
 * stronger setting is the safer default for a security judge.
 */
export function reasoningFields(
  caps: JudgeCaps,
  stage: 'fast' | 'thinking' | undefined
): Readonly<Record<string, unknown>> {
  return caps.reasoning[stage ?? 'thinking']
}

/**
 * The output cap a body sends, before the caps decide whether it is sent at
 * all: the request's `maxTokens`, clamped to the route's catalog ceiling when
 * both are known. No `maxTokens`, no cap — the ceiling alone never adds one.
 */
export function outputCapValue(
  route: Pick<ResolvedJudgeRoute, 'maxOutputTokens'>,
  req: Pick<JudgeRequest, 'maxTokens'>
): number | undefined {
  if (req.maxTokens === undefined || route.maxOutputTokens === undefined) return req.maxTokens
  return Math.min(req.maxTokens, route.maxOutputTokens)
}

/**
 * The value of both `prompt_cache_key` and the affinity header: `judge-` + the
 * first 32 hex of SHA-256(system prompt). Derived from the policy prompt alone,
 * so every call in a session (and both stages) lands on the same cache entry.
 */
export function judgeCacheKey(system: string): string {
  return `judge-${createHash('sha256').update(system).digest('hex').slice(0, 32)}`
}
