/**
 * Every engine map names ClaudeUI's own tools in that engine's spelling, leaves a
 * third-party tool alone, and builds a dispatch view from `name`/`description`.
 */
import { describe, expect, it } from 'vitest'
import { ClaudeEngineToolMap } from '../ClaudeEngineToolMap'
import { OpencodeEngineToolMap } from '../OpencodeEngineToolMap'
import { PiEngineToolMap } from '../PiEngineToolMap'
import type { EngineToolMap } from '../../../../../../shared/tool-kinds'

const CLAUDE_NAMES: Record<string, string> = {
  dispatch_agent: 'mcp__claude-ui-collab__dispatch_agent',
  render_mermaid: 'mcp__claude-ui__render_mermaid',
  create_mockup: 'mcp__claude-ui-mockup__create_mockup',
  show_mockup: 'mcp__claude-ui-mockup__show_mockup'
}

const ENGINES: Array<{
  label: string
  map: EngineToolMap
  spell: (bare: string) => string
  /** A tool that is not ClaudeUI's, and the header the engine gave it before this change. */
  third: [string, string]
}> = [
  {
    label: 'claude',
    map: ClaudeEngineToolMap,
    spell: (bare) => CLAUDE_NAMES[bare] ?? `mcp__claude-ui-sessions__${bare}`,
    third: ['mcp__github__create_issue', 'mcp__github__create_issue']
  },
  {
    label: 'opencode',
    map: OpencodeEngineToolMap,
    spell: (bare) => `claudeui_${bare}`,
    third: ['github_create_issue', 'github_create_issue']
  },
  {
    label: 'pi',
    map: PiEngineToolMap,
    spell: (bare) => bare,
    third: ['mcp__github__create_issue', 'mcp__github__create_issue']
  }
]

describe.each(ENGINES)('$label: first-party display names', ({ map, spell, third }) => {
  it.each([
    ['dispatch_agent', 'X-Agent'],
    ['render_mermaid', 'Diagram'],
    ['create_mockup', 'Mockup'],
    ['show_mockup', 'Mockup'],
    ['session_start', 'Session · start'],
    ['session_list', 'Session · list']
  ])('%s is "%s"', (bare, label) => {
    expect(map.displayName(spell(bare))).toBe(label)
  })

  it('leaves a third-party tool as it was', () => {
    expect(map.displayName(third[0])).toBe(third[1])
  })

  it("a dispatch view carries the name and description it was given, else today's fallback", () => {
    const toolName = spell('dispatch_agent')
    const named = map.normalize(
      'task',
      { engine: 'opencode', prompt: 'p', name: 'impl-e1', description: 'Review auth diff' },
      undefined,
      toolName
    )
    expect(named).toMatchObject({ kind: 'task', name: 'impl-e1', description: 'Review auth diff' })
    const unnamed = map.normalize('task', { engine: 'opencode', prompt: 'p' }, undefined, toolName)
    expect(unnamed).toMatchObject({ kind: 'task', description: 'Dispatch: opencode' })
    expect((unnamed as { name?: string }).name).toBeUndefined()
  })
})

describe('built-in tools keep their display', () => {
  it('Claude passes built-ins through; opencode and pi prettify as before', () => {
    expect(ClaudeEngineToolMap.displayName('Agent')).toBe('Agent')
    expect(OpencodeEngineToolMap.displayName('read')).toBe('Read')
    expect(PiEngineToolMap.displayName('agent')).toBe('Agent')
  })
})
