import { describe, expect, it } from 'vitest'
import { codexItemId, mapCodexDelta, mapCodexItem, type CodexMappedEvent } from '../event-mapper'
import { selectCodexModel } from '../model-selection'
import type { ThreadItem } from '../protocol/v2/ThreadItem'
import type { Model } from '../protocol/v2/Model'
import type { FileDiff } from '../../../shared/types'

describe('Codex item mapping', () => {
  it('does not turn an interrupted in-progress command into a successful result', () => {
    const output = mapCodexItem(
      'root',
      'turn',
      {
        type: 'commandExecution',
        id: 'active',
        command: 'sleep',
        cwd: '/tmp',
        status: 'inProgress',
        exitCode: null,
        aggregatedOutput: 'partial'
      } as ThreadItem,
      true,
      1
    )
    expect(output[1]).toMatchObject({
      kind: 'toolResult',
      isError: true,
      result: expect.stringContaining('did not report completion')
    })
  })
  it('scopes item ids across turns and threads without delimiter collisions', () => {
    expect(
      new Set([
        codexItemId('a:b', 'c', 'd'),
        codexItemId('a', 'b:c', 'd'),
        codexItemId('a', 'b', 'c:d')
      ]).size
    ).toBe(3)
  })
  it('maps authoritative command output and file diffs', () => {
    const command = mapCodexItem(
      'root',
      'turn',
      {
        type: 'commandExecution',
        id: '1',
        command: 'pwd',
        cwd: '/tmp',
        status: 'failed',
        exitCode: 1,
        aggregatedOutput: 'failure'
      } as ThreadItem,
      true,
      123
    )
    expect(command[1]).toMatchObject({ kind: 'toolResult', result: 'failure', isError: true })
    const file = mapCodexItem(
      'root',
      'turn',
      {
        type: 'fileChange',
        id: '1',
        status: 'completed',
        changes: [
          { path: 'a.ts', diff: '@@\n-old\n+new', kind: { type: 'update', move_path: null } }
        ]
      },
      true,
      123
    )
    expect(file[1]).toMatchObject({
      kind: 'toolResult',
      fileDiffs: [{ path: 'a.ts', patch: '@@\n-old\n+new' }],
      isError: false
    })
  })
  it('keeps native ultra effort and config defaults separate from Claude aliases', () => {
    const catalog = [
      { model: 'default-native', isDefault: true },
      { model: 'configured' }
    ] as Model[]
    expect(selectCodexModel(catalog, 'configured')).toBe('configured')
    expect(selectCodexModel([], null, 'unknown-explicit')).toBe('unknown-explicit')
    expect(selectCodexModel([], null)).toBeUndefined()
    expect(() => selectCodexModel(catalog, null, 'default')).toThrow('unavailable')
  })
  it('maps reasoning and command deltas without clocks', () => {
    expect(
      mapCodexDelta('item/reasoning/summaryTextDelta', {
        threadId: 'r',
        turnId: 't',
        itemId: 'i',
        delta: 'thought'
      })
    ).toEqual([{ kind: 'stream', delta: { type: 'thinking', text: 'thought' } }])
    expect(
      mapCodexDelta('item/commandExecution/outputDelta', {
        threadId: 'r',
        turnId: 't',
        itemId: 'i',
        delta: 'out'
      })[0]
    ).toMatchObject({ kind: 'commandDelta', delta: 'out' })
  })
})

/**
 * ClaudeUI's own hosted tools ride Codex's dynamic-tool channel, so the
 * `dynamicToolCall` item is the transcript row for render_mermaid /
 * create_mockup / show_mockup. The v2 projection of the item carries NO `error`
 * field (`app-server-protocol/src/protocol/v2/item.rs`, `CoreTurnItem::
 * DynamicToolCall` -> `ThreadItem::DynamicToolCall` drops the core's `error`),
 * so a cancelled call arrives as `failed` with an EMPTY `contentItems` and the
 * mapper has to say something itself.
 */
describe('Codex dynamic tool calls', () => {
  const item = (over: Record<string, unknown> = {}): ThreadItem =>
    ({
      type: 'dynamicToolCall',
      id: 'call-1',
      namespace: null,
      tool: 'render_mermaid',
      arguments: { source: 'graph TD; A-->B' },
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
      ...over
    }) as ThreadItem

  it('maps an in-flight call to a tool_use block and nothing else', () => {
    const output = mapCodexItem('root', 'turn', item(), false, 7)
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({
      kind: 'message',
      message: {
        id: codexItemId('root', 'turn', 'call-1'),
        content: [
          {
            type: 'tool_use',
            toolUseId: codexItemId('root', 'turn', 'call-1'),
            toolName: 'render_mermaid',
            toolInput: { source: 'graph TD; A-->B' }
          }
        ]
      }
    })
  })

  it('joins the completed call text into a successful tool result', () => {
    const output = mapCodexItem(
      'root',
      'turn',
      item({
        status: 'completed',
        success: true,
        contentItems: [
          { type: 'inputText', text: 'Diagram rendered successfully.' },
          { type: 'inputText', text: 'second line' }
        ]
      }),
      true,
      7
    )
    expect(output[1]).toEqual({
      kind: 'toolResult',
      toolUseId: codexItemId('root', 'turn', 'call-1'),
      result: 'Diagram rendered successfully.\nsecond line',
      isError: false
    })
  })

  it('reports a failed call as an error even when the handler returned text', () => {
    const output = mapCodexItem(
      'root',
      'turn',
      item({
        status: 'failed',
        success: false,
        contentItems: [{ type: 'inputText', text: 'Mermaid syntax error: no diagram type' }]
      }),
      true,
      7
    )
    expect(output[1]).toMatchObject({
      kind: 'toolResult',
      result: 'Mermaid syntax error: no diagram type',
      isError: true
    })
  })

  it('says why a cancelled call has no output at all', () => {
    const output = mapCodexItem(
      'root',
      'turn',
      item({ status: 'failed', success: false, contentItems: [] }),
      true,
      7
    )
    expect(output[1]).toMatchObject({
      kind: 'toolResult',
      result: 'Hosted tool call did not return a result.',
      isError: true
    })
  })

  it('drops non-text content items rather than rendering a data URL', () => {
    const output = mapCodexItem(
      'root',
      'turn',
      item({
        status: 'completed',
        success: true,
        contentItems: [
          { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
          { type: 'inputText', text: 'kept' }
        ]
      }),
      true,
      7
    )
    expect(output[1]).toMatchObject({ kind: 'toolResult', result: 'kept', isError: false })
  })
})

/**
 * The wire's `diff` field is only a unified diff for `update` — see
 * `format_file_change_diff` in codex-rs's app-server-protocol
 * (`item_builders.rs`). An `add`/`delete` carries the raw file CONTENT, and a
 * renamed `update` carries the diff with a `Moved to:` trailer glued on. Passing
 * either through as `FileDiff.patch` parses to zero hunks, which is what the
 * viewer renders as "No changes".
 */
describe('Codex file-change patches', () => {
  const diffOf = (
    path: string,
    diff: string,
    kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  ): FileDiff => {
    const output = mapCodexItem(
      'root',
      'turn',
      { type: 'fileChange', id: '1', status: 'completed', changes: [{ path, diff, kind }] },
      true,
      1
    )
    const result = output[1] as Extract<CodexMappedEvent, { kind: 'toolResult' }>
    return result.fileDiffs![0]
  }

  it('wraps the raw content of an added file in a unified add diff', () => {
    const file = diffOf('new.ts', 'const a = 1\nexport default a\n', { type: 'add' })
    expect(file.changeType).toBe('add')
    expect(file.patch).toBe(
      [
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+const a = 1',
        '+export default a'
      ].join('\n')
    )
  })

  it('keeps a missing trailing newline on an add', () => {
    expect(diffOf('new.ts', 'only line', { type: 'add' }).patch).toBe(
      [
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,1 @@',
        '+only line',
        '\\ No newline at end of file'
      ].join('\n')
    )
  })

  it('gives an empty add a hunk, so the viewer does not call it "No changes"', () => {
    expect(diffOf('empty.ts', '', { type: 'add' }).patch).toBe(
      ['--- /dev/null', '+++ b/empty.ts', '@@ -0,0 +0,0 @@'].join('\n')
    )
  })

  it('wraps the raw content of a deleted file in a unified delete diff', () => {
    const file = diffOf('gone.ts', 'a\nb\n', { type: 'delete' })
    expect(file.changeType).toBe('delete')
    expect(file.patch).toBe(
      ['--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'].join('\n')
    )
  })

  it('strips the Moved to trailer but keeps the move changeType', () => {
    const file = diffOf('old.ts', '@@ -1 +1 @@\n-a\n+b\n\nMoved to: new.ts', {
      type: 'update',
      move_path: 'new.ts'
    })
    expect(file.changeType).toBe('move')
    expect(file.patch).toBe('@@ -1 +1 @@\n-a\n+b')
  })

  it('passes a plain update through untouched', () => {
    const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b'
    expect(diffOf('a.ts', patch, { type: 'update', move_path: null }).patch).toBe(patch)
  })

  it('never re-wraps content that looks like a diff — the kind decides', () => {
    // A file whose first lines happen to look like a patch is still an ADD, and
    // its content must be wrapped like any other content.
    const file = diffOf('sample.patch', '--- a/x\n+++ b/x\n', { type: 'add' })
    expect(file.patch).toBe(
      ['--- /dev/null', '+++ b/sample.patch', '@@ -0,0 +1,2 @@', '+--- a/x', '++++ b/x'].join('\n')
    )
  })
})
