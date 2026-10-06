import { describe, it, expect } from 'vitest'
import { deriveSessionDotState, statusDotLabel, type SessionDotInput } from '../StatusDot'

const base: SessionDotInput = {
  active: false,
  needsAttention: false,
  isRunning: false,
  isSdkActive: false,
  isWatching: false,
  runningSubagents: 0
}
const derive = (o: Partial<SessionDotInput>): string => deriveSessionDotState({ ...base, ...o })

describe('deriveSessionDotState', () => {
  it('attention beats running beats subagents', () => {
    const all = { needsAttention: true, isRunning: true, isSdkActive: true, runningSubagents: 2 }
    expect(derive(all)).toBe('attention')
    expect(derive({ ...all, needsAttention: false })).toBe('running')
    expect(derive({ ...all, needsAttention: false, isRunning: false })).toBe('subagents')
  })

  it('an idle live session with subagents still working is `subagents`, not `idle`', () => {
    expect(derive({ isSdkActive: true, runningSubagents: 1 })).toBe('subagents')
    expect(derive({ isSdkActive: true, runningSubagents: 0 })).toBe('idle')
  })

  it('stale task records on a dead process are not `subagents`', () => {
    expect(derive({ runningSubagents: 1 })).toBe('inactive')
    expect(derive({ isWatching: true, runningSubagents: 1 })).toBe('watching')
  })

  it('the active session does not show attention', () => {
    expect(derive({ active: true, needsAttention: true, isSdkActive: true })).toBe('idle')
  })

  it('falls through to watching, then inactive', () => {
    expect(derive({ isWatching: true })).toBe('watching')
    expect(derive({})).toBe('inactive')
  })
})

describe('statusDotLabel', () => {
  it('names the state alone with no subagents', () => {
    expect(statusDotLabel('running', 0)).toBe('Working')
    expect(statusDotLabel('inactive', 0)).toBe('Not running')
  })

  it('appends the subagent count, singular and plural', () => {
    expect(statusDotLabel('running', 1)).toBe('Working · 1 subagent running')
    expect(statusDotLabel('attention', 3)).toBe('Needs attention · 3 subagents running')
  })

  it('the subagents state reads as just the count', () => {
    expect(statusDotLabel('subagents', 1)).toBe('1 subagent running')
    expect(statusDotLabel('subagents', 2)).toBe('2 subagents running')
  })
})
