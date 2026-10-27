/**
 * The session tools (slice 2) on the three non-Claude engines' tool maps: each
 * engine's spelling of the nine tools is the generic MCP row, with the server and
 * tool Claude's `mcp__claude-ui-sessions__*` name carries, so none renders as an
 * unknown tool.
 *
 * Bare names cannot collide with another MCP tool: pi sanitises MCP tools to
 * `mcp__server__tool` and Codex MCP calls carry a namespace, so only opencode needs the
 * `claudeui_` prefix guard (its MCP actions are `server_tool`).
 */
import { describe, expect, it } from 'vitest'
import { CodexEngineToolMap } from '../CodexEngineToolMap'
import { OpencodeEngineToolMap } from '../OpencodeEngineToolMap'
import { PiEngineToolMap } from '../PiEngineToolMap'
import { piToolKind } from '../../../../../../core/pi/permission-engine'
import { SESSION_TOOL_NAMES } from '../../../../../../shared/session-tools-description'
import type { EngineToolMap } from '../../../../../../shared/tool-kinds'

const ENGINES: Array<{ label: string; map: EngineToolMap; spell: (name: string) => string }> = [
  { label: 'opencode', map: OpencodeEngineToolMap, spell: (name) => `claudeui_${name}` },
  { label: 'pi', map: PiEngineToolMap, spell: (name) => name },
  { label: 'codex', map: CodexEngineToolMap, spell: (name) => name }
]

describe.each(ENGINES)('$label tool map: the session tools', ({ map, spell }) => {
  it.each([...SESSION_TOOL_NAMES])('%s is the MCP row, not an unknown tool', (name) => {
    expect(map.kindOf(spell(name))).toBe('mcp')
  })

  it.each([...SESSION_TOOL_NAMES])(
    '%s names its server and tool, and keeps the arguments',
    (name) => {
      const input = { session: 's-abc123', message: 'hi' }
      expect(map.normalize('mcp', input, undefined, spell(name))).toMatchObject({
        kind: 'mcp',
        input,
        server: 'claude-ui-sessions',
        tool: name
      })
    }
  )

  it('has a header of its own: "Session · <verb>"', () => {
    for (const name of SESSION_TOOL_NAMES) {
      expect(map.displayName(spell(name))).toBe(
        `Session · ${name.replace('session_', '').replace(/_/g, ' ')}`
      )
    }
    expect(map.displayName(spell('session_start'))).toBe('Session · start')
  })

  it('does not capture a tool that only looks similar', () => {
    expect(map.kindOf(spell('session_nope'))).toBe('unknown')
    expect(map.kindOf('claudeui_session_nope')).toBe('unknown')
    // Another MCP tool without a splittable name keeps its dump.
    expect(map.normalize('mcp', { a: 1 }, undefined, 'foo_bar')).toEqual({
      kind: 'mcp',
      input: { a: 1 }
    })
  })
})

describe('opencode: only its own spelling', () => {
  it('a bare session_* name is not an opencode tool (its hosted tools are claudeui_-prefixed)', () => {
    expect(OpencodeEngineToolMap.kindOf('session_start')).toBe('unknown')
  })
})

describe('pi: the engine and the renderer agree (single-source guard)', () => {
  it.each([...SESSION_TOOL_NAMES])("piToolKind(%s) === the map's kindOf", (name) => {
    expect(piToolKind(name)).toBe(PiEngineToolMap.kindOf(name))
    expect(piToolKind(name)).toBe('mcp')
  })
})
