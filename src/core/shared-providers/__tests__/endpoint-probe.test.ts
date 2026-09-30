/**
 * @vitest-environment node
 *
 * Detect's network half against a REAL local HTTP server (port 0) — the shapes
 * vLLM, SGLang and a plain OpenAI-compatible server answer, and every way a
 * probe fails. The key must reach the server as a Bearer token and appear
 * nowhere in what comes back.
 */
import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { probeEndpoint } from '../endpoint-probe'

const KEY = 'sk-probe-secret-7f3a'

type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void

interface Served {
  origin: string
  /** Every request the server saw: path and headers. */
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders }>
}

const servers: http.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function serve(routes: Record<string, Route>): Promise<Served> {
  const requests: Served['requests'] = []
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    requests.push({ path, headers: req.headers })
    const route = routes[path]
    if (route) route(req, res)
    else json(res, 404, { detail: 'Not Found' })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, requests }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const vllmModels: Route = (_req, res) =>
  json(res, 200, {
    object: 'list',
    data: [
      {
        id: 'llama-3.3-70b',
        object: 'model',
        owned_by: 'vllm',
        root: '/models/llama',
        parent: null,
        max_model_len: 32768
      },
      { id: 'no-length', object: 'model', owned_by: 'vllm', max_model_len: 0 },
      { id: 'fractional', object: 'model', owned_by: 'vllm', max_model_len: 1.5 },
      { object: 'model', owned_by: 'vllm' },
      { id: 42, owned_by: 'vllm' }
    ]
  })

const sglangModels: Route = (_req, res) =>
  json(res, 200, {
    object: 'list',
    data: [
      { id: 'qwen3-coder', object: 'model', owned_by: 'sglang', max_model_len: 262144 },
      { id: 'qwen3-coder-lora', object: 'model', owned_by: 'sglang', max_model_len: 32768 }
    ]
  })

const sglangInfo: Route = (_req, res) =>
  json(res, 200, {
    model_path: '/models/qwen3',
    served_model_name: 'qwen3-coder',
    has_image_understanding: true,
    reasoning_parser: 'qwen3',
    tool_call_parser: null
  })

describe('probeEndpoint — server shapes', () => {
  it('vLLM: ids and max_model_len; nothing about vision or reasoning', async () => {
    const { origin } = await serve({ '/v1/models': vllmModels })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1` })).toEqual({
      status: 'detected',
      server: 'vllm',
      models: [
        { id: 'llama-3.3-70b', contextWindow: 32768 },
        { id: 'no-length' },
        { id: 'fractional' }
      ]
    })
  })

  it('SGLang: context from /v1/models, vision + reasoning from /model_info, for every model', async () => {
    const { origin, requests } = await serve({
      '/v1/models': sglangModels,
      '/model_info': sglangInfo
    })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1` })).toEqual({
      status: 'detected',
      server: 'sglang',
      models: [
        {
          id: 'qwen3-coder',
          contextWindow: 262144,
          vision: true,
          reasoning: true,
          reasoningParser: 'qwen3'
        },
        {
          id: 'qwen3-coder-lora',
          contextWindow: 32768,
          vision: true,
          reasoning: true,
          reasoningParser: 'qwen3'
        }
      ],
      toolCallParser: null
    })
    // /model_info lives at the server root, not under /v1.
    expect(requests.map((request) => request.path)).toEqual(['/v1/models', '/model_info'])
  })

  it('SGLang: falls back to the deprecated /get_model_info on a 404', async () => {
    const { origin, requests } = await serve({
      '/v1/models': sglangModels,
      '/get_model_info': (_req, res) =>
        json(res, 200, {
          has_image_understanding: false,
          reasoning_parser: null,
          tool_call_parser: 'qwen25'
        })
    })
    const result = await probeEndpoint({ baseUrl: `${origin}/v1` })
    expect(result).toMatchObject({ status: 'detected', server: 'sglang', toolCallParser: 'qwen25' })
    if (result.status !== 'detected') throw new Error('expected detected')
    expect(result.models[0]).toEqual({
      id: 'qwen3-coder',
      contextWindow: 262144,
      vision: false,
      reasoning: false
    })
    expect(result.modelInfoUnavailable).toBeUndefined()
    expect(requests.map((request) => request.path)).toEqual([
      '/v1/models',
      '/model_info',
      '/get_model_info'
    ])
  })

  it('SGLang: both model_info routes 404 → still detected, context only, flagged', async () => {
    const { origin } = await serve({ '/v1/models': sglangModels })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1` })).toEqual({
      status: 'detected',
      server: 'sglang',
      models: [
        { id: 'qwen3-coder', contextWindow: 262144 },
        { id: 'qwen3-coder-lora', contextWindow: 32768 }
      ],
      modelInfoUnavailable: true
    })
  })

  it('SGLang: a model_info that is not a 404 is not retried, just unavailable', async () => {
    const { origin, requests } = await serve({
      '/v1/models': sglangModels,
      '/model_info': (_req, res) => json(res, 500, { error: 'boom' })
    })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1` })).toMatchObject({
      status: 'detected',
      server: 'sglang',
      modelInfoUnavailable: true
    })
    expect(requests.map((request) => request.path)).toEqual(['/v1/models', '/model_info'])
  })

  it('a generic OpenAI-compatible server: ids only', async () => {
    const { origin } = await serve({
      '/v1/models': (_req, res) =>
        json(res, 200, {
          object: 'list',
          data: [
            { id: 'gpt-local', object: 'model', owned_by: 'organization-owner' },
            { id: 'gpt-local', object: 'model', owned_by: 'organization-owner' },
            { id: 'embed', object: 'model', owned_by: 'openai' }
          ]
        })
    })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1` })).toEqual({
      status: 'detected',
      server: 'openai-compatible',
      models: [{ id: 'gpt-local' }, { id: 'embed' }]
    })
  })

  it('reads the base as typed: trailing slash stripped, no /v1 appended', async () => {
    const { origin, requests } = await serve({
      '/v1/models': sglangModels,
      '/model_info': sglangInfo,
      '/models': vllmModels
    })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1/` })).toMatchObject({ server: 'sglang' })
    // Without /v1 the root is the base itself.
    expect(await probeEndpoint({ baseUrl: origin })).toMatchObject({ server: 'vllm' })
    expect(requests.map((request) => request.path)).toEqual([
      '/v1/models',
      '/model_info',
      '/models'
    ])
  })

  it('a path prefix before /v1 keeps its prefix at the root', async () => {
    const { origin, requests } = await serve({
      '/lab/v1/models': sglangModels,
      '/lab/model_info': sglangInfo
    })
    expect(await probeEndpoint({ baseUrl: `  ${origin}/lab/v1  ` })).toMatchObject({
      server: 'sglang',
      toolCallParser: null
    })
    expect(requests.map((request) => request.path)).toEqual(['/lab/v1/models', '/lab/model_info'])
  })
})

describe('probeEndpoint — failures', () => {
  it('401 / 403 → unauthorized', async () => {
    const { origin } = await serve({
      '/v1/models': (_req, res) => json(res, 401, { error: 'Unauthorized' }),
      '/v2/models': (_req, res) => json(res, 403, { error: 'Forbidden' })
    })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1` })).toEqual({
      status: 'failed',
      reason: 'unauthorized',
      message: `${origin}/v1/models refused the request (HTTP 401).`
    })
    expect(await probeEndpoint({ baseUrl: `${origin}/v2` })).toMatchObject({
      reason: 'unauthorized'
    })
  })

  it('302 → redirect, never followed, naming where without its query', async () => {
    const { origin, requests } = await serve({
      '/v1/models': (_req, res) => {
        res.writeHead(302, { location: '/login?next=%2Fv1&token=abc' })
        res.end()
      }
    })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1` })).toEqual({
      status: 'failed',
      reason: 'redirect',
      message: `${origin}/v1/models redirected to ${origin}/login (HTTP 302). Use the address it serves the API on.`
    })
    expect(requests.map((request) => request.path)).toEqual(['/v1/models'])
  })

  it('500 → http, with the status', async () => {
    const { origin } = await serve({ '/v1/models': (_req, res) => json(res, 500, {}) })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1` })).toEqual({
      status: 'failed',
      reason: 'http',
      message: `${origin}/v1/models answered HTTP 500.`
    })
  })

  it('invalid JSON, or JSON without a data array → invalid-response', async () => {
    const { origin } = await serve({
      '/v1/models': (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>login</html>')
      },
      '/v2/models': (_req, res) => json(res, 200, { models: [] })
    })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1` })).toMatchObject({
      status: 'failed',
      reason: 'invalid-response'
    })
    expect(await probeEndpoint({ baseUrl: `${origin}/v2` })).toMatchObject({
      status: 'failed',
      reason: 'invalid-response'
    })
  })

  it('a body over 2 MiB → invalid-response, declared or streamed', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1)
    const { origin } = await serve({
      // res.end(string) declares a content-length.
      '/v1/models': (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(big)
      },
      // write() without one streams chunked: the cap has to count bytes.
      '/v2/models': (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        for (let i = 0; i < 3; i++) res.write('y'.repeat(1024 * 1024))
        res.end()
      }
    })
    for (const path of ['/v1', '/v2']) {
      expect(await probeEndpoint({ baseUrl: `${origin}${path}` })).toMatchObject({
        status: 'failed',
        reason: 'invalid-response',
        message: expect.stringContaining('more than 2 MiB')
      })
    }
  })

  it('a server that never answers → timeout', async () => {
    const { origin } = await serve({
      '/v1/models': () => {
        /* hold the request open */
      }
    })
    expect(await probeEndpoint({ baseUrl: `${origin}/v1` }, fetch, { timeoutMs: 150 })).toEqual({
      status: 'failed',
      reason: 'timeout',
      message: `${origin}/v1/models did not answer within 0.2 s.`
    })
  })

  it('a closed port → unreachable', async () => {
    const closed = http.createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const { port } = closed.address() as AddressInfo
    await new Promise((resolve) => closed.close(resolve))
    expect(await probeEndpoint({ baseUrl: `http://127.0.0.1:${port}/v1` })).toEqual({
      status: 'failed',
      reason: 'unreachable',
      message: `Couldn't reach http://127.0.0.1:${port}/v1/models (connection refused).`
    })
  })

  it('refuses anything but an http(s) URL, and a URL carrying credentials', async () => {
    for (const baseUrl of [
      '',
      'not a url',
      'ftp://host/v1',
      'file:///etc/passwd',
      'http://u:p@host/v1'
    ]) {
      expect(await probeEndpoint({ baseUrl })).toMatchObject({
        status: 'failed',
        reason: 'invalid-url'
      })
    }
  })
})

describe('probeEndpoint — the key (GUARD)', () => {
  it('reaches the server as a Bearer token, x-api-key only for the Anthropic protocol', async () => {
    const { origin, requests } = await serve({
      '/v1/models': sglangModels,
      '/model_info': sglangInfo
    })
    const result = await probeEndpoint({
      baseUrl: `${origin}/v1`,
      protocol: 'openai-completions',
      apiKey: `  ${KEY}\n`
    })
    expect(result.status).toBe('detected')
    // Both requests, model_info included.
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`)
      expect(request.headers['x-api-key']).toBeUndefined()
      expect(request.headers.accept).toBe('application/json')
    }
    expect(JSON.stringify(result)).not.toContain(KEY)

    await probeEndpoint({ baseUrl: `${origin}/v1`, protocol: 'anthropic-messages', apiKey: KEY })
    expect(requests[2].headers['x-api-key']).toBe(KEY)
  })

  it('sends no Authorization at all without a key', async () => {
    const { origin, requests } = await serve({ '/v1/models': vllmModels })
    await probeEndpoint({ baseUrl: `${origin}/v1`, apiKey: '   ' })
    expect(requests[0].headers.authorization).toBeUndefined()
  })

  it('never appears in a failure, whatever the transport error says', async () => {
    // undici quotes a rejected header value in its TypeError; the probe must
    // not pass that text on.
    const throwing = (async () => {
      throw new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value.`)
    }) as unknown as typeof fetch
    const result = await probeEndpoint(
      { baseUrl: 'http://127.0.0.1:1/v1?token=query-secret', apiKey: KEY },
      throwing
    )
    expect(result).toMatchObject({ status: 'failed', reason: 'unreachable' })
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(JSON.stringify(result)).not.toContain('query-secret')
  })

  it('never appears in an error from a failed response', async () => {
    const { origin } = await serve({
      '/v1/models': (_req, res) => {
        res.writeHead(307, { location: `https://sso.example.test/login?key=${KEY}` })
        res.end()
      },
      '/v2/models': (_req, res) => json(res, 401, { error: `bad key ${KEY}` })
    })
    for (const path of ['/v1', '/v2']) {
      const result = await probeEndpoint({ baseUrl: `${origin}${path}`, apiKey: KEY })
      expect(result.status).toBe('failed')
      expect(JSON.stringify(result)).not.toContain(KEY)
    }
  })
})
