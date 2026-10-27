/**
 * The session tools' names on every engine (slice 2): one bare name, three
 * spellings, and the guidance split the carriers use.
 */
import { describe, expect, it } from 'vitest'
import {
  SESSION_TOOL_NAMES,
  SESSION_TOOLS_SERVER_NAME,
  sessionToolBareName,
  sessionToolMcpFields,
  sessionToolsGuidance,
  sessionToolsGuidanceParts
} from '../session-tools-description'

describe('sessionToolBareName', () => {
  it('reads all three engine spellings back to the bare tool', () => {
    for (const name of SESSION_TOOL_NAMES) {
      expect(sessionToolBareName(name), name).toBe(name)
      expect(sessionToolBareName(`claudeui_${name}`), name).toBe(name)
      expect(sessionToolBareName(`mcp__${SESSION_TOOLS_SERVER_NAME}__${name}`), name).toBe(name)
    }
  })

  it('is an exact match: near misses, other servers and the other hosted tools are not session tools', () => {
    for (const name of [
      '',
      'session_',
      'session_nope',
      'session_start ',
      'Session_start',
      'claudeui_dispatch_agent',
      'claudeui_session_nope',
      'claudeui_claudeui_session_start',
      'mcp__other__session_start',
      'mcp__claude-ui-sessions__nope',
      'mcp__claude-ui-sessions__',
      'x_session_start',
      'dispatch_agent'
    ])
      expect(sessionToolBareName(name), JSON.stringify(name)).toBeNull()
  })
})

describe('sessionToolMcpFields', () => {
  it('gives the server and bare tool for any spelling, and null for another tool', () => {
    expect(sessionToolMcpFields('claudeui_session_hand_off')).toEqual({
      server: 'claude-ui-sessions',
      tool: 'session_hand_off'
    })
    expect(sessionToolMcpFields('session_list')).toEqual({
      server: 'claude-ui-sessions',
      tool: 'session_list'
    })
    expect(sessionToolMcpFields('claudeui_render_mermaid')).toBeNull()
  })
})

describe('sessionToolsGuidanceParts', () => {
  it('the parts joined are exactly the system-prompt guidance, whatever the prefix', () => {
    for (const toolPrefix of ['', 'claudeui_', 'mcp__claude-ui-sessions__']) {
      const { intro, bullets } = sessionToolsGuidanceParts({ toolPrefix })
      expect(sessionToolsGuidance({ toolPrefix })).toBe(
        [intro, ...bullets.map((bullet) => `- ${bullet}`)].join('\n')
      )
      expect(bullets.length).toBeGreaterThan(0)
      // pi's promptGuidelines are single lines.
      for (const line of [intro, ...bullets]) expect(line).not.toContain('\n')
    }
  })

  it('names the tools as the engine spells them', () => {
    expect(sessionToolsGuidance({ toolPrefix: 'claudeui_' })).toContain('`claudeui_session_start`')
    expect(sessionToolsGuidance({ toolPrefix: '' })).toContain('`session_start`')
    expect(sessionToolsGuidance({ toolPrefix: '' })).not.toContain('claudeui_')
  })
})
