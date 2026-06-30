/**
 * Tests for summarizeTool + displayName (ROADMAP #11e)
 *
 * Guards:
 *  1. summarizeTool vs getSummary equivalence for every Claude kind (regression).
 *  2. displayName: Claude passthrough, opencode prettify map.
 *  3. ExpandableText: truncation, reveal, no chrome under limit.
 *  4. toolOutputMaxChars round-trip (default + update).
 */

import { describe, it, expect } from 'vitest'
import { summarizeTool } from '../summary'
import { getSummary } from '../../ToolCallBlock/utils'
import { ClaudeEngineToolMap } from '../ClaudeEngineToolMap'
import { OpencodeEngineToolMap } from '../OpencodeEngineToolMap'
import type { ToolView } from '../../../../../../shared/tool-kinds'
import type { ContentBlock } from '../../../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

// Helper: build a tool_use block the same way getSummary sees it.
function makeBlock(toolName: string, toolInput: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', toolUseId: 'test', toolName, toolInput }
}

// ---------------------------------------------------------------------------
// (e) summarizeTool — Claude equivalence guard
// ---------------------------------------------------------------------------

describe('summarizeTool — Claude equivalence guard vs getSummary', () => {
  /**
   * For each Claude kind, build the block + view that getSummary and summarizeTool
   * would each operate on. Assert they produce identical strings.
   */

  it('command: summarizeTool === getSummary for Bash', () => {
    const block = makeBlock('Bash', { command: 'ls -la /tmp' })
    const view: ToolView = { kind: 'command', command: 'ls -la /tmp' }
    expect(summarizeTool('command', view)).toBe(getSummary(block))
  })

  it('fileRead: summarizeTool === getSummary for Read (short path)', () => {
    const block = makeBlock('Read', { file_path: '/src/a.ts' })
    const view: ToolView = { kind: 'fileRead', path: '/src/a.ts', content: '' }
    expect(summarizeTool('fileRead', view)).toBe(getSummary(block))
  })

  it('fileRead: summarizeTool === getSummary for Read (deep path gets shortened)', () => {
    const path = '/a/b/c/d/e/f.ts'
    const block = makeBlock('Read', { file_path: path })
    const view: ToolView = { kind: 'fileRead', path, content: '' }
    expect(summarizeTool('fileRead', view)).toBe(getSummary(block))
  })

  it('fileWrite: summarizeTool === getSummary for Write', () => {
    const block = makeBlock('Write', { file_path: '/out/file.ts' })
    const view: ToolView = { kind: 'fileWrite', path: '/out/file.ts', content: '' }
    expect(summarizeTool('fileWrite', view)).toBe(getSummary(block))
  })

  it('fileEdit: summarizeTool === getSummary for Edit', () => {
    const block = makeBlock('Edit', { file_path: '/src/edit.ts' })
    const view: ToolView = { kind: 'fileEdit', path: '/src/edit.ts', before: '', after: '' }
    expect(summarizeTool('fileEdit', view)).toBe(getSummary(block))
  })

  it('search: summarizeTool === getSummary for Glob (pattern)', () => {
    const block = makeBlock('Glob', { pattern: '**/*.ts' })
    const view: ToolView = { kind: 'search', query: '**/*.ts' }
    expect(summarizeTool('search', view)).toBe(getSummary(block))
  })

  it('search: summarizeTool === getSummary for Grep (pattern)', () => {
    const block = makeBlock('Grep', { pattern: 'useState' })
    const view: ToolView = { kind: 'search', query: 'useState' }
    expect(summarizeTool('search', view)).toBe(getSummary(block))
  })

  it('todo: summarizeTool === getSummary for TodoWrite', () => {
    const todos = [
      { status: 'completed', content: 'task 1' },
      { status: 'pending', content: 'task 2' },
      { status: 'completed', content: 'task 3' }
    ]
    const block = makeBlock('TodoWrite', { todos })
    const view: ToolView = {
      kind: 'todo',
      items: todos.map((t) => ({ status: t.status, text: t.content }))
    }
    expect(summarizeTool('todo', view)).toBe(getSummary(block))
    expect(summarizeTool('todo', view)).toBe('2/3 tasks')
  })

  it('question: summarizeTool === getSummary for AskUserQuestion (1 question)', () => {
    const block = makeBlock('AskUserQuestion', {
      questions: [{ question: 'What?', header: '', options: [] }]
    })
    const view: ToolView = {
      kind: 'question',
      questions: [{ question: 'What?', header: '', options: [], multiSelect: false }]
    }
    expect(summarizeTool('question', view)).toBe(getSummary(block))
    expect(summarizeTool('question', view)).toBe('1 question')
  })

  it('question: summarizeTool === getSummary for AskUserQuestion (3 questions)', () => {
    const qs = [
      { question: 'A?', header: '', options: [] },
      { question: 'B?', header: '', options: [] },
      { question: 'C?', header: '', options: [] }
    ]
    const block = makeBlock('AskUserQuestion', { questions: qs })
    const view: ToolView = {
      kind: 'question',
      questions: qs.map((q) => ({ ...q, multiSelect: false }))
    }
    expect(summarizeTool('question', view)).toBe(getSummary(block))
    expect(summarizeTool('question', view)).toBe('3 questions')
  })

  it('diagram: summarizeTool === getSummary for mermaid (with title)', () => {
    const block = makeBlock('mcp__claude-ui__render_mermaid', { title: 'Flow', source: '...' })
    const view: ToolView = { kind: 'diagram', source: '...', title: 'Flow' }
    expect(summarizeTool('diagram', view)).toBe(getSummary(block))
    expect(summarizeTool('diagram', view)).toBe('Flow')
  })

  it('diagram: summarizeTool === getSummary for mermaid (no title)', () => {
    const block = makeBlock('mcp__claude-ui__render_mermaid', { source: '...' })
    const view: ToolView = { kind: 'diagram', source: '...' }
    expect(summarizeTool('diagram', view)).toBe(getSummary(block))
    expect(summarizeTool('diagram', view)).toBe('diagram')
  })

  it('mockup: summarizeTool === getSummary for create_mockup (with title)', () => {
    const block = makeBlock('mcp__claude-ui-mockup__create_mockup', { title: 'My UI' })
    const view: ToolView = { kind: 'mockup', title: 'My UI' }
    expect(summarizeTool('mockup', view)).toBe(getSummary(block))
    expect(summarizeTool('mockup', view)).toBe('My UI')
  })

  it('mockup: summarizeTool === getSummary for create_mockup (no title, no directory)', () => {
    const block = makeBlock('mcp__claude-ui-mockup__create_mockup', {})
    const view: ToolView = { kind: 'mockup' }
    expect(summarizeTool('mockup', view)).toBe(getSummary(block))
    expect(summarizeTool('mockup', view)).toBe('new mockup')
  })

  it('mcp: summarizeTool returns JSON for unknown mcp input', () => {
    const inp = { foo: 'bar', n: 42 }
    const view: ToolView = { kind: 'mcp', input: inp }
    expect(summarizeTool('mcp', view)).toBe(JSON.stringify(inp))
  })

  it('unknown: summarizeTool returns JSON for unknown input', () => {
    const inp = { x: 1 }
    const view: ToolView = { kind: 'unknown', input: inp }
    expect(summarizeTool('unknown', view)).toBe(JSON.stringify(inp))
  })
})

// NOTE on mockup show_mockup wording drift:
// Old getSummary: `show <dir8>` (e.g. "show abc12345")
// New summarizeTool: "show mockup" (when has directory but no title)
// This is acceptable per spec §2(e). Not included in equivalence guard since it's
// an intentional wording improvement.
describe('summarizeTool — mockup show_mockup wording (documented drift)', () => {
  it('with directory but no title: returns "show mockup" (not old show <dir8>)', () => {
    const view: ToolView = { kind: 'mockup', directory: 'abc12345' }
    expect(summarizeTool('mockup', view)).toBe('show mockup')
    // Old behavior: getSummary would return "show abc12345" (8-char slice of 'abc12345')
    const oldBlock = makeBlock('mcp__claude-ui-mockup__show_mockup', { directory: 'abc12345' })
    expect(getSummary(oldBlock)).toBe('show abc12345') // .slice(0,8) of 'abc12345' = 'abc12345' (exactly 8)
  })
})

// ---------------------------------------------------------------------------
// (e) displayName
// ---------------------------------------------------------------------------

describe('displayName — Claude passthrough', () => {
  it('returns standard tool names verbatim', () => {
    const names = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
      'TodoWrite', 'AskUserQuestion', 'ExitPlanMode']
    for (const name of names) {
      expect(ClaudeEngineToolMap.displayName(name)).toBe(name)
    }
  })

  it('passes through MCP tool names verbatim', () => {
    expect(ClaudeEngineToolMap.displayName('mcp__claude-ui__render_mermaid')).toBe('mcp__claude-ui__render_mermaid')
    expect(ClaudeEngineToolMap.displayName('mcp__claude-ui-mockup__create_mockup')).toBe('mcp__claude-ui-mockup__create_mockup')
  })

  it('passes through agent tool names verbatim', () => {
    expect(ClaudeEngineToolMap.displayName('Task')).toBe('Task')
    expect(ClaudeEngineToolMap.displayName('Agent')).toBe('Agent')
  })
})

describe('displayName — opencode prettify map', () => {
  it('prettifies known lowercase names', () => {
    expect(OpencodeEngineToolMap.displayName('bash')).toBe('Bash')
    expect(OpencodeEngineToolMap.displayName('read')).toBe('Read')
    expect(OpencodeEngineToolMap.displayName('write')).toBe('Write')
    expect(OpencodeEngineToolMap.displayName('edit')).toBe('Edit')
    expect(OpencodeEngineToolMap.displayName('glob')).toBe('Glob')
    expect(OpencodeEngineToolMap.displayName('grep')).toBe('Grep')
    expect(OpencodeEngineToolMap.displayName('webfetch')).toBe('WebFetch')
    expect(OpencodeEngineToolMap.displayName('websearch')).toBe('WebSearch')
    expect(OpencodeEngineToolMap.displayName('todowrite')).toBe('TodoWrite')
    expect(OpencodeEngineToolMap.displayName('task')).toBe('Task')
    expect(OpencodeEngineToolMap.displayName('question')).toBe('AskUserQuestion')
    expect(OpencodeEngineToolMap.displayName('apply_patch')).toBe('Patch')
    expect(OpencodeEngineToolMap.displayName('claudeui_render_mermaid')).toBe('Mermaid')
    expect(OpencodeEngineToolMap.displayName('claudeui_create_mockup')).toBe('Mockup')
    expect(OpencodeEngineToolMap.displayName('claudeui_show_mockup')).toBe('Mockup')
  })

  it('falls back to raw name for unknown tools', () => {
    expect(OpencodeEngineToolMap.displayName('some_custom_tool')).toBe('some_custom_tool')
    expect(OpencodeEngineToolMap.displayName('lsp_hover')).toBe('lsp_hover')
  })
})
