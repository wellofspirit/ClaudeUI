/**
 * Tests for AutonomyMode ↔ PermissionMode mapping.
 * The mapping lives in shared/permission-modes.ts — the SAME constants the
 * Settings picker and the session store's defaultMode hydration import, so
 * these assertions bind the real thing rather than a copy.
 */

import { describe, it, expect } from 'vitest'
import type { AutonomyMode } from '../model-capabilities'
import { CLAUDE_ENGINE_CAPABILITIES } from '../model-capabilities'
import {
  AUTONOMY_TO_PERMISSION,
  PERMISSION_TO_AUTONOMY,
  AUTONOMY_LABELS,
  toPermissionMode
} from '../permission-modes'

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

  // `permissions.defaultMode` is free-form on disk (hand-edited settings.json,
  // upstream modes ClaudeUI has no session equivalent for). Everything that is
  // not a renderer PermissionMode must land on 'default' — the never-gated mode.
  describe('toPermissionMode (settings.json defaultMode → session mode)', () => {
    it.each(['default', 'acceptEdits', 'plan', 'auto'])('passes through %s', (mode) => {
      expect(toPermissionMode(mode)).toBe(mode)
    })

    it('maps bypassPermissions to default (no ClaudeUI session equivalent)', () => {
      expect(toPermissionMode('bypassPermissions')).toBe('default')
    })

    it('maps absent/unknown values to default', () => {
      expect(toPermissionMode(undefined)).toBe('default')
      expect(toPermissionMode(null)).toBe('default')
      expect(toPermissionMode('')).toBe('default')
      expect(toPermissionMode('futureMode')).toBe('default')
    })

    it('accepts every AUTONOMY_TO_PERMISSION output unchanged', () => {
      for (const mode of Object.values(AUTONOMY_TO_PERMISSION)) {
        expect(toPermissionMode(mode)).toBe(mode)
      }
    })
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
