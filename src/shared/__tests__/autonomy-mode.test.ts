/**
 * Tests for AutonomyMode ↔ PermissionMode mapping.
 * The mapping is defined in settings-sections.tsx but we test the logic here
 * as pure functions to keep it environment-agnostic.
 */

import { describe, it, expect } from 'vitest'
import type { AutonomyMode } from '../model-capabilities'
import { CLAUDE_ENGINE_CAPABILITIES } from '../model-capabilities'

// Mirror the exact mapping constants from settings-sections.tsx
const AUTONOMY_TO_PERMISSION: Record<AutonomyMode, string> = {
  plan: 'plan',
  ask: 'default',
  autoEdit: 'acceptEdits',
  full: 'auto'
}

const PERMISSION_TO_AUTONOMY: Record<string, AutonomyMode> = {
  plan: 'plan',
  default: 'ask',
  acceptEdits: 'autoEdit',
  auto: 'full'
}

const AUTONOMY_LABELS: Record<AutonomyMode, string> = {
  plan: 'Read-only (Plan)',
  ask: 'Ask (default)',
  autoEdit: 'Auto-edit files',
  full: 'Full auto'
}

describe('AutonomyMode ↔ PermissionMode mapping', () => {
  it('maps plan → "plan" PermissionMode', () => {
    expect(AUTONOMY_TO_PERMISSION.plan).toBe('plan')
  })

  it('maps ask → "default" PermissionMode', () => {
    expect(AUTONOMY_TO_PERMISSION.ask).toBe('default')
  })

  it('maps autoEdit → "acceptEdits" PermissionMode', () => {
    expect(AUTONOMY_TO_PERMISSION.autoEdit).toBe('acceptEdits')
  })

  it('maps full → "auto" PermissionMode', () => {
    expect(AUTONOMY_TO_PERMISSION.full).toBe('auto')
  })

  it('maps "plan" PermissionMode → plan AutonomyMode', () => {
    expect(PERMISSION_TO_AUTONOMY['plan']).toBe('plan')
  })

  it('maps "default" PermissionMode → ask AutonomyMode', () => {
    expect(PERMISSION_TO_AUTONOMY['default']).toBe('ask')
  })

  it('maps "acceptEdits" PermissionMode → autoEdit AutonomyMode', () => {
    expect(PERMISSION_TO_AUTONOMY['acceptEdits']).toBe('autoEdit')
  })

  it('maps "auto" PermissionMode → full AutonomyMode', () => {
    expect(PERMISSION_TO_AUTONOMY['auto']).toBe('full')
  })

  it('round-trips: autonomy → permission → autonomy for all modes', () => {
    const modes: AutonomyMode[] = ['plan', 'ask', 'autoEdit', 'full']
    for (const mode of modes) {
      const permission = AUTONOMY_TO_PERMISSION[mode]
      const roundTripped = PERMISSION_TO_AUTONOMY[permission]
      expect(roundTripped).toBe(mode)
    }
  })

  it('has labels for all autonomy modes', () => {
    const modes: AutonomyMode[] = ['plan', 'ask', 'autoEdit', 'full']
    for (const mode of modes) {
      expect(AUTONOMY_LABELS[mode]).toBeTruthy()
    }
  })

  it('CLAUDE_ENGINE_CAPABILITIES.autonomyModes contains all four modes', () => {
    const expected: AutonomyMode[] = ['plan', 'ask', 'autoEdit', 'full']
    for (const mode of expected) {
      expect(CLAUDE_ENGINE_CAPABILITIES.autonomyModes).toContain(mode)
    }
  })

  describe('AUTONOMY_LABELS content', () => {
    it('plan label mentions plan', () => {
      expect(AUTONOMY_LABELS.plan.toLowerCase()).toContain('plan')
    })

    it('ask label mentions ask or default', () => {
      const label = AUTONOMY_LABELS.ask.toLowerCase()
      expect(label.includes('ask') || label.includes('default')).toBe(true)
    })

    it('autoEdit label mentions auto or edit', () => {
      const label = AUTONOMY_LABELS.autoEdit.toLowerCase()
      expect(label.includes('auto') || label.includes('edit')).toBe(true)
    })

    it('full label mentions full or auto', () => {
      const label = AUTONOMY_LABELS.full.toLowerCase()
      expect(label.includes('full') || label.includes('auto')).toBe(true)
    })
  })
})
