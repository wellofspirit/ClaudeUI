/**
 * Layer 1: gallery derivation from a message list.
 *
 * Entries are blob REFS (ADR-087), not `data:` URIs: deriving a gallery must
 * allocate nothing image-sized, because it re-runs on every streaming partial.
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

/** A 64-hex blob id that reads as its tag in a failure message. */
function bid(tag: string): string {
  return tag.padEnd(64, '0')
}

function image(tag: string, fileName?: string): ContentBlock {
  return { type: 'image', mediaType: 'image/png', blobId: bid(tag), bytes: 3, fileName }
}

describe('deriveAttachmentGallery', () => {
  it('collects user-message images in message order, as blob refs', () => {
    const messages = [
      message('user', [{ type: 'text', text: 'one' }, image('a', 'a.png')], 'm-a'),
      message('assistant', [{ type: 'text', text: 'ok' }]),
      message('user', [image('b'), image('c', 'c.png')], 'm-b')
    ]

    expect(deriveAttachmentGallery(messages)).toEqual([
      {
        key: 'm-a#0',
        blob: { blobId: bid('a'), mediaType: 'image/png' },
        fileName: 'a.png'
      },
      { key: 'm-b#0', blob: { blobId: bid('b'), mediaType: 'image/png' }, fileName: undefined },
      { key: 'm-b#1', blob: { blobId: bid('c'), mediaType: 'image/png' }, fileName: 'c.png' }
    ])
  })

  it('never builds a data: URI — an entry has no src for the viewer to mistake for ready', () => {
    const [entry] = deriveAttachmentGallery([message('user', [image('a')])])
    expect(entry).not.toHaveProperty('src')
  })

  it('indexes within the message by image-block position, ignoring other blocks', () => {
    // The key basis must match MessageBubble's own `imageBlocks` filter — a text
    // block between two images must not shift the second image's index.
    const msg = message('user', [image('a'), { type: 'text', text: 'mid' }, image('b')], 'm-mixed')
    expect(deriveAttachmentGallery([msg]).map((e) => e.key)).toEqual(['m-mixed#0', 'm-mixed#1'])
    expect(imageBlocksOf(msg)).toHaveLength(2)
  })

  it('ignores images on assistant and system messages', () => {
    const messages = [
      message('assistant', [image('a')]),
      message('system', [image('b')]),
      message('user', [image('c')], 'm-user')
    ]
    expect(deriveAttachmentGallery(messages).map((e) => e.key)).toEqual(['m-user#0'])
  })

  it('is empty for a conversation with no attachments', () => {
    expect(deriveAttachmentGallery([message('user', [{ type: 'text', text: 'hi' }])])).toEqual([])
  })

  it('agrees with attachmentKey', () => {
    expect(attachmentKey('m-1', 2)).toBe('m-1#2')
  })
})

describe('deriveToolResultGallery', () => {
  function toolResult(toolUseId: string, images?: ToolResultImage[]): ContentBlock {
    return { type: 'tool_result', toolUseId, toolResult: 'ok', ...(images ? { images } : {}) }
  }

  function toolImage(tag: string, fileName?: string): ToolResultImage {
    return {
      mediaType: 'image/png',
      blobId: bid(tag),
      bytes: 3,
      ...(fileName ? { fileName } : {})
    }
  }

  it('is empty for a tool_result with no images', () => {
    const messages = [
      message('assistant', [{ type: 'tool_result', toolUseId: 't1', toolResult: 'done' }])
    ]
    expect(deriveToolResultGallery(messages)).toEqual([])
  })

  it('emits a blob entry from blobId + mediaType, keyed by message#toolUse#index', () => {
    const messages = [message('assistant', [toolResult('t1', [toolImage('z', 'shot.png')])], 'm-1')]
    expect(deriveToolResultGallery(messages)).toEqual([
      {
        key: 'm-1#t1#0',
        blob: { blobId: bid('z'), mediaType: 'image/png' },
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
          toolResult('t1', [toolImage('a'), toolImage('b')]),
          { type: 'text', text: 'between' },
          toolResult('t2', [toolImage('c')])
        ],
        'm-1'
      ),
      message('assistant', [toolResult('t3', [toolImage('d')])], 'm-2')
    ]
    expect(deriveToolResultGallery(messages).map((e) => [e.key, e.blob.blobId])).toEqual([
      ['m-1#t1#0', bid('a')],
      ['m-1#t1#1', bid('b')],
      ['m-1#t2#0', bid('c')],
      ['m-2#t3#0', bid('d')]
    ])
  })

  it('includes tool results on USER-role messages (Claude attaches them there)', () => {
    // The subagent-watcher path emits tool_result blocks on a synthetic
    // user-role message — unlike the attachments gallery, this one is
    // role-agnostic on purpose.
    const messages = [message('user', [toolResult('t1', [toolImage('u')])], 'm-u')]
    expect(deriveToolResultGallery(messages).map((e) => e.key)).toEqual(['m-u#t1#0'])
  })
})

describe('deriveGalleries', () => {
  it('returns both galleries', () => {
    const messages = [message('user', [image('a')], 'm-1')]
    expect(deriveGalleries(messages)).toEqual({
      attachments: [
        { key: 'm-1#0', blob: { blobId: bid('a'), mediaType: 'image/png' }, fileName: undefined }
      ],
      toolResults: []
    })
  })
})
