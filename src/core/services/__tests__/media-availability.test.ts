/**
 * @vitest-environment node
 *
 * `mediaOffered`: the engine's toggle is on AND a model resolves for that kind.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setting: vi.fn<(key: string) => unknown>(),
  resolve: vi.fn<(kind: string) => Promise<unknown>>()
}))
vi.mock('../app-settings', () => ({ appSetting: mocks.setting }))
vi.mock('../media-catalog', () => ({ resolveMediaModel: mocks.resolve }))

import { mediaKindsEnabled, mediaOffered } from '../media-availability'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.setting.mockReturnValue({
    engines: { claude: true, pi: false, opencode: true },
    imageModel: 'auto',
    videoModel: 'auto'
  })
  mocks.resolve.mockResolvedValue({ ref: 'x' })
})

describe('mediaOffered', () => {
  it('an engine whose toggle is off is offered nothing and the catalog is not asked', async () => {
    expect(await mediaOffered('pi')).toEqual({ image: false, video: false })
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  it('is per kind: a kind with no resolvable model (error result or a throw) is hidden', async () => {
    mocks.resolve.mockImplementation(async (kind) => {
      if (kind === 'video') return { error: 'no video model' }
      return { ref: 'x' }
    })
    expect(await mediaOffered('claude')).toEqual({ image: true, video: false })
    mocks.resolve.mockImplementation(async (kind) => {
      if (kind === 'image') throw new Error('catalog down')
      return { ref: 'x' }
    })
    expect(await mediaOffered('opencode')).toEqual({ image: false, video: true })
  })
})

describe('Off means not offered', () => {
  it('a kind set to Off is hidden without asking the catalog, whatever is connected', async () => {
    mocks.setting.mockReturnValue({
      engines: { claude: true, pi: true, opencode: true },
      imageModel: 'auto',
      videoModel: 'off'
    })
    expect(await mediaOffered('pi')).toEqual({ image: true, video: false })
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    expect(mocks.resolve).toHaveBeenCalledWith('image', undefined, false)
  })

  it('mediaKindsEnabled is the I/O-free part: the toggle and Off', () => {
    mocks.setting.mockReturnValue({
      engines: { claude: true, pi: false, opencode: true },
      imageModel: 'off',
      videoModel: 'openrouter/acme/vid'
    })
    expect(mediaKindsEnabled('claude')).toEqual({ image: false, video: true })
    expect(mediaKindsEnabled('pi')).toEqual({ image: false, video: false })
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
})
