/**
 * Unit tests for ToolCallBlock pure logic — visual state machine.
 */

import { describe, it, expect } from 'vitest'
import { resolveToolVisualState, TOOL_BORDER_CLASSES, type ToolStateContext } from '../utils'

describe('resolveToolVisualState', () => {
  const baseCtx: ToolStateContext = {
    isCommandKind: true,
    hasResult: false,
    isHistorical: false,
    hasApproval: false,
    isBackgroundBash: false,
    bgNotificationStatus: null,
    resultIsError: false
  }

  it('returns pending when approval exists and not historical', () => {
    expect(resolveToolVisualState({ ...baseCtx, hasApproval: true })).toBe('pending')
  })

  it('returns loaded for approval in historical mode (no longer pending)', () => {
    expect(resolveToolVisualState({ ...baseCtx, hasApproval: true, isHistorical: true })).toBe(
      'loaded'
    )
  })

  it('returns error when tool result has error', () => {
    expect(resolveToolVisualState({ ...baseCtx, hasResult: true, resultIsError: true })).toBe(
      'error'
    )
  })

  it('returns error for failed background bash', () => {
    expect(
      resolveToolVisualState({
        ...baseCtx,
        isBackgroundBash: true,
        bgNotificationStatus: 'failed'
      })
    ).toBe('error')
  })

  // Regression: this gate used to check `toolName === 'Bash'`, which missed
  // opencode's raw (lowercase) 'bash' tool name. It now takes a pre-resolved
  // `isCommandKind` boolean from the caller (kind === 'command'), so the same
  // context shape covers both engines' bash tools without a name check here.
  it('returns running for a command-kind tool without result', () => {
    expect(resolveToolVisualState({ ...baseCtx, isCommandKind: true })).toBe('running')
  })

  it('returns running for background bash without notification', () => {
    expect(resolveToolVisualState({ ...baseCtx, isBackgroundBash: true })).toBe('running')
  })

  it('returns success when background bash completes', () => {
    expect(
      resolveToolVisualState({
        ...baseCtx,
        isBackgroundBash: true,
        bgNotificationStatus: 'completed'
      })
    ).toBe('success')
  })

  it('returns success when background bash is stopped', () => {
    expect(
      resolveToolVisualState({
        ...baseCtx,
        isBackgroundBash: true,
        bgNotificationStatus: 'stopped'
      })
    ).toBe('success')
  })

  it('returns success for non-command tool with result', () => {
    expect(
      resolveToolVisualState({
        ...baseCtx,
        isCommandKind: false,
        hasResult: true
      })
    ).toBe('success')
  })

  it('returns loaded for historical tool without result', () => {
    expect(
      resolveToolVisualState({
        ...baseCtx,
        isCommandKind: false,
        isHistorical: true
      })
    ).toBe('loaded')
  })

  // Explicit non-command-kind case: with no result and not historical, a tool
  // that isn't kind 'command' must stay 'idle' (not fall through to 'running').
  it('returns idle for a non-command-kind tool without result or history', () => {
    expect(resolveToolVisualState({ ...baseCtx, isCommandKind: false })).toBe('idle')
  })

  it('border classes map to correct CSS', () => {
    expect(TOOL_BORDER_CLASSES.pending).toBe('border-warning/40')
    expect(TOOL_BORDER_CLASSES.error).toBe('border-danger/30')
    expect(TOOL_BORDER_CLASSES.running).toBe('border-accent/30')
    expect(TOOL_BORDER_CLASSES.success).toBe('border-success/30')
    expect(TOOL_BORDER_CLASSES.loaded).toBe('border-border')
    expect(TOOL_BORDER_CLASSES.idle).toBe('border-border')
  })
})
