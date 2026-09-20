/**
 * Unit tests for InputBox pure helpers — prompt routing state machine and
 * model picker filter.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveSendAction,
  filterModelsForEngine,
  dedupeResolvedModels,
  type SendContext,
  type ModelEntry
} from '../utils'

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
    expect(result).toEqual({
      type: 'send-prompt',
      prompt: '/btw what is this?',
      attachments: undefined
    })
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

  it('queue path includes attachments (an image queued mid-turn is not dropped)', () => {
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
    expect(result.type).toBe('queue-prompt')
    if (result.type === 'queue-prompt') {
      expect(result.prompt).toBe('Hello Claude')
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments![0].mediaType).toBe('image/png')
    }
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

  it('returns only Claude models for a fresh Claude session', () => {
    const result = filterModelsForEngine(allModels, 'claude')
    expect(result).toContain(claudeModel)
    expect(result).toContain(legacyModel) // no engineId defaults to 'claude'
    expect(result).not.toContain(opencodeModel)
  })

  it('returns only opencode models for a fresh opencode session', () => {
    const result = filterModelsForEngine(allModels, 'opencode')
    expect(result).toContain(opencodeModel)
    expect(result).not.toContain(claudeModel)
    expect(result).not.toContain(legacyModel)
  })

  it('excludes opencode models from a Claude session', () => {
    const result = filterModelsForEngine(allModels, 'claude')
    expect(result.some((m) => m.engineId === 'opencode')).toBe(false)
  })

  it('defaults sessionEngineId to claude when null/undefined', () => {
    const result = filterModelsForEngine(allModels, null)
    expect(result).toContain(claudeModel)
    expect(result).toContain(legacyModel)
    expect(result).not.toContain(opencodeModel)
  })

  it('returns an empty list when no models match the selected engine', () => {
    const onlyOpencode = [opencodeModel]
    const result = filterModelsForEngine(onlyOpencode, 'claude')
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// dedupeResolvedModels
// ---------------------------------------------------------------------------

describe('dedupeResolvedModels', () => {
  /**
   * cli.js 2.1.268's real Claude catalog, in its own preference order. The
   * first two rows resolve to the SAME model and carry an IDENTICAL
   * description, which is what the picker labels rows from — so pre-fix the
   * picker showed two rows reading "Opus 5 with 1M context".
   */
  const catalog: ModelEntry[] = [
    { value: 'default', engineId: 'claude', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'opus[1m]', engineId: 'claude', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'claude-fable-5-1[1m]', engineId: 'claude', resolvedModel: 'claude-fable-5-1' },
    { value: 'sonnet', engineId: 'claude', resolvedModel: 'claude-sonnet-5' },
    { value: 'haiku', engineId: 'claude', resolvedModel: 'claude-haiku-4-5-20251001' }
  ]

  it('collapses the five-row catalog to four, `default` surviving', () => {
    const result = dedupeResolvedModels(catalog)
    expect(result.map((m) => m.value)).toEqual([
      'default',
      'claude-fable-5-1[1m]',
      'sonnet',
      'haiku'
    ])
  })

  it('keeps the SELECTED row when the selection is a later member of the group', () => {
    // A session already pinned to opus[1m] must keep seeing its own row rather
    // than being silently relabelled `default`.
    const result = dedupeResolvedModels(catalog, 'opus[1m]')
    expect(result.map((m) => m.value)).toEqual([
      'opus[1m]',
      'claude-fable-5-1[1m]',
      'sonnet',
      'haiku'
    ])
    expect(result).toHaveLength(4)
  })

  it('keeps `default` when `default` is itself the selection', () => {
    expect(dedupeResolvedModels(catalog, 'default').map((m) => m.value)).toEqual([
      'default',
      'claude-fable-5-1[1m]',
      'sonnet',
      'haiku'
    ])
  })

  it('a selection outside the list changes nothing', () => {
    expect(dedupeResolvedModels(catalog, 'not-in-catalog').map((m) => m.value)).toEqual([
      'default',
      'claude-fable-5-1[1m]',
      'sonnet',
      'haiku'
    ])
  })

  it('preserves input order rather than grouping survivors together', () => {
    const interleaved: ModelEntry[] = [
      { value: 'a', resolvedModel: 'X' },
      { value: 'b', resolvedModel: 'Y' },
      { value: 'c', resolvedModel: 'X' },
      { value: 'd', resolvedModel: 'Y' }
    ]
    expect(dedupeResolvedModels(interleaved).map((m) => m.value)).toEqual(['a', 'b'])
    // The later-selected member wins its own group, in place.
    expect(dedupeResolvedModels(interleaved, 'c').map((m) => m.value)).toEqual(['b', 'c'])
  })

  it('never merges rows that carry no resolvedModel (every non-Claude engine)', () => {
    const noResolved: ModelEntry[] = [
      { value: 'gpt-4o', engineId: 'opencode' },
      { value: 'gpt-4o-mini', engineId: 'opencode' },
      { value: 'legacy' }
    ]
    expect(dedupeResolvedModels(noResolved)).toEqual(noResolved)
  })

  it('does not merge rows whose resolvedModel is an empty string', () => {
    const blank: ModelEntry[] = [
      { value: 'p', resolvedModel: '' },
      { value: 'q', resolvedModel: '' }
    ]
    expect(dedupeResolvedModels(blank).map((m) => m.value)).toEqual(['p', 'q'])
  })

  it('leaves a mixed list alone apart from the genuine duplicate', () => {
    const mixed: ModelEntry[] = [
      ...catalog,
      { value: 'gpt-4o', engineId: 'opencode' },
      { value: 'legacy' }
    ]
    expect(dedupeResolvedModels(mixed)).toHaveLength(6)
  })

  it('returns an empty list unchanged', () => {
    expect(dedupeResolvedModels([])).toEqual([])
  })
})
