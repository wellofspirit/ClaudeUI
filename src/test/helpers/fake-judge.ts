/**
 * A stand-in for the auto-mode judge MODEL behind ClaudeUI's HTTP judge
 * transport (ADR-081), for session tests: a resolved route with obviously fake
 * credentials, and a `fetch` that plays the provider — each judge POST's
 * system prompt and user turn go to a callback, whose answer streams back as a
 * chat-completions SSE reply with a usage chunk.
 *
 * The session tests mock `pickJudgeFetch` to return this fetch and
 * `resolveJudgeRoute` to return {@link fakeJudgeRoute}, so the REAL transport,
 * wire reader and classifier run end to end without a network.
 */
import { capsFor } from '../../core/automode/judge-http/caps'
import type {
  JudgeRouteAccount,
  JudgeUsageSample,
  ResolvedJudgeRoute
} from '../../core/automode/judge-http/types'

export const FAKE_JUDGE_KEY = 'sk-test-session-judge-000000000000'

export const FAKE_JUDGE_ACCOUNT: JudgeRouteAccount = {
  vendorId: 'judge-vendor',
  accountId: null,
  accountKey: 'judge-vendor:key:0000000000000000',
  accountLabel: 'judge-vendor key …0000',
  billingType: 'apiKey'
}

/** The usage every fake reply reports unless the test says otherwise. */
export const FAKE_JUDGE_USAGE = {
  prompt_tokens: 1200,
  prompt_tokens_details: { cached_tokens: 1000 },
  completion_tokens: 7,
  completion_tokens_details: { reasoning_tokens: 0 }
} as const

/** The sample the transport derives from {@link FAKE_JUDGE_USAGE}. */
export const FAKE_JUDGE_SAMPLE: JudgeUsageSample = {
  inputTokens: 1200,
  cachedInputTokens: 1000,
  outputTokens: 7,
  reasoningTokens: 0,
  costUsd: null
}

/** A `custom-chat` route to a fake endpoint, as the resolver would build one. */
export function fakeJudgeRoute(model = 'judge-model'): ResolvedJudgeRoute {
  return {
    kind: 'custom-chat',
    wire: 'chat',
    url: 'https://judge.test/v1/chat/completions',
    model,
    headers: { Authorization: `Bearer ${FAKE_JUDGE_KEY}` },
    caps: capsFor('custom-chat', model),
    label: `judge-vendor · ${model}`,
    account: FAKE_JUDGE_ACCOUNT
  }
}

/** What the fake provider was sent on one judge call. */
export interface FakeJudgeCall {
  system: string
  user: string
  body: Record<string, unknown>
}

/** A string is the model's reply text; a `Response` is sent back as is (error shapes). */
export type FakeJudgeReply = string | Response

/** One chat-completions SSE reply: the text, a stop, the usage chunk, `[DONE]`. */
export function judgeSseResponse(text: string, usage: unknown = FAKE_JUDGE_USAGE): Response {
  const frames = [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage }
  ]
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * A `fetch` that answers every judge POST through `reply`. The request's chat
 * body is decoded so a test can assert what the judge was shown; the
 * credential header never reaches the callback.
 */
export function fakeJudgeFetch(
  reply: (call: FakeJudgeCall) => FakeJudgeReply | Promise<FakeJudgeReply>
): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>
    const call: FakeJudgeCall = {
      system: String(messages.find((m) => m.role !== 'user')?.content ?? ''),
      user: String(messages.find((m) => m.role === 'user')?.content ?? ''),
      body
    }
    const answer = await reply(call)
    return typeof answer === 'string' ? judgeSseResponse(answer) : answer
  }) as typeof fetch
}
