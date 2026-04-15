/**
 * Unit tests for ToolCallBlock pure logic — visual state machine.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveToolVisualState,
  TOOL_BORDER_CLASSES,
  type ToolStateContext,
} from '../utils'

describe('resolveToolVisualState', () => {
  const baseCtx: ToolStateContext = {
    toolName: 'Bash',
    hasResult: false,
    isHistorical: false,
    hasApproval: false,
    isBackgroundBash: false,
    bgNotificationStatus: null,
    resultIsError: false,
  }

  it('returns pending when approval exists and not historical', () => {
    expect(resolveToolVisualState({ ...baseCtx, hasApproval: true })).toBe('pending')
  })

  it('returns loaded for approval in historical mode (no longer pending)', () => {
    expect(resolveToolVisualState({ ...baseCtx, hasApproval: true, isHistorical: true })).toBe('loaded')
  })

  it('returns error when tool result has error', () => {
    expect(resolveToolVisualState({ ...baseCtx, hasResult: true, resultIsError: true })).toBe('error')
  })

  it('returns error for failed background bash', () => {
    expect(resolveToolVisualState({
      ...baseCtx, isBackgroundBash: true, bgNotificationStatus: 'failed',
    })).toBe('error')
  })

  it('returns running for foreground bash without result', () => {
    expect(resolveToolVisualState({ ...baseCtx, toolName: 'Bash' })).toBe('running')
  })

  it('returns running for background bash without notification', () => {
    expect(resolveToolVisualState({ ...baseCtx, isBackgroundBash: true })).toBe('running')
  })

  it('returns success when background bash completes', () => {
    expect(resolveToolVisualState({
      ...baseCtx, isBackgroundBash: true, bgNotificationStatus: 'completed',
    })).toBe('success')
  })

  it('returns success when background bash is stopped', () => {
    expect(resolveToolVisualState({
      ...baseCtx, isBackgroundBash: true, bgNotificationStatus: 'stopped',
    })).toBe('success')
  })

  it('returns success for non-bash tool with result', () => {
    expect(resolveToolVisualState({
      ...baseCtx, toolName: 'Read', hasResult: true,
    })).toBe('success')
  })

  it('returns loaded for historical tool without result', () => {
    expect(resolveToolVisualState({
      ...baseCtx, toolName: 'Read', isHistorical: true,
    })).toBe('loaded')
  })

  it('returns idle for non-bash tool without result or history', () => {
    expect(resolveToolVisualState({ ...baseCtx, toolName: 'Read' })).toBe('idle')
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
