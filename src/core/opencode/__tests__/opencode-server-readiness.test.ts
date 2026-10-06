/**
 * Hosted-tools readiness (S0 finding 1, ADR-093 §2): a scripted server and a
 * fake clock — every wait is virtual.
 */
import { describe, it, expect } from 'vitest'
import {
  MODEL_CATALOG_WARMUP_MS,
  modelListIsAuthoritative,
  READINESS_SENTINEL_TOOL,
  waitForHostedTools,
  type ReadinessDeps,
  type ReadinessResponse
} from '../opencode-server-readiness'

/** What the fake server answers at a virtual time. */
interface Script {
  rpc?: (t: number) => ReadinessResponse | Error
  mcp: (t: number) => ReadinessResponse | Error
}

function harness(script: Script): { deps: ReadinessDeps; requests: string[]; clock: () => number } {
  let t = 0
  const requests: string[] = []
  const answer = (r: ReadinessResponse | Error | undefined): Promise<ReadinessResponse> =>
    r instanceof Error
      ? Promise.reject(r)
      : r
        ? Promise.resolve(r)
        : Promise.reject(new Error('no route'))
  return {
    requests,
    clock: () => t,
    deps: {
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
      request: (method, path) => {
        requests.push(`${method} ${path}`)
        if (path === '/api/mcp') return answer(script.mcp(t))
        if (path === '/api/rpc/claudeui-xeng/tools') return answer(script.rpc?.(t))
        return answer(undefined)
      }
    }
  }
}

const rpcTools = (...tools: string[]): ReadinessResponse => ({
  status: 200,
  body: { output: { tools } }
})
const mcpStatus = (status: string, error?: string): ReadinessResponse => ({
  status: 200,
  body: {
    location: {},
    data: [{ name: 'claudeui', status: { status, ...(error ? { error } : {}) } }]
  }
})
const noServers: ReadinessResponse = { status: 200, body: { data: [] } }
const rpcUnavailable: ReadinessResponse = {
  status: 400,
  body: { _tag: 'RpcError', type: 'rpc.unavailable', message: 'RPC is unavailable: claudeui-xeng' }
}

describe('waitForHostedTools', () => {
  it('ready on the registry signal once the plugin lists the sentinel tool — not on "connected"', async () => {
    // connected at 200 ms, registered (debounce) at 350 ms
    const { deps } = harness({
      mcp: (t) => (t < 200 ? noServers : mcpStatus('connected')),
      rpc: (t) =>
        t < 350 ? rpcTools() : rpcTools('claudeui_create_mockup', READINESS_SENTINEL_TOOL)
    })
    const result = await waitForHostedTools({ pluginExpected: true }, deps)
    expect(result).toEqual({ state: 'ready', signal: 'registry', elapsedMs: 350 })
  })

  it('keeps waiting while connected but not yet registered (the S0 race)', async () => {
    const { deps } = harness({
      mcp: () => mcpStatus('connected'),
      rpc: (t) => (t < 1500 ? rpcTools() : rpcTools(READINESS_SENTINEL_TOOL))
    })
    const result = await waitForHostedTools({ pluginExpected: true }, deps)
    expect(result).toMatchObject({ state: 'ready', signal: 'registry', elapsedMs: 1500 })
  })

  it('without a plugin: connected + settle margin (heuristic), never the RPC', async () => {
    const { deps, requests } = harness({
      mcp: (t) => (t < 100 ? noServers : mcpStatus('connected'))
    })
    const result = await waitForHostedTools({ pluginExpected: false, settleMs: 400 }, deps)
    expect(result).toEqual({ state: 'ready', signal: 'mcp-status', elapsedMs: 500 })
    expect(requests.every((r) => r === 'GET /api/mcp')).toBe(true)
  })

  it('plugin expected but its RPC never answers: falls back after the grace period', async () => {
    const { deps } = harness({
      mcp: (t) => (t < 100 ? noServers : mcpStatus('connected')),
      rpc: () => rpcUnavailable
    })
    const result = await waitForHostedTools(
      { pluginExpected: true, pluginGraceMs: 2000, settleMs: 400 },
      deps
    )
    expect(result).toEqual({ state: 'ready', signal: 'mcp-status', elapsedMs: 2100 })
  })

  it('a plugin that answers (empty list) is trusted: no status fallback while it answers', async () => {
    const { deps } = harness({
      mcp: () => mcpStatus('connected'),
      rpc: () => rpcTools()
    })
    const result = await waitForHostedTools({ pluginExpected: true, timeoutMs: 5000 }, deps)
    expect(result.state).toBe('timeout')
  })

  it('stops at once when claudeui failed to connect', async () => {
    const { deps } = harness({
      mcp: (t) => (t < 300 ? mcpStatus('pending') : mcpStatus('failed', 'Connection refused')),
      rpc: () => rpcTools()
    })
    const result = await waitForHostedTools({ pluginExpected: true }, deps)
    expect(result).toEqual({
      state: 'failed',
      reason: 'claudeui failed: Connection refused',
      elapsedMs: 300
    })
  })

  it('times out (bounded) with the last observation, and never throws on request errors', async () => {
    const { deps, clock } = harness({
      mcp: () => new Error('ECONNREFUSED'),
      rpc: () => new Error('ECONNREFUSED')
    })
    const result = await waitForHostedTools({ pluginExpected: true, timeoutMs: 10_000 }, deps)
    expect(result).toEqual({
      state: 'timeout',
      last: 'rpc unreachable, claudeui absent',
      elapsedMs: 10_000
    })
    expect(clock()).toBe(10_000)
  })
})

describe('modelListIsAuthoritative (S7 seam)', () => {
  it('an empty list right after boot is not authoritative; a non-empty one always is', () => {
    expect(modelListIsAuthoritative({ count: 0, startedAt: 1000, now: 2500 })).toBe(false)
    expect(modelListIsAuthoritative({ count: 3, startedAt: 1000, now: 1001 })).toBe(true)
    expect(
      modelListIsAuthoritative({ count: 0, startedAt: 1000, now: 1000 + MODEL_CATALOG_WARMUP_MS })
    ).toBe(true)
  })
})
