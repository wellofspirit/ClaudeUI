import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildEnv } from '../args'
import { setEndpointEnv } from '../endpoint-env'

describe('buildEnv anthropic endpoint overlay', () => {
  beforeEach(() => {
    setEndpointEnv(null)
  })

  afterEach(() => {
    setEndpointEnv(null)
  })

  it('no in-app endpoint → inherited ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN are PRESERVED (M-CL4)', () => {
    // A user routing through a gateway/LiteLLM via their own shell env relies on
    // these and the stock CLI supports them; deleting them (the old behavior)
    // silently removed their token auth + endpoint. These are the user's own
    // env — the vault path never writes ANTHROPIC_* to process.env.
    const env = buildEnv({
      ANTHROPIC_BASE_URL: 'http://gateway.corp',
      ANTHROPIC_AUTH_TOKEN: 'user-shell-token'
    })
    expect(env.ANTHROPIC_BASE_URL).toBe('http://gateway.corp')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('user-shell-token')
  })

  it('endpoint set → overlays both env vars on the spawn env', () => {
    setEndpointEnv({
      ANTHROPIC_BASE_URL: 'http://localhost:1234',
      ANTHROPIC_AUTH_TOKEN: 'lmstudio'
    })
    const env = buildEnv({})
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:1234')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('lmstudio')
  })

  it('endpoint set with empty token → still overlays base URL', () => {
    setEndpointEnv({
      ANTHROPIC_BASE_URL: 'http://gateway.local',
      ANTHROPIC_AUTH_TOKEN: ''
    })
    const env = buildEnv({})
    expect(env.ANTHROPIC_BASE_URL).toBe('http://gateway.local')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('')
  })

  it('clearing endpoint after it was set removes both vars from overlay', () => {
    setEndpointEnv({
      ANTHROPIC_BASE_URL: 'http://localhost:1234',
      ANTHROPIC_AUTH_TOKEN: 'lmstudio'
    })
    expect(buildEnv({}).ANTHROPIC_BASE_URL).toBe('http://localhost:1234')
    setEndpointEnv(null)
    const cleared = buildEnv({})
    expect(cleared.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(cleared.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('endpoint overlay overrides any value already in base env', () => {
    setEndpointEnv({
      ANTHROPIC_BASE_URL: 'http://override.local',
      ANTHROPIC_AUTH_TOKEN: 'override-token'
    })
    const env = buildEnv({
      ANTHROPIC_BASE_URL: 'http://stale-from-process-env',
      ANTHROPIC_AUTH_TOKEN: 'stale-token'
    })
    expect(env.ANTHROPIC_BASE_URL).toBe('http://override.local')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('override-token')
  })

  it('endpoint and proxy overlays are independent', () => {
    setEndpointEnv({
      ANTHROPIC_BASE_URL: 'http://endpoint.local',
      ANTHROPIC_AUTH_TOKEN: 'tok'
    })
    const env = buildEnv({})
    expect(env.ANTHROPIC_BASE_URL).toBe('http://endpoint.local')
    // Proxy was not set in this test, so it should remain stripped.
    expect(env.HTTP_PROXY).toBeUndefined()
  })
})
