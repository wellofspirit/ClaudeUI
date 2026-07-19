/**
 * Unit tests for PiEngineToolMap — kindOf + normalize field-mapping.
 * Mirrors OpencodeEngineToolMap.test.ts's structure, adapted to pi's built-in
 * tool set (bash/read/write/edit/grep/find/ls) and input field names.
 */

import { describe, it, expect } from 'vitest'
import { PiEngineToolMap } from '../PiEngineToolMap'
import type { ToolKind } from '../../../../../../shared/tool-kinds'
// Main can't import renderer code (separate Electron processes/bundles), so
// permission-engine.ts (src/main/pi/) keeps its OWN small copy of this exact
// kindOf switch for its mode-base gating decisions (see that file's doc
// comment). This is the single-source guard: it fails if the two tables ever
// disagree for a known pi tool name.
import { piToolKind } from '../../../../../../main/pi/permission-engine'

describe('PiEngineToolMap.kindOf', () => {
  const cases: [string, ToolKind][] = [
    ['bash', 'command'],
    ['edit', 'fileEdit'],
    ['write', 'fileWrite'],
    ['read', 'fileRead'],
    ['grep', 'search'],
    ['find', 'search'],
    ['ls', 'search'],
    // Hosted-tools MCP names resolve engine-independently (M4 — pi doesn't
    // host them yet, but the map is ready).
    ['mcp__claude-ui__render_mermaid', 'diagram'],
    ['mcp__claude-ui-mockup__create_mockup', 'mockup'],
    ['mcp__some-server__tool', 'mcp'],
    // Unknown tool names fall through gracefully.
    ['skill', 'unknown'],
    ['invalid', 'unknown']
  ]

  it.each(cases)('kindOf(%s) === %s', (name, kind) => {
    expect(PiEngineToolMap.kindOf(name)).toBe(kind)
  })

  it('has an empty hidden set', () => {
    expect(PiEngineToolMap.hidden.size).toBe(0)
  })

  it.each(cases)("single-source guard: main's piToolKind(%s) agrees with the renderer's kindOf", (name, kind) => {
    expect(piToolKind(name)).toBe(kind)
    expect(piToolKind(name)).toBe(PiEngineToolMap.kindOf(name))
  })
})

describe('PiEngineToolMap.normalize', () => {
  it('command: maps command + result output', () => {
    const result = { type: 'tool_result', toolUseId: 'x', toolResult: 'total 0', isError: false } as const
    const view = PiEngineToolMap.normalize('command', { command: 'ls -la' }, result)
    expect(view).toMatchObject({ kind: 'command', command: 'ls -la', output: 'total 0' })
  })

  it('fileEdit: a single edit populates before/after from oldText/newText', () => {
    const view = PiEngineToolMap.normalize('fileEdit', {
      path: '/src/a.ts',
      edits: [{ oldText: 'foo', newText: 'bar' }]
    })
    expect(view).toMatchObject({ kind: 'fileEdit', path: '/src/a.ts', before: 'foo', after: 'bar' })
  })

  it('fileEdit: a multi-edit call (2+ edits) leaves before/after empty (generic fallback)', () => {
    const view = PiEngineToolMap.normalize('fileEdit', {
      path: '/src/a.ts',
      edits: [
        { oldText: 'foo', newText: 'bar' },
        { oldText: 'baz', newText: 'qux' }
      ]
    })
    expect(view).toMatchObject({ kind: 'fileEdit', path: '/src/a.ts', before: '', after: '' })
  })

  it('fileEdit: no edits array → empty before/after', () => {
    const view = PiEngineToolMap.normalize('fileEdit', { path: '/src/a.ts' })
    expect(view).toMatchObject({ kind: 'fileEdit', path: '/src/a.ts', before: '', after: '' })
  })

  it('fileEdit: M2 — never carries files (rich diff deferred)', () => {
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'x',
      toolResult: 'Successfully replaced 1 block(s) in /src/a.ts.',
      isError: false
    }
    const view = PiEngineToolMap.normalize(
      'fileEdit',
      { path: '/src/a.ts', edits: [{ oldText: 'foo', newText: 'bar' }] },
      result
    )
    if (view.kind === 'fileEdit') {
      expect(view.files).toBeUndefined()
    }
  })

  it('fileWrite: maps pi\'s path/content → path/content', () => {
    const view = PiEngineToolMap.normalize('fileWrite', { path: '/src/new.ts', content: 'export const x = 1' })
    expect(view).toMatchObject({ kind: 'fileWrite', path: '/src/new.ts', content: 'export const x = 1' })
  })

  it('fileRead: maps pi\'s path → path and result → content', () => {
    const result = { type: 'tool_result', toolUseId: 'x', toolResult: 'file contents', isError: false } as const
    const view = PiEngineToolMap.normalize('fileRead', { path: '/src/a.ts' }, result)
    expect(view).toMatchObject({ kind: 'fileRead', path: '/src/a.ts', content: 'file contents' })
  })

  it('search: grep/find map pattern → query', () => {
    const view = PiEngineToolMap.normalize('search', { pattern: 'TODO', path: '/src', ignoreCase: true })
    expect(view).toMatchObject({ kind: 'search', query: 'TODO' })
  })

  it('search: ls (no pattern field) falls back to path', () => {
    const view = PiEngineToolMap.normalize('search', { path: '/src', limit: 100 })
    expect(view).toMatchObject({ kind: 'search', query: '/src' })
  })

  it('search: neither pattern nor path → JSON summary of the input', () => {
    const view = PiEngineToolMap.normalize('search', { limit: 5 })
    expect(view).toMatchObject({ kind: 'search', query: JSON.stringify({ limit: 5 }) })
  })

  it('mcp / unknown: pass input through', () => {
    expect(PiEngineToolMap.normalize('mcp', { a: 1 })).toMatchObject({ kind: 'mcp', input: { a: 1 } })
    expect(PiEngineToolMap.normalize('unknown', { b: 2 })).toMatchObject({ kind: 'unknown', input: { b: 2 } })
  })
})

describe('PiEngineToolMap.displayName', () => {
  it('prettifies pi\'s lowercase built-in tool names', () => {
    expect(PiEngineToolMap.displayName('bash')).toBe('Bash')
    expect(PiEngineToolMap.displayName('read')).toBe('Read')
    expect(PiEngineToolMap.displayName('write')).toBe('Write')
    expect(PiEngineToolMap.displayName('edit')).toBe('Edit')
    expect(PiEngineToolMap.displayName('grep')).toBe('Grep')
    expect(PiEngineToolMap.displayName('find')).toBe('Find')
    expect(PiEngineToolMap.displayName('ls')).toBe('Ls')
  })

  it('passes an unrecognised name through unchanged', () => {
    expect(PiEngineToolMap.displayName('mystery_tool')).toBe('mystery_tool')
  })
})
