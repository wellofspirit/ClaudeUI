import { describe, expect, it } from 'vitest'
import { DEFAULT_MEDIA_GENERATION, resolveMediaGeneration } from '../media-generation'

describe('resolveMediaGeneration', () => {
  it('returns the defaults for nothing, a non-object and an empty object', () => {
    for (const saved of [undefined, null, 'x', 7, [], {}]) {
      expect(resolveMediaGeneration(saved)).toEqual(DEFAULT_MEDIA_GENERATION)
    }
  })

  it('takes each valid field and defaults the rest, field by field', () => {
    const out = resolveMediaGeneration({
      engines: { pi: false },
      imageModel: 'openai/x',
      videoModel: 'auto',
      imageQuality: 'low',
      saveTo: 'generated'
    })
    expect(out).toEqual({
      ...DEFAULT_MEDIA_GENERATION,
      engines: { claude: true, pi: false, opencode: true },
      imageModel: 'openai/x',
      videoModel: 'auto',
      imageQuality: 'low',
      saveTo: 'generated'
    })
  })

  it('defaults wrongly typed or unknown values', () => {
    const out = resolveMediaGeneration({
      engines: { claude: 'no', opencode: 0 },
      imageModel: 5,
      videoModel: '',
      imageQuality: 'ultra',
      concurrency: 'many',
      timeoutMinutes: NaN,
      saveTo: 'elsewhere'
    })
    expect(out).toEqual(DEFAULT_MEDIA_GENERATION)
  })

  it('rounds and clamps the numbers', () => {
    expect(resolveMediaGeneration({ concurrency: 0, timeoutMinutes: 9999 })).toMatchObject({
      concurrency: 1,
      timeoutMinutes: 120
    })
    expect(resolveMediaGeneration({ concurrency: 99.4, timeoutMinutes: 2.6 })).toMatchObject({
      concurrency: 16,
      timeoutMinutes: 3
    })
  })
})
