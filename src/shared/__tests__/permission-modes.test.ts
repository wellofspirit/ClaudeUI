/**
 * Tests for the pure permission-mode cycling logic shared by the renderer's
 * Shift+Tab handler.
 */

import { describe, it, expect } from 'vitest'
import { nextPermissionMode, claudeAutoModeAvailable } from '../permission-modes'
import type { ModelInfo, PermissionMode } from '../types'

describe('nextPermissionMode', () => {
  const openGates = { canPlan: true, autoAvailable: true }

  it('cycles through the full sequence when both gates are open', () => {
    expect(nextPermissionMode('default', openGates)).toBe('acceptEdits')
    expect(nextPermissionMode('acceptEdits', openGates)).toBe('plan')
    expect(nextPermissionMode('plan', openGates)).toBe('auto')
    expect(nextPermissionMode('auto', openGates)).toBe('default')
  })

  it('skips plan when canPlan is false', () => {
    expect(nextPermissionMode('acceptEdits', { canPlan: false, autoAvailable: true })).toBe('auto')
  })

  it('skips auto when autoAvailable is false', () => {
    expect(nextPermissionMode('plan', { canPlan: true, autoAvailable: false })).toBe('default')
  })

  it('skips both plan and auto when both gates are closed, and terminates', () => {
    expect(nextPermissionMode('acceptEdits', { canPlan: false, autoAvailable: false })).toBe(
      'default'
    )
  })

  it('treats an unknown/legacy current mode as default', () => {
    expect(nextPermissionMode('localAuto' as PermissionMode, openGates)).toBe('acceptEdits')
  })
})

describe('claudeAutoModeAvailable', () => {
  it('returns true for an empty model list', () => {
    expect(claudeAutoModeAvailable([])).toBe(true)
  })

  it('returns true when supportsAutoMode is undefined on all models', () => {
    const models: Pick<ModelInfo, 'engineId' | 'supportsAutoMode'>[] = [
      { engineId: 'claude' },
      { engineId: 'claude' }
    ]
    expect(claudeAutoModeAvailable(models)).toBe(true)
  })

  it('returns false when every Claude model explicitly reports no support', () => {
    const models: Pick<ModelInfo, 'engineId' | 'supportsAutoMode'>[] = [
      { engineId: 'claude', supportsAutoMode: false },
      { engineId: 'claude', supportsAutoMode: false }
    ]
    expect(claudeAutoModeAvailable(models)).toBe(false)
  })

  it('returns true when at least one Claude model supports it', () => {
    const models: Pick<ModelInfo, 'engineId' | 'supportsAutoMode'>[] = [
      { engineId: 'claude', supportsAutoMode: false },
      { engineId: 'claude', supportsAutoMode: true }
    ]
    expect(claudeAutoModeAvailable(models)).toBe(true)
  })

  it('ignores non-claude engine models, even if they report no support', () => {
    const models: Pick<ModelInfo, 'engineId' | 'supportsAutoMode'>[] = [
      { engineId: 'opencode', supportsAutoMode: false },
      { engineId: 'opencode', supportsAutoMode: false }
    ]
    expect(claudeAutoModeAvailable(models)).toBe(true)
  })

  it('treats entries with undefined engineId as claude', () => {
    const models: Pick<ModelInfo, 'engineId' | 'supportsAutoMode'>[] = [
      { engineId: undefined, supportsAutoMode: false }
    ]
    expect(claudeAutoModeAvailable(models)).toBe(false)
  })
})
