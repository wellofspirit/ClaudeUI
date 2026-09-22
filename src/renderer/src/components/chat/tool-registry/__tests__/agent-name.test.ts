/**
 * Every engine's spawn tool has to say what to CALL the agent (ADR-073).
 *
 * Without it a fan-out of four Explore agents renders four identical rows, and
 * nothing can tie a `SendMessage{to: "reviewer"}` back to the agent it
 * addressed. The four engines keep the name in four different places, which is
 * exactly why the ToolView carries one normalized field.
 */
import { describe, expect, it } from 'vitest'
import { ClaudeEngineToolMap } from '../ClaudeEngineToolMap'
import { OpencodeEngineToolMap } from '../OpencodeEngineToolMap'
import { PiEngineToolMap } from '../PiEngineToolMap'
import { CodexEngineToolMap } from '../CodexEngineToolMap'

const nameOf = (view: { kind: string }): string | undefined => (view as { name?: string }).name

describe('task ToolView — agent name', () => {
  it('claude prefers the Agent call’s name over its type', () => {
    const view = ClaudeEngineToolMap.normalize('task', {
      name: 'reviewer',
      subagent_type: 'Explore',
      description: 'audit',
      prompt: 'p'
    })
    expect(nameOf(view)).toBe('reviewer')
    // The badge is unchanged — `subagent` still carries the TYPE.
    expect((view as { subagent?: string }).subagent).toBe('Explore')
  })

  it('claude falls back to the subagent type when the call was unnamed', () => {
    expect(nameOf(ClaudeEngineToolMap.normalize('task', { subagent_type: 'Explore' }))).toBe(
      'Explore'
    )
    // Older transcripts used camelCase.
    expect(nameOf(ClaudeEngineToolMap.normalize('task', { subagentType: 'Plan' }))).toBe('Plan')
    expect(
      nameOf(ClaudeEngineToolMap.normalize('task', { description: 'no type' }))
    ).toBeUndefined()
  })

  it('opencode uses the subagent type it has', () => {
    expect(nameOf(OpencodeEngineToolMap.normalize('task', { subagent_type: 'general' }))).toBe(
      'general'
    )
    expect(nameOf(OpencodeEngineToolMap.normalize('task', { description: 'x' }))).toBeUndefined()
  })

  it('pi names a single subagent, and counts a parallel batch', () => {
    expect(nameOf(PiEngineToolMap.normalize('task', { agent: 'explorer', task: 't' }))).toBe(
      'explorer'
    )
    // One tool_use id, N agents — the row says so rather than picking one.
    expect(
      nameOf(
        PiEngineToolMap.normalize('task', {
          tasks: [
            { agent: 'a', task: 't1' },
            { agent: 'b', task: 't2' },
            { agent: 'c', task: 't3' }
          ]
        })
      )
    ).toBe('3 subagents')
    expect(
      nameOf(PiEngineToolMap.normalize('task', { tasks: [{ agent: 'solo', task: 't' }] }))
    ).toBe('solo')
  })

  it('codex takes the leaf of the agent path', () => {
    expect(
      nameOf(
        CodexEngineToolMap.normalize('task', {
          receiverThreadIds: ['t1'],
          agentPath: '/root/probe'
        })
      )
    ).toBe('probe')
    expect(
      nameOf(CodexEngineToolMap.normalize('task', { receiverThreadIds: ['t1'], model: 'gpt-5' }))
    ).toBeUndefined()
  })

  it('leaves cross-engine dispatch cards unnamed on every engine', () => {
    // Dispatch has no agent identity — its badge is "<engine> · <model>".
    for (const map of [ClaudeEngineToolMap, OpencodeEngineToolMap, PiEngineToolMap]) {
      const view = map.normalize('task', { engine: 'codex', model: 'gpt-5', prompt: 'p' })
      expect(nameOf(view)).toBeUndefined()
      expect((view as { subagent?: string }).subagent).toBe('codex · gpt-5')
    }
  })
})
