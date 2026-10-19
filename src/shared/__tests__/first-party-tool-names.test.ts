/**
 * The first-party tool name table: ClaudeUI's own tools get product names in each
 * engine's spelling, and nothing that is not ours does.
 */
import { describe, expect, it } from 'vitest'
import {
  DISPATCH_LABEL,
  firstPartyDisplayName,
  firstPartyToolLabel
} from '../first-party-tool-names'
import { SESSION_TOOL_NAMES } from '../session-tools-description'
import { dispatchTaskView, taskHeaderLabel } from '../tool-kinds'

describe('firstPartyToolLabel', () => {
  it.each([
    ['dispatch_agent', 'X-Agent'],
    ['render_mermaid', 'Diagram'],
    ['create_mockup', 'Mockup'],
    ['show_mockup', 'Mockup'],
    ['session_start', 'Session · start'],
    ['session_hand_off', 'Session · hand off'],
    ['session_dismiss_proposal', 'Session · dismiss proposal']
  ])('%s -> %s', (bare, label) => {
    expect(firstPartyToolLabel(bare)).toBe(label)
  })

  it('names every session tool, and nothing else', () => {
    for (const name of SESSION_TOOL_NAMES) {
      expect(firstPartyToolLabel(name)).toMatch(/^Session · /)
    }
    for (const other of ['Bash', 'read', 'session_nope', 'toString', '__proto__', 'constructor']) {
      expect(firstPartyToolLabel(other), other).toBeUndefined()
    }
  })
})

describe('firstPartyDisplayName: each engine strips its own prefix only', () => {
  it('mcp (Claude): the first-party servers, and only their own tools', () => {
    expect(firstPartyDisplayName('mcp__claude-ui-collab__dispatch_agent', 'mcp')).toBe('X-Agent')
    expect(firstPartyDisplayName('mcp__claude-ui-sessions__session_stop', 'mcp')).toBe(
      'Session · stop'
    )
    expect(firstPartyDisplayName('mcp__claude-ui__render_mermaid', 'mcp')).toBe('Diagram')
    expect(firstPartyDisplayName('mcp__claude-ui-mockup__show_mockup', 'mcp')).toBe('Mockup')
    // Third-party and wrong-server names are not ours.
    expect(firstPartyDisplayName('mcp__github__create_issue', 'mcp')).toBeUndefined()
    expect(firstPartyDisplayName('mcp__github__dispatch_agent', 'mcp')).toBeUndefined()
    expect(firstPartyDisplayName('mcp__claude-ui__dispatch_agent', 'mcp')).toBeUndefined()
    expect(firstPartyDisplayName('mcp__claude-ui-collab__session_start', 'mcp')).toBeUndefined()
    expect(firstPartyDisplayName('mcp__constructor__constructor', 'mcp')).toBeUndefined()
    expect(firstPartyDisplayName('mcp__claude-ui-collab__dispatch_agent__x', 'mcp')).toBeUndefined()
    expect(firstPartyDisplayName('dispatch_agent', 'mcp')).toBeUndefined()
    expect(firstPartyDisplayName('claudeui_dispatch_agent', 'mcp')).toBeUndefined()
  })

  it('claudeui_ (opencode): only the prefixed spelling', () => {
    expect(firstPartyDisplayName('claudeui_dispatch_agent', 'claudeui_')).toBe('X-Agent')
    expect(firstPartyDisplayName('claudeui_session_list', 'claudeui_')).toBe('Session · list')
    expect(firstPartyDisplayName('dispatch_agent', 'claudeui_')).toBeUndefined()
    expect(firstPartyDisplayName('claudeui_bash', 'claudeui_')).toBeUndefined()
    expect(
      firstPartyDisplayName('mcp__claude-ui-collab__dispatch_agent', 'claudeui_')
    ).toBeUndefined()
  })

  it('bare (pi, Codex): only the bare spelling', () => {
    expect(firstPartyDisplayName('dispatch_agent', 'bare')).toBe('X-Agent')
    expect(firstPartyDisplayName('session_message', 'bare')).toBe('Session · message')
    expect(firstPartyDisplayName('claudeui_dispatch_agent', 'bare')).toBeUndefined()
    expect(firstPartyDisplayName('read', 'bare')).toBeUndefined()
  })
})

describe('dispatchTaskView: name and description', () => {
  it('takes them from the input when present', () => {
    expect(
      dispatchTaskView({
        engine: 'pi',
        prompt: 'p',
        name: ' impl-e1 ',
        description: 'Review auth diff'
      })
    ).toMatchObject({
      kind: 'task',
      name: 'impl-e1',
      description: 'Review auth diff',
      dispatch: { engine: 'pi' }
    })
  })

  it('falls back to "Dispatch: <engine>" and no name; blank or non-string values count as absent', () => {
    for (const extra of [{}, { name: '  ', description: '' }, { name: 3, description: null }]) {
      const view = dispatchTaskView({ engine: 'codex', prompt: 'p', ...extra })
      expect(view.description).toBe('Dispatch: codex')
      expect('name' in view).toBe(false)
    }
  })
})

describe('taskHeaderLabel', () => {
  it('a dispatch reads X-Agent, a native subagent Task', () => {
    expect(taskHeaderLabel(dispatchTaskView({ engine: 'pi' }))).toBe(DISPATCH_LABEL)
    expect(taskHeaderLabel({})).toBe('Task')
  })
})
