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
    // 'patch' was a dead case — opencode's real id is 'apply_patch' (§2 verified)
    ['apply_patch', 'fileEdit'],
    ['write', 'fileWrite'],
    ['read', 'fileRead'],
    ['glob', 'search'],
    ['grep', 'search'],
    // 'list' was a dead case — no such tool in opencode registry (§2 verified)
    ['webfetch', 'web'],
    // 'websearch' was previously unmapped — now correctly mapped
    ['websearch', 'web'],
    ['task', 'task'],
    // Lifted kinds — previously unknown, now correctly classified
    ['todowrite', 'todo'],
    ['question', 'question'],
    ['plan_exit', 'plan'],
    // Hosted-tools MCP names — claudeui_ prefixed (opencode sanitizes server+tool name)
    ['claudeui_render_mermaid', 'diagram'],
    ['claudeui_create_mockup', 'mockup'],
    ['claudeui_show_mockup', 'mockup'],
    // Cross-engine dispatch (ADR-033 M3) — opencode sanitizes the hosted
    // 'claudeui' server's dispatch_agent tool to this name.
    ['claudeui_dispatch_agent', 'task'],
    // Real MCP tools resolve engine-independently
    ['mcp__some-server__tool', 'mcp'],
    // Graceful unknowns (skill/lsp/invalid stay unknown — out of scope)
    ['skill', 'unknown'],
    ['lsp', 'unknown'],
    ['invalid', 'unknown'],
    ['somethingelse', 'unknown']
  ]

  it.each(cases)('kindOf(%s) === %s', (name, kind) => {
    expect(OpencodeEngineToolMap.kindOf(name)).toBe(kind)
  })

  // Guard: todowrite was previously 'unknown' — this fails against pre-fix code
  it('GUARD: kindOf(todowrite) === todo (was unknown before fix)', () => {
    expect(OpencodeEngineToolMap.kindOf('todowrite')).toBe('todo')
  })

  // Guard: patch was a dead case that mapped to 'fileEdit' — it should now be 'unknown'
  it('GUARD: dead "patch" case removed — falls through to unknown', () => {
    expect(OpencodeEngineToolMap.kindOf('patch')).toBe('unknown')
  })

  // Guard: list was a dead case that mapped to 'search' — it should now be 'unknown'
  it('GUARD: dead "list" case removed — falls through to unknown', () => {
    expect(OpencodeEngineToolMap.kindOf('list')).toBe('unknown')
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

  it('fileEdit: result.fileDiffs (apply_patch/edit) → view.files, real per-file diffs', () => {
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'x',
      toolResult: 'Success. Updated the following files:\nM a.ts',
      isError: false,
      fileDiffs: [
        { path: 'a.ts', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1, changeType: 'update' as const }
      ]
    }
    const view = OpencodeEngineToolMap.normalize('fileEdit', { patchText: '*** Begin Patch ***' }, result)
    expect(view).toMatchObject({ kind: 'fileEdit', files: result.fileDiffs })
  })

  it('fileEdit: no result.fileDiffs → view.files stays undefined', () => {
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'x',
      toolResult: 'File updated',
      isError: false
    }
    const view = OpencodeEngineToolMap.normalize(
      'fileEdit',
      { filePath: '/src/a.ts', oldString: 'foo', newString: 'bar' },
      result
    )
    if (view.kind === 'fileEdit') {
      expect(view.files).toBeUndefined()
    }
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

  it('task: maps description + prompt + subagent_type + model + background', () => {
    const view = OpencodeEngineToolMap.normalize('task', {
      description: 'sub',
      prompt: 'do it',
      subagent_type: 'claude',
      model: 'claude-opus-4',
      background: true
    })
    expect(view).toMatchObject({
      kind: 'task',
      description: 'sub',
      prompt: 'do it',
      subagent: 'claude',
      model: 'claude-opus-4',
      background: true
    })
  })

  it('task: subagent/model/background absent → undefined fields', () => {
    const view = OpencodeEngineToolMap.normalize('task', { description: 'sub', prompt: 'do it' })
    expect(view).toMatchObject({ kind: 'task', description: 'sub', prompt: 'do it' })
    if (view.kind === 'task') {
      expect(view.subagent).toBeUndefined()
      expect(view.model).toBeUndefined()
      expect(view.background).toBeUndefined()
    }
  })

  // Cross-engine dispatch (ADR-033 M3): `engine` present discriminates
  // claudeui_dispatch_agent's input from opencode's native task tool.
  describe('task: dispatch_agent (engine present)', () => {
    it('builds "Dispatch: <engine>" description + "<engine> · <model>" badge', () => {
      const view = OpencodeEngineToolMap.normalize('task', {
        engine: 'claude',
        prompt: 'review this',
        model: 'haiku'
      })
      expect(view).toMatchObject({
        kind: 'task',
        description: 'Dispatch: claude',
        prompt: 'review this',
        subagent: 'claude · haiku'
      })
    })

    it('badge falls back to bare engine name when model is omitted', () => {
      const view = OpencodeEngineToolMap.normalize('task', { engine: 'claude', prompt: 'x' })
      expect(view).toMatchObject({ kind: 'task', subagent: 'claude' })
      if (view.kind === 'task') {
        expect(view.model).toBeUndefined()
      }
    })
  })

  it('todo: maps opencode todos array (content→text, status preserved)', () => {
    const view = OpencodeEngineToolMap.normalize('todo', {
      todos: [
        { content: 'Do A', status: 'pending', priority: 'high' },
        { content: 'Do B', status: 'completed', priority: 'low' },
        { content: 'Do C', status: 'cancelled', priority: 'medium' }
      ]
    })
    expect(view).toMatchObject({
      kind: 'todo',
      items: [
        { status: 'pending', text: 'Do A' },
        { status: 'completed', text: 'Do B' },
        { status: 'cancelled', text: 'Do C' }
      ]
    })
  })

  it('todo: empty todos array → empty items', () => {
    const view = OpencodeEngineToolMap.normalize('todo', { todos: [] })
    expect(view).toMatchObject({ kind: 'todo', items: [] })
  })

  it('question: maps opencode questions (multiple→multiSelect)', () => {
    const view = OpencodeEngineToolMap.normalize('question', {
      questions: [
        {
          question: 'Pick a framework',
          header: 'Framework',
          options: [{ label: 'React', description: 'UI library' }, { label: 'Vue', description: 'Another' }],
          multiple: true
        }
      ]
    })
    expect(view).toMatchObject({
      kind: 'question',
      questions: [
        {
          question: 'Pick a framework',
          header: 'Framework',
          multiSelect: true,
          options: [{ label: 'React', description: 'UI library' }, { label: 'Vue', description: 'Another' }]
        }
      ]
    })
  })

  it('question: multiple=false → multiSelect=false', () => {
    const view = OpencodeEngineToolMap.normalize('question', {
      questions: [{ question: 'Which?', header: 'H', options: [], multiple: false }]
    })
    if (view.kind === 'question') {
      expect(view.questions[0].multiSelect).toBe(false)
    }
  })

  it('plan: maps plan field', () => {
    const view = OpencodeEngineToolMap.normalize('plan', { plan: 'Step 1: ...' })
    expect(view).toMatchObject({ kind: 'plan', plan: 'Step 1: ...' })
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
