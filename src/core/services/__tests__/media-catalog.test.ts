/**
 * @vitest-environment node
 *
 * The media catalog: connected-only listing and model resolution order (explicit → setting →
 * Automatic, Off, needsImages), over injected dependencies.
 */
import { describe, expect, it } from 'vitest'
import type { MediaGenerationSettings } from '../../../shared/media-generation'
import { listMediaModels, resolveMediaModel, type MediaCatalogDeps } from '../media-catalog'
import type { MediaModelRow } from '../opencode-pricing'

const ROWS: MediaModelRow[] = [
  {
    providerId: 'openai',
    id: 'gpt-image-old',
    name: 'GPT Image Old',
    type: 'image',
    acceptsImages: true,
    releaseDate: '2026-01-01'
  },
  {
    providerId: 'openai',
    id: 'gpt-image-new',
    name: 'GPT Image New',
    type: 'image',
    acceptsImages: false,
    releaseDate: '2026-06-01'
  },
  { providerId: 'openai', id: 'sora-x', name: 'Sora', type: 'video', acceptsImages: true },
  {
    providerId: 'openrouter',
    id: 'acme/img',
    name: 'Acme Img',
    type: 'image',
    acceptsImages: true,
    releaseDate: '2026-03-01',
    cost: { input: 0, output: 0 }
  },
  {
    providerId: 'openrouter',
    id: 'acme/vid-old',
    name: 'Vid Old',
    type: 'video',
    acceptsImages: true,
    releaseDate: '2026-02-01'
  },
  {
    providerId: 'openrouter',
    id: 'acme/vid-new',
    name: 'Vid New',
    type: 'video',
    acceptsImages: false,
    releaseDate: '2026-04-01'
  }
]

function deps(
  over: {
    chatgpt?: boolean
    keys?: Array<'openai' | 'openrouter'>
    disabled?: Array<'openai' | 'openrouter'>
    setting?: Partial<MediaGenerationSettings> | unknown
  } = {}
): MediaCatalogDeps {
  return {
    chatgptConnected: async () => over.chatgpt ?? false,
    hasApiKey: async (id) => (over.keys ?? []).includes(id),
    providerEnabled: (id) => !(over.disabled ?? []).includes(id),
    mediaRows: () => ROWS,
    setting: () => over.setting
  }
}

const refs = async (d: MediaCatalogDeps): Promise<string[]> =>
  (await listMediaModels(d)).models.map((m) => m.ref)

describe('listMediaModels', () => {
  it('lists nothing when nothing is connected', async () => {
    const c = await listMediaModels(deps())
    expect(c.models).toEqual([])
    expect(c.connected).toEqual({ 'chatgpt-plan': false, openai: false, openrouter: false })
  })

  it('lists the ChatGPT Plan entry only when signed in', async () => {
    const c = await listMediaModels(deps({ chatgpt: true }))
    expect(c.models).toEqual([
      {
        ref: 'chatgpt-plan',
        kind: 'image',
        source: 'chatgpt-plan',
        name: 'ChatGPT Plan',
        acceptsImages: true
      }
    ])
  })

  it('lists only the connected keys, newest first, OpenAI image only, free flagged', async () => {
    expect(await refs(deps({ keys: ['openai'] }))).toEqual([
      'openai/gpt-image-new',
      'openai/gpt-image-old'
    ])
    const c = await listMediaModels(deps({ keys: ['openrouter'] }))
    expect(c.models.map((m) => m.ref)).toEqual([
      'openrouter/acme/vid-new',
      'openrouter/acme/img',
      'openrouter/acme/vid-old'
    ])
    expect(c.models.find((m) => m.ref === 'openrouter/acme/img')?.free).toBe(true)
  })

  it('flags free only for a :free id or a cost known to be 0 on both sides', async () => {
    const row = (id: string, cost?: { input?: number; output?: number }): MediaModelRow => ({
      providerId: 'openrouter',
      id,
      name: id,
      type: 'image',
      acceptsImages: false,
      ...(cost ? { cost } : {})
    })
    const d: MediaCatalogDeps = {
      ...deps({ keys: ['openrouter'] }),
      mediaRows: () => [
        row('a:free'),
        row('both-zero', { input: 0, output: 0 }),
        row('output-only', { output: 0 }),
        row('input-only', { input: 0 }),
        row('priced', { input: 0, output: 1 })
      ]
    }
    const free = Object.fromEntries(
      (await listMediaModels(d)).models.map((m) => [m.name, m.free === true])
    )
    expect(free).toEqual({
      'a:free': true,
      'both-zero': true,
      'output-only': false,
      'input-only': false,
      priced: false
    })
  })

  it('treats a key of a switched-off shared provider as not connected', async () => {
    const c = await listMediaModels(
      deps({ keys: ['openai', 'openrouter'], disabled: ['openrouter'] })
    )
    expect(c.connected.openrouter).toBe(false)
    expect(c.models.every((m) => m.source === 'openai')).toBe(true)
  })
})

describe('resolveMediaModel', () => {
  it('Automatic image: the ChatGPT Plan when signed in, else the newest keyed model', async () => {
    expect(
      await resolveMediaModel('image', undefined, false, deps({ chatgpt: true, keys: ['openai'] }))
    ).toMatchObject({
      ref: 'chatgpt-plan',
      source: 'chatgpt-plan',
      label: 'ChatGPT Plan'
    })
    expect(
      await resolveMediaModel('image', undefined, false, deps({ keys: ['openai', 'openrouter'] }))
    ).toMatchObject({
      ref: 'openai/gpt-image-new',
      modelId: 'gpt-image-new'
    })
  })

  it('Automatic image with input images skips a model that cannot take them', async () => {
    expect(
      await resolveMediaModel('image', undefined, true, deps({ keys: ['openai'] }))
    ).toMatchObject({
      ref: 'openai/gpt-image-old'
    })
  })

  it('names the reason when nothing is connected', async () => {
    expect(await resolveMediaModel('image', undefined, false, deps())).toEqual({
      error: expect.stringContaining('No image model is connected')
    })
  })

  it('video is Off by default and Automatic picks the newest OpenRouter video model', async () => {
    const d = deps({ keys: ['openrouter'] })
    expect(await resolveMediaModel('video', undefined, false, d)).toEqual({
      error: expect.stringContaining('turned off in Settings')
    })
    const on = deps({ keys: ['openrouter'], setting: { videoModel: 'auto' } })
    expect(await resolveMediaModel('video', undefined, false, on)).toMatchObject({
      ref: 'openrouter/acme/vid-new'
    })
    expect(await resolveMediaModel('video', undefined, true, on)).toMatchObject({
      ref: 'openrouter/acme/vid-old'
    })
  })

  it('the setting picks a model, and Off wins over a connected source', async () => {
    const d = (setting: unknown) => deps({ chatgpt: true, keys: ['openai'], setting })
    expect(
      await resolveMediaModel('image', undefined, false, d({ imageModel: 'openai/gpt-image-old' }))
    ).toMatchObject({
      ref: 'openai/gpt-image-old'
    })
    expect(await resolveMediaModel('image', undefined, false, d({ imageModel: 'off' }))).toEqual({
      error: expect.stringContaining('turned off in Settings')
    })
    expect(
      await resolveMediaModel('image', undefined, false, d({ imageModel: 'openrouter/acme/img' }))
    ).toEqual({
      error: expect.stringContaining('not connected')
    })
  })

  it('Off wins over an explicit model', async () => {
    const d = deps({ chatgpt: true, keys: ['openai'], setting: { imageModel: 'off' } })
    expect(await resolveMediaModel('image', 'openai/gpt-image-old', false, d)).toEqual({
      error: expect.stringContaining('turned off in Settings')
    })
  })

  it('an explicit model beats a chosen setting, must be listed, and is checked for images', async () => {
    const d = deps({
      chatgpt: true,
      keys: ['openai'],
      setting: { imageModel: 'chatgpt-plan' }
    })
    expect(await resolveMediaModel('image', 'openai/gpt-image-old', false, d)).toMatchObject({
      ref: 'openai/gpt-image-old'
    })
    expect(await resolveMediaModel('image', 'openai/nope', false, d)).toEqual({
      error: expect.stringContaining('not available')
    })
    expect(await resolveMediaModel('image', 'openai/gpt-image-new', true, d)).toEqual({
      error: expect.stringContaining('does not take input images')
    })
    // A video ref is not an image model.
    expect(
      await resolveMediaModel('image', 'chatgpt-plan', false, deps({ keys: ['openai'] }))
    ).toEqual({
      error: expect.stringContaining('not available')
    })
  })
})
