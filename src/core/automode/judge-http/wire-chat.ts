/**
 * The chat-completions wire (`POST …/chat/completions`, streamed) for the
 * OpenAI API-key, OpenRouter and custom `openai-completions` routes
 * (ADR-081 §4).
 *
 * The body's field ORDER is fixed by the object literal below, so everything
 * ahead of the user turn serializes byte-identically across calls: no
 * timestamps, no request ids.
 */

import type { JudgeRequest } from '../classifier'
import { judgeCacheKey, reasoningFields } from './caps'
import type { SseFrame } from './sse'
import {
  JudgeTextAccumulator,
  count,
  isRecord,
  JUDGE_STREAM_TRUNCATED_MESSAGE,
  parseFrameObject,
  providerError
} from './stream-text'
import {
  JudgeWireError,
  type JudgeStreamOptions,
  type JudgeStreamResult,
  type JudgeUsageSample,
  type ResolvedJudgeRoute
} from './types'

/**
 * `{model, messages, stream, ...extraBody, ...reasoning[stage], <cap>, <stop>,
 * <temperature>, <prompt_cache_key>}`.
 *
 * - The system prompt goes in the `developer` role when the caps say so
 *   (OpenAI reasoning models), otherwise `system`. With `cacheMarkerOnSystem`
 *   it becomes one text part carrying `cache_control` (Anthropic via
 *   OpenRouter caches only what is marked).
 * - The cap is sent under the caps' field name only when the request has one.
 * - `stop` only when the route accepts it and the request has any; otherwise
 *   the reader still enforces it client-side.
 */
export function buildChatBody(
  route: ResolvedJudgeRoute,
  req: JudgeRequest
): Record<string, unknown> {
  const { caps } = route
  const systemContent = caps.cacheMarkerOnSystem
    ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
    : req.system
  const body: Record<string, unknown> = {
    model: route.model,
    messages: [
      { role: caps.systemChannel === 'developer' ? 'developer' : 'system', content: systemContent },
      { role: 'user', content: req.user }
    ],
    stream: true,
    ...caps.extraBody,
    ...reasoningFields(caps, req.stage)
  }
  if (
    req.maxTokens !== undefined &&
    (caps.outputCap === 'max_tokens' || caps.outputCap === 'max_completion_tokens')
  ) {
    body[caps.outputCap] = req.maxTokens
  }
  if (caps.supportsStop && req.stopSequences?.length) body.stop = [...req.stopSequences]
  if (caps.temperature !== null) body.temperature = caps.temperature
  if (caps.promptCacheKey) body.prompt_cache_key = judgeCacheKey(req.system)
  return body
}

/** `usage` of a chat chunk → the normalized sample. `cost` is OpenRouter's. */
function chatUsage(u: Record<string, unknown>): JudgeUsageSample {
  const prompt = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : {}
  const completion = isRecord(u.completion_tokens_details) ? u.completion_tokens_details : {}
  return {
    inputTokens: count(u.prompt_tokens),
    cachedInputTokens: count(prompt.cached_tokens),
    outputTokens: count(u.completion_tokens),
    reasoningTokens: count(completion.reasoning_tokens),
    costUsd: typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null
  }
}

/**
 * Read a chat-completions stream to its end (`[DONE]` or EOF).
 *
 * The stream must show that it finished: a `[DONE]`, or a `finish_reason` on
 * some chunk before EOF. A clean EOF with neither is a truncated reply (a
 * dropped connection, a proxy cutting the body) and throws — it must not pass
 * as a finished one. The one exception is the post-stop drain ending early
 * (see `JudgeTextAccumulator.push`): the verdict is already cut and complete.
 *
 * Text comes from `choices[0].delta.content` only — `delta.reasoning*` fields
 * are the model's thinking, not its answer. Usage is taken from whichever chunk
 * carries it (the final one, with `stream_options.include_usage`). A chunk
 * carrying `error` — which can arrive after HTTP 200 — or a `finish_reason` of
 * `error` fails the call.
 */
export async function readChatStream(
  frames: AsyncIterable<SseFrame>,
  opts: JudgeStreamOptions
): Promise<JudgeStreamResult> {
  const acc = new JudgeTextAccumulator(opts)
  let usage: JudgeUsageSample | null = null
  let finishReason: string | null = null
  /** `[DONE]` seen, or the post-stop drain ended the read with the verdict in hand. */
  let ended = false

  for await (const frame of frames) {
    if (frame.data === '[DONE]') {
      ended = true
      break
    }
    const chunk = parseFrameObject(frame.data)
    if (isRecord(chunk.error)) throw providerError('judge stream error', chunk.error)
    if (isRecord(chunk.usage)) {
      usage = chatUsage(chunk.usage)
      opts.onUsageSeen?.(usage)
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
    if (!isRecord(choice)) continue
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
    if (finishReason === 'error') throw new JudgeWireError('judge stream ended with an error')
    const content = isRecord(choice.delta) ? choice.delta.content : undefined
    if (typeof content === 'string' && content !== '' && !acc.push(content)) {
      ended = true
      break
    }
  }

  if (!ended && finishReason === null) throw new JudgeWireError(JUDGE_STREAM_TRUNCATED_MESSAGE)
  return acc.finish(finishReason === 'length' ? 'length' : 'stop', usage)
}
