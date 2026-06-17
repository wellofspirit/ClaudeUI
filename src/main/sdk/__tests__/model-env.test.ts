import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildEnv } from '../args'
import { setModelEnv } from '../model-env'

describe('buildEnv model override overlay', () => {
  beforeEach(() => {
    setModelEnv(null)
  })

  afterEach(() => {
    setModelEnv(null)
  })

  it('no model env set → strips ANTHROPIC_MODEL family from overlay', () => {
    const env = buildEnv({
      ANTHROPIC_MODEL: 'should-not-leak',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'should-not-leak',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'should-not-leak',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'should-not-leak'
    })
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
  })

  it('all four fields populated → overlays all four env vars', () => {
    setModelEnv({
      ANTHROPIC_MODEL: 'sonnet',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5'
    })
    const env = buildEnv({})
    expect(env.ANTHROPIC_MODEL).toBe('sonnet')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5')
  })

  it('partial override (only sonnet) → leaves other family vars unset', () => {
    setModelEnv({
      ANTHROPIC_MODEL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'my-gateway/sonnet',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ''
    })
    const env = buildEnv({})
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('my-gateway/sonnet')
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
  })

  it('partial overlay strips inherited value of other families from base env', () => {
    setModelEnv({
      ANTHROPIC_MODEL: 'opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ''
    })
    // Base env carries a stale ANTHROPIC_DEFAULT_SONNET_MODEL — overlay must strip it
    // because the user did not opt to set sonnet.
    const env = buildEnv({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-from-process-env'
    })
    expect(env.ANTHROPIC_MODEL).toBe('opus')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
  })

  it('clearing model env after it was set removes all four vars', () => {
    setModelEnv({
      ANTHROPIC_MODEL: 'sonnet',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5'
    })
    expect(buildEnv({}).ANTHROPIC_MODEL).toBe('sonnet')
    setModelEnv(null)
    const cleared = buildEnv({})
    expect(cleared.ANTHROPIC_MODEL).toBeUndefined()
    expect(cleared.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
    expect(cleared.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(cleared.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
  })

  it('model override accepts alias values like opusplan or sonnet[1m]', () => {
    setModelEnv({
      ANTHROPIC_MODEL: 'opusplan',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ''
    })
    const env = buildEnv({})
    expect(env.ANTHROPIC_MODEL).toBe('opusplan')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7[1m]')
  })
})
