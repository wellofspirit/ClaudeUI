/**
 * Unit tests for InputBox pure helpers — prompt routing state machine and
 * model picker filter.
 */

import { describe, it, expect } from 'vitest'
import { resolveSendAction, filterModelsForEngine, type SendContext, type ModelEntry } from '../utils'

// ---------------------------------------------------------------------------
// resolveSendAction
// ---------------------------------------------------------------------------

describe('resolveSendAction', () => {
  const baseCtx: SendContext = {
    text: 'Hello Claude',
    attachedFiles: [],
    isDisabled: false,
    activeSessionId: 'session-1',
    isRunning: false
  }

  it('returns noop when text is empty and no files', () => {
    expect(resolveSendAction({ ...baseCtx, text: '' })).toEqual({ type: 'noop' })
    expect(resolveSendAction({ ...baseCtx, text: '   ' })).toEqual({ type: 'noop' })
  })

  it('returns noop when disabled', () => {
    expect(resolveSendAction({ ...baseCtx, isDisabled: true })).toEqual({ type: 'noop' })
  })

  it('returns noop when no active session', () => {
    expect(resolveSendAction({ ...baseCtx, activeSessionId: null })).toEqual({ type: 'noop' })
  })

  it('returns side-question for /btw prefix', () => {
    const result = resolveSendAction({ ...baseCtx, text: '/btw what is this?' })
    expect(result).toEqual({ type: 'side-question', question: 'what is this?' })
  })

  it('does not treat /btw with empty question as side-question', () => {
    const result = resolveSendAction({ ...baseCtx, text: '/btw   ' })
    // Falls through to normal send
    expect(result.type).not.toBe('side-question')
  })

  it('treats /btw as ordinary prompt when sideQuestion capability is off', () => {
    const result = resolveSendAction({
      ...baseCtx,
      text: '/btw what is this?',
      sideQuestionEnabled: false
    })
    expect(result).toEqual({ type: 'send-prompt', prompt: '/btw what is this?', attachments: undefined })
  })

  it('still routes /btw to side-question when sideQuestion capability is on', () => {
    const result = resolveSendAction({
      ...baseCtx,
      text: '/btw what is this?',
      sideQuestionEnabled: true
    })
    expect(result).toEqual({ type: 'side-question', question: 'what is this?' })
  })

  it('returns clear-session for /clear', () => {
    expect(resolveSendAction({ ...baseCtx, text: '/clear' })).toEqual({ type: 'clear-session' })
  })

  it('does not treat /clearfoo as clear command', () => {
    const result = resolveSendAction({ ...baseCtx, text: '/clearfoo' })
    expect(result.type).not.toBe('clear-session')
  })

  it('queues prompt when session is running', () => {
    const result = resolveSendAction({ ...baseCtx, isRunning: true })
    expect(result).toEqual({ type: 'queue-prompt', prompt: 'Hello Claude' })
  })

  it('returns noop (retains input) when running but queue capability is off', () => {
    const result = resolveSendAction({ ...baseCtx, isRunning: true, queueEnabled: false })
    expect(result).toEqual({ type: 'noop' })
  })

  it('queues when running and queue capability is on', () => {
    const result = resolveSendAction({ ...baseCtx, isRunning: true, queueEnabled: true })
    expect(result).toEqual({ type: 'queue-prompt', prompt: 'Hello Claude' })
  })

  it('sends prompt with attachments when not running', () => {
    const files = [
      {
        id: '1',
        fileName: 'test.png',
        fileType: 'image' as const,
        mediaType: 'image/png' as const,
        base64Data: 'abc123',
        previewUrl: ''
      }
    ]
    const result = resolveSendAction({ ...baseCtx, attachedFiles: files })
    expect(result.type).toBe('send-prompt')
    if (result.type === 'send-prompt') {
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments![0].mediaType).toBe('image/png')
    }
  })

  it('sends prompt without attachments for text-only', () => {
    const result = resolveSendAction(baseCtx)
    expect(result).toEqual({ type: 'send-prompt', prompt: 'Hello Claude', attachments: undefined })
  })

  it('allows sending with files but no text', () => {
    const files = [
      {
        id: '1',
        fileName: 'doc.pdf',
        fileType: 'pdf' as const,
        mediaType: 'application/pdf' as const,
        base64Data: 'abc',
        previewUrl: ''
      }
    ]
    const result = resolveSendAction({ ...baseCtx, text: '', attachedFiles: files })
    expect(result.type).toBe('send-prompt')
  })

  it('queue path does not include attachments', () => {
    const files = [
      {
        id: '1',
        fileName: 'test.png',
        fileType: 'image' as const,
        mediaType: 'image/png' as const,
        base64Data: 'abc',
        previewUrl: ''
      }
    ]
    const result = resolveSendAction({ ...baseCtx, isRunning: true, attachedFiles: files })
    // Queue only sends text, not attachments
    expect(result).toEqual({ type: 'queue-prompt', prompt: 'Hello Claude' })
  })
})

// ---------------------------------------------------------------------------
// filterModelsForEngine
// ---------------------------------------------------------------------------

describe('filterModelsForEngine', () => {
  const claudeModel: ModelEntry = { value: 'claude-opus-4', engineId: 'claude' }
  const opencodeModel: ModelEntry = { value: 'gpt-4o', engineId: 'opencode' }
  const legacyModel: ModelEntry = { value: 'legacy-model' } // no engineId — treated as claude

  const allModels = [claudeModel, opencodeModel, legacyModel]

  it('returns all models when not engine-locked (claude default)', () => {
    const result = filterModelsForEngine(allModels, false, 'claude')
    expect(result).toEqual(allModels)
  })

  it('returns all models when not engine-locked (opencode default)', () => {
    const result = filterModelsForEngine(allModels, false, 'opencode')
    expect(result).toEqual(allModels)
  })

  it('returns only claude models when engine-locked to claude', () => {
    const result = filterModelsForEngine(allModels, true, 'claude')
    expect(result).toContain(claudeModel)
    expect(result).toContain(legacyModel) // no engineId defaults to 'claude'
    expect(result).not.toContain(opencodeModel)
  })

  it('returns only opencode models when engine-locked to opencode', () => {
    const result = filterModelsForEngine(allModels, true, 'opencode')
    expect(result).toContain(opencodeModel)
    expect(result).not.toContain(claudeModel)
    expect(result).not.toContain(legacyModel)
  })

  it('excludes opencode models from a locked claude session (historical-session regression guard)', () => {
    // A historical Claude session (status.sessionId null but engine-committed)
    // is engine-locked; opencode models must never appear in its picker, or a
    // cross-engine pick would corrupt the engine-committed session.
    const result = filterModelsForEngine(allModels, true, 'claude')
    expect(result.some((m) => m.engineId === 'opencode')).toBe(false)
  })

  it('defaults sessionEngineId to claude when null/undefined while locked', () => {
    const result = filterModelsForEngine(allModels, true, null)
    expect(result).toContain(claudeModel)
    expect(result).toContain(legacyModel)
    expect(result).not.toContain(opencodeModel)
  })

  it('returns an empty list when no models match the locked engine', () => {
    const onlyOpencode = [opencodeModel]
    const result = filterModelsForEngine(onlyOpencode, true, 'claude')
    expect(result).toHaveLength(0)
  })
})
