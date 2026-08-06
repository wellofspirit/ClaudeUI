/**
 * @vitest-environment node
 *
 * Tool-result IMAGE extraction, for the Claude-side producers that share
 * `extractToolResultContent` (src/main/services/tool-result-content.ts).
 *
 * A tool that returns an image (Read on a .png, a screenshot tool, most MCP
 * image tools) puts it in the tool_result's array content as a standard block:
 *
 *   { type:'image', source:{ type:'base64', media_type:'image/png', data:'<b64>' } }
 *
 * Every producer used to collapse that array with `(c.text) || ''`, so the
 * image was silently dropped at the process boundary and the renderer never saw
 * it. These tests pin the extraction contract AND the preserved text collapse
 * (an image block still contributes its empty string to the joined text — the
 * pre-existing behaviour every other test depends on).
 */
import { describe, it, expect } from 'vitest'
import {
  extractToolResultContent,
  type ToolResultContent
} from '../tool-result-content'
import { transformAssistantMessage } from '../assistant-message'

function imageBlock(mediaType: string, data: string): Record<string, unknown> {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
}

describe('extractToolResultContent', () => {
  it('string content → text only, no images key', () => {
    const out: ToolResultContent = extractToolResultContent('plain output')
    expect(out).toEqual({ text: 'plain output' })
    expect('images' in out).toBe(false)
  })

  it('collects a base64 image block', () => {
    const out = extractToolResultContent([imageBlock('image/png', 'AAAA')])
    expect(out.images).toEqual([{ mediaType: 'image/png', base64Data: 'AAAA' }])
  })

  it('preserves the legacy text collapse alongside images', () => {
    // `(c.text) || ''` joined with '\n' — an image block contributes ''.
    const out = extractToolResultContent([
      { type: 'text', text: 'Read 1 image' },
      imageBlock('image/jpeg', 'BBBB')
    ])
    expect(out.text).toBe('Read 1 image\n')
    expect(out.images).toEqual([{ mediaType: 'image/jpeg', base64Data: 'BBBB' }])
  })

  it('keeps multiple images in content order', () => {
    const out = extractToolResultContent([
      imageBlock('image/png', 'A'),
      imageBlock('image/webp', 'B'),
      imageBlock('image/gif', 'C')
    ])
    expect(out.images).toEqual([
      { mediaType: 'image/png', base64Data: 'A' },
      { mediaType: 'image/webp', base64Data: 'B' },
      { mediaType: 'image/gif', base64Data: 'C' }
    ])
  })

  it('omits the images key entirely when there are none (never [])', () => {
    const out = extractToolResultContent([{ type: 'text', text: 'ok' }])
    expect(out).toEqual({ text: 'ok' })
    expect('images' in out).toBe(false)
  })

  it('skips blocks outside the modelled media types / with a bad source', () => {
    const out = extractToolResultContent([
      imageBlock('image/svg+xml', 'nope'), // not in the allowlist
      imageBlock('image/png', ''), // empty payload
      { type: 'image', source: { type: 'url', url: 'https://x/y.png' } }, // not base64
      { type: 'image' }, // no source
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'P' } },
      imageBlock('image/png', 'GOOD')
    ])
    expect(out.images).toEqual([{ mediaType: 'image/png', base64Data: 'GOOD' }])
  })

  it('tolerates junk content (untrusted input is never thrown on)', () => {
    expect(extractToolResultContent(null)).toEqual({ text: '' })
    expect(extractToolResultContent(undefined)).toEqual({ text: '' })
    expect(extractToolResultContent(42)).toEqual({ text: '' })
    expect(extractToolResultContent([null, 'str', 7])).toEqual({ text: '\n\n' })
  })
})

describe('transformAssistantMessage — assistant-embedded tool_result', () => {
  it('carries images through to the tool_result ContentBlock', () => {
    const msg = transformAssistantMessage({
      message: {
        id: 'msg-1',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: [{ type: 'text', text: 'shot' }, imageBlock('image/png', 'ZZZ')]
          }
        ]
      }
    })
    expect(msg!.content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tu-1',
      images: [{ mediaType: 'image/png', base64Data: 'ZZZ' }]
    })
  })

  it('omits images for a text-only tool_result', () => {
    const msg = transformAssistantMessage({
      message: {
        id: 'msg-2',
        content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'just text' }]
      }
    })
    expect(msg!.content[0]).toEqual({
      type: 'tool_result',
      toolUseId: 'tu-2',
      toolResult: 'just text',
      isError: undefined
    })
  })
})
