/**
 * The chat-completions wire: exact request bodies per route kind, and the
 * stream reader's success and failure shapes.
 */
import { describe, it, expect, vi } from 'vitest'
import { judgeCacheKey } from '../caps'
import {
  JUDGE_BUDGET_EXHAUSTED_MESSAGE,
  JUDGE_EMPTY_REPLY_MESSAGE,
  JUDGE_OVER_BUDGET_MESSAGE,
  JUDGE_STREAM_TRUNCATED_MESSAGE
} from '../stream-text'
import { JudgeWireError } from '../types'
import { buildChatBody, readChatStream } from '../wire-chat'
import { CHAT_DONE, chat, chatDelta, chatFinish, framesOf, routeFor } from './helpers'

const SYSTEM = 'POLICY — the whole judge system prompt'
const USER = 'transcript + proposed action + instruction'
const STAGE1 = {
  system: SYSTEM,
  user: USER,
  maxTokens: 64,
  stopSequences: ['</block>'],
  stage: 'fast' as const
}
const STAGE2 = { system: SYSTEM, user: USER, maxTokens: 8192, stage: 'thinking' as const }

describe('buildChatBody', () => {
  it('openai reasoning model: developer role, max_completion_tokens, no stop, no temperature', () => {
    const body = buildChatBody(routeFor('openai', 'gpt-5-mini'), STAGE1)
    expect(body).toEqual({
      model: 'gpt-5-mini',
      messages: [
        { role: 'developer', content: SYSTEM },
        { role: 'user', content: USER }
      ],
      stream: true,
      store: false,
      stream_options: { include_usage: true },
      reasoning_effort: 'minimal',
      max_completion_tokens: 64,
      prompt_cache_key: judgeCacheKey(SYSTEM)
    })
    // Stage 2 changes only the stage-dependent fields.
    expect(buildChatBody(routeFor('openai', 'gpt-5-mini'), STAGE2)).toMatchObject({
      reasoning_effort: 'low',
      max_completion_tokens: 8192
    })
  })

  it('openai non-reasoning model: system role, stop, temperature 0', () => {
    expect(buildChatBody(routeFor('openai', 'gpt-4.1-mini'), STAGE1)).toEqual({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER }
      ],
      stream: true,
      store: false,
      stream_options: { include_usage: true },
      max_completion_tokens: 64,
      stop: ['</block>'],
      temperature: 0,
      prompt_cache_key: judgeCacheKey(SYSTEM)
    })
  })

  it('openrouter anthropic/*: cache_control on the system part, max_tokens, no temperature', () => {
    expect(buildChatBody(routeFor('openrouter', 'anthropic/claude-haiku-4.5'), STAGE1)).toEqual({
      model: 'anthropic/claude-haiku-4.5',
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }]
        },
        { role: 'user', content: USER }
      ],
      stream: true,
      usage: { include: true },
      stream_options: { include_usage: true },
      max_tokens: 64,
      stop: ['</block>']
    })
  })

  it('openrouter reasoning model: reasoning switched off on both stages, temperature 0', () => {
    const route = routeFor('openrouter', 'z-ai/glm-4.6', { reasoning: true })
    expect(buildChatBody(route, STAGE2)).toEqual({
      model: 'z-ai/glm-4.6',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER }
      ],
      stream: true,
      usage: { include: true },
      stream_options: { include_usage: true },
      reasoning: { enabled: false },
      max_tokens: 8192,
      temperature: 0
    })
    expect(buildChatBody(route, STAGE1).reasoning).toEqual({ enabled: false })
  })

  it('custom-chat: max_tokens, stop, temperature 0, no cache fields', () => {
    expect(buildChatBody(routeFor('custom-chat', 'local-model'), STAGE1)).toEqual({
      model: 'local-model',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER }
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
      stop: ['</block>'],
      temperature: 0
    })
  })

  it('omits the cap without maxTokens and stop without stop sequences', () => {
    const route = routeFor('custom-chat', 'local-model')
    const body = buildChatBody(route, { system: SYSTEM, user: USER, stopSequences: [] })
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('stop')
  })

  it('does not alias the request stop array', () => {
    const req = { ...STAGE1, stopSequences: ['</block>'] }
    const body = buildChatBody(routeFor('custom-chat', 'm'), req)
    expect(body.stop).toEqual(req.stopSequences)
    expect(body.stop).not.toBe(req.stopSequences)
  })

  it('field order is fixed: model, messages, stream, extras, reasoning, cap, stop, temperature, key', () => {
    const body = buildChatBody(routeFor('openai', 'gpt-4.1-mini'), STAGE1)
    expect(Object.keys(body)).toEqual([
      'model',
      'messages',
      'stream',
      'store',
      'stream_options',
      'max_completion_tokens',
      'stop',
      'temperature',
      'prompt_cache_key'
    ])
  })

  it('serializes byte-identically across two calls that differ only in the user turn', () => {
    const route = routeFor('openrouter', 'anthropic/claude-haiku-4.5')
    const a = JSON.stringify(buildChatBody(route, { ...STAGE1, user: 'FIRST-USER-TURN' }))
    const b = JSON.stringify(buildChatBody(route, { ...STAGE1, user: 'SECOND-USER-TURN' }))
    const [aHead, aTail] = a.split('FIRST-USER-TURN')
    const [bHead, bTail] = b.split('SECOND-USER-TURN')
    expect(aHead).toBe(bHead)
    expect(aTail).toBe(bTail)
    // …and the system prompt sits in the stable prefix.
    expect(aHead).toContain(SYSTEM)
  })
})

describe('readChatStream', () => {
  const opts = { maxChars: 10_000 }

  it('accumulates content deltas and maps usage (cost included)', async () => {
    const out = await readChatStream(
      framesOf([
        ': OPENROUTER PROCESSING\n\n',
        chatDelta('<block>'),
        chatDelta('no</block>'),
        chatFinish('stop'),
        chat({
          choices: [],
          usage: {
            prompt_tokens: 1200,
            prompt_tokens_details: { cached_tokens: 1000 },
            completion_tokens: 30,
            completion_tokens_details: { reasoning_tokens: 20 },
            cost: 0.00042
          }
        }),
        CHAT_DONE
      ]),
      opts
    )
    expect(out).toEqual({
      text: '<block>no</block>',
      finish: 'stop',
      usage: {
        inputTokens: 1200,
        cachedInputTokens: 1000,
        outputTokens: 30,
        reasoningTokens: 20,
        costUsd: 0.00042
      }
    })
  })

  it('missing usage detail fields read as 0 and a missing cost as null', async () => {
    const out = await readChatStream(
      framesOf([
        chatDelta('x'),
        chat({ usage: { prompt_tokens: 5, completion_tokens: 1 } }),
        CHAT_DONE
      ]),
      opts
    )
    expect(out.usage).toEqual({
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      costUsd: null
    })
  })

  it('ignores reasoning deltas — only content is the answer', async () => {
    const out = await readChatStream(
      framesOf([
        chat({ choices: [{ delta: { reasoning: 'thinking hard', reasoning_content: 'more' } }] }),
        chatDelta('<block>no</block>'),
        CHAT_DONE
      ]),
      opts
    )
    expect(out.text).toBe('<block>no</block>')
  })

  it('cuts at a stop string straddling two deltas, and still reads the usage after it', async () => {
    const onUsageSeen = vi.fn()
    const out = await readChatStream(
      framesOf([
        chatDelta('<block>no</bl'),
        chatDelta('ock><reason>ignored</reason>'),
        chatDelta(' still ignored'),
        chatFinish('stop'),
        chat({ usage: { prompt_tokens: 10, completion_tokens: 9 } }),
        CHAT_DONE
      ]),
      { ...opts, stopSequences: ['</block>'], onUsageSeen }
    )
    expect(out.text).toBe('<block>no')
    expect(out.finish).toBe('stop')
    expect(out.usage).toMatchObject({ inputTokens: 10, outputTokens: 9 })
    expect(onUsageSeen).toHaveBeenCalledWith(out.usage)
  })

  it('cuts at the EARLIEST of several stop strings', async () => {
    const out = await readChatStream(framesOf([chatDelta('abcSTOP2defSTOP1'), CHAT_DONE]), {
      ...opts,
      stopSequences: ['STOP1', 'STOP2']
    })
    expect(out.text).toBe('abc')
  })

  it('an error chunk after HTTP 200 throws with its message and code — after usage was seen', async () => {
    const onUsageSeen = vi.fn()
    const err = await readChatStream(
      framesOf([
        chatDelta('<block>'),
        chat({ usage: { prompt_tokens: 3, completion_tokens: 1 } }),
        chat({
          error: { code: 502, message: 'upstream provider unavailable' },
          choices: [{ delta: {}, finish_reason: 'error' }]
        })
      ]),
      { ...opts, onUsageSeen }
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JudgeWireError)
    expect((err as JudgeWireError).message).toBe(
      'judge stream error (502): upstream provider unavailable'
    )
    expect((err as JudgeWireError).code).toBe('502')
    expect(onUsageSeen).toHaveBeenCalledTimes(1)
  })

  it('a finish_reason of error without an error object still fails', async () => {
    await expect(
      readChatStream(framesOf([chatDelta('<block>no'), chatFinish('error')]), opts)
    ).rejects.toThrow('judge stream ended with an error')
  })

  it('length with no text → the reasoning-ate-the-budget message', async () => {
    await expect(
      readChatStream(
        framesOf([chat({ choices: [{ delta: { reasoning: '…' } }] }), chatFinish('length')]),
        opts
      )
    ).rejects.toThrow(JUDGE_BUDGET_EXHAUSTED_MESSAGE)
  })

  it('no text otherwise → empty judge reply (whitespace counts as empty)', async () => {
    await expect(readChatStream(framesOf([chatFinish('stop'), CHAT_DONE]), opts)).rejects.toThrow(
      JUDGE_EMPTY_REPLY_MESSAGE
    )
    await expect(readChatStream(framesOf([chatDelta('  \n'), CHAT_DONE]), opts)).rejects.toThrow(
      JUDGE_EMPTY_REPLY_MESSAGE
    )
    // A stop string at position 0 leaves nothing either.
    await expect(
      readChatStream(framesOf([chatDelta('</block>'), CHAT_DONE]), {
        ...opts,
        stopSequences: ['</block>']
      })
    ).rejects.toThrow(JUDGE_EMPTY_REPLY_MESSAGE)
  })

  it('length WITH text is returned as a length finish (the classifier parses what it got)', async () => {
    const out = await readChatStream(
      framesOf([chatDelta('<thinking>long'), chatFinish('length'), CHAT_DONE]),
      opts
    )
    expect(out).toMatchObject({ text: '<thinking>long', finish: 'length' })
  })

  it('text past maxChars aborts the call', async () => {
    await expect(
      readChatStream(framesOf([chatDelta('x'.repeat(8)), chatDelta('x'.repeat(8))]), {
        maxChars: 10
      })
    ).rejects.toThrow(JUDGE_OVER_BUDGET_MESSAGE)
  })

  it('after the stop cut, a runaway tail ends the drain instead of throwing', async () => {
    const out = await readChatStream(
      framesOf([
        chatDelta('<block>no</block>'),
        chatDelta('y'.repeat(8)),
        chatDelta('y'.repeat(8)),
        chatDelta('never reached'),
        chat({ usage: { prompt_tokens: 1, completion_tokens: 1 } })
      ]),
      { maxChars: 12, stopSequences: ['</block>'] }
    )
    expect(out).toEqual({ text: '<block>no', finish: 'stop', usage: null })
  })

  it('stops at [DONE] and ignores anything after it', async () => {
    const out = await readChatStream(
      framesOf([chatDelta('<block>no'), CHAT_DONE, 'data: not json\n\n']),
      opts
    )
    expect(out.text).toBe('<block>no')
  })

  it('a finish_reason then EOF (no [DONE]) is a finished reply', async () => {
    const out = await readChatStream(framesOf([chatDelta('<block>no'), chatFinish('stop')]), opts)
    expect(out).toMatchObject({ text: '<block>no', finish: 'stop' })
  })

  it('EOF with neither [DONE] nor a finish_reason is a truncated reply — it throws', async () => {
    // Text in hand, usage even, but nothing says the model finished: a dropped
    // connection must not pass as a complete verdict.
    const err = await readChatStream(
      framesOf([
        chatDelta('<block>no'),
        chat({ usage: { prompt_tokens: 1, completion_tokens: 1 } })
      ]),
      opts
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JudgeWireError)
    expect((err as Error).message).toBe(JUDGE_STREAM_TRUNCATED_MESSAGE)
  })

  it('a malformed frame fails the call', async () => {
    await expect(
      readChatStream(framesOf([chatDelta('x'), 'data: {not json\n\n']), opts)
    ).rejects.toThrow('malformed judge stream frame')
  })
})
