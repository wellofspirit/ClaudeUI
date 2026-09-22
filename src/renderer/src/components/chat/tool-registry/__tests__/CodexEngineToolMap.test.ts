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
    // Slice 4b: an inherited MCP tool's approval card, in Claude's rule vocabulary.
    ['mcp__verify-stub__ping', 'mcp'],
    ['mcp__verify-stub', 'mcp'],
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
      // The path's leaf is also the agent's roster name (ADR-073).
      name: 'fixture_child',
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

/**
 * F20 — the history-mapper kinds. `kindOf` routes the seven new wire names and
 * `normalize` reads the shapes `mapCodexItem` emits for them.
 */
describe('CodexEngineToolMap — the F20 history-mapper kinds', () => {
  it.each([
    ['webSearch', 'web'],
    ['imageView', 'fileRead'],
    ['imageGeneration', 'image'],
    ['sleep', 'sleep'],
    ['plan', 'plan']
  ])('kindOf(%s) is %s', (name, kind) => {
    expect(CodexEngineToolMap.kindOf(name)).toBe(kind)
  })

  it('displayName: an mcp__ name reads as the KIND, not the rule vocabulary', () => {
    // The server and the tool are the card's SUMMARY line (`summary.ts`), so a
    // header repeating `mcp__<server>__<tool>` says it twice and reads as
    // machinery rather than as "an MCP call" (mockup § 2).
    expect(CodexEngineToolMap.displayName('mcp__verify-stub__ping')).toBe('MCP')
    expect(CodexEngineToolMap.displayName('mcp__verify-stub')).toBe('MCP')
  })

  it.each([
    ['webSearch', 'Web search'],
    ['imageView', 'Read'],
    ['imageGeneration', 'Image'],
    ['sleep', 'Sleep'],
    ['plan', 'Plan']
  ])('displayName(%s) is %s', (name, display) => {
    expect(CodexEngineToolMap.displayName(name)).toBe(display)
  })

  it('web: a search reads the query and the structured rows', () => {
    expect(
      CodexEngineToolMap.normalize('web', {
        query: 'electron 38',
        action: { type: 'search', query: 'electron 38' },
        results: [{ title: 'Electron 38', url: 'https://electronjs.org' }]
      })
    ).toEqual({
      kind: 'web',
      target: 'electron 38',
      action: 'search',
      results: [{ title: 'Electron 38', url: 'https://electronjs.org' }]
    })
  })

  /**
   * The REAL v2 wire tags. `protocol/v2/WebSearchAction.ts` spells them in CAMEL
   * case — `search | openPage | findInPage | other` — even though the core's own
   * Rust enum serialises snake_case, and matching only the snake_case spellings
   * demoted every page fetch to `other`: the label read "Web" and `target` fell
   * back to a `query` an openPage item need not carry.
   */
  it('web: openPage reads the url and takes the fetch action (v2 camelCase)', () => {
    expect(
      CodexEngineToolMap.normalize('web', {
        query: 'https://electronjs.org',
        action: { type: 'openPage', url: 'https://electronjs.org' }
      })
    ).toEqual({ kind: 'web', target: 'https://electronjs.org', action: 'fetch' })
  })

  it('web: findInPage reads the url and takes the find action (v2 camelCase)', () => {
    expect(
      CodexEngineToolMap.normalize('web', {
        query: "'needle' in https://e.test",
        action: { type: 'findInPage', url: 'https://e.test', pattern: 'needle' }
      })
    ).toEqual({ kind: 'web', target: 'https://e.test', action: 'find' })
  })

  it('web: an openPage with no query still reads its url as the target', () => {
    // The shape that made the old snake_case match render a BLANK target.
    expect(
      CodexEngineToolMap.normalize('web', {
        action: { type: 'openPage', url: 'https://electronjs.org/docs' }
      })
    ).toMatchObject({ target: 'https://electronjs.org/docs', action: 'fetch' })
  })

  it('web: the core\u2019s snake_case spellings are accepted too', () => {
    // Belt and braces: the app-server projects camelCase today, but the core's
    // own serialisation is snake_case and a projection change must not silently
    // demote a fetch to `other`.
    expect(
      CodexEngineToolMap.normalize('web', {
        action: { type: 'open_page', url: 'https://e.test' }
      })
    ).toMatchObject({ target: 'https://e.test', action: 'fetch' })
    expect(
      CodexEngineToolMap.normalize('web', {
        action: { type: 'find_in_page', url: 'https://e.test', pattern: 'x' }
      })
    ).toMatchObject({ target: 'https://e.test', action: 'find' })
  })

  it('web: an openPage whose url the wire omitted falls back to the query', () => {
    expect(
      CodexEngineToolMap.normalize('web', {
        query: 'https://fallback.test',
        action: { type: 'openPage', url: null }
      })
    ).toMatchObject({ target: 'https://fallback.test', action: 'fetch' })
  })

  it('web: an item with no action at all takes `other` and keeps the query', () => {
    expect(CodexEngineToolMap.normalize('web', { query: 'x' })).toEqual({
      kind: 'web',
      target: 'x',
      action: 'other'
    })
  })

  it('mcp: splits mcp__<server>__<tool> off the NAME and unwraps the envelope', () => {
    expect(
      CodexEngineToolMap.normalize(
        'mcp',
        { arguments: { host: 'example.test' }, readOnlyHint: true },
        undefined,
        'mcp__verify-stub__ping'
      )
    ).toEqual({
      kind: 'mcp',
      input: { host: 'example.test' },
      server: 'verify-stub',
      tool: 'ping',
      readOnly: true
    })
  })

  it('mcp: a tool name containing __ stays whole; a server-only name has no tool', () => {
    expect(
      CodexEngineToolMap.normalize('mcp', { arguments: {} }, undefined, 'mcp__srv__a__b')
    ).toMatchObject({ server: 'srv', tool: 'a__b' })
    const serverOnly = CodexEngineToolMap.normalize(
      'mcp',
      { arguments: {} },
      undefined,
      'mcp__verify-stub'
    )
    expect(serverOnly).toMatchObject({ server: 'verify-stub' })
    expect('tool' in serverOnly).toBe(false)
  })

  it('mcp: an input without the envelope falls back to itself rather than blanking', () => {
    expect(
      CodexEngineToolMap.normalize('mcp', { host: 'x' }, undefined, 'mcp__srv__tool')
    ).toMatchObject({ input: { host: 'x' } })
  })

  it('fileRead: imageView is a path with no text body', () => {
    expect(CodexEngineToolMap.normalize('fileRead', { path: '/tmp/shot.png' })).toEqual({
      kind: 'fileRead',
      path: '/tmp/shot.png',
      content: ''
    })
  })

  it('image: carries the revised prompt and the saved path, omitting what is absent', () => {
    expect(
      CodexEngineToolMap.normalize('image', { prompt: 'a cat', savedPath: '/tmp/cat.png' })
    ).toEqual({ kind: 'image', prompt: 'a cat', savedPath: '/tmp/cat.png' })
    expect(CodexEngineToolMap.normalize('image', {})).toEqual({ kind: 'image' })
  })

  it('sleep: reads the duration, and a missing one is zero rather than NaN', () => {
    expect(CodexEngineToolMap.normalize('sleep', { durationMs: 2500 })).toEqual({
      kind: 'sleep',
      durationMs: 2500
    })
    expect(CodexEngineToolMap.normalize('sleep', {})).toEqual({ kind: 'sleep', durationMs: 0 })
  })

  it('plan: reads the markdown the plan card renders', () => {
    expect(CodexEngineToolMap.normalize('plan', { plan: '## Step one' })).toEqual({
      kind: 'plan',
      plan: '## Step one'
    })
  })
})
