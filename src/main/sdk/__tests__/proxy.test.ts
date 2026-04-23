import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildEnv } from '../args'
import { setProxyEnv, setProxyAllSubprocesses } from '../proxy'

describe('buildEnv proxy overlay', () => {
  beforeEach(() => {
    setProxyEnv(null)
    setProxyAllSubprocesses(false)
  })

  afterEach(() => {
    setProxyEnv(null)
    setProxyAllSubprocesses(false)
  })

  it('no proxy set → HTTP_PROXY/HTTPS_PROXY/ALL_PROXY stripped from overlay', () => {
    const env = buildEnv({
      HTTP_PROXY: 'http://should-not-leak',
      HTTPS_PROXY: 'http://should-not-leak',
      ALL_PROXY: 'http://should-not-leak',
      CLAUDEUI_PROXY_SUBPROCESSES: '1',
    })
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.ALL_PROXY).toBeUndefined()
    expect(env.CLAUDEUI_PROXY_SUBPROCESSES).toBeUndefined()
  })

  it('proxy set with default scope → overlays proxy, no CLAUDEUI_PROXY_SUBPROCESSES', () => {
    setProxyEnv({
      HTTP_PROXY: 'http://proxy.local:8080',
      HTTPS_PROXY: 'http://proxy.local:8080',
      ALL_PROXY: 'http://proxy.local:8080',
    })
    const env = buildEnv({})
    expect(env.HTTP_PROXY).toBe('http://proxy.local:8080')
    expect(env.HTTPS_PROXY).toBe('http://proxy.local:8080')
    expect(env.ALL_PROXY).toBe('http://proxy.local:8080')
    expect(env.CLAUDEUI_PROXY_SUBPROCESSES).toBeUndefined()
  })

  it('proxy set with proxyAllSubprocesses=true → sets CLAUDEUI_PROXY_SUBPROCESSES=1', () => {
    setProxyEnv({
      HTTP_PROXY: 'http://proxy.local:8080',
      HTTPS_PROXY: 'http://proxy.local:8080',
      ALL_PROXY: 'http://proxy.local:8080',
    })
    setProxyAllSubprocesses(true)
    const env = buildEnv({})
    expect(env.HTTP_PROXY).toBe('http://proxy.local:8080')
    expect(env.CLAUDEUI_PROXY_SUBPROCESSES).toBe('1')
  })

  it('clearing proxy after it was set removes it from overlay', () => {
    setProxyEnv({
      HTTP_PROXY: 'http://proxy.local:8080',
      HTTPS_PROXY: 'http://proxy.local:8080',
      ALL_PROXY: 'http://proxy.local:8080',
    })
    expect(buildEnv({}).HTTP_PROXY).toBe('http://proxy.local:8080')
    setProxyEnv(null)
    expect(buildEnv({}).HTTP_PROXY).toBeUndefined()
  })

  it('base env retains non-proxy entries', () => {
    const env = buildEnv({ FOO: 'bar', PATH: '/usr/bin' })
    expect(env.FOO).toBe('bar')
    expect(env.PATH).toBe('/usr/bin')
  })
})
