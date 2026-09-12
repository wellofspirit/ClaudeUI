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
    // Cross-engine dispatch (slice E) rides the same bare-name channel and
    // renders on the engine-neutral TaskCard, exactly as pi's does.
    ['dispatch_agent', 'task'],
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

/**
 * Cross-engine dispatch (slice E). `dispatch_agent` reaches Codex over the same
 * dynamic-tool channel as the hosted three, under the same bare name pi uses,
 * so it normalizes to the engine-neutral `task` shape TaskCard renders.
 */
describe('CodexEngineToolMap — dispatch_agent', () => {
  it('names it the way every other engine does', () => {
    expect(CodexEngineToolMap.displayName('dispatch_agent')).toBe('Dispatch')
  })

  it('task: the target engine is the discriminator, the model rides the subtitle', () => {
    expect(
      CodexEngineToolMap.normalize('task', {
        engine: 'claude',
        prompt: 'summarise the repo',
        model: 'haiku'
      })
    ).toEqual({
      kind: 'task',
      description: 'Dispatch: claude',
      prompt: 'summarise the repo',
      subagent: 'claude · haiku'
    })
  })

  it('task: no model means the engine alone', () => {
    expect(CodexEngineToolMap.normalize('task', { engine: 'pi', prompt: 'run tests' })).toEqual({
      kind: 'task',
      description: 'Dispatch: pi',
      prompt: 'run tests',
      subagent: 'pi'
    })
  })
})

/**
 * Native children (slice F). `collab:spawnAgent` is the ONLY collab call that
 * owns a subagent transcript, so it is the only one that takes the `task` kind;
 * the rest are agent bookkeeping and render through the generic body.
 */
describe('CodexEngineToolMap — collab agent tools', () => {
  it('gives the spawn call the engine-neutral subagent kind', () => {
    expect(CodexEngineToolMap.kindOf('collab:spawnAgent')).toBe('task')
  })

  it('leaves the bookkeeping calls on the generic body', () => {
    for (const tool of ['wait', 'sendInput', 'closeAgent', 'resumeAgent', 'listAgents'])
      expect(CodexEngineToolMap.kindOf(`collab:${tool}`)).toBe('unknown')
  })

  it('names each collab call', () => {
    expect(CodexEngineToolMap.displayName('collab:spawnAgent')).toBe('Agent')
    expect(CodexEngineToolMap.displayName('collab:wait')).toBe('Wait for agents')
    expect(CodexEngineToolMap.displayName('collab:sendInput')).toBe('Message agent')
    expect(CodexEngineToolMap.displayName('collab:closeAgent')).toBe('Close agent')
  })

  it('task: a spawn normalizes off receiverThreadIds, never the dispatch shape', () => {
    expect(
      CodexEngineToolMap.normalize('task', {
        prompt: 'survey the tests',
        model: 'gpt-mock',
        reasoningEffort: 'high',
        receiverThreadIds: ['child-1'],
        agentsStates: { 'child-1': { status: 'running', message: null } }
      })
    ).toEqual({
      kind: 'task',
      description: 'Agent',
      prompt: 'survey the tests',
      subagent: 'gpt-mock',
      model: 'gpt-mock'
    })
  })

  it('task: a spawn with no model still reads as an agent, not as a dispatch', () => {
    expect(
      CodexEngineToolMap.normalize('task', { prompt: 'go', model: null, receiverThreadIds: [] })
    ).toMatchObject({ kind: 'task', description: 'Agent', prompt: 'go' })
  })
})

describe('CodexEngineToolMap — v2 sub-agent activity cards', () => {
  it('task: a v2 spawn card has no prompt or model, so the agent path names it', () => {
    expect(
      CodexEngineToolMap.normalize('task', {
        agentPath: '/root/fixture_child',
        receiverThreadIds: ['child-1'],
        agentsStates: {}
      })
    ).toEqual({
      kind: 'task',
      description: 'Agent',
      prompt: '',
      subagent: '/root/fixture_child'
    })
  })

  it('task: an explicit model still wins over the agent path', () => {
    expect(
      CodexEngineToolMap.normalize('task', {
        agentPath: '/root/fixture_child',
        model: 'gpt-mock',
        receiverThreadIds: ['child-1']
      })
    ).toMatchObject({ subagent: 'gpt-mock', model: 'gpt-mock' })
  })
})
