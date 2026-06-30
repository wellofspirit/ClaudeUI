/**
 * Unit tests for ClaudeEngineToolMap — kindOf, hidden, normalize, and hostedMcpKind.
 *
 * These are the regression guard for the ToolKind taxonomy and the normalize
 * field-mapping that transforms Claude's raw block inputs into engine-neutral
 * ToolView shapes.
 */

import { describe, it, expect } from 'vitest'
import { ClaudeEngineToolMap } from '../ClaudeEngineToolMap'
import { hostedMcpKind } from '../../../../../../shared/tool-kinds'
import type { ToolKind } from '../../../../../../shared/tool-kinds'

// ---------------------------------------------------------------------------
// kindOf — every Claude tool name → expected kind
// ---------------------------------------------------------------------------

describe('ClaudeEngineToolMap.kindOf', () => {
  const cases: [string, ToolKind][] = [
    ['Bash', 'command'],
    ['Edit', 'fileEdit'],
    ['MultiEdit', 'fileEdit'],
    ['Write', 'fileWrite'],
    ['Read', 'fileRead'],
    ['Glob', 'search'],
    ['Grep', 'search'],
    ['WebFetch', 'web'],
    ['WebSearch', 'web'],
    ['ExitPlanMode', 'plan'],
    ['AskUserQuestion', 'question'],
    ['TodoWrite', 'todo'],
    ['Task', 'task'],
    ['Agent', 'task'],
    // MCP tools are handled by hostedMcpKind first, but kindOf still covers them
    ['mcp__claude-ui__render_mermaid', 'diagram'],
    ['mcp__claude-ui-mockup__create_mockup', 'mockup'],
    ['mcp__claude-ui-mockup__show_mockup', 'mockup'],
    ['mcp__some-server__some-tool', 'mcp'],
    // Unknown tools fall back to 'unknown'
    ['NotARealTool', 'unknown'],
    ['SomeNewTool', 'unknown']
  ]

  it.each(cases)('kindOf(%s) === %s', (toolName, expectedKind) => {
    expect(ClaudeEngineToolMap.kindOf(toolName)).toBe(expectedKind)
  })
})

// ---------------------------------------------------------------------------
// hidden set
// ---------------------------------------------------------------------------

describe('ClaudeEngineToolMap.hidden', () => {
  it('hides EnterPlanMode', () => {
    expect(ClaudeEngineToolMap.hidden.has('EnterPlanMode')).toBe(true)
  })

  it('hides TaskCreate', () => {
    expect(ClaudeEngineToolMap.hidden.has('TaskCreate')).toBe(true)
  })

  it('hides TaskUpdate', () => {
    expect(ClaudeEngineToolMap.hidden.has('TaskUpdate')).toBe(true)
  })

  it('hides TaskList', () => {
    expect(ClaudeEngineToolMap.hidden.has('TaskList')).toBe(true)
  })

  it('hides TaskGet', () => {
    expect(ClaudeEngineToolMap.hidden.has('TaskGet')).toBe(true)
  })

  it('does not hide Bash', () => {
    expect(ClaudeEngineToolMap.hidden.has('Bash')).toBe(false)
  })

  it('does not hide TodoWrite (todo kind — lifted, but not hidden)', () => {
    expect(ClaudeEngineToolMap.hidden.has('TodoWrite')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// normalize — field mapping per kind
// ---------------------------------------------------------------------------

describe('ClaudeEngineToolMap.normalize', () => {
  describe('command (Bash)', () => {
    it('maps command field', () => {
      const view = ClaudeEngineToolMap.normalize('command', { command: 'echo hello' })
      expect(view).toMatchObject({ kind: 'command', command: 'echo hello' })
    })

    it('includes output from result', () => {
      const result = { type: 'tool_result', toolUseId: 'x', toolResult: 'hello\n', isError: false } as const
      const view = ClaudeEngineToolMap.normalize('command', { command: 'echo hello' }, result)
      expect(view).toMatchObject({ kind: 'command', command: 'echo hello', output: 'hello\n' })
    })

    it('handles missing command gracefully', () => {
      const view = ClaudeEngineToolMap.normalize('command', {})
      expect(view).toMatchObject({ kind: 'command', command: '' })
    })
  })

  describe('fileEdit (Edit)', () => {
    it('maps old_string→before, new_string→after, file_path→path', () => {
      const view = ClaudeEngineToolMap.normalize('fileEdit', {
        file_path: '/src/foo.ts',
        old_string: 'const x = 1',
        new_string: 'const x = 2'
      })
      expect(view).toMatchObject({
        kind: 'fileEdit',
        path: '/src/foo.ts',
        before: 'const x = 1',
        after: 'const x = 2'
      })
    })
  })

  describe('fileWrite (Write)', () => {
    it('maps file_path→path, content→content', () => {
      const view = ClaudeEngineToolMap.normalize('fileWrite', {
        file_path: '/src/new.ts',
        content: 'export const x = 1'
      })
      expect(view).toMatchObject({
        kind: 'fileWrite',
        path: '/src/new.ts',
        content: 'export const x = 1'
      })
    })
  })

  describe('fileRead (Read)', () => {
    it('maps file_path→path and result→content', () => {
      const result = { type: 'tool_result', toolUseId: 'x', toolResult: 'file content', isError: false } as const
      const view = ClaudeEngineToolMap.normalize('fileRead', { file_path: '/src/foo.ts' }, result)
      expect(view).toMatchObject({
        kind: 'fileRead',
        path: '/src/foo.ts',
        content: 'file content'
      })
    })

    it('returns empty content when no result', () => {
      const view = ClaudeEngineToolMap.normalize('fileRead', { file_path: '/src/foo.ts' })
      expect(view).toMatchObject({ kind: 'fileRead', path: '/src/foo.ts', content: '' })
    })
  })

  describe('search (Glob/Grep)', () => {
    it('maps pattern→query', () => {
      const view = ClaudeEngineToolMap.normalize('search', { pattern: '**/*.ts' })
      expect(view).toMatchObject({ kind: 'search', query: '**/*.ts' })
    })

    it('falls back to JSON when no pattern', () => {
      const view = ClaudeEngineToolMap.normalize('search', { glob: '*.ts' })
      expect(view).toMatchObject({ kind: 'search' })
      if (view.kind === 'search') {
        expect(view.query).toContain('glob')
      }
    })
  })

  describe('web (WebFetch/WebSearch)', () => {
    it('maps url→target for WebFetch', () => {
      const view = ClaudeEngineToolMap.normalize('web', { url: 'https://example.com' })
      expect(view).toMatchObject({ kind: 'web', target: 'https://example.com' })
    })

    it('maps query→target for WebSearch', () => {
      const view = ClaudeEngineToolMap.normalize('web', { query: 'typescript generics' })
      expect(view).toMatchObject({ kind: 'web', target: 'typescript generics' })
    })
  })

  describe('task (Task/Agent)', () => {
    it('maps description and prompt', () => {
      const view = ClaudeEngineToolMap.normalize('task', {
        description: 'Search codebase',
        prompt: 'Find all usages of X'
      })
      expect(view).toMatchObject({
        kind: 'task',
        description: 'Search codebase',
        prompt: 'Find all usages of X'
      })
    })

    it('maps subagent_type → subagent, model, run_in_background → background', () => {
      const view = ClaudeEngineToolMap.normalize('task', {
        description: 'Explore code',
        prompt: 'Find all...',
        subagent_type: 'claude',
        model: 'claude-sonnet-4',
        run_in_background: true
      })
      expect(view).toMatchObject({
        kind: 'task',
        subagent: 'claude',
        model: 'claude-sonnet-4',
        background: true
      })
    })

    it('falls back to subagentType (camelCase) for older transcripts', () => {
      const view = ClaudeEngineToolMap.normalize('task', {
        description: 'Explore',
        prompt: 'Do X',
        subagentType: 'general-purpose'
      })
      if (view.kind === 'task') {
        expect(view.subagent).toBe('general-purpose')
      }
    })

    it('subagent/model/background undefined when not in input', () => {
      const view = ClaudeEngineToolMap.normalize('task', { description: 'x', prompt: 'y' })
      if (view.kind === 'task') {
        expect(view.subagent).toBeUndefined()
        expect(view.model).toBeUndefined()
        expect(view.background).toBeUndefined()
      }
    })
  })

  describe('todo (TodoWrite)', () => {
    it('maps todos array to items', () => {
      const view = ClaudeEngineToolMap.normalize('todo', {
        todos: [
          { content: 'Do A', status: 'pending' },
          { content: 'Do B', status: 'completed' }
        ]
      })
      expect(view).toMatchObject({
        kind: 'todo',
        items: [
          { status: 'pending', text: 'Do A' },
          { status: 'completed', text: 'Do B' }
        ]
      })
    })

    it('includes activeForm from todo item when present', () => {
      const view = ClaudeEngineToolMap.normalize('todo', {
        todos: [
          { content: 'Write tests', status: 'in_progress', activeForm: 'src/foo.test.ts' }
        ]
      })
      expect(view).toMatchObject({
        kind: 'todo',
        items: [{ status: 'in_progress', text: 'Write tests', activeForm: 'src/foo.test.ts' }]
      })
    })

    it('activeForm undefined when not present (opencode compat)', () => {
      const view = ClaudeEngineToolMap.normalize('todo', {
        todos: [{ content: 'Task', status: 'pending' }]
      })
      if (view.kind === 'todo') {
        expect(view.items[0].activeForm).toBeUndefined()
      }
    })

    it('handles missing todos gracefully', () => {
      const view = ClaudeEngineToolMap.normalize('todo', {})
      expect(view).toMatchObject({ kind: 'todo', items: [] })
    })
  })

  describe('diagram (mcp__claude-ui__render_mermaid)', () => {
    it('maps source and title', () => {
      const view = ClaudeEngineToolMap.normalize('diagram', {
        source: 'graph TD; A-->B',
        title: 'My Diagram'
      })
      expect(view).toMatchObject({
        kind: 'diagram',
        source: 'graph TD; A-->B',
        title: 'My Diagram'
      })
    })

    it('handles missing title', () => {
      const view = ClaudeEngineToolMap.normalize('diagram', { source: 'graph TD; A-->B' })
      expect(view).toMatchObject({ kind: 'diagram', source: 'graph TD; A-->B' })
      if (view.kind === 'diagram') {
        expect(view.title).toBeUndefined()
      }
    })
  })

  describe('mockup (mcp__claude-ui-mockup__*)', () => {
    it('maps directory and title', () => {
      const view = ClaudeEngineToolMap.normalize('mockup', {
        directory: '/tmp/mockup-123',
        title: 'My Mockup'
      })
      expect(view).toMatchObject({
        kind: 'mockup',
        directory: '/tmp/mockup-123',
        title: 'My Mockup'
      })
    })

    it('extracts directory from result text when not in input', () => {
      const result = {
        type: 'tool_result' as const,
        toolUseId: 'x',
        toolResult: 'Mockup created. Directory: /tmp/mockup-abc123',
        isError: false
      }
      const view = ClaudeEngineToolMap.normalize('mockup', {}, result)
      if (view.kind === 'mockup') {
        expect(view.directory).toBe('/tmp/mockup-abc123')
      }
    })
  })

  describe('unknown (fallback)', () => {
    it('wraps input', () => {
      const view = ClaudeEngineToolMap.normalize('unknown', { some: 'data' })
      expect(view).toMatchObject({ kind: 'unknown', input: { some: 'data' } })
    })
  })

  describe('handles undefined input gracefully', () => {
    it('command with undefined input', () => {
      const view = ClaudeEngineToolMap.normalize('command', undefined)
      expect(view).toMatchObject({ kind: 'command', command: '' })
    })
  })
})

// ---------------------------------------------------------------------------
// hostedMcpKind — engine-independent classification
// ---------------------------------------------------------------------------

describe('hostedMcpKind', () => {
  it('classifies render_mermaid as diagram', () => {
    expect(hostedMcpKind('mcp__claude-ui__render_mermaid')).toBe('diagram')
  })

  it('classifies create_mockup as mockup', () => {
    expect(hostedMcpKind('mcp__claude-ui-mockup__create_mockup')).toBe('mockup')
  })

  it('classifies show_mockup as mockup', () => {
    expect(hostedMcpKind('mcp__claude-ui-mockup__show_mockup')).toBe('mockup')
  })

  it('classifies other mcp__ tools as mcp', () => {
    expect(hostedMcpKind('mcp__some-server__my-tool')).toBe('mcp')
  })

  it('returns null for non-MCP tool names', () => {
    expect(hostedMcpKind('Bash')).toBeNull()
    expect(hostedMcpKind('Edit')).toBeNull()
    expect(hostedMcpKind('Read')).toBeNull()
    expect(hostedMcpKind('NotATool')).toBeNull()
  })
})
