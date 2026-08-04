/**
 * Layer 1: gallery derivation from a message list.
 */

import { describe, it, expect } from 'vitest'
import type { ChatMessage, ContentBlock } from '../../../../../../shared/types'
import {
  attachmentKey,
  deriveAttachmentGallery,
  deriveGalleries,
  deriveToolResultGallery,
  imageBlocksOf
} from '../gallery'

let counter = 0
function message(role: ChatMessage['role'], content: ContentBlock[], id?: string): ChatMessage {
  counter++
  return { id: id ?? `m${counter}`, role, content, timestamp: 1000 + counter }
}

function image(base64Data: string, fileName?: string): ContentBlock {
  return { type: 'image', mediaType: 'image/png', base64Data, fileName }
}

describe('deriveAttachmentGallery', () => {
  it('collects user-message images in message order', () => {
    const messages = [
      message('user', [{ type: 'text', text: 'one' }, image('AAA', 'a.png')], 'm-a'),
      message('assistant', [{ type: 'text', text: 'ok' }]),
      message('user', [image('BBB'), image('CCC', 'c.png')], 'm-b')
    ]

    expect(deriveAttachmentGallery(messages)).toEqual([
      { key: 'm-a#0', src: 'data:image/png;base64,AAA', fileName: 'a.png' },
      { key: 'm-b#0', src: 'data:image/png;base64,BBB', fileName: undefined },
      { key: 'm-b#1', src: 'data:image/png;base64,CCC', fileName: 'c.png' }
    ])
  })

  it('indexes within the message by image-block position, ignoring other blocks', () => {
    // The key basis must match MessageBubble's own `imageBlocks` filter — a text
    // block between two images must not shift the second image's index.
    const msg = message(
      'user',
      [image('AAA'), { type: 'text', text: 'mid' }, image('BBB')],
      'm-mixed'
    )
    expect(deriveAttachmentGallery([msg]).map((e) => e.key)).toEqual(['m-mixed#0', 'm-mixed#1'])
    expect(imageBlocksOf(msg)).toHaveLength(2)
  })

  it('ignores images on assistant and system messages', () => {
    const messages = [
      message('assistant', [image('AAA')]),
      message('system', [image('BBB')]),
      message('user', [image('CCC')], 'm-user')
    ]
    expect(deriveAttachmentGallery(messages).map((e) => e.key)).toEqual(['m-user#0'])
  })

  it('is empty for a conversation with no attachments', () => {
    expect(deriveAttachmentGallery([message('user', [{ type: 'text', text: 'hi' }])])).toEqual([])
  })

  it('reuses the same data-URI string across derivations (no re-encode per partial)', () => {
    const msg = message('user', [image('AAA')])
    const first = deriveAttachmentGallery([msg])[0].src
    const second = deriveAttachmentGallery([msg])[0].src
    // Same reference, not merely an equal string.
    expect(second).toBe(first)
  })

  it('agrees with attachmentKey', () => {
    expect(attachmentKey('m-1', 2)).toBe('m-1#2')
  })
})

describe('deriveToolResultGallery', () => {
  // The `images` field is not on ContentBlock yet (see the TODO in gallery.ts).
  // These blocks are hand-built to pin the reader's contract for when it lands.
  function toolResult(toolUseId: string, images: unknown): ContentBlock {
    return { type: 'tool_result', toolUseId, toolResult: 'ok', images } as ContentBlock
  }

  it('is empty for the tool_result blocks we actually emit today', () => {
    const messages = [
      message('assistant', [{ type: 'tool_result', toolUseId: 't1', toolResult: 'done' }])
    ]
    expect(deriveToolResultGallery(messages)).toEqual([])
  })

  it('reads a ready-made src', () => {
    const messages = [message('assistant', [toolResult('t1', [{ src: 'blob:x', fileName: 'x.png' }])], 'm-1')]
    expect(deriveToolResultGallery(messages)).toEqual([
      { key: 'm-1#t1#0', src: 'blob:x', fileName: 'x.png' }
    ])
  })

  it('reads a mediaType + base64Data pair', () => {
    const messages = [
      message('assistant', [toolResult('t1', [{ mediaType: 'image/webp', base64Data: 'ZZZ' }])], 'm-1')
    ]
    expect(deriveToolResultGallery(messages)).toEqual([
      { key: 'm-1#t1#0', src: 'data:image/webp;base64,ZZZ', fileName: undefined }
    ])
  })

  it('skips malformed entries instead of rendering broken images', () => {
    const messages = [
      message(
        'assistant',
        [
          toolResult('t1', [
            null,
            'nope',
            { mediaType: 'image/png' },
            { base64Data: 'AAA' },
            { src: '' },
            { src: 'ok:1' }
          ])
        ],
        'm-1'
      )
    ]
    expect(deriveToolResultGallery(messages)).toEqual([{ key: 'm-1#t1#0', src: 'ok:1', fileName: undefined }])
  })

  it('ignores a non-array images field', () => {
    expect(deriveToolResultGallery([message('assistant', [toolResult('t1', { a: 1 })])])).toEqual([])
  })
})

describe('deriveGalleries', () => {
  it('returns both galleries', () => {
    const messages = [message('user', [image('AAA')], 'm-1')]
    expect(deriveGalleries(messages)).toEqual({
      attachments: [{ key: 'm-1#0', src: 'data:image/png;base64,AAA', fileName: undefined }],
      toolResults: []
    })
  })
})
