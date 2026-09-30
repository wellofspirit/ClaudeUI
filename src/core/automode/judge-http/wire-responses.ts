/**
 * The Responses wire (`POST …/responses`, streamed) for the ChatGPT
 * subscription route and custom `openai-responses` endpoints (ADR-081 §4).
 *
 * The ChatGPT backend must stream, rejects `max_output_tokens` at any value,
 * and takes no `stop` or `temperature` — so on that route the stage budget and
 * the stop sequence exist only client-side, in the reader.
 */

import type { JudgeRequest } from '../classifier'
import { judgeCacheKey, outputCapValue, reasoningFields } from './caps'
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
 * `{model, instructions, input, stream, ...extraBody, ...reasoning[stage],
 * <max_output_tokens>, <temperature>, <prompt_cache_key>}`.
 *
 * `instructions` is the system prompt verbatim. `max_output_tokens` only when
 * the caps name it (never on ChatGPT), clamped to the route's catalog ceiling. The Responses API has no `stop`, so it is
 * never sent here, whatever the caps say.
 */
export function buildResponsesBody(
  route: ResolvedJudgeRoute,
  req: JudgeRequest
): Record<string, unknown> {
  const { caps } = route
  const body: Record<string, unknown> = {
    model: route.model,
    instructions: req.system,
    input: [{ role: 'user', content: [{ type: 'input_text', text: req.user }] }],
    stream: true,
    ...caps.extraBody,
    ...reasoningFields(caps, req.stage)
  }
  const cap = outputCapValue(route, req)
  if (cap !== undefined && caps.outputCap === 'max_output_tokens') body.max_output_tokens = cap
  if (caps.temperature !== null) body.temperature = caps.temperature
  if (caps.promptCacheKey) body.prompt_cache_key = judgeCacheKey(req.system)
  return body
}

/** `response.usage` → the normalized sample. The Responses API reports no cost. */
function responsesUsage(u: Record<string, unknown>): JudgeUsageSample {
  const input = isRecord(u.input_tokens_details) ? u.input_tokens_details : {}
  const output = isRecord(u.output_tokens_details) ? u.output_tokens_details : {}
  return {
    inputTokens: count(u.input_tokens),
    cachedInputTokens: count(input.cached_tokens),
    outputTokens: count(u.output_tokens),
    reasoningTokens: count(output.reasoning_tokens),
    costUsd: null
  }
}

/**
 * Read a Responses stream up to its terminal event.
 *
 * - Text: `response.output_text.delta` only (reasoning summaries and every
 *   other item event are ignored).
 * - Terminal: `response.completed` / `response.done`, or `response.incomplete`
 *   — which is a length stop when `incomplete_details.reason` is
 *   `max_output_tokens`, and an error for any other reason.
 * - Errors: `response.failed` (`response.error`) and `error` (its fields at the
 *   top level, or nested under `error`) — both can follow an HTTP 200.
 * - EOF before a terminal event is an error: the answer may be cut short.
 *
 * The event type is read from the payload's `type`, falling back to the frame's
 * `event:` line. `[DONE]` is ignored.
 */
export async function readResponsesStream(
  frames: AsyncIterable<SseFrame>,
  opts: JudgeStreamOptions
): Promise<JudgeStreamResult> {
  const acc = new JudgeTextAccumulator(opts)
  let usage: JudgeUsageSample | null = null
  const captureUsage = (ev: Record<string, unknown>): void => {
    const response = isRecord(ev.response) ? ev.response : {}
    if (!isRecord(response.usage)) return
    usage = responsesUsage(response.usage)
    opts.onUsageSeen?.(usage)
  }

  for await (const frame of frames) {
    if (frame.data === '[DONE]') continue
    const ev = parseFrameObject(frame.data)
    const type = typeof ev.type === 'string' ? ev.type : frame.event
    switch (type) {
      case 'response.output_text.delta':
        if (typeof ev.delta === 'string' && ev.delta !== '' && !acc.push(ev.delta)) {
          return acc.finish('stop', usage)
        }
        break
      case 'response.completed':
      case 'response.done':
        captureUsage(ev)
        return acc.finish('stop', usage)
      case 'response.incomplete': {
        captureUsage(ev)
        const response = isRecord(ev.response) ? ev.response : {}
        const details = isRecord(response.incomplete_details) ? response.incomplete_details : {}
        if (details.reason === 'max_output_tokens') return acc.finish('length', usage)
        throw new JudgeWireError(
          `response incomplete: ${typeof details.reason === 'string' ? details.reason : 'unknown reason'}`
        )
      }
      case 'response.failed': {
        captureUsage(ev)
        const response = isRecord(ev.response) ? ev.response : {}
        throw providerError('response failed', isRecord(response.error) ? response.error : {})
      }
      case 'error':
        // The top-level form's own `type` is the event name, not an error type.
        throw providerError(
          'judge stream error',
          isRecord(ev.error) ? ev.error : { code: ev.code, message: ev.message }
        )
    }
  }

  throw new JudgeWireError(JUDGE_STREAM_TRUNCATED_MESSAGE)
}
