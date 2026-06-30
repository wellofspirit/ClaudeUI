/**
 * Unit tests for the auto-mode classifier core (ADR-023) — pure functions +
 * the orchestrator with an injected fake judge. No model calls.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  slimTranscript,
  renderAction,
  buildUserPrompt,
  buildSystemPrompt,
  parseVerdict,
  classify,
  type ClassifyInput
} from '../auto-mode-classifier'
import type { ChatMessage } from '../../../shared/types'

function msg(role: 'user' | 'assistant', content: ChatMessage['content']): ChatMessage {
  return { id: `m${Math.round(content.length)}`, role, content, timestamp: 0 }
}

describe('slimTranscript', () => {
  it('keeps user text + assistant tool CALLS; drops prose/thinking/results', () => {
    const messages: ChatMessage[] = [
      msg('user', [{ type: 'text', text: 'research chatview' }]),
      msg('assistant', [
        { type: 'thinking', text: 'let me think...' },
        { type: 'text', text: 'Sure, I will explore.' },
        { type: 'tool_use', toolUseId: 't1', toolName: 'grep', toolInput: { pattern: 'ChatPanel' } }
      ]),
      msg('user', [{ type: 'tool_result', toolUseId: 't1', toolResult: 'a.tsx\nb.tsx', isError: false }])
    ]
    expect(slimTranscript(messages)).toBe('User: research chatview\ngrep {"pattern":"ChatPanel"}')
  })

  it('skips empty user text', () => {
    expect(slimTranscript([msg('user', [{ type: 'text', text: '   ' }])])).toBe('')
  })
})

describe('renderAction + buildUserPrompt + buildSystemPrompt', () => {
  it('renders the proposed action as toolName <input>', () => {
    expect(renderAction({ toolName: 'bash', input: { command: 'rm -rf /' } })).toBe('bash {"command":"rm -rf /"}')
  })
  it('wraps transcript + action + instruction', () => {
    const input: ClassifyInput = {
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      action: { toolName: 'bash', input: { command: 'ls' } }
    }
    const p = buildUserPrompt(input, 'INSTRUCT')
    expect(p).toContain('<transcript>')
    expect(p).toContain('User: hi')
    expect(p).toContain('Proposed next action:\nbash {"command":"ls"}')
    expect(p).toContain('INSTRUCT')
  })
  it('appends environment to the system prompt when provided', () => {
    expect(buildSystemPrompt('repo=foo')).toContain('## Environment\nrepo=foo')
    expect(buildSystemPrompt()).not.toContain('## Environment')
  })
})

describe('parseVerdict (fail-closed)', () => {
  it('parses yes/no, closing tag optional', () => {
    expect(parseVerdict('<block>yes</block>').block).toBe(true)
    expect(parseVerdict('<block>no</block>').block).toBe(false)
    expect(parseVerdict('...<block>yes').block).toBe(true) // truncated by stop seq
  })
  it('extracts reason', () => {
    expect(parseVerdict('<block>yes</block><reason>destructive</reason>').reason).toBe('destructive')
  })
  it('unparseable → block (fail-closed)', () => {
    expect(parseVerdict('I cannot help with that').block).toBe(true)
    expect(parseVerdict('').block).toBe(true)
  })
})

describe('classify (orchestrator)', () => {
  const base: ClassifyInput = {
    messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    action: { toolName: 'bash', input: { command: 'ls' } }
  }

  it('fast mode → single call, returns its verdict', async () => {
    const judge = vi.fn().mockResolvedValue('<block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'fast' }, judge)
    expect(r).toMatchObject({ block: false, stage: 'fast' })
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('both mode: terse ALLOW short-circuits (no second call)', async () => {
    const judge = vi.fn().mockResolvedValue('<block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r.block).toBe(false)
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('both mode: terse BLOCK escalates to a reasoning pass', async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce('<block>yes</block>')
      .mockResolvedValueOnce('<thinking>actually fine</thinking><block>no</block>')
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: false, stage: 'thinking' })
    expect(judge).toHaveBeenCalledTimes(2)
  })

  it('fail-closed: judge throws → block + unavailable, no escalation', async () => {
    const judge = vi.fn().mockRejectedValue(new Error('judge down'))
    const r = await classify({ ...base, twoStageMode: 'both' }, judge)
    expect(r).toMatchObject({ block: true, unavailable: true, stage: 'error' })
    expect(judge).toHaveBeenCalledTimes(1)
  })
})
