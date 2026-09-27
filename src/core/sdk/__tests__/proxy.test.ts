import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildEnv } from '../args'
import { setProxyEnv } from '../proxy'

const IN_APP = {
  HTTP_PROXY: 'http://proxy.local:8080',
  HTTPS_PROXY: 'http://proxy.local:8080',
  ALL_PROXY: 'http://proxy.local:8080'
}

describe('buildEnv proxy overlay', () => {
  beforeEach(() => setProxyEnv(null))
  afterEach(() => setProxyEnv(null))

  it('in-app proxy set → the three vars carry the in-app values, with no strip marker', () => {
    // cli.js hands its env to Bash/MCP/LSP/hook children as-is, so these same
    // values reach them. Nothing switches a strip on or off any more.
    setProxyEnv(IN_APP)
    const env = buildEnv({
      HTTP_PROXY: 'http://corp-proxy:8080',
      HTTPS_PROXY: 'http://corp-proxy:8080',
      ALL_PROXY: 'http://corp-proxy:8080'
    })
    expect(env.HTTP_PROXY).toBe(IN_APP.HTTP_PROXY)
    expect(env.HTTPS_PROXY).toBe(IN_APP.HTTPS_PROXY)
    expect(env.ALL_PROXY).toBe(IN_APP.ALL_PROXY)
    expect(env).not.toHaveProperty('CLAUDEUI_PROXY_SUBPROCESSES')
  })

  it('no in-app proxy → inherited HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY pass through unchanged (M-CL4)', () => {
    // A user behind an env-configured corporate proxy must keep connectivity —
    // cli.js honors these for its own API traffic. Deleting them (the old
    // behavior) left such users with a dead cli.js.
    const inherited = {
      HTTP_PROXY: 'http://corp-proxy:8080',
      HTTPS_PROXY: 'http://corp-proxy:8081',
      ALL_PROXY: 'socks5://corp-proxy:1080',
      NO_PROXY: 'localhost,.corp'
    }
    const env = buildEnv(inherited)
    expect(env).toMatchObject(inherited)
    expect(env).not.toHaveProperty('CLAUDEUI_PROXY_SUBPROCESSES')
  })

  it('clearing proxy after it was set removes it from overlay', () => {
    setProxyEnv(IN_APP)
    expect(buildEnv({}).HTTP_PROXY).toBe(IN_APP.HTTP_PROXY)
    setProxyEnv(null)
    expect(buildEnv({}).HTTP_PROXY).toBeUndefined()
  })

  it('base env retains non-proxy entries', () => {
    const env = buildEnv({ FOO: 'bar', PATH: '/usr/bin' })
    expect(env.FOO).toBe('bar')
    expect(env.PATH).toBe('/usr/bin')
  })
})
