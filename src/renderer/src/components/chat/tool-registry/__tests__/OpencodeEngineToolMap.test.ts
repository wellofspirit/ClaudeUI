/**
 * Unit tests for OpencodeEngineToolMap — kindOf + normalize field-mapping.
 *
 * opencode uses different tool names + input field names than Claude; this map
 * must produce the SAME ToolView the kind bodies consume. The hosted-tools MCP
 * names arrive with the `claudeui_` prefix (opencode sanitizes server+tool names)
 * and must classify to diagram/mockup.
 */

import { describe, it, expect } from 'vitest'
import { OpencodeEngineToolMap } from '../OpencodeEngineToolMap'
import type { ToolKind } from '../../../../../../shared/tool-kinds'

describe('OpencodeEngineToolMap.kindOf', () => {
  const cases: [string, ToolKind][] = [
    ['bash', 'command'],
    ['edit', 'fileEdit'],
    ['patch', 'fileEdit'],
    ['write', 'fileWrite'],
    ['read', 'fileRead'],
    ['glob', 'search'],
    ['grep', 'search'],
    ['list', 'search'],
    ['webfetch', 'web'],
    ['task', 'task'],
    // Hosted-tools MCP names — claudeui_ prefixed (opencode sanitizes server+tool name)
    ['claudeui_render_mermaid', 'diagram'],
    ['claudeui_create_mockup', 'mockup'],
    ['claudeui_show_mockup', 'mockup'],
    // Real MCP tools resolve engine-independently
    ['mcp__some-server__tool', 'mcp'],
    // Unknown
    ['somethingelse', 'unknown']
  ]

  it.each(cases)('kindOf(%s) === %s', (name, kind) => {
    expect(OpencodeEngineToolMap.kindOf(name)).toBe(kind)
  })

  it('has an empty hidden set', () => {
    expect(OpencodeEngineToolMap.hidden.size).toBe(0)
  })
})

describe('OpencodeEngineToolMap.normalize', () => {
  it('command: maps command + result output', () => {
    const result = { type: 'tool_result', toolUseId: 'x', toolResult: 'done', isError: false } as const
    const view = OpencodeEngineToolMap.normalize('command', { command: 'ls -la' }, result)
    expect(view).toMatchObject({ kind: 'command', command: 'ls -la', output: 'done' })
  })

  it('fileEdit: maps opencode filePath/oldString/newString → path/before/after', () => {
    const view = OpencodeEngineToolMap.normalize('fileEdit', {
      filePath: '/src/a.ts',
      oldString: 'foo',
      newString: 'bar'
    })
    expect(view).toMatchObject({
      kind: 'fileEdit',
      path: '/src/a.ts',
      before: 'foo',
      after: 'bar'
    })
  })

  it('fileEdit: patch shape (no old/new) → empty before/after (generic fallback in body)', () => {
    const view = OpencodeEngineToolMap.normalize('fileEdit', { filePath: '/src/a.ts', patch: '@@ -1 +1 @@' })
    expect(view).toMatchObject({ kind: 'fileEdit', path: '/src/a.ts', before: '', after: '' })
  })

  it('fileWrite: maps opencode filePath/content → path/content', () => {
    const view = OpencodeEngineToolMap.normalize('fileWrite', {
      filePath: '/src/new.ts',
      content: 'export const x = 1'
    })
    expect(view).toMatchObject({
      kind: 'fileWrite',
      path: '/src/new.ts',
      content: 'export const x = 1'
    })
  })

  it('fileRead: maps opencode filePath → path and result → content', () => {
    const result = { type: 'tool_result', toolUseId: 'x', toolResult: 'contents', isError: false } as const
    const view = OpencodeEngineToolMap.normalize('fileRead', { filePath: '/src/a.ts' }, result)
    expect(view).toMatchObject({ kind: 'fileRead', path: '/src/a.ts', content: 'contents' })
  })

  it('search: maps pattern → query', () => {
    const view = OpencodeEngineToolMap.normalize('search', { pattern: '*.ts' })
    expect(view).toMatchObject({ kind: 'search', query: '*.ts' })
  })

  it('web: maps url → target', () => {
    const view = OpencodeEngineToolMap.normalize('web', { url: 'https://x.com' })
    expect(view).toMatchObject({ kind: 'web', target: 'https://x.com' })
  })

  it('task: maps description + prompt', () => {
    const view = OpencodeEngineToolMap.normalize('task', { description: 'sub', prompt: 'do it' })
    expect(view).toMatchObject({ kind: 'task', description: 'sub', prompt: 'do it' })
  })

  it('diagram: maps plugin source/title (same as Claude)', () => {
    const view = OpencodeEngineToolMap.normalize('diagram', { source: 'graph TD; A-->B', title: 'Flow' })
    expect(view).toMatchObject({ kind: 'diagram', source: 'graph TD; A-->B', title: 'Flow' })
  })

  it('mockup: maps directory/title; extracts directory from result text when absent', () => {
    const withDir = OpencodeEngineToolMap.normalize('mockup', { directory: 'abc12345', title: 'M' })
    expect(withDir).toMatchObject({ kind: 'mockup', directory: 'abc12345', title: 'M' })

    const result = {
      type: 'tool_result' as const,
      toolUseId: 'x',
      toolResult: 'Mockup created.\nDirectory: def67890',
      isError: false
    }
    const fromResult = OpencodeEngineToolMap.normalize('mockup', {}, result)
    if (fromResult.kind === 'mockup') {
      expect(fromResult.directory).toBe('def67890')
    }
  })

  it('mcp / unknown: pass input through', () => {
    expect(OpencodeEngineToolMap.normalize('mcp', { a: 1 })).toMatchObject({ kind: 'mcp', input: { a: 1 } })
    expect(OpencodeEngineToolMap.normalize('unknown', { b: 2 })).toMatchObject({
      kind: 'unknown',
      input: { b: 2 }
    })
  })
})
