/**
 * ClaudeUI's own auto-mode judge transport (ADR-081): the opencode and pi
 * judge's one model call, made directly over HTTP. See `./types.ts` for the
 * contract the route resolver and the session wiring build on.
 */

export * from './types'
export {
  capsFor,
  isOpenAIReasoningModel,
  judgeCacheKey,
  lowestReasoningEffort,
  reasoningFields,
  wireForKind
} from './caps'
export { readSseFrames, type SseFrame } from './sse'
export { buildChatBody, readChatStream } from './wire-chat'
export { buildResponsesBody, readResponsesStream } from './wire-responses'
export { pickJudgeFetch } from './net'
export {
  JUDGE_BUDGET_EXHAUSTED_MESSAGE,
  JUDGE_EMPTY_REPLY_MESSAGE,
  JUDGE_OVER_BUDGET_MESSAGE,
  JUDGE_STREAM_TRUNCATED_MESSAGE
} from './stream-text'
export {
  JudgeRouteUnavailableError,
  makeHttpJudgeTransport,
  type HttpJudgeTransportOptions
} from './transport'
