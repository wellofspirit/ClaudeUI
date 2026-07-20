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
    // Hosted-tools MCP names resolve engine-independently (a future pi MCP
    // bridge would land here — pi's OWN hosted tools use bare names below).
    ['mcp__claude-ui__render_mermaid', 'diagram'],
    ['mcp__claude-ui-mockup__create_mockup', 'mockup'],
    ['mcp__some-server__tool', 'mcp'],
    // Hosted tools (M4a+b) registered via pi.registerTool() — BARE names
    // (hostedMcpKind above only matches mcp__* prefixed names).
    ['render_mermaid', 'diagram'],
    ['create_mockup', 'mockup'],
    ['show_mockup', 'mockup'],
    ['dispatch_agent', 'task'],
    // Plan mode (M5a) — exit_plan, also a bare-name pi.registerTool() registration.
    ['exit_plan', 'plan'],
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

  it('plan: exit_plan maps its plan field straight through (M5a)', () => {
    const view = PiEngineToolMap.normalize('plan', { plan: '1. Do X\n2. Do Y' })
    expect(view).toEqual({ kind: 'plan', plan: '1. Do X\n2. Do Y' })
  })

  it('plan: a missing plan field normalizes to an empty string', () => {
    const view = PiEngineToolMap.normalize('plan', {})
    expect(view).toEqual({ kind: 'plan', plan: '' })
  })
})

describe('PiEngineToolMap.normalize — hosted tools (M4a+b)', () => {
  it('diagram: maps source/title straight through (render_mermaid args)', () => {
    const view = PiEngineToolMap.normalize('diagram', { source: 'graph TD; A-->B', title: 'Flow' })
    expect(view).toEqual({ kind: 'diagram', source: 'graph TD; A-->B', title: 'Flow' })
  })

  it('diagram: title is optional', () => {
    const view = PiEngineToolMap.normalize('diagram', { source: 'graph TD' })
    expect(view).toEqual({ kind: 'diagram', source: 'graph TD', title: undefined })
  })

  it('mockup: create_mockup input has no directory field -- extracted from the tool result text', () => {
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'x',
      toolResult: 'Mockup created successfully.\nDirectory: abc123\nPath: .claude/ui/mockups/abc123',
      isError: false
    }
    const view = PiEngineToolMap.normalize('mockup', { html: '<div>hi</div>', title: 'My UI' }, result)
    expect(view).toEqual({ kind: 'mockup', directory: 'abc123', title: 'My UI' })
  })

  it('mockup: show_mockup input carries directory directly (no result needed)', () => {
    const view = PiEngineToolMap.normalize('mockup', { directory: 'abc123' })
    expect(view).toEqual({ kind: 'mockup', directory: 'abc123', title: undefined })
  })

  it('mockup: no directory in input and no result -> undefined directory', () => {
    const view = PiEngineToolMap.normalize('mockup', { html: '<div>hi</div>' })
    expect(view).toEqual({ kind: 'mockup', directory: undefined, title: undefined })
  })

  it('task: dispatch_agent input (engine present) -> "Dispatch: <engine>" / "<engine> · <model>"', () => {
    const view = PiEngineToolMap.normalize('task', { engine: 'opencode', prompt: 'do X', model: 'openai/gpt-5' })
    expect(view).toEqual({
      kind: 'task',
      description: 'Dispatch: opencode',
      prompt: 'do X',
      subagent: 'opencode · openai/gpt-5'
    })
  })

  it('task: dispatch_agent without a model -> subagent is just the engine name', () => {
    const view = PiEngineToolMap.normalize('task', { engine: 'claude', prompt: 'do X' })
    expect(view).toEqual({ kind: 'task', description: 'Dispatch: claude', prompt: 'do X', subagent: 'claude' })
  })

  it('task: no engine field (defensive fallback, unreachable for pi today) -> generic view', () => {
    const view = PiEngineToolMap.normalize('task', { prompt: 'do X' })
    expect(view).toMatchObject({ kind: 'task', description: '', prompt: 'do X' })
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

  it('prettifies hosted tool bare names (M4a+b)', () => {
    expect(PiEngineToolMap.displayName('render_mermaid')).toBe('Mermaid')
    expect(PiEngineToolMap.displayName('create_mockup')).toBe('Mockup')
    expect(PiEngineToolMap.displayName('show_mockup')).toBe('Mockup')
    expect(PiEngineToolMap.displayName('dispatch_agent')).toBe('Dispatch')
  })
})
