import { describe, expect, it } from 'vitest'
import { isMediaToolName, mediaKindOfTool, mediaToolView } from '../media-tool-view'

describe('mediaToolView', () => {
  it('reads the documented arguments of an image call', () => {
    expect(
      mediaToolView('image', {
        prompt: 'a fox',
        images: ['a.png', 'b.png'],
        model: 'openrouter/qwen/qwen-image-3',
        path: 'out/fox.png'
      })
    ).toEqual({
      kind: 'media',
      media: 'image',
      prompt: 'a fox',
      model: 'openrouter/qwen/qwen-image-3',
      path: 'out/fox.png',
      images: ['a.png', 'b.png']
    })
  })

  it('ignores wrongly typed or empty fields instead of throwing', () => {
    expect(
      mediaToolView('video', { prompt: 7, images: 'a.png', model: '  ', path: { x: 1 } })
    ).toEqual({
      kind: 'media',
      media: 'video',
      prompt: undefined,
      model: undefined,
      path: undefined
    })
    expect(mediaToolView('image', { images: ['a.png', 3, ''] })).toMatchObject({
      images: ['a.png']
    })
  })

  it('names the media kind of the two bare tool names only', () => {
    expect(mediaKindOfTool('generate_image')).toBe('image')
    expect(mediaKindOfTool('generate_video')).toBe('video')
    expect(mediaKindOfTool('constructor')).toBeNull()
  })

  it('recognises the three engine spellings and nothing else', () => {
    expect(isMediaToolName('mcp__claude-ui-media__generate_video')).toBe(true)
    expect(isMediaToolName('claudeui_generate_image')).toBe(true)
    expect(isMediaToolName('generate_image')).toBe(true)
    expect(isMediaToolName('mcp__other__generate_image')).toBe(false)
    expect(isMediaToolName('Bash')).toBe(false)
  })
})
