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
import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  extractToolResultContent,
  type ToolResultContent
} from '../../../core/services/tool-result-content'
import { transformAssistantMessage } from '../../../core/services/assistant-message'
import { blobStore } from '../../../core/services/blob-store'

function imageBlock(mediaType: string, data: string): Record<string, unknown> {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
}

/** What the decoder must hand back for these base64 bytes: a ref, never the bytes (ADR-087). */
function refOf(mediaType: string, base64: string): Record<string, unknown> {
  const bytes = Buffer.from(base64, 'base64')
  return {
    mediaType,
    blobId: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length
  }
}

beforeEach(() => blobStore.clearForTests())

describe('extractToolResultContent', () => {
  it('string content → text only, no images key', () => {
    const out: ToolResultContent = extractToolResultContent('plain output')
    expect(out).toEqual({ text: 'plain output' })
    expect('images' in out).toBe(false)
  })

  it('collects a base64 image block', () => {
    const out = extractToolResultContent([imageBlock('image/png', 'AAAA')])
    expect(out.images).toEqual([refOf('image/png', 'AAAA')])
  })

  it('returns a ref for a ~1 MiB image: no base64 in the result, exact bytes in the store', () => {
    const bytes = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
    const out = extractToolResultContent([
      { type: 'text', text: 'shot' },
      imageBlock('image/png', bytes.toString('base64'))
    ])

    expect(out.images).toHaveLength(1)
    // The whole result — not just `images` — stays tiny: nothing image-sized survives.
    expect(JSON.stringify(out).length).toBeLessThan(512)
    expect(out.images![0]).not.toHaveProperty('base64Data')

    const stored = blobStore.get(out.images![0].blobId)
    expect(stored?.mediaType).toBe('image/png')
    expect(stored?.data.equals(bytes)).toBe(true)
    expect(out.images![0].bytes).toBe(bytes.length)
  })

  it('dedupes the same screenshot arriving twice to one blob', () => {
    const a = extractToolResultContent([imageBlock('image/png', 'AAAA')])
    const b = extractToolResultContent([imageBlock('image/png', 'AAAA')])
    expect(a.images![0].blobId).toBe(b.images![0].blobId)
    expect(blobStore.stats().entries).toBe(1)
  })

  it('preserves the legacy text collapse alongside images', () => {
    // `(c.text) || ''` joined with '\n' — an image block contributes ''.
    const out = extractToolResultContent([
      { type: 'text', text: 'Read 1 image' },
      imageBlock('image/jpeg', 'BBBB')
    ])
    expect(out.text).toBe('Read 1 image\n')
    expect(out.images).toEqual([refOf('image/jpeg', 'BBBB')])
  })

  it('keeps multiple images in content order', () => {
    const out = extractToolResultContent([
      imageBlock('image/png', 'QQ=='),
      imageBlock('image/webp', 'Qg=='),
      imageBlock('image/gif', 'Qw==')
    ])
    expect(out.images).toEqual([
      refOf('image/png', 'QQ=='),
      refOf('image/webp', 'Qg=='),
      refOf('image/gif', 'Qw==')
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
    expect(out.images).toEqual([refOf('image/png', 'GOOD')])
  })

  it('skips a payload that is not decodable base64 rather than interning its remains', () => {
    const out = extractToolResultContent([
      imageBlock('image/png', 'not base64 !!'),
      imageBlock('image/png', 'A') // one sextet: no whole byte
    ])
    expect(out).toEqual({ text: '\n' })
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
      images: [refOf('image/png', 'ZZZ')]
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
