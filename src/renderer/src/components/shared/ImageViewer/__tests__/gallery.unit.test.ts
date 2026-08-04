/**
 * Layer 1: gallery derivation from a message list.
 */

import { describe, it, expect } from 'vitest'
import type { ChatMessage, ContentBlock, ToolResultImage } from '../../../../../../shared/types'
import {
  attachmentKey,
  deriveAttachmentGallery,
  deriveGalleries,
  deriveToolResultGallery,
  imageBlocksOf,
  toolResultKey
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
  function toolResult(toolUseId: string, images?: ToolResultImage[]): ContentBlock {
    return { type: 'tool_result', toolUseId, toolResult: 'ok', ...(images ? { images } : {}) }
  }

  function toolImage(base64Data: string, fileName?: string): ToolResultImage {
    return { mediaType: 'image/png', base64Data, ...(fileName ? { fileName } : {}) }
  }

  it('is empty for a tool_result with no images', () => {
    const messages = [
      message('assistant', [{ type: 'tool_result', toolUseId: 't1', toolResult: 'done' }])
    ]
    expect(deriveToolResultGallery(messages)).toEqual([])
  })

  it('builds a data URI from mediaType + base64Data, keyed by message#toolUse#index', () => {
    const messages = [
      message('assistant', [toolResult('t1', [toolImage('ZZZ', 'shot.png')])], 'm-1')
    ]
    expect(deriveToolResultGallery(messages)).toEqual([
      {
        key: 'm-1#t1#0',
        src: 'data:image/png;base64,ZZZ',
        fileName: 'shot.png',
        toolUseId: 't1',
        indexWithinResult: 0
      }
    ])
    expect(toolResultKey('m-1', 't1', 0)).toBe('m-1#t1#0')
  })

  it('flattens several tool calls and several images per call, in order', () => {
    const messages = [
      message(
        'assistant',
        [
          toolResult('t1', [toolImage('A'), toolImage('B')]),
          { type: 'text', text: 'between' },
          toolResult('t2', [toolImage('C')])
        ],
        'm-1'
      ),
      message('assistant', [toolResult('t3', [toolImage('D')])], 'm-2')
    ]
    expect(deriveToolResultGallery(messages).map((e) => [e.key, e.src])).toEqual([
      ['m-1#t1#0', 'data:image/png;base64,A'],
      ['m-1#t1#1', 'data:image/png;base64,B'],
      ['m-1#t2#0', 'data:image/png;base64,C'],
      ['m-2#t3#0', 'data:image/png;base64,D']
    ])
  })

  it('includes tool results on USER-role messages (Claude attaches them there)', () => {
    // The subagent-watcher path emits tool_result blocks on a synthetic
    // user-role message — unlike the attachments gallery, this one is
    // role-agnostic on purpose.
    const messages = [message('user', [toolResult('t1', [toolImage('U')])], 'm-u')]
    expect(deriveToolResultGallery(messages).map((e) => e.key)).toEqual(['m-u#t1#0'])
  })

  it('reuses the same data-URI string across derivations (no re-encode per partial)', () => {
    const msg = message('assistant', [toolResult('t1', [toolImage('AAA')])])
    expect(deriveToolResultGallery([msg])[0].src).toBe(deriveToolResultGallery([msg])[0].src)
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
