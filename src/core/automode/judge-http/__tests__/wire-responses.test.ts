/**
 * The Responses wire: exact request bodies for the ChatGPT backend and custom
 * endpoints, and every terminal / failure shape of the stream.
 */
import { describe, it, expect, vi } from 'vitest'
import { judgeCacheKey } from '../caps'
import {
  JUDGE_BUDGET_EXHAUSTED_MESSAGE,
  JUDGE_EMPTY_REPLY_MESSAGE,
  JUDGE_OVER_BUDGET_MESSAGE
} from '../stream-text'
import { JudgeWireError } from '../types'
import { buildResponsesBody, readResponsesStream } from '../wire-responses'
import { framesOf, resp, respDelta, routeFor } from './helpers'

const SYSTEM = 'POLICY — the whole judge system prompt\n  with its whitespace kept  '
const USER = 'transcript + proposed action + instruction'
const STAGE1 = {
  system: SYSTEM,
  user: USER,
  maxTokens: 64,
  stopSequences: ['</block>'],
  stage: 'fast' as const
}

const USAGE = {
  input_tokens: 9000,
  input_tokens_details: { cached_tokens: 8800 },
  output_tokens: 40,
  output_tokens_details: { reasoning_tokens: 32 },
  total_tokens: 9040
}
const completed = (usage: unknown = USAGE): string =>
  resp({ type: 'response.completed', response: { status: 'completed', usage } })

describe('buildResponsesBody', () => {
  it('chatgpt: no cap / stop / temperature, instructions verbatim, cache key', () => {
    expect(buildResponsesBody(routeFor('chatgpt', 'gpt-5.1-codex-mini'), STAGE1)).toEqual({
      model: 'gpt-5.1-codex-mini',
      instructions: SYSTEM,
      input: [{ role: 'user', content: [{ type: 'input_text', text: USER }] }],
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      text: { verbosity: 'low' },
      reasoning: { effort: 'none' },
      prompt_cache_key: judgeCacheKey(SYSTEM)
    })
  })

  it('chatgpt stage 2 asks for low effort', () => {
    const body = buildResponsesBody(routeFor('chatgpt', 'gpt-5.1-codex-mini'), {
      system: SYSTEM,
      user: USER,
      maxTokens: 8192,
      stage: 'thinking'
    })
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect(body).not.toHaveProperty('max_output_tokens')
  })

  it('custom-responses: max_output_tokens, still no stop or temperature', () => {
    expect(buildResponsesBody(routeFor('custom-responses', 'gpt-5-mini'), STAGE1)).toEqual({
      model: 'gpt-5-mini',
      instructions: SYSTEM,
      input: [{ role: 'user', content: [{ type: 'input_text', text: USER }] }],
      stream: true,
      store: false,
      max_output_tokens: 64,
      prompt_cache_key: judgeCacheKey(SYSTEM)
    })
  })

  it('serializes byte-identically across two calls that differ only in the user turn', () => {
    const route = routeFor('chatgpt', 'gpt-5.1-codex-mini')
    const a = JSON.stringify(buildResponsesBody(route, { ...STAGE1, user: 'FIRST-USER-TURN' }))
    const b = JSON.stringify(buildResponsesBody(route, { ...STAGE1, user: 'SECOND-USER-TURN' }))
    const [aHead, aTail] = a.split('FIRST-USER-TURN')
    const [bHead, bTail] = b.split('SECOND-USER-TURN')
    expect(aHead).toBe(bHead)
    expect(aTail).toBe(bTail)
  })
})

describe('readResponsesStream', () => {
  const opts = { maxChars: 10_000 }

  it('accumulates output_text deltas, ignores other events, maps usage at completion', async () => {
    const out = await readResponsesStream(
      framesOf([
        resp({ type: 'response.created', response: { status: 'in_progress' } }),
        resp({ type: 'response.reasoning_summary_text.delta', delta: 'NOT THE ANSWER' }),
        respDelta('<block>'),
        respDelta('no</block>'),
        resp({ type: 'response.output_text.done', text: '<block>no</block>' }),
        completed()
      ]),
      opts
    )
    expect(out).toEqual({
      text: '<block>no</block>',
      finish: 'stop',
      usage: {
        inputTokens: 9000,
        cachedInputTokens: 8800,
        outputTokens: 40,
        reasoningTokens: 32,
        costUsd: null
      }
    })
  })

  it('response.done is terminal too, and [DONE] is ignored', async () => {
    const out = await readResponsesStream(
      framesOf([
        respDelta('<block>no'),
        'data: [DONE]\n\n',
        resp({ type: 'response.done', response: { usage: USAGE } })
      ]),
      opts
    )
    expect(out.text).toBe('<block>no')
    expect(out.usage?.inputTokens).toBe(9000)
  })

  it('falls back to the event: line when the payload has no type', async () => {
    const out = await readResponsesStream(
      framesOf([
        'event: response.output_text.delta\ndata: {"delta":"<block>no"}\n\n',
        'event: response.completed\ndata: {"response":{}}\n\n'
      ]),
      opts
    )
    expect(out).toEqual({ text: '<block>no', finish: 'stop', usage: null })
  })

  it('client-side stop: cut at the stop string, keep reading to completion for the usage', async () => {
    const onUsageSeen = vi.fn()
    const out = await readResponsesStream(
      framesOf([respDelta('<block>no</blo'), respDelta('ck> and then more'), completed()]),
      { ...opts, stopSequences: ['</block>'], onUsageSeen }
    )
    expect(out.text).toBe('<block>no')
    expect(out.usage?.outputTokens).toBe(40)
    expect(onUsageSeen).toHaveBeenCalledTimes(1)
  })

  it('response.failed throws with the error code and message, after capturing usage', async () => {
    const onUsageSeen = vi.fn()
    const err = await readResponsesStream(
      framesOf([
        respDelta('<block>'),
        resp({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: { code: 'server_error', message: 'The model failed' },
            usage: USAGE
          }
        })
      ]),
      { ...opts, onUsageSeen }
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JudgeWireError)
    expect((err as JudgeWireError).message).toBe('response failed (server_error): The model failed')
    expect((err as JudgeWireError).code).toBe('server_error')
    expect(onUsageSeen).toHaveBeenCalledTimes(1)
  })

  it('a top-level error event throws (can follow HTTP 200)', async () => {
    await expect(
      readResponsesStream(
        framesOf([
          respDelta('<block>'),
          resp({ type: 'error', code: 'rate_limit_exceeded', message: 'Slow down' })
        ]),
        opts
      )
    ).rejects.toThrow('judge stream error (rate_limit_exceeded): Slow down')
  })

  it('a nested error event throws, taking the code from error.type when code is absent', async () => {
    const err = await readResponsesStream(
      framesOf([
        resp({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Unsupported parameter' }
        })
      ]),
      opts
    ).catch((e: unknown) => e)
    expect((err as Error).message).toBe(
      'judge stream error (invalid_request_error): Unsupported parameter'
    )
    // No code at all: no parenthetical, and the event's own type is not one.
    await expect(
      readResponsesStream(framesOf([resp({ type: 'error', message: 'boom' })]), opts)
    ).rejects.toThrow(/^judge stream error: boom$/)
  })

  it('response.incomplete for max_output_tokens is a length stop', async () => {
    const out = await readResponsesStream(
      framesOf([
        respDelta('<block>yes'),
        resp({
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' }, usage: USAGE }
        })
      ]),
      opts
    )
    expect(out).toMatchObject({ text: '<block>yes', finish: 'length' })
    expect(out.usage?.inputTokens).toBe(9000)
  })

  it('response.incomplete for max_output_tokens with no text → the budget message', async () => {
    await expect(
      readResponsesStream(
        framesOf([
          resp({
            type: 'response.incomplete',
            response: { incomplete_details: { reason: 'max_output_tokens' } }
          })
        ]),
        opts
      )
    ).rejects.toThrow(JUDGE_BUDGET_EXHAUSTED_MESSAGE)
  })

  it('response.incomplete for any other reason is an error', async () => {
    await expect(
      readResponsesStream(
        framesOf([
          respDelta('<block>no'),
          resp({
            type: 'response.incomplete',
            response: { incomplete_details: { reason: 'content_filter' } }
          })
        ]),
        opts
      )
    ).rejects.toThrow('response incomplete: content_filter')
  })

  it('EOF without a terminal event is an error, even with text in hand', async () => {
    await expect(
      readResponsesStream(framesOf([respDelta('<block>no</block>')]), opts)
    ).rejects.toThrow('stream ended before the response completed')
  })

  it('completion with no text → empty judge reply', async () => {
    await expect(readResponsesStream(framesOf([completed()]), opts)).rejects.toThrow(
      JUDGE_EMPTY_REPLY_MESSAGE
    )
  })

  it('text past maxChars aborts the call', async () => {
    await expect(
      readResponsesStream(framesOf([respDelta('x'.repeat(11)), completed()]), { maxChars: 10 })
    ).rejects.toThrow(JUDGE_OVER_BUDGET_MESSAGE)
  })

  it('after the stop cut, a runaway tail ends the read with the verdict in hand', async () => {
    const out = await readResponsesStream(
      framesOf([respDelta('<block>no</block>'), respDelta('z'.repeat(20)), completed()]),
      { maxChars: 12, stopSequences: ['</block>'] }
    )
    expect(out).toEqual({ text: '<block>no', finish: 'stop', usage: null })
  })
})
