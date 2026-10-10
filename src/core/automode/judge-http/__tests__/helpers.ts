/**
 * Shared fixtures for the judge-http tests: routes with obviously fake
 * credentials, SSE bodies, and frame builders for both wires.
 */
import { capsFor, wireForKind } from '../caps'
import { readSseFrames, type SseFrame } from '../sse'
import type { JudgeRouteKind, ResolvedJudgeRoute } from '../types'

export const FAKE_KEY = 'sk-test-0000000000000000000000'

/** A credential-free account every fixture route is billed to. */
export const FAKE_ACCOUNT: ResolvedJudgeRoute['account'] = {
  vendorId: 'test-vendor',
  accountId: null,
  accountKey: 'test-vendor:key:0000000000000000',
  accountLabel: 'test-vendor key …0000',
  billingType: 'apiKey'
}

export function routeFor(
  kind: JudgeRouteKind,
  model: string,
  opts: {
    reasoning?: boolean
    headers?: Record<string, string>
    url?: string
    reauthorize?: ResolvedJudgeRoute['reauthorize']
    maxOutputTokens?: number
  } = {}
): ResolvedJudgeRoute {
  const wire = wireForKind(kind)
  return {
    kind,
    wire,
    url:
      opts.url ??
      (wire === 'chat'
        ? 'https://judge.test/v1/chat/completions'
        : 'https://judge.test/v1/responses'),
    model,
    headers: opts.headers ?? { Authorization: `Bearer ${FAKE_KEY}` },
    caps: capsFor(kind, model, { reasoning: opts.reasoning }),
    label: `${kind} · ${model}`,
    account: FAKE_ACCOUNT,
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.reauthorize ? { reauthorize: opts.reauthorize } : {})
  }
}

/** A body delivering exactly these chunks, UTF-8 encoded. */
export function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) controller.close()
      else controller.enqueue(enc.encode(chunks[i++]))
    }
  })
}

export function framesOf(chunks: string[]): AsyncGenerator<SseFrame, void, undefined> {
  return readSseFrames(sseStream(chunks))
}

/** One chat-completions `data:` frame. */
export const chat = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
export const CHAT_DONE = 'data: [DONE]\n\n'
export const chatDelta = (content: string): string =>
  chat({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
export const chatFinish = (reason: string): string =>
  chat({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })

/** One Responses frame, with the `event:` line mirroring the payload's `type`. */
export const resp = (obj: { type: string } & Record<string, unknown>): string =>
  `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`
export const respDelta = (delta: string): string =>
  resp({ type: 'response.output_text.delta', delta })
