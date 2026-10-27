import { describe, expect, it } from 'vitest'
import type { AutonomyMode } from '../model-capabilities'
import { AUTONOMY_TO_PERMISSION } from '../permission-modes'
import { modeClass, stricterMode } from '../mode-class'

describe('modeClass', () => {
  it('ranks plan < default < acceptEdits < auto < bypassPermissions, dontAsk beside default', () => {
    const order = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']
    expect(order.map((m) => modeClass(m))).toEqual([0, 1, 2, 3, 4])
    expect(modeClass('dontAsk')).toBe(modeClass('default'))
    expect(modeClass('nonsense')).toBeNull()
    expect(modeClass(undefined)).toBeNull()
    // The session tools' own table does not know the AutonomyMode names.
    expect(modeClass('ask')).toBeNull()
  })
})

describe('stricterMode', () => {
  const claude = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']
  const autonomy: AutonomyMode[] = ['plan', 'ask', 'autoEdit', 'full']

  it('picks the mode that lets the agent do less unasked, either way round', () => {
    for (let i = 0; i < claude.length; i++)
      for (let j = 0; j < claude.length; j++)
        expect(stricterMode(claude[i], claude[j])).toBe(claude[Math.min(i, j)])
  })

  it('orders every AutonomyMode pair, either way round', () => {
    for (let i = 0; i < autonomy.length; i++)
      for (let j = 0; j < autonomy.length; j++)
        expect(stricterMode(autonomy[i], autonomy[j])).toBe(autonomy[Math.min(i, j)])
  })

  it('a tightened parent beats a looser launch whichever vocabulary names either', () => {
    expect(stricterMode('full', 'ask')).toBe('ask')
    expect(stricterMode('ask', 'full')).toBe('ask')
    expect(stricterMode('autoEdit', 'default')).toBe('default')
    expect(stricterMode('acceptEdits', 'ask')).toBe('ask')
    expect(stricterMode('bypassPermissions', 'plan')).toBe('plan')
    expect(stricterMode('ask', 'bypassPermissions')).toBe('ask')
    expect(stricterMode('full', 'plan')).toBe('plan')
  })

  it('an AutonomyMode name ranks with the PermissionMode it maps to, and full is auto', () => {
    for (const mode of autonomy) {
      const mapped = AUTONOMY_TO_PERMISSION[mode]
      expect(stricterMode(mode, mapped)).toBe(mode) // a tie keeps the first
      expect(stricterMode(mapped, mode)).toBe(mapped)
      for (const other of claude) {
        // Same side of every other mode as its mapped twin.
        expect(stricterMode(mode, other) === mode).toBe(stricterMode(mapped, other) === mapped)
        expect(stricterMode(other, mode) === other).toBe(stricterMode(other, mapped) === other)
      }
    }
    expect(stricterMode('full', 'bypassPermissions')).toBe('full')
  })

  it('an unknown mode loses to a known one, and two unknown ones fall back to default', () => {
    expect(stricterMode('mystery', 'bypassPermissions')).toBe('bypassPermissions')
    expect(stricterMode('bypassPermissions', 'mystery')).toBe('bypassPermissions')
    expect(stricterMode('mystery', 'full')).toBe('full')
    expect(stricterMode('plan', 'mystery')).toBe('plan')
    expect(stricterMode('mystery', 'other-mystery')).toBe('default')
  })

  it('keeps the first on a tie', () => {
    expect(stricterMode('default', 'ask')).toBe('default')
    expect(stricterMode('ask', 'default')).toBe('ask')
    expect(stricterMode('auto', 'full')).toBe('auto')
  })
})
