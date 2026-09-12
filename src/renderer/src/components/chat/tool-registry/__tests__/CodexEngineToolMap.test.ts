/**
 * Codex engine tool map — the native item names (`commandExecution`,
 * `fileChange`, `requestUserInput`) plus ClaudeUI's own hosted tools, which
 * reach Codex over the dynamic-tool channel under the SAME bare names pi's
 * `pi.registerTool()` registrations use (`render_mermaid`, `create_mockup`,
 * `show_mockup`). `hostedMcpKind` only matches `mcp__*`-prefixed names, so the
 * bare ones need explicit cases here exactly as they do in PiEngineToolMap.
 */
import { describe, expect, it } from 'vitest'
import { CodexEngineToolMap } from '../CodexEngineToolMap'
import type { ContentBlock } from '../../../../../../shared/types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

describe('CodexEngineToolMap.kindOf', () => {
  const cases: Array<[string, string]> = [
    ['commandExecution', 'command'],
    ['fileChange', 'fileEdit'],
    ['requestUserInput', 'question'],
    ['render_mermaid', 'diagram'],
    ['create_mockup', 'mockup'],
    ['show_mockup', 'mockup'],
    ['somethingElse', 'unknown']
  ]
  it.each(cases)('kindOf(%s) === %s', (name, kind) => {
    expect(CodexEngineToolMap.kindOf(name)).toBe(kind)
  })
})

describe('CodexEngineToolMap — hosted tools', () => {
  it('names the hosted tools the way every other engine does', () => {
    expect(CodexEngineToolMap.displayName('render_mermaid')).toBe('Mermaid')
    expect(CodexEngineToolMap.displayName('create_mockup')).toBe('Mockup')
    expect(CodexEngineToolMap.displayName('show_mockup')).toBe('Mockup')
  })

  it('diagram: maps render_mermaid source/title straight through', () => {
    expect(
      CodexEngineToolMap.normalize('diagram', { source: 'graph TD; A-->B', title: 'Flow' })
    ).toEqual({ kind: 'diagram', source: 'graph TD; A-->B', title: 'Flow' })
    expect(CodexEngineToolMap.normalize('diagram', { source: 'graph TD' })).toEqual({
      kind: 'diagram',
      source: 'graph TD',
      title: undefined
    })
  })

  it('mockup: create_mockup has no input directory — it comes from the result text', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: 'x',
      toolResult:
        'Mockup created successfully.\nDirectory: abc123\nPath: .claude/ui/mockups/abc123',
      isError: false
    }
    expect(
      CodexEngineToolMap.normalize('mockup', { html: '<div>hi</div>', title: 'My UI' }, result)
    ).toEqual({ kind: 'mockup', directory: 'abc123', title: 'My UI' })
  })

  it('mockup: show_mockup carries the directory on the input', () => {
    expect(CodexEngineToolMap.normalize('mockup', { directory: 'abc123' })).toEqual({
      kind: 'mockup',
      directory: 'abc123',
      title: undefined
    })
  })

  it('mockup: no directory anywhere stays undefined rather than guessing', () => {
    expect(CodexEngineToolMap.normalize('mockup', { html: '<div>hi</div>' })).toEqual({
      kind: 'mockup',
      directory: undefined,
      title: undefined
    })
  })
})
