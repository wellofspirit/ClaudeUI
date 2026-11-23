import { describe, it, expect, afterEach } from 'vitest'
import { getContextWindowSize } from '../context-window'

const ONE_M = 1_000_000
const DEFAULT = 200_000

describe('getContextWindowSize', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
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
      'claude-fable-5-1',
      'claude-fable-5-2',
      'claude-mythos-5',
      'claude-mythos-5-1',
      'claude-mythos-5-2',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5'
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

    it('sonnet resolves to claude-sonnet-5 (native-1M since 2.1.197)', () => {
      expect(getContextWindowSize('sonnet')).toBe(ONE_M)
    })

    it('haiku resolves to claude-haiku-5-5 (native-1M, baked catalog since 2.1.293)', () => {
      expect(getContextWindowSize('haiku')).toBe(ONE_M)
    })

    it('opusplan and best stay at the 200K default (recognised aliases, not unknown ids)', () => {
      expect(getContextWindowSize('opusplan')).toBe(DEFAULT)
      expect(getContextWindowSize('best')).toBe(DEFAULT)
    })
  })

  describe('200K models (recognised by cli.js 2.1.326, no native 1M)', () => {
    it.each([
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4-0',
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-opus-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet',
      'claude-3-5-haiku',
      'claude-3-opus-20240229',
      'claude-3-haiku',
      'us.anthropic.claude-3-5-sonnet-20241022-v2:0'
    ])('%s → 200K', (model) => {
      expect(getContextWindowSize(model)).toBe(DEFAULT)
    })
  })

  describe('models cli.js does not recognise (2.1.323: assumed 1M)', () => {
    it.each(['some-future-model', 'claude-sonnet-latest', 'claude-opus-6', 'gpt-5'])(
      '%s → 1M',
      (model) => {
        expect(getContextWindowSize(model)).toBe(ONE_M)
      }
    )

    it('claude-mythos-preview is recognised at 1M', () => {
      expect(getContextWindowSize('claude-mythos-preview')).toBe(ONE_M)
    })

    it('CLAUDE_CODE_MAX_CONTEXT_TOKENS sets the window of an unrecognised id only (2.1.325)', () => {
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '300000'
      expect(getContextWindowSize('claude-sonnet-latest')).toBe(300_000)
      expect(getContextWindowSize('gateway/custom-model')).toBe(300_000)
      expect(getContextWindowSize('claude-sonnet-4-6')).toBe(DEFAULT)
      expect(getContextWindowSize('claude-fable-5')).toBe(ONE_M)
      expect(getContextWindowSize('sonnet')).toBe(ONE_M)
    })

    it.each(['0', '-5', 'abc', ''])(
      'ignores a non-positive CLAUDE_CODE_MAX_CONTEXT_TOKENS %j',
      (v) => {
        process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = v
        expect(getContextWindowSize('claude-sonnet-latest')).toBe(ONE_M)
      }
    )

    it('CLAUDE_CODE_MAX_CONTEXT_TOKENS wins over CLAUDE_CODE_DISABLE_1M_CONTEXT for an unrecognised id', () => {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
      expect(getContextWindowSize('claude-sonnet-latest')).toBe(DEFAULT)
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '300000'
      expect(getContextWindowSize('claude-sonnet-latest')).toBe(300_000)
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
