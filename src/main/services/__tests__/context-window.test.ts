import { describe, it, expect, afterEach } from 'vitest'
import { getContextWindowSize } from '../context-window'

const ONE_M = 1_000_000
const DEFAULT = 200_000

describe('getContextWindowSize', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  })

  describe('[1m] suffix', () => {
    it.each([
      'sonnet[1m]',
      'opus[1m]',
      'claude-opus-4-6[1m]',
      'claude-fable-5[1m]',
      'claude-sonnet-4-6-20251101[1m]'
    ])('%s → 1M', (model) => {
      expect(getContextWindowSize(model)).toBe(ONE_M)
    })

    it('is case-insensitive like cli.js _J()', () => {
      expect(getContextWindowSize('SONNET[1M]')).toBe(ONE_M)
    })
  })

  describe('implicit-1M models (no [1m] in the name)', () => {
    it.each([
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-4-7',
      'claude-opus-4-8'
    ])('%s → 1M', (model) => {
      expect(getContextWindowSize(model)).toBe(ONE_M)
    })

    it('resolves dated ids by substring', () => {
      expect(getContextWindowSize('claude-fable-5-20260315')).toBe(ONE_M)
      expect(getContextWindowSize('claude-opus-4-8-20251201')).toBe(ONE_M)
    })

    it('resolves provider-prefixed (Bedrock) ids', () => {
      expect(getContextWindowSize('us.anthropic.claude-opus-4-8-20251201-v1:0')).toBe(ONE_M)
    })
  })

  describe('picker aliases', () => {
    it('fable and opus resolve to implicit-1M models', () => {
      expect(getContextWindowSize('fable')).toBe(ONE_M)
      expect(getContextWindowSize('opus')).toBe(ONE_M)
    })

    it('sonnet, haiku, and opusplan stay at the 200K default', () => {
      expect(getContextWindowSize('sonnet')).toBe(DEFAULT)
      expect(getContextWindowSize('haiku')).toBe(DEFAULT)
      expect(getContextWindowSize('opusplan')).toBe(DEFAULT)
    })
  })

  describe('200K models', () => {
    it.each([
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-3-5-sonnet'
    ])('%s → 200K', (model) => {
      expect(getContextWindowSize(model)).toBe(DEFAULT)
    })

    it('unknown models fall back to 200K', () => {
      expect(getContextWindowSize('some-future-model')).toBe(DEFAULT)
    })
  })

  describe('CLAUDE_CODE_DISABLE_1M_CONTEXT', () => {
    it.each(['1', 'true', 'YES', ' on '])('value %j forces 200K everywhere', (v) => {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = v
      expect(getContextWindowSize('claude-fable-5')).toBe(DEFAULT)
      expect(getContextWindowSize('sonnet[1m]')).toBe(DEFAULT)
    })

    it.each(['0', 'false', 'off', ''])('non-truthy value %j is ignored', (v) => {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = v
      expect(getContextWindowSize('claude-fable-5')).toBe(ONE_M)
    })
  })
})
