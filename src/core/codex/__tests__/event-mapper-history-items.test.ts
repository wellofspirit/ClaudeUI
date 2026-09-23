/**
 * Layer 1 guards for F20 — the eleven Codex thread items `mapCodexItem`'s
 * `default` case used to drop on BOTH paths (live `CodexSession.item` and cold
 * `history.ts` share this one pure function, so one test covers both).
 *
 * Every fixture below is wire-shaped: the field names and nullability come from
 * `protocol/v2/ThreadItem.ts` and its satellites, not from what the mapper finds
 * convenient. Against HEAD every case here returns `[]`.
 */

import { describe, expect, it } from 'vitest'
import { codexItemId, codexPlanSteps, mapCodexDelta, mapCodexItem } from '../event-mapper'
import type { ThreadItem } from '../protocol/v2/ThreadItem'

const ID = codexItemId('thread', 'turn', 'item')

const map = (item: ThreadItem, completed = true): ReturnType<typeof mapCodexItem> =>
  mapCodexItem('thread', 'turn', item, completed, 1000)

/** The first `message` event's content blocks. */
const blocks = (item: ThreadItem, completed = true): unknown[] => {
  const event = map(item, completed)[0]
  return event?.kind === 'message' ? event.message.content : []
}

describe('image references', () => {
  it('preserves inline user images and visibly marks opaque file IDs', () => {
    const item = {
      type: 'userMessage',
      id: 'item',
      clientId: null,
      content: [
        { type: 'image', url: 'data:image/png;base64,QUJD' },
        { type: 'image', fileId: 'opaque-user-image' }
      ]
    } as ThreadItem
    expect(blocks(item)).toEqual([
      { type: 'image', mediaType: 'image/png', base64Data: 'QUJD' },
      { type: 'text', text: '[Native image reference is not an inline supported image]' }
    ])
  })
})

describe('webSearch', () => {
  const item = (results: unknown[] | null): ThreadItem =>
    ({
      type: 'webSearch',
      id: 'item',
      query: 'electron 38 contextIsolation',
      action: { type: 'search', query: 'electron 38 contextIsolation' },
      results
    }) as unknown as ThreadItem

  it('maps to a webSearch tool_use carrying the query, the action and the results', () => {
    expect(
      blocks(item([{ title: 'Electron 38', url: 'https://electronjs.org/blog', snippet: 'x' }]))
    ).toEqual([
      {
        type: 'tool_use',
        toolUseId: ID,
        toolName: 'webSearch',
        toolInput: {
          query: 'electron 38 contextIsolation',
          action: { type: 'search', query: 'electron 38 contextIsolation' },
          results: [{ title: 'Electron 38', url: 'https://electronjs.org/blog', snippet: 'x' }]
        }
      }
    ])
  })

  it('summarises the results as one `title — url` line each', () => {
    const output = map(
      item([
        { title: 'A', url: 'https://a.test' },
        { title: 'B', url: 'https://b.test' }
      ])
    )
    expect(output[1]).toEqual({
      kind: 'toolResult',
      toolUseId: ID,
      result: 'A — https://a.test\nB — https://b.test',
      isError: false
    })
  })

  it('leaves the result EMPTY when the wire carries no results', () => {
    // `WebBody` already shows the query under the action line; repeating it as
    // a terminal "Result" block would say the same thing twice.
    expect(map(item(null))[1]).toEqual({
      kind: 'toolResult',
      toolUseId: ID,
      result: '',
      isError: false
    })
  })

  it('drops an opaque result entry that is not a usable row', () => {
    // `results` is declared opaque JSON on the wire, so nothing may assume its
    // shape: a scalar, and an object with neither title nor url, are dropped
    // rather than rendered as `undefined`.
    const out = blocks(item(['a string', 42, {}, { snippet: 'orphan' }])) as {
      toolInput: Record<string, unknown>
    }[]
    expect(out[0].toolInput.results).toBeUndefined()
  })

  it('uses the url as the title when only the url is present', () => {
    const out = blocks(item([{ url: 'https://only.test' }])) as {
      toolInput: Record<string, unknown>
    }[]
    expect(out[0].toolInput.results).toEqual([
      { title: 'https://only.test', url: 'https://only.test' }
    ])
  })
})

describe('mcpToolCall', () => {
  const item = (overrides: Record<string, unknown> = {}): ThreadItem =>
    ({
      type: 'mcpToolCall',
      id: 'item',
      server: 'verify-stub',
      tool: 'ping',
      status: 'completed',
      arguments: { host: 'example.test' },
      appContext: null,
      pluginId: null,
      readOnlyHint: true,
      result: {
        content: [{ type: 'text', text: 'pong-from-mcp' }],
        structuredContent: null,
        _meta: null
      },
      error: null,
      durationMs: 12,
      ...overrides
    }) as unknown as ThreadItem

  it('names the call in the mcp__server__tool vocabulary and envelopes the arguments', () => {
    expect(blocks(item())).toEqual([
      {
        type: 'tool_use',
        toolUseId: ID,
        toolName: 'mcp__verify-stub__ping',
        toolInput: { arguments: { host: 'example.test' }, readOnlyHint: true }
      }
    ])
  })

  it('joins the text content blocks into the result', () => {
    expect(map(item())[1]).toEqual({
      kind: 'toolResult',
      toolUseId: ID,
      result: 'pong-from-mcp',
      isError: false
    })
  })

  it('lifts image content into the result images, allowlisted types only', () => {
    const out = map(
      item({
        result: {
          content: [
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'image', data: 'BBBB', mimeType: 'image/svg+xml' },
            { type: 'resource', resource: { uri: 'file:///x' } }
          ],
          structuredContent: null,
          _meta: null
        }
      })
    )
    expect(out[1]).toMatchObject({
      images: [{ mediaType: 'image/png', base64Data: 'AAAA' }],
      result: ''
    })
  })

  it('renders a server error as the error result', () => {
    expect(
      map(item({ status: 'failed', result: null, error: { message: 'HTTP 403' } }))[1]
    ).toEqual({
      kind: 'toolResult',
      toolUseId: ID,
      result: 'HTTP 403',
      isError: true
    })
  })

  it('wraps non-object arguments rather than dropping them', () => {
    expect(blocks(item({ arguments: 'bare' }))).toMatchObject([
      { toolInput: { arguments: { value: 'bare' } } }
    ])
  })

  it('omits readOnlyHint entirely when the server declared none', () => {
    const out = blocks(item({ readOnlyHint: null })) as { toolInput: Record<string, unknown> }[]
    expect('readOnlyHint' in out[0].toolInput).toBe(false)
  })
})

describe('imageView, imageGeneration and sleep', () => {
  it('maps imageView to a path-only tool_use with an EMPTY result', () => {
    const item = { type: 'imageView', id: 'item', path: '/tmp/shot.png' } as ThreadItem
    expect(blocks(item)).toEqual([
      {
        type: 'tool_use',
        toolUseId: ID,
        toolName: 'imageView',
        toolInput: { path: '/tmp/shot.png' }
      }
    ])
    // NOT the path: `FileReadBody` renders `toolResult` as the file's CONTENT,
    // so the path there would print as file text under a header already showing
    // it. Empty is the image-only Read shape `ToolCard` renders the strip for.
    expect(map(item)[1]).toEqual({ kind: 'toolResult', toolUseId: ID, result: '', isError: false })
  })

  it('maps imageGeneration to the revised prompt, the saved path and the PNG', () => {
    const item = {
      type: 'imageGeneration',
      id: 'item',
      status: 'completed',
      revisedPrompt: 'An isometric desktop app',
      result: 'UE5HQkFTRTY0',
      failure: null,
      savedPath: '/tmp/img_01.png'
    } as unknown as ThreadItem
    expect(blocks(item)).toEqual([
      {
        type: 'tool_use',
        toolUseId: ID,
        toolName: 'imageGeneration',
        toolInput: { prompt: 'An isometric desktop app', savedPath: '/tmp/img_01.png' }
      }
    ])
    expect(map(item)[1]).toMatchObject({
      isError: false,
      images: [{ mediaType: 'image/png', base64Data: 'UE5HQkFTRTY0' }]
    })
  })

  it('turns an image-generation usage limit into an error result naming the reset', () => {
    const item = {
      type: 'imageGeneration',
      id: 'item',
      status: 'failed',
      revisedPrompt: null,
      result: '',
      failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: 1_760_000_000 }
    } as unknown as ThreadItem
    expect(map(item)[1]).toMatchObject({
      isError: true,
      result: `Image generation limit reached. Resets at ${new Date(1_760_000_000_000).toISOString()}.`
    })
  })

  it('maps sleep to its duration plus an empty resolving result', () => {
    const item = { type: 'sleep', id: 'item', durationMs: 2500 } as unknown as ThreadItem
    expect(blocks(item)).toEqual([
      { type: 'tool_use', toolUseId: ID, toolName: 'sleep', toolInput: { durationMs: 2500 } }
    ])
    expect(map(item)[1]).toEqual({ kind: 'toolResult', toolUseId: ID, result: '', isError: false })
    // Unresolved: the card spins, so there must be no result yet.
    expect(map(item, false)).toHaveLength(1)
  })
})

describe('plan', () => {
  const item = (text: string): ThreadItem => ({ type: 'plan', id: 'item', text }) as ThreadItem

  it('maps to the plan tool_use the ExitPlanModeCard renders', () => {
    expect(blocks(item('## Step one'))).toEqual([
      { type: 'tool_use', toolUseId: ID, toolName: 'plan', toolInput: { plan: '## Step one' } }
    ])
  })

  it('renders the text so far while the item is still in progress', () => {
    expect(blocks(item('## Ste'), false)).toMatchObject([{ toolInput: { plan: '## Ste' } }])
  })

  it('turns item/plan/delta into an item-scoped planDelta, and an empty one into nothing', () => {
    expect(
      mapCodexDelta('item/plan/delta', {
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'turn-plan',
        delta: '## Ste'
      })
    ).toEqual([
      { kind: 'planDelta', toolUseId: codexItemId('thread', 'turn', 'turn-plan'), delta: '## Ste' }
    ])
    expect(
      mapCodexDelta('item/plan/delta', {
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'turn-plan',
        delta: ''
      })
    ).toEqual([])
  })
})

describe('system rows', () => {
  it('maps contextCompaction to a hairline separator on a system message', () => {
    const event = map({ type: 'contextCompaction', id: 'item' } as ThreadItem)[0]
    expect(event).toMatchObject({
      kind: 'message',
      message: { role: 'system', content: [{ type: 'compact_separator' }] }
    })
  })

  it('maps hookPrompt fragments to one context_note, labelled by hook run', () => {
    const event = map({
      type: 'hookPrompt',
      id: 'item',
      fragments: [
        { text: 'Repository policy: never write to vendor/.', hookRunId: '9f2a' },
        { text: '3 uncommitted files.', hookRunId: '9f2b' }
      ]
    } as ThreadItem)[0]
    expect(event).toMatchObject({
      kind: 'message',
      message: {
        role: 'system',
        content: [
          {
            type: 'context_note',
            title: 'Injected context',
            fragments: [
              { text: 'Repository policy: never write to vendor/.', label: '9f2a' },
              { text: '3 uncommitted files.', label: '9f2b' }
            ]
          }
        ]
      }
    })
  })

  it('drops a hookPrompt with no fragments', () => {
    expect(map({ type: 'hookPrompt', id: 'item', fragments: [] } as ThreadItem)).toEqual([])
  })

  it('maps enteredReviewMode to a verbatim notice, with a fallback hint', () => {
    expect(
      map({ type: 'enteredReviewMode', id: 'item', review: 'uncommitted changes' } as ThreadItem)[0]
    ).toMatchObject({
      message: {
        role: 'system',
        content: [{ type: 'text', text: 'Review started: uncommitted changes' }]
      }
    })
    expect(
      map({ type: 'enteredReviewMode', id: 'item', review: '' } as ThreadItem)[0]
    ).toMatchObject({
      message: { content: [{ type: 'text', text: 'Review started: Review requested.' }] }
    })
  })

  it('maps exitedReviewMode to a review_result, and an empty review to nothing', () => {
    expect(
      map({ type: 'exitedReviewMode', id: 'item', review: '## 2 findings' } as ThreadItem)[0]
    ).toMatchObject({
      message: { role: 'system', content: [{ type: 'review_result', text: '## 2 findings' }] }
    })
    expect(map({ type: 'exitedReviewMode', id: 'item', review: '' } as ThreadItem)).toEqual([])
  })
})

describe('functionCallOutput', () => {
  it('maps a client-supplied output to a result-only card naming its source', () => {
    const item = {
      type: 'functionCallOutput',
      id: 'item',
      name: 'request_user_input_async',
      namespace: null,
      output: '{"answers":{"Which branch?":"pre-release"}}'
    } as unknown as ThreadItem
    expect(blocks(item)).toEqual([
      {
        type: 'tool_use',
        toolUseId: ID,
        toolName: 'request_user_input_async',
        toolInput: { source: 'another client' }
      }
    ])
    expect(map(item)[1]).toMatchObject({
      result: '{"answers":{"Which branch?":"pre-release"}}',
      isError: false
    })
  })

  it('joins input_text entries and lifts input_image into the result images', () => {
    const item = {
      type: 'functionCallOutput',
      id: 'item',
      name: 'hook_output',
      namespace: 'plugin',
      output: [
        { type: 'input_text', text: 'line one' },
        { type: 'input_text', text: 'line two' },
        { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
        { type: 'input_image', file_id: 'opaque-tool-image' },
        { type: 'encrypted_content', encrypted_content: 'nope' }
      ]
    } as unknown as ThreadItem
    expect(map(item)[1]).toMatchObject({
      result: 'line one\nline two',
      images: [{ mediaType: 'image/png', base64Data: 'QUJD' }]
    })
    expect(blocks(item)).toMatchObject([
      { toolInput: { namespace: 'plugin', source: 'another client' } }
    ])
  })
})

describe('codexPlanSteps', () => {
  it('maps turn/plan/updated statuses onto the engine-neutral todo statuses', () => {
    expect(
      codexPlanSteps([
        { step: 'Inventory each harness', status: 'completed' },
        { step: 'Draft the mockups', status: 'inProgress' },
        { step: 'Kickoff F20', status: 'pending' }
      ])
    ).toEqual([
      { content: 'Inventory each harness', status: 'completed', activeForm: '' },
      { content: 'Draft the mockups', status: 'in_progress', activeForm: '' },
      { content: 'Kickoff F20', status: 'pending', activeForm: '' }
    ])
  })

  it('drops an entry the wire did not give a step, rather than rendering undefined', () => {
    expect(
      codexPlanSteps([
        { step: 'real', status: 'pending' },
        { status: 'pending' },
        null
      ] as unknown as Parameters<typeof codexPlanSteps>[0])
    ).toEqual([{ content: 'real', status: 'pending', activeForm: '' }])
  })

  it('reads an unknown status as pending rather than dropping the step', () => {
    expect(
      codexPlanSteps([{ step: 'x', status: 'somethingNew' }] as unknown as Parameters<
        typeof codexPlanSteps
      >[0])
    ).toEqual([{ content: 'x', status: 'pending', activeForm: '' }])
  })
})
