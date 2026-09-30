/**
 * `pickJudgeFetch`: the global fetch without a proxy, undici's fetch behind an
 * `EnvHttpProxyAgent` with one (the dynamic import is mocked), memoized per
 * proxy configuration. Each test uses its own proxy URL because the memo is
 * module-level.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickJudgeFetch } from '../net'

const undici = vi.hoisted(() => {
  class EnvHttpProxyAgent {
    static instances: EnvHttpProxyAgent[] = []
    static failNext = false
    constructor(readonly opts: Record<string, string>) {
      if (EnvHttpProxyAgent.failNext) {
        EnvHttpProxyAgent.failNext = false
        throw new Error('agent construction failed')
      }
      EnvHttpProxyAgent.instances.push(this)
    }
  }
  const fetch = vi.fn(async () => new Response('proxied'))
  return { EnvHttpProxyAgent, fetch }
})
vi.mock('undici', () => undici)

beforeEach(() => {
  undici.EnvHttpProxyAgent.instances = []
  undici.fetch.mockClear()
})

describe('pickJudgeFetch', () => {
  it('returns the global fetch when no proxy variable is set, without loading undici', async () => {
    const picked = await pickJudgeFetch({ PATH: '/bin', NO_PROXY: 'localhost' })
    expect(picked).toBe(globalThis.fetch)
    expect(undici.EnvHttpProxyAgent.instances).toHaveLength(0)
  })

  it('treats an empty proxy variable as unset', async () => {
    expect(await pickJudgeFetch({ HTTPS_PROXY: '' })).toBe(globalThis.fetch)
  })

  it('HTTPS_PROXY → undici fetch bound to an EnvHttpProxyAgent built from the given env', async () => {
    const picked = await pickJudgeFetch({
      HTTPS_PROXY: 'http://proxy-a.test:3128',
      NO_PROXY: 'localhost,127.0.0.1'
    })
    expect(picked).not.toBe(globalThis.fetch)
    expect(undici.EnvHttpProxyAgent.instances).toHaveLength(1)
    const agent = undici.EnvHttpProxyAgent.instances[0]
    expect(agent.opts).toEqual({
      httpsProxy: 'http://proxy-a.test:3128',
      noProxy: 'localhost,127.0.0.1'
    })

    const res = await picked('https://judge.test/v1/chat/completions', {
      method: 'POST',
      body: '{}'
    })
    expect(await res.text()).toBe('proxied')
    expect(undici.fetch).toHaveBeenCalledWith('https://judge.test/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      dispatcher: agent
    })
  })

  it('reads the variables in any case', async () => {
    await pickJudgeFetch({ http_proxy: 'http://proxy-b.test:1' })
    await pickJudgeFetch({ Https_Proxy: 'http://proxy-c.test:1' })
    expect(undici.EnvHttpProxyAgent.instances.map((a) => a.opts)).toEqual([
      { httpProxy: 'http://proxy-b.test:1' },
      { httpsProxy: 'http://proxy-c.test:1' }
    ])
  })

  it('ALL_PROXY stands in for both schemes (undici does not read it itself)', async () => {
    await pickJudgeFetch({ ALL_PROXY: 'http://proxy-d.test:1' })
    expect(undici.EnvHttpProxyAgent.instances[0].opts).toEqual({
      httpProxy: 'http://proxy-d.test:1',
      httpsProxy: 'http://proxy-d.test:1'
    })
  })

  it('is memoized per proxy configuration', async () => {
    const env = { HTTPS_PROXY: 'http://proxy-e.test:1' }
    const a = await pickJudgeFetch(env)
    const b = await pickJudgeFetch({ ...env })
    expect(b).toBe(a)
    expect(undici.EnvHttpProxyAgent.instances).toHaveLength(1)

    const c = await pickJudgeFetch({ HTTPS_PROXY: 'http://proxy-f.test:1' })
    expect(c).not.toBe(a)
    expect(undici.EnvHttpProxyAgent.instances).toHaveLength(2)
  })

  it('does not cache a failure — the next call retries', async () => {
    const env = { HTTPS_PROXY: 'http://proxy-g.test:1' }
    undici.EnvHttpProxyAgent.failNext = true
    await expect(pickJudgeFetch(env)).rejects.toThrow('agent construction failed')
    const picked = await pickJudgeFetch(env)
    expect(picked).not.toBe(globalThis.fetch)
    expect(undici.EnvHttpProxyAgent.instances).toHaveLength(1)
  })
})
