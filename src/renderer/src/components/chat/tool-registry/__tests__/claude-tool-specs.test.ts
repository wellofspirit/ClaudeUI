/**
 * The per-tool specs for Claude's twenty previously-unmapped tools.
 *
 * Two guards matter here. First, that every tool cli.js 2.1.268 can hand us has
 * a shape (docs/tool-survey.md § 7 is the census this list mirrors) — a
 * regression here means a tool silently went back to dumping its own JSON.
 * Second, that a spec never invents a field: the input is whatever the model
 * sent, so a missing or wrongly-typed value must drop out rather than render as
 * "undefined".
 */

import { describe, it, expect } from 'vitest'
import { ClaudeEngineToolMap } from '../ClaudeEngineToolMap'
import { claudeToolSpec, humanDelay } from '../claude-tool-specs'
import { summarizeTool } from '../summary'
import type { ContentBlock } from '../../../../../../shared/types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>
const res = (text: string, isError = false): ToolResultBlock => ({
  type: 'tool_result',
  toolUseId: 't',
  toolResult: text,
  isError
})

/** The tools the init probe lists that used to fall through to `unknown`. */
const NEWLY_SHAPED: [string, string][] = [
  ['Skill', 'detail'],
  ['Monitor', 'detail'],
  ['TaskOutput', 'detail'],
  ['Workflow', 'detail'],
  ['Artifact', 'detail'],
  ['ListAgents', 'detail'],
  ['SendMessage', 'detail'],
  ['ScheduleWakeup', 'detail'],
  ['CronCreate', 'detail'],
  ['RemoteTrigger', 'detail'],
  ['EnterWorktree', 'detail'],
  ['ShareOnboardingGuide', 'detail'],
  ['DesignSync', 'detail'],
  ['ReportFindings', 'findings'],
  ['ToolSearch', 'note'],
  ['TaskStop', 'note'],
  ['PushNotification', 'note'],
  ['CronDelete', 'note'],
  ['CronList', 'note'],
  ['ExitWorktree', 'note'],
  ['SendUserFile', 'note']
]

describe('kind coverage', () => {
  it.each(NEWLY_SHAPED)('%s is classified as %s, not unknown', (tool, kind) => {
    expect(ClaudeEngineToolMap.kindOf(tool)).toBe(kind)
  })

  it('leaves a name with no spec on unknown, rather than guessing a shape', () => {
    expect(ClaudeEngineToolMap.kindOf('SomeFutureTool')).toBe('unknown')
    expect(claudeToolSpec('SomeFutureTool')).toBeNull()
  })

  it('reads NotebookEdit as a file edit, with the cell source as the diff', () => {
    expect(ClaudeEngineToolMap.kindOf('NotebookEdit')).toBe('fileEdit')
    const view = ClaudeEngineToolMap.normalize(
      'fileEdit',
      { notebook_path: '/a/b.ipynb', old_source: 'x = 1', new_source: 'x = 2' },
      undefined,
      'NotebookEdit'
    )
    expect(view).toEqual({
      kind: 'fileEdit',
      path: '/a/b.ipynb',
      before: 'x = 1',
      after: 'x = 2'
    })
  })

  it('keeps MultiEdit mapped so old transcripts still render as edits', () => {
    expect(ClaudeEngineToolMap.kindOf('MultiEdit')).toBe('fileEdit')
  })
})

describe('detail specs', () => {
  const build = (tool: string, input: Record<string, unknown>, result?: ToolResultBlock) =>
    ClaudeEngineToolMap.normalize(ClaudeEngineToolMap.kindOf(tool), input, result, tool)

  it('names a skill and its arguments, and shows what it loaded', () => {
    const view = build(
      'Skill',
      { skill: 'verifier-electron', args: '--testid x' },
      res('Launching')
    )
    expect(view).toEqual({
      kind: 'detail',
      fields: [
        { label: 'skill', value: 'verifier-electron' },
        { label: 'args', value: '--testid x' }
      ],
      text: 'Launching'
    })
  })

  it('drops a field the call did not carry instead of rendering undefined', () => {
    const view = build('Skill', { skill: 'unslop' })
    expect(view).toEqual({ kind: 'detail', fields: [{ label: 'skill', value: 'unslop' }] })
  })

  it('states a cron schedule, its prompt and whether it repeats', () => {
    const view = build('CronCreate', {
      cron: '0 9 * * 1-5',
      prompt: 'Check CI',
      recurring: false
    })
    expect(view.kind === 'detail' && view.fields).toEqual([
      { label: 'schedule', value: '0 9 * * 1-5' },
      { label: 'prompt', value: 'Check CI' },
      { label: 'recurring', value: 'once' }
    ])
  })

  it('reads a wake-up as a delay a person can parse, and a stop as a stop', () => {
    const wake = build('ScheduleWakeup', { delaySeconds: 1200, reason: 'watching CI', noop: true })
    expect(wake.kind === 'detail' && wake.fields[0]).toEqual({ label: 'wakes in', value: '20 min' })
    const stop = build('ScheduleWakeup', { stop: true })
    expect(stop.kind === 'detail' && stop.fields).toEqual([{ label: 'loop', value: 'stopped' }])
  })

  it('puts a sent message in the body rather than in a field row', () => {
    const view = build('SendMessage', { to: 'reviewer', message: 'start on part 1' })
    expect(view).toEqual({
      kind: 'detail',
      fields: [{ label: 'to', value: 'reviewer' }],
      text: 'start on part 1'
    })
  })

  it('summarises a detail card with its first field', () => {
    const view = build('Skill', { skill: 'verifier-electron' })
    expect(summarizeTool('detail', view)).toBe('verifier-electron')
  })
})

describe('findings spec', () => {
  it('maps each finding to its claim, place and verdict', () => {
    const view = ClaudeEngineToolMap.normalize(
      'findings',
      {
        level: 'high',
        findings: [
          {
            file: 'a.ts',
            line: 12,
            short_summary: 'recall drops a boundary',
            summary: 'flushQueuedItems returns before the forward resolves',
            category: 'correctness',
            verdict: 'CONFIRMED'
          }
        ]
      },
      undefined,
      'ReportFindings'
    )
    expect(view).toEqual({
      kind: 'findings',
      level: 'high',
      findings: [
        {
          file: 'a.ts',
          line: 12,
          summary: 'recall drops a boundary',
          detail: 'flushQueuedItems returns before the forward resolves',
          category: 'correctness',
          verdict: 'CONFIRMED',
          outcome: undefined
        }
      ]
    })
  })

  it('survives a findings array that is absent or malformed', () => {
    const empty = ClaudeEngineToolMap.normalize('findings', {}, undefined, 'ReportFindings')
    expect(empty).toEqual({ kind: 'findings', level: undefined, findings: [] })
  })

  it('counts confirmed findings in the header summary', () => {
    const view = ClaudeEngineToolMap.normalize(
      'findings',
      {
        findings: [
          { summary: 'a', verdict: 'CONFIRMED' },
          { summary: 'b', verdict: 'PLAUSIBLE' }
        ]
      },
      undefined,
      'ReportFindings'
    )
    expect(summarizeTool('findings', view)).toBe('2 findings · 1 confirmed')
  })
})

describe('note specs', () => {
  const text = (tool: string, input: Record<string, unknown>): string => {
    const view = ClaudeEngineToolMap.normalize('note', input, undefined, tool)
    return view.kind === 'note' ? view.text : ''
  }

  it('says what ToolSearch actually did, for both query forms', () => {
    expect(text('ToolSearch', { query: 'select:Read,Edit' })).toBe(
      'Loaded 2 tool schemas: Read, Edit'
    )
    expect(text('ToolSearch', { query: 'notebook jupyter' })).toBe(
      'Searched tools for "notebook jupyter"'
    )
  })

  it('names the task that was stopped', () => {
    expect(text('TaskStop', { task_id: 'bash_01H9' })).toBe('Stopped background task bash_01H9')
  })

  it('distinguishes leaving a worktree from cleaning one up', () => {
    expect(text('ExitWorktree', { action: 'remove', discard_changes: true })).toBe(
      'Cleaned up the worktree, discarding its changes'
    )
    expect(text('ExitWorktree', {})).toBe('Left the worktree')
  })

  it('lists sent files by name with the caption', () => {
    expect(text('SendUserFile', { files: ['/a/b/report.md'], caption: 'the draft' })).toBe(
      'Sent 1 file: report.md — the draft'
    )
    expect(text('SendUserFile', { files: [] })).toBe('Sent a file')
  })
})

describe('humanDelay', () => {
  it.each([
    [45, '45 s'],
    [90, '2 min'],
    [1200, '20 min'],
    [3600, '60 min'],
    [7500, '2 h 5 min']
  ])('%i seconds reads as %s', (seconds, expected) => {
    expect(humanDelay(seconds)).toBe(expected)
  })

  it('refuses to invent a number for a nonsense delay', () => {
    expect(humanDelay(Number.NaN)).toBe('?')
    expect(humanDelay(-5)).toBe('?')
  })
})
