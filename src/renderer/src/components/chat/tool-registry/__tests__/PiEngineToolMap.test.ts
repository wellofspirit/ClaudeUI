/**
 * Unit tests for PiEngineToolMap — kindOf + normalize field-mapping.
 * Mirrors OpencodeEngineToolMap.test.ts's structure, adapted to pi's built-in
 * tool set (bash/read/write/edit/grep/find/ls) and input field names.
 */

import { describe, it, expect } from 'vitest'
import { PiEngineToolMap } from '../PiEngineToolMap'
import { deriveTaskState } from '../../task-state'
import type { ToolKind } from '../../../../../../shared/tool-kinds'
// Main can't import renderer code (separate Electron processes/bundles), so
// permission-engine.ts (src/main/pi/) keeps its OWN small copy of this exact
// kindOf switch for its mode-base gating decisions (see that file's doc
// comment). This is the single-source guard: it fails if the two tables ever
// disagree for a known pi tool name.
import { piToolKind } from '../../../../../../core/pi/permission-engine'

describe('PiEngineToolMap.kindOf', () => {
  const cases: [string, ToolKind][] = [
    ['bash', 'command'],
    ['edit', 'fileEdit'],
    ['write', 'fileWrite'],
    ['read', 'fileRead'],
    ['grep', 'search'],
    ['find', 'search'],
    ['ls', 'search'],
    // Hosted-tools MCP names resolve engine-independently (a future pi MCP
    // bridge would land here — pi's OWN hosted tools use bare names below).
    ['mcp__claude-ui__render_mermaid', 'diagram'],
    ['mcp__claude-ui-mockup__create_mockup', 'mockup'],
    ['mcp__some-server__tool', 'mcp'],
    // Hosted tools (M4a+b) registered via pi.registerTool() — BARE names
    // (hostedMcpKind above only matches mcp__* prefixed names).
    ['render_mermaid', 'diagram'],
    ['create_mockup', 'mockup'],
    ['show_mockup', 'mockup'],
    ['dispatch_agent', 'task'],
    // Host-run subagents (ADR-089) — the bridge's `agent` tool.
    ['agent', 'task'],
    // Legacy M5b `subagent` (old transcripts, pi's upstream example extension).
    ['subagent', 'task'],
    // Plan mode (M5a) — exit_plan, also a bare-name pi.registerTool() registration.
    ['exit_plan', 'plan'],
    // Unknown tool names fall through gracefully.
    ['skill', 'unknown'],
    ['invalid', 'unknown']
  ]

  it.each(cases)('kindOf(%s) === %s', (name, kind) => {
    expect(PiEngineToolMap.kindOf(name)).toBe(kind)
  })

  it('has an empty hidden set', () => {
    expect(PiEngineToolMap.hidden.size).toBe(0)
  })

  it.each(cases)(
    "single-source guard: main's piToolKind(%s) agrees with the renderer's kindOf",
    (name, kind) => {
      expect(piToolKind(name)).toBe(kind)
      expect(piToolKind(name)).toBe(PiEngineToolMap.kindOf(name))
    }
  )
})

describe('PiEngineToolMap.normalize', () => {
  it('command: maps command + result output', () => {
    const result = {
      type: 'tool_result',
      toolUseId: 'x',
      toolResult: 'total 0',
      isError: false
    } as const
    const view = PiEngineToolMap.normalize('command', { command: 'ls -la' }, result)
    expect(view).toMatchObject({ kind: 'command', command: 'ls -la', output: 'total 0' })
  })

  it('fileEdit: a single edit populates before/after from oldText/newText', () => {
    const view = PiEngineToolMap.normalize('fileEdit', {
      path: '/src/a.ts',
      edits: [{ oldText: 'foo', newText: 'bar' }]
    })
    expect(view).toMatchObject({ kind: 'fileEdit', path: '/src/a.ts', before: 'foo', after: 'bar' })
  })

  it('fileEdit: a multi-edit call (2+ edits) leaves before/after empty (generic fallback)', () => {
    const view = PiEngineToolMap.normalize('fileEdit', {
      path: '/src/a.ts',
      edits: [
        { oldText: 'foo', newText: 'bar' },
        { oldText: 'baz', newText: 'qux' }
      ]
    })
    expect(view).toMatchObject({ kind: 'fileEdit', path: '/src/a.ts', before: '', after: '' })
  })

  it('fileEdit: no edits array → empty before/after', () => {
    const view = PiEngineToolMap.normalize('fileEdit', { path: '/src/a.ts' })
    expect(view).toMatchObject({ kind: 'fileEdit', path: '/src/a.ts', before: '', after: '' })
  })

  it('fileEdit: no fileDiffs on the result -> no files (before/after fallback still used)', () => {
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'x',
      toolResult: 'Successfully replaced 1 block(s) in /src/a.ts.',
      isError: false
    }
    const view = PiEngineToolMap.normalize(
      'fileEdit',
      { path: '/src/a.ts', edits: [{ oldText: 'foo', newText: 'bar' }] },
      result
    )
    if (view.kind === 'fileEdit') {
      expect(view.files).toBeUndefined()
    }
  })

  it('fileEdit: M2 — result.fileDiffs (from event-mapper.ts) is surfaced AS `files`, mirroring OpencodeEngineToolMap', () => {
    const fileDiffs = [
      {
        path: '/src/a.ts',
        patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-foo\n+bar',
        changeType: 'update' as const,
        additions: 1,
        deletions: 1
      }
    ]
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'x',
      toolResult: 'Successfully replaced 1 block(s) in /src/a.ts.',
      isError: false,
      fileDiffs
    }
    const view = PiEngineToolMap.normalize(
      'fileEdit',
      { path: '/src/a.ts', edits: [{ oldText: 'foo', newText: 'bar' }] },
      result
    )
    expect(view).toMatchObject({ kind: 'fileEdit', path: '/src/a.ts', files: fileDiffs })
  })

  it('fileEdit: M2 — a multi-edit call ALSO surfaces `files` when the result carries fileDiffs (no more forced generic view)', () => {
    const fileDiffs = [
      {
        path: '/src/a.ts',
        patch: 'unified diff text',
        changeType: 'update' as const,
        additions: 2,
        deletions: 1
      }
    ]
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'x',
      toolResult: 'Successfully replaced 2 block(s) in /src/a.ts.',
      isError: false,
      fileDiffs
    }
    const view = PiEngineToolMap.normalize(
      'fileEdit',
      {
        path: '/src/a.ts',
        edits: [
          { oldText: 'foo', newText: 'bar' },
          { oldText: 'baz', newText: 'qux' }
        ]
      },
      result
    )
    expect(view).toMatchObject({
      kind: 'fileEdit',
      path: '/src/a.ts',
      before: '',
      after: '',
      files: fileDiffs
    })
  })

  it('fileEdit: an empty fileDiffs array on the result -> no files (defensive, mirrors OpencodeEngineToolMap)', () => {
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'x',
      toolResult: 'ok',
      isError: false,
      fileDiffs: []
    }
    const view = PiEngineToolMap.normalize('fileEdit', { path: '/src/a.ts' }, result)
    if (view.kind === 'fileEdit') {
      expect(view.files).toBeUndefined()
    }
  })

  it("fileWrite: maps pi's path/content → path/content", () => {
    const view = PiEngineToolMap.normalize('fileWrite', {
      path: '/src/new.ts',
      content: 'export const x = 1'
    })
    expect(view).toMatchObject({
      kind: 'fileWrite',
      path: '/src/new.ts',
      content: 'export const x = 1'
    })
  })

  it("fileRead: maps pi's path → path and result → content", () => {
    const result = {
      type: 'tool_result',
      toolUseId: 'x',
      toolResult: 'file contents',
      isError: false
    } as const
    const view = PiEngineToolMap.normalize('fileRead', { path: '/src/a.ts' }, result)
    expect(view).toMatchObject({ kind: 'fileRead', path: '/src/a.ts', content: 'file contents' })
  })

  it('search: grep/find map pattern → query', () => {
    const view = PiEngineToolMap.normalize('search', {
      pattern: 'TODO',
      path: '/src',
      ignoreCase: true
    })
    expect(view).toMatchObject({ kind: 'search', query: 'TODO' })
  })

  it('search: ls (no pattern field) falls back to path', () => {
    const view = PiEngineToolMap.normalize('search', { path: '/src', limit: 100 })
    expect(view).toMatchObject({ kind: 'search', query: '/src' })
  })

  it('search: neither pattern nor path → JSON summary of the input', () => {
    const view = PiEngineToolMap.normalize('search', { limit: 5 })
    expect(view).toMatchObject({ kind: 'search', query: JSON.stringify({ limit: 5 }) })
  })

  it('mcp / unknown: pass input through', () => {
    expect(PiEngineToolMap.normalize('mcp', { a: 1 })).toMatchObject({
      kind: 'mcp',
      input: { a: 1 }
    })
    expect(PiEngineToolMap.normalize('unknown', { b: 2 })).toMatchObject({
      kind: 'unknown',
      input: { b: 2 }
    })
  })

  it('plan: exit_plan maps its plan field straight through (M5a)', () => {
    const view = PiEngineToolMap.normalize('plan', { plan: '1. Do X\n2. Do Y' })
    expect(view).toEqual({ kind: 'plan', plan: '1. Do X\n2. Do Y' })
  })

  it('plan: a missing plan field normalizes to an empty string', () => {
    const view = PiEngineToolMap.normalize('plan', {})
    expect(view).toEqual({ kind: 'plan', plan: '' })
  })
})

describe('PiEngineToolMap.normalize — hosted tools (M4a+b)', () => {
  it('diagram: maps source/title straight through (render_mermaid args)', () => {
    const view = PiEngineToolMap.normalize('diagram', { source: 'graph TD; A-->B', title: 'Flow' })
    expect(view).toEqual({ kind: 'diagram', source: 'graph TD; A-->B', title: 'Flow' })
  })

  it('diagram: title is optional', () => {
    const view = PiEngineToolMap.normalize('diagram', { source: 'graph TD' })
    expect(view).toEqual({ kind: 'diagram', source: 'graph TD', title: undefined })
  })

  it('mockup: create_mockup input has no directory field -- extracted from the tool result text', () => {
    const result = {
      type: 'tool_result' as const,
      toolUseId: 'x',
      toolResult:
        'Mockup created successfully.\nDirectory: abc123\nPath: .claude/ui/mockups/abc123',
      isError: false
    }
    const view = PiEngineToolMap.normalize(
      'mockup',
      { html: '<div>hi</div>', title: 'My UI' },
      result
    )
    expect(view).toEqual({ kind: 'mockup', directory: 'abc123', title: 'My UI' })
  })

  it('mockup: show_mockup input carries directory directly (no result needed)', () => {
    const view = PiEngineToolMap.normalize('mockup', { directory: 'abc123' })
    expect(view).toEqual({ kind: 'mockup', directory: 'abc123', title: undefined })
  })

  it('mockup: no directory in input and no result -> undefined directory', () => {
    const view = PiEngineToolMap.normalize('mockup', { html: '<div>hi</div>' })
    expect(view).toEqual({ kind: 'mockup', directory: undefined, title: undefined })
  })

  it('task: dispatch_agent input (engine present) -> "Dispatch: <engine>" / the dispatch field', () => {
    const view = PiEngineToolMap.normalize('task', {
      engine: 'opencode',
      prompt: 'do X',
      model: 'openai/gpt-5'
    })
    expect(view).toEqual({
      kind: 'task',
      description: 'Dispatch: opencode',
      prompt: 'do X',
      dispatch: { engine: 'opencode', model: 'openai/gpt-5' }
    })
  })

  it('task: dispatch_agent without a model -> the dispatch field is just the engine', () => {
    const view = PiEngineToolMap.normalize('task', { engine: 'claude', prompt: 'do X' })
    expect(view).toEqual({
      kind: 'task',
      description: 'Dispatch: claude',
      prompt: 'do X',
      dispatch: { engine: 'claude' }
    })
  })

  it('task: no engine field (defensive fallback, unreachable for pi today) -> generic view', () => {
    const view = PiEngineToolMap.normalize('task', { prompt: 'do X' })
    expect(view).toMatchObject({ kind: 'task', description: '', prompt: 'do X' })
  })

  it('task: the agent tool ({description, prompt, subagent_type?, name?, model?}, ADR-089)', () => {
    expect(
      PiEngineToolMap.normalize('task', {
        description: 'Find the gate',
        prompt: 'Look for X',
        subagent_type: 'Explore',
        model: 'openai-codex/gpt-5.6-luna'
      })
    ).toEqual({
      kind: 'task',
      description: 'Find the gate',
      prompt: 'Look for X',
      subagent: 'Explore',
      name: 'Explore',
      model: 'openai-codex/gpt-5.6-luna',
      background: true
    })
    expect(
      PiEngineToolMap.normalize('task', { description: 'd', prompt: 'p', name: 'scout' })
    ).toEqual({
      kind: 'task',
      description: 'd',
      prompt: 'p',
      subagent: 'general-purpose',
      name: 'scout',
      background: true
    })
    // ADR-089 S3: background is the default; only an explicit false is foreground.
    expect(
      PiEngineToolMap.normalize('task', { description: 'd', prompt: 'p', run_in_background: false })
    ).toMatchObject({ kind: 'task', background: false })
    // Without description it is not the agent shape (the generic fallback stays).
    expect(PiEngineToolMap.normalize('task', { prompt: 'do X' })).toMatchObject({ description: '' })
  })

  it('task: subagent single mode ({agent, task}) -> "Subagent: <agent>" / subagent field is the bare agent name', () => {
    const view = PiEngineToolMap.normalize('task', { agent: 'echoer', task: 'say hi' })
    expect(view).toEqual({
      kind: 'task',
      description: 'Subagent: echoer',
      prompt: 'say hi',
      name: 'echoer',
      subagent: 'echoer'
    })
  })

  it('task: subagent parallel mode ({tasks: [...]}) -> "Subagents: a, b" / prompt lists each [agent] task', () => {
    const view = PiEngineToolMap.normalize('task', {
      tasks: [
        { agent: 'scout', task: 'find X' },
        { agent: 'planner', task: 'plan Y' }
      ]
    })
    expect(view).toEqual({
      kind: 'task',
      description: 'Subagents: scout, planner',
      prompt: '[scout] find X\n\n[planner] plan Y',
      // One tool_use id, two agents: the row counts them (ADR-073 §3).
      name: '2 subagents',
      subagent: 'scout, planner'
    })
  })

  it("task: subagent takes precedence over the generic fallback but dispatch_agent's `engine` field is checked FIRST (never confused with subagent input)", () => {
    // dispatch_agent's shape never carries `agent`/`tasks` -- this just proves
    // the two branches don't cross-contaminate for a pathological input that
    // (unrealistically) carried both.
    const view = PiEngineToolMap.normalize('task', {
      engine: 'claude',
      prompt: 'x',
      agent: 'echoer',
      task: 'y'
    })
    expect(view).toEqual({
      kind: 'task',
      description: 'Dispatch: claude',
      prompt: 'x',
      dispatch: { engine: 'claude' }
    })
  })
})

describe('PiEngineToolMap.displayName', () => {
  it("prettifies pi's lowercase built-in tool names", () => {
    expect(PiEngineToolMap.displayName('bash')).toBe('Bash')
    expect(PiEngineToolMap.displayName('read')).toBe('Read')
    expect(PiEngineToolMap.displayName('write')).toBe('Write')
    expect(PiEngineToolMap.displayName('edit')).toBe('Edit')
    expect(PiEngineToolMap.displayName('grep')).toBe('Grep')
    expect(PiEngineToolMap.displayName('find')).toBe('Find')
    expect(PiEngineToolMap.displayName('ls')).toBe('Ls')
  })

  it('passes an unrecognised name through unchanged', () => {
    expect(PiEngineToolMap.displayName('mystery_tool')).toBe('mystery_tool')
  })

  it('prettifies hosted tool bare names (M4a+b)', () => {
    expect(PiEngineToolMap.displayName('render_mermaid')).toBe('Mermaid')
    expect(PiEngineToolMap.displayName('create_mockup')).toBe('Mockup')
    expect(PiEngineToolMap.displayName('show_mockup')).toBe('Mockup')
    expect(PiEngineToolMap.displayName('dispatch_agent')).toBe('Dispatch')
    expect(PiEngineToolMap.displayName('subagent')).toBe('Subagent')
    expect(PiEngineToolMap.displayName('agent')).toBe('Agent')
  })
})

describe('PiEngineToolMap — agent background comes from the RESULT once there is one (ADR-089 S3 review R1)', () => {
  const input = { description: 'd', prompt: 'p' }
  const result = (toolResult: string, isError?: boolean) => ({
    type: 'tool_result' as const,
    toolUseId: 'call-1',
    toolResult,
    ...(isError === undefined ? {} : { isError })
  })
  const launched = result(
    "Async agent launched successfully.\nagentId: a (use send_message with to: 'a' to continue this agent.)\n…"
  )
  const stateOf = (background: boolean | undefined, hasResult: boolean, notified: boolean) =>
    deriveTaskState({
      isHistorical: false,
      hasActiveTask: false,
      isBackground: !!background,
      hasResult,
      notification: notified
        ? { taskId: 'a', toolUseId: 'call-1', status: 'completed', outputFile: '', summary: '' }
        : undefined,
      resultIsError: false
    })

  it('a call refused before any spawn (isError, no lifecycle record) is settled, not running', () => {
    const view = PiEngineToolMap.normalize(
      'task',
      input,
      result('Agent type "nope" not found. Available agents: general-purpose', true)
    )
    expect(view).toMatchObject({ kind: 'task', background: false })
    expect(stateOf(view.kind === 'task' ? view.background : undefined, true, false).isRunning).toBe(
      false
    )
  })

  it('an async-launched result is background: running until its notification', () => {
    const view = PiEngineToolMap.normalize('task', input, launched)
    expect(view).toMatchObject({ background: true })
    const bg = view.kind === 'task' ? view.background : undefined
    expect(stateOf(bg, true, false).isRunning).toBe(true)
    expect(stateOf(bg, true, true).isRunning).toBe(false)
  })

  it('a definition that forced background (input said false) reads background on reload', () => {
    const view = PiEngineToolMap.normalize('task', { ...input, run_in_background: false }, launched)
    expect(view).toMatchObject({ background: true })
  })

  it('a foreground report is not background; before a result the input decides', () => {
    expect(PiEngineToolMap.normalize('task', input, result('the report'))).toMatchObject({
      background: false
    })
    expect(PiEngineToolMap.normalize('task', input)).toMatchObject({ background: true })
  })
})

describe('PiEngineToolMap — send_message / task_stop rows (ADR-089 S3b)', () => {
  it('kinds mirror permission-engine (detail / note)', () => {
    expect(PiEngineToolMap.kindOf('send_message')).toBe('detail')
    expect(PiEngineToolMap.kindOf('task_stop')).toBe('note')
    expect(piToolKind('send_message')).toBe('detail')
    expect(piToolKind('task_stop')).toBe('note')
  })

  it('send_message: to + summary as fields, the message as the text; task_stop: a stop note', () => {
    expect(
      PiEngineToolMap.normalize('detail', { to: 'scout', summary: 'check X', message: 'also X' })
    ).toEqual({
      kind: 'detail',
      fields: [
        { label: 'to', value: 'scout' },
        { label: 'summary', value: 'check X' }
      ],
      text: 'also X'
    })
    expect(PiEngineToolMap.normalize('note', { task_id: 'scout' })).toEqual({
      kind: 'note',
      icon: 'stop',
      text: 'Stopped agent scout'
    })
  })

  it('task_stop: once the host answered, the row says what it said (a refusal is not a stop)', () => {
    expect(
      PiEngineToolMap.normalize(
        'note',
        { task_id: 'scout' },
        {
          type: 'tool_result',
          toolUseId: 't',
          toolResult: 'Agent scout is not running.',
          isError: true
        }
      )
    ).toEqual({ kind: 'note', icon: 'stop', text: 'Agent scout is not running.' })
  })
})
