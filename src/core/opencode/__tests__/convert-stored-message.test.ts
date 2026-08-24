/**
 * @vitest-environment node
 *
 * Tests for convertStoredMessage — maps opencode's persisted message+parts shape
 * (GET /session/{id}/message) to a ChatMessage for history replay on resume.
 * Parity with the live-turn buildChatMessage part→block mapping.
 */
import { describe, it, expect } from 'vitest'
import { convertStoredMessage } from '../event-mapper'
import type { StoredMessage } from '../protocol/types'

function msg(
  role: 'user' | 'assistant' | 'system',
  parts: StoredMessage['parts'],
  id = 'm1'
): StoredMessage {
  return { info: { id, role, time: { created: 1000 } }, parts }
}

describe('convertStoredMessage', () => {
  it('maps a text part to a text block (assistant)', () => {
    const r = convertStoredMessage(msg('assistant', [{ type: 'text', text: 'hello' }]))
    expect(r).not.toBeNull()
    expect(r!.role).toBe('assistant')
    expect(r!.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(r!.timestamp).toBe(1000)
  })

  it('maps a reasoning part to a thinking block', () => {
    const r = convertStoredMessage(msg('assistant', [{ type: 'reasoning', text: 'thinking…' }]))
    expect(r!.content).toEqual([{ type: 'thinking', text: 'thinking…' }])
  })

  it('maps a completed tool part to tool_use + tool_result (success)', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        {
          type: 'tool',
          tool: 'bash',
          callID: 'call-1',
          state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb' }
        }
      ])
    )
    expect(r!.content).toEqual([
      { type: 'tool_use', toolUseId: 'call-1', toolName: 'bash', toolInput: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 'call-1', toolResult: 'a\nb', isError: false }
    ])
  })

  it('maps an errored tool part to tool_result isError=true (from state.error)', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        { type: 'tool', tool: 'bash', callID: 'c2', state: { status: 'error', error: 'boom' } }
      ])
    )
    const result = r!.content.find((b) => b.type === 'tool_result')
    expect(result).toEqual({
      type: 'tool_result',
      toolUseId: 'c2',
      toolResult: 'boom',
      isError: true
    })
  })

  it('a running tool part yields only tool_use (no tool_result)', () => {
    const r = convertStoredMessage(
      msg('assistant', [{ type: 'tool', tool: 'bash', callID: 'c3', state: { status: 'running' } }])
    )
    expect(r!.content).toHaveLength(1)
    expect(r!.content[0].type).toBe('tool_use')
  })

  it('preserves user role', () => {
    const r = convertStoredMessage(msg('user', [{ type: 'text', text: 'hi' }]))
    expect(r!.role).toBe('user')
  })

  it('skips system messages (returns null)', () => {
    expect(convertStoredMessage(msg('system', [{ type: 'text', text: 'sys' }]))).toBeNull()
  })

  it('returns null when there is no renderable content', () => {
    expect(
      convertStoredMessage(msg('assistant', [{ type: 'step-start' }, { type: 'file' }]))
    ).toBeNull()
    expect(convertStoredMessage(msg('assistant', []))).toBeNull()
    expect(convertStoredMessage(msg('assistant', [{ type: 'text', text: '' }]))).toBeNull()
  })

  it('returns null when info.id is missing', () => {
    expect(
      convertStoredMessage({
        info: { role: 'assistant' } as never,
        parts: [{ type: 'text', text: 'x' }]
      })
    ).toBeNull()
  })

  it('attaches fileDiffs to the tool_result block for a completed apply_patch part', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        {
          type: 'tool',
          tool: 'apply_patch',
          callID: 'c5',
          state: {
            status: 'completed',
            input: { patchText: '*** Begin Patch ***' },
            output: 'Success. Updated the following files:\nM a.ts',
            metadata: {
              files: [
                {
                  relativePath: 'a.ts',
                  type: 'update',
                  patch: '@@ -1 +1 @@\n-old\n+new',
                  additions: 1,
                  deletions: 1
                }
              ]
            }
          }
        }
      ])
    )
    const result = r!.content.find((b) => b.type === 'tool_result')
    expect(result).toMatchObject({
      type: 'tool_result',
      toolUseId: 'c5',
      fileDiffs: [
        {
          path: 'a.ts',
          patch: '@@ -1 +1 @@\n-old\n+new',
          additions: 1,
          deletions: 1,
          changeType: 'update'
        }
      ]
    })
  })

  it('does not attach fileDiffs for a completed bash part (no files/filediff metadata)', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        {
          type: 'tool',
          tool: 'bash',
          callID: 'c6',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            output: 'a\nb',
            metadata: { output: 'a\nb' }
          }
        }
      ])
    )
    const result = r!.content.find((b) => b.type === 'tool_result') as { fileDiffs?: unknown }
    expect(result?.fileDiffs).toBeUndefined()
  })

  it('preserves block order for a mixed message and ignores unknown parts', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        { type: 'text', text: 'before' },
        { type: 'step-start' },
        {
          type: 'tool',
          tool: 'read',
          callID: 'c4',
          state: { status: 'completed', input: {}, output: 'x' }
        },
        { type: 'text', text: 'after' }
      ])
    )
    expect(r!.content.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_result', 'text'])
    expect((r!.content[0] as { text: string }).text).toBe('before')
    expect((r!.content[3] as { text: string }).text).toBe('after')
  })
})

/**
 * User attachments: opencode persists them as `file` parts carrying a
 * `data:<mime>;base64,<data>` url (OpencodeSession.buildFileParts). @-mentioned
 * files/directories use the SAME part type but a `file://` url with
 * text/plain / application/x-directory mime (vendor prompt.ts resolvePromptParts)
 * — those stay skipped. Assistant-role file parts are tool-result images and are
 * handled separately.
 */
describe('convertStoredMessage — user attachment file parts', () => {
  it('maps a data-URI image file part to an image block with fileName', () => {
    const r = convertStoredMessage(
      msg('user', [
        { type: 'text', text: 'look' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'shot.png' }
      ])
    )
    expect(r).not.toBeNull()
    expect(r!.content).toEqual([
      { type: 'image', mediaType: 'image/png', base64Data: 'AAAA', fileName: 'shot.png' },
      { type: 'text', text: 'look' }
    ])
  })

  it('omits fileName when the part has no filename', () => {
    const r = convertStoredMessage(
      msg('user', [{ type: 'file', mime: 'image/webp', url: 'data:image/webp;base64,BBBB' }])
    )
    expect(r!.content).toEqual([{ type: 'image', mediaType: 'image/webp', base64Data: 'BBBB' }])
  })

  it('maps a data-URI pdf file part to a document block', () => {
    const r = convertStoredMessage(
      msg('user', [
        {
          type: 'file',
          mime: 'application/pdf',
          url: 'data:application/pdf;base64,PDFDATA',
          filename: 'spec.pdf'
        }
      ])
    )
    expect(r!.content).toEqual([
      {
        type: 'document',
        mediaType: 'application/pdf',
        base64Data: 'PDFDATA',
        fileName: 'spec.pdf'
      }
    ])
  })

  it('does not null an image-only user message', () => {
    const r = convertStoredMessage(
      msg('user', [{ type: 'file', mime: 'image/jpeg', url: 'data:image/jpeg;base64,CCCC' }])
    )
    expect(r).not.toBeNull()
    expect(r!.role).toBe('user')
    expect(r!.content).toHaveLength(1)
  })

  it('skips a file:// text/plain @-mention part', () => {
    const r = convertStoredMessage(
      msg('user', [
        { type: 'text', text: 'see @src/a.ts' },
        { type: 'file', mime: 'text/plain', url: 'file:///d:/repo/src/a.ts', filename: 'src/a.ts' }
      ])
    )
    expect(r!.content).toEqual([{ type: 'text', text: 'see @src/a.ts' }])
  })

  it('skips a file:// directory @-mention part', () => {
    const r = convertStoredMessage(
      msg('user', [
        { type: 'text', text: 'see @src' },
        {
          type: 'file',
          mime: 'application/x-directory',
          url: 'file:///d:/repo/src',
          filename: 'src'
        }
      ])
    )
    expect(r!.content).toEqual([{ type: 'text', text: 'see @src' }])
  })

  it('skips a file:// image @-mention part (no inline data available)', () => {
    const r = convertStoredMessage(
      msg('user', [
        { type: 'text', text: 'see @a.png' },
        { type: 'file', mime: 'image/png', url: 'file:///d:/repo/a.png', filename: 'a.png' }
      ])
    )
    expect(r!.content).toEqual([{ type: 'text', text: 'see @a.png' }])
  })

  it('skips an assistant-role data-URI image file part', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        { type: 'text', text: 'here' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,DDDD' }
      ])
    )
    expect(r!.content).toEqual([{ type: 'text', text: 'here' }])
  })

  it('skips malformed data URIs without throwing', () => {
    const cases: StoredMessage['parts'] = [
      { type: 'file', mime: 'image/png' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,' },
      { type: 'file', mime: 'image/png', url: 'data:image/jpeg;base64,AAAA' },
      { type: 'file', mime: 'image/png', url: 'data:image/png,AAAA' },
      { type: 'file', mime: 'image/tiff', url: 'data:image/tiff;base64,AAAA' },
      { type: 'file', url: 'data:image/png;base64,AAAA' }
    ]
    for (const part of cases) {
      const r = convertStoredMessage(msg('user', [{ type: 'text', text: 'x' }, part]))
      expect(r!.content, JSON.stringify(part)).toEqual([{ type: 'text', text: 'x' }])
    }
  })

  it('keeps multiple attachments in part order, ahead of the text block', () => {
    const r = convertStoredMessage(
      msg('user', [
        { type: 'text', text: 'both' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,ONE', filename: '1.png' },
        { type: 'file', mime: 'image/gif', url: 'data:image/gif;base64,TWO', filename: '2.gif' }
      ])
    )
    expect(r!.content).toEqual([
      { type: 'image', mediaType: 'image/png', base64Data: 'ONE', fileName: '1.png' },
      { type: 'image', mediaType: 'image/gif', base64Data: 'TWO', fileName: '2.gif' },
      { type: 'text', text: 'both' }
    ])
  })
})

/**
 * Tool-RETURNED images.
 *
 * Verified against the pinned vendor source (vendor/opencode-src,
 * packages/opencode/src/session/processor.ts `completeToolCall` +
 * packages/sdk/js/src/gen/types.gen.ts `ToolStateCompleted`): a tool that
 * returns media (read on a .png → `attachments: [{type:'file', mime, url}]`)
 * has those FilePart attachments stored on the tool part's own
 * `state.attachments`, NOT as separate assistant-message `file` parts. They were
 * dropped entirely by convertStoredMessage.
 */
describe('convertStoredMessage — tool-result images', () => {
  it('maps state.attachments data-URIs onto the tool_result images field', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        {
          type: 'tool',
          tool: 'read',
          callID: 'call-img',
          state: {
            status: 'completed',
            input: { filePath: '/x.png' },
            output: 'Image read successfully',
            attachments: [
              {
                type: 'file',
                mime: 'image/png',
                url: 'data:image/png;base64,SHOT',
                filename: 'x.png'
              }
            ]
          }
        }
      ])
    )
    const result = r!.content.find((b) => b.type === 'tool_result')
    expect(result).toEqual({
      type: 'tool_result',
      toolUseId: 'call-img',
      toolResult: 'Image read successfully',
      isError: false,
      images: [{ mediaType: 'image/png', base64Data: 'SHOT', fileName: 'x.png' }]
    })
  })

  it('keeps multiple attachments in order and skips non-image / non-data-URI ones', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        {
          type: 'tool',
          tool: 'read',
          callID: 'call-multi',
          state: {
            status: 'completed',
            output: 'ok',
            attachments: [
              { type: 'file', mime: 'image/png', url: 'data:image/png;base64,ONE' },
              { type: 'file', mime: 'application/pdf', url: 'data:application/pdf;base64,PDF' },
              { type: 'file', mime: 'image/tiff', url: 'data:image/tiff;base64,TIFF' },
              { type: 'file', mime: 'image/png', url: 'file:///not-inline.png' },
              { type: 'file', mime: 'image/webp', url: 'data:image/webp;base64,TWO' }
            ]
          }
        }
      ])
    )
    const result = r!.content.find((b) => b.type === 'tool_result')
    expect(result).toMatchObject({
      images: [
        { mediaType: 'image/png', base64Data: 'ONE' },
        { mediaType: 'image/webp', base64Data: 'TWO' }
      ]
    })
  })

  it('omits images when the tool returned none', () => {
    const r = convertStoredMessage(
      msg('assistant', [
        {
          type: 'tool',
          tool: 'bash',
          callID: 'c-none',
          state: { status: 'completed', output: 'x' }
        }
      ])
    )
    const result = r!.content.find((b) => b.type === 'tool_result')!
    expect('images' in result).toBe(false)
  })
})
