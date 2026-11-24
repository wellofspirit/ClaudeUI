/**
 * @vitest-environment node
 *
 * The three media provider clients against a fake fetch: request shapes, the ChatGPT 401
 * refresh-retry, abort, error truncation and credential masking, plan-usage parsing, the OpenRouter
 * video create/poll/download. No network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatgptInjectionToken } from '../../../auth/vault/CredentialSync'
import { createChatgptPlanProvider } from '../chatgpt-plan'
import { createOpenAiImagesProvider } from '../openai-images'
import { createOpenRouterProvider } from '../openrouter'
import { getPlanUsage, resetPlanUsage } from '../plan-usage'
import { MediaProviderError, type MediaGenerateRequest } from '../types'

const PNG = Buffer.from('89504e470d0a1a0a00', 'hex')
const B64 = PNG.toString('base64')
const SECRET = 'tok-secret-0123456789'

function token(accessToken = SECRET): ChatgptInjectionToken {
  return { accessToken, chatgptAccountId: 'acct-1', chatgptPlanType: null, vaultAccountId: 'v1' }
}

function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers }
  })
}

type Call = { url: string; init: RequestInit }
function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const call = { url: String(input), init }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

function request(over: Partial<MediaGenerateRequest> = {}): MediaGenerateRequest {
  return {
    kind: 'image',
    source: 'chatgpt-plan',
    modelId: 'gpt-image-2',
    prompt: 'a red fox',
    images: [],
    signal: new AbortController().signal,
    ...over
  }
}

const inputImage = { bytes: Buffer.from([1, 2, 3]), mime: 'image/png' }

afterEach(() => resetPlanUsage())

describe('ChatGPT plan provider', () => {
  const make = (f: typeof fetch, tokens: Array<ChatgptInjectionToken | null> = [token()]) => {
    const token = vi.fn(async (force: boolean) => (force ? tokens[1] : tokens[0]) ?? null)
    return {
      token,
      provider: createChatgptPlanProvider({
        fetch: async () => f,
        token,
        appVersion: () => '1.0.0'
      })
    }
  }

  it('posts a generation as JSON with the plan headers and returns the PNG and plan usage', async () => {
    const f = fakeFetch(() =>
      json(
        { data: [{ b64_json: B64, generation_id: 'g' }], size: '1536x1024', quality: 'low' },
        {
          headers: {
            'x-codex-primary-used-percent': '42',
            'x-codex-primary-reset-after-seconds': '3600'
          }
        }
      )
    )
    const { provider } = make(f.fetch)
    const res = await provider.generate(request())
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].url).toBe('https://chatgpt.com/backend-api/codex/images/generations')
    const headers = f.calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^Bearer /)
    expect(headers['ChatGPT-Account-Id']).toBe('acct-1')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      model: 'gpt-image-2',
      prompt: 'a red fox',
      n: 1,
      output_format: 'png'
    })
    expect(res.bytes.equals(PNG)).toBe(true)
    expect(res).toMatchObject({ mime: 'image/png', width: 1536, height: 1024 })
    expect(res.planUsage).toMatchObject({ usedPercent: 42, resetsInSeconds: 3600 })
    expect(getPlanUsage()?.usedPercent).toBe(42)
  })

  it('sends an edit as JSON with data-URL images (never multipart)', async () => {
    const f = fakeFetch(() => json({ data: [{ b64_json: B64 }] }))
    await make(f.fetch).provider.generate(request({ images: [inputImage] }))
    expect(f.calls[0].url).toBe('https://chatgpt.com/backend-api/codex/images/edits')
    expect(typeof f.calls[0].init.body).toBe('string')
    const body = JSON.parse(String(f.calls[0].init.body))
    expect(body.images).toEqual([{ image_url: 'data:image/png;base64,AQID' }])
  })

  it('retries once on a 401 with a force-refreshed token', async () => {
    const f = fakeFetch((_c, n) =>
      n === 0 ? json({ error: 'expired' }, { status: 401 }) : json({ data: [{ b64_json: B64 }] })
    )
    const { provider, token: tokenFn } = make(f.fetch, [
      token('old-token-123456'),
      token('new-token-123456')
    ])
    await provider.generate(request())
    expect(f.calls).toHaveLength(2)
    expect(tokenFn).toHaveBeenNthCalledWith(2, true)
    expect((f.calls[1].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer new-token-123456'
    )
  })

  it('does not retry when the refresh changed nothing, and the error leaks no token', async () => {
    const f = fakeFetch(() => json({ error: `bad ${SECRET}` }, { status: 401 }))
    const { provider } = make(f.fetch, [token(), token()])
    const err = await provider.generate(request()).catch((e: unknown) => e)
    expect(f.calls).toHaveLength(1)
    expect(err).toBeInstanceOf(MediaProviderError)
    expect((err as Error).message).not.toContain(SECRET)
  })

  it('truncates a long provider error and masks the token', async () => {
    const f = fakeFetch(() =>
      json({ error: { message: `${SECRET} ${'x'.repeat(2000)}` } }, { status: 400 })
    )
    const err = (await make(f.fetch)
      .provider.generate(request())
      .catch((e: unknown) => e)) as MediaProviderError
    expect(err.status).toBe(400)
    expect(err.message.length).toBeLessThanOrEqual(600)
    expect(err.message).not.toContain(SECRET)
    expect(err.message).toContain('HTTP 400')
  })

  it('refuses a video request', async () => {
    const f = fakeFetch(() => json({}))
    await expect(make(f.fetch).provider.generate(request({ kind: 'video' }))).rejects.toThrow(
      /images only/
    )
    expect(f.calls).toHaveLength(0)
  })

  it('passes the abort signal to fetch and surfaces the abort unchanged', async () => {
    const ac = new AbortController()
    const f = fakeFetch(async (c) => {
      expect(c.init.signal).toBe(ac.signal)
      ac.abort(new Error('stopped'))
      throw ac.signal.reason
    })
    await expect(make(f.fetch).provider.generate(request({ signal: ac.signal }))).rejects.toThrow(
      'stopped'
    )
  })
})

describe('OpenAI images provider', () => {
  const make = (f: typeof fetch) =>
    createOpenAiImagesProvider({ fetch: async () => f, apiKey: async () => 'sk-test-0123456789' })

  it('posts a generation as JSON with quality and png output', async () => {
    const f = fakeFetch(() => json({ data: [{ b64_json: B64 }], usage: { cost: 0.17 } }))
    const res = await make(f.fetch).generate(
      request({ source: 'openai', modelId: 'gpt-image-2.6', quality: 'medium' })
    )
    expect(f.calls[0].url).toBe('https://api.openai.com/v1/images/generations')
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /)
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      model: 'gpt-image-2.6',
      prompt: 'a red fox',
      n: 1,
      output_format: 'png',
      quality: 'medium'
    })
    expect(res.costUsd).toBe(0.17)
  })

  it('posts an edit as multipart with image[] parts', async () => {
    const f = fakeFetch(() => json({ data: [{ b64_json: B64 }] }))
    await make(f.fetch).generate(
      request({
        source: 'openai',
        modelId: 'gpt-image-2.6',
        quality: 'high',
        images: [inputImage, inputImage]
      })
    )
    expect(f.calls[0].url).toBe('https://api.openai.com/v1/images/edits')
    const form = f.calls[0].init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('gpt-image-2.6')
    expect(form.get('quality')).toBe('high')
    expect(form.getAll('image[]')).toHaveLength(2)
    expect((f.calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('omits output_format and quality for a non-GPT-image model', async () => {
    const f = fakeFetch(() => json({ data: [{ b64_json: B64 }] }))
    await make(f.fetch).generate(
      request({ source: 'openai', modelId: 'dall-e-3', quality: 'high' })
    )
    const body = JSON.parse(String(f.calls[0].init.body))
    expect(body.output_format).toBeUndefined()
    expect(body.quality).toBeUndefined()
  })

  it('masks the key if the provider echoes it', async () => {
    const f = fakeFetch(() =>
      json({ error: { message: 'Incorrect API key: sk-test-0123456789' } }, { status: 401 })
    )
    const err = (await make(f.fetch)
      .generate(request({ source: 'openai', modelId: 'gpt-image-2' }))
      .catch((e: unknown) => e)) as Error
    expect(err.message).not.toContain('sk-test-0123456789')
  })
})

describe('OpenRouter provider', () => {
  const make = (f: typeof fetch) =>
    createOpenRouterProvider({
      fetch: async () => f,
      apiKey: async () => 'or-key-0123456789',
      sleep: async () => {}
    })

  it('generates an image with input_references and attribution headers', async () => {
    const f = fakeFetch(() => json({ data: [{ b64_json: B64 }], usage: { cost: 0.02 } }))
    const res = await make(f.fetch).generate(
      request({ source: 'openrouter', modelId: 'acme/img-1', images: [inputImage] })
    )
    expect(f.calls[0].url).toBe('https://openrouter.ai/api/v1/images/generations')
    const headers = f.calls[0].init.headers as Record<string, string>
    expect(headers['X-Title']).toBe('ClaudeUI')
    expect(headers['HTTP-Referer']).toBeTruthy()
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      model: 'acme/img-1',
      prompt: 'a red fox',
      n: 1,
      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }]
    })
    expect(res).toMatchObject({ mime: 'image/png', costUsd: 0.02 })
  })

  it('creates a video, reports the job id at once, polls, and downloads with the key', async () => {
    const mp4 = Buffer.from('video-bytes')
    const f = fakeFetch((c, n) => {
      if (n === 0) return json({ id: 'job-9', status: 'pending' })
      if (c.url.endsWith('/videos/job-9')) {
        return n === 1
          ? json({ status: 'in_progress' })
          : json({
              status: 'completed',
              unsigned_urls: ['https://openrouter.ai/api/v1/videos/job-9/content?index=0'],
              usage: { cost: 1.5 }
            })
      }
      return new Response(new Uint8Array(mp4), { status: 200 })
    })
    const ids: string[] = []
    const res = await make(f.fetch).generate(
      request({
        kind: 'video',
        source: 'openrouter',
        modelId: 'acme/video-1',
        images: [inputImage, inputImage],
        durationSeconds: 5,
        aspect: '16:9',
        onProviderJobId: (id) => ids.push(id)
      })
    )
    expect(ids).toEqual(['job-9'])
    expect(f.calls[0].url).toBe('https://openrouter.ai/api/v1/videos')
    const body = JSON.parse(String(f.calls[0].init.body))
    expect(body).toMatchObject({
      model: 'acme/video-1',
      duration: 5,
      aspect_ratio: '16:9',
      frame_images: [{ frame_type: 'first_frame' }, { frame_type: 'last_frame' }]
    })
    const download = f.calls[f.calls.length - 1]
    expect((download.init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /)
    expect(res.bytes.equals(mp4)).toBe(true)
    expect(res).toMatchObject({ mime: 'video/mp4', costUsd: 1.5, durationSeconds: 5 })
  })

  it('does not send the key to a download URL on another host', async () => {
    const f = fakeFetch((_c, n) => {
      if (n === 0) return json({ id: 'j' })
      if (n === 1)
        return json({ status: 'completed', unsigned_urls: ['https://cdn.example.com/v.mp4'] })
      return new Response(new Uint8Array([1]), { status: 200 })
    })
    await make(f.fetch).generate(request({ kind: 'video', source: 'openrouter', modelId: 'm' }))
    expect(f.calls[2].init.headers).toBeUndefined()
  })

  it('fails with the provider reason when the video job fails', async () => {
    const f = fakeFetch((_c, n) =>
      n === 0 ? json({ id: 'j' }) : json({ status: 'failed', error: 'content policy' })
    )
    await expect(
      make(f.fetch).generate(request({ kind: 'video', source: 'openrouter', modelId: 'm' }))
    ).rejects.toThrow(/failed: content policy/)
  })

  it('stops polling when aborted', async () => {
    const ac = new AbortController()
    const provider = createOpenRouterProvider({
      fetch: async () => fakeFetch(() => json({ id: 'j' })).fetch,
      apiKey: async () => 'or-key-0123456789',
      sleep: async (_ms, signal) => {
        ac.abort(new Error('stopped'))
        throw signal.reason
      }
    })
    await expect(
      provider.generate(
        request({ kind: 'video', source: 'openrouter', modelId: 'm', signal: ac.signal })
      )
    ).rejects.toThrow('stopped')
  })
})
