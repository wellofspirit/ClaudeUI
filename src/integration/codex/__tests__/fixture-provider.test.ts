/**
 * @vitest-environment node
 *
 * The shared Codex fixture provider (`src/integration/codex/fixture-provider.ts`).
 *
 * Two things are guarded here, and both are load-bearing for something that
 * cannot guard itself cheaply:
 *
 *  - the `config.toml` text, asserted against the literal the real-binary
 *    integration suite used before the extraction. That suite is gated to
 *    macOS arm64 (and the ADR-068 files also to Windows x64), so on any other
 *    host nothing else would notice a drifted key — and a drifted key means the
 *    child talks to the real OpenAI endpoint, or writes analytics, or retries a
 *    turn the fixture only scripted once.
 *  - the HTTP behaviour: what it accepts, what it refuses, and the SSE framing
 *    of a scripted turn. `scripts/codex-render-stress.mjs` drives a real app
 *    through it, and a silently-tolerated bad request there would look like a
 *    passing stress run.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FIXTURE_API_KEY,
  FIXTURE_AUTHORIZATION,
  FIXTURE_HOLD,
  fixtureAssistantMessage,
  renderFixtureConfigToml,
  startFixtureProvider,
  writeFixtureCodexHome,
  type FixtureProvider
} from '../fixture-provider'

let provider: FixtureProvider | undefined
let home: string | undefined
afterEach(async () => {
  await provider?.close()
  provider = undefined
  if (home) rmSync(home, { recursive: true, force: true })
  home = undefined
})

function post(
  port: number,
  body: string,
  options: { path?: string; method?: string; authorization?: string } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/v1/responses',
        headers: {
          'Content-Type': 'application/json',
          ...(options.authorization ? { authorization: options.authorization } : {})
        }
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** The status line of a raw WebSocket upgrade attempt. */
function upgrade(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZmFrZWtleWZha2VrZXkxMg==\r\n\r\n`
      )
    })
    let text = ''
    socket.on('data', (chunk) => (text += chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(text.split('\r\n')[0] ?? ''))
  })
}

describe('fixture config.toml', () => {
  // VERBATIM from `codex-app-server.integration.test.ts` before the extraction
  // (the non-native branch: `model = "mock-model"`, the `fixture` provider, no
  // `openai_base_url`). The blank third line is the empty interpolation and is
  // part of the contract — the assertion is on the whole file, not on keys.
  const fixtureVariant = `model = "mock-model"
model_provider = "fixture"

approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"
[model_providers.fixture]
name = "Isolated localhost fixture"
base_url = "http://127.0.0.1:41999/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 15000
[analytics]
enabled = false
[feedback]
enabled = false
[otel]
exporter = "none"
[features]
apps = false
plugins = false
remote_plugin = false
browser_use = false
computer_use = false
shell_snapshot = false
`

  it('renders the fixture-provider variant byte for byte', () => {
    expect(renderFixtureConfigToml({ port: 41999, model: 'mock-model' })).toBe(fixtureVariant)
  })

  it('renders the native-session variant byte for byte', () => {
    // The `nativeSession` branch: no model line (the catalog default), the
    // built-in `openai` provider, and its base URL pointed at the fixture.
    const expected = fixtureVariant
      .replace('model = "mock-model"\n', '\n')
      .replace('model_provider = "fixture"\n\n', 'model_provider = "openai"\n')
      .replace('approval_policy', 'openai_base_url = "http://127.0.0.1:41999/v1"\napproval_policy')
    expect(
      renderFixtureConfigToml({
        port: 41999,
        provider: 'openai',
        openaiBaseUrl: 'http://127.0.0.1:41999/v1'
      })
    ).toBe(expected)
    // Guard the guard: the rewrite above must have produced the four lines the
    // native-session home actually needs, not an accidental no-op.
    expect(expected.startsWith('\nmodel_provider = "openai"\nopenai_base_url =')).toBe(true)
  })

  it('pins the model when one is named and picks the guardian reviewer on request', () => {
    const toml = renderFixtureConfigToml({
      port: 1,
      model: 'gpt-5.6-luna',
      approvalsReviewer: 'auto_review'
    })
    expect(toml.startsWith('model = "gpt-5.6-luna"\n')).toBe(true)
    expect(toml).toContain('approvals_reviewer = "auto_review"')
  })

  it('never declares a table for the built-in openai provider', () => {
    // 0.154 refuses the WHOLE config file when `model_providers` names a
    // built-in id ("Built-in providers cannot be overridden") and falls back to
    // its defaults — i.e. the real OpenAI endpoint. Probed on Windows x64
    // 2026-09-15; the fixture points the built-in provider at itself with
    // `openai_base_url` instead.
    const toml = renderFixtureConfigToml({
      port: 7,
      provider: 'openai',
      openaiBaseUrl: 'http://127.0.0.1:7/v1'
    })
    expect(toml).not.toContain('[model_providers.openai]')
    expect(toml).toContain('openai_base_url = "http://127.0.0.1:7/v1"')
    expect(toml.endsWith('shell_snapshot = false\n')).toBe(true)
  })

  it('writes config.toml always and auth.json only for an API key', () => {
    home = mkdtempSync(join(tmpdir(), 'codex-fixture-home-'))
    writeFixtureCodexHome(home, { port: 8 })
    expect(existsSync(join(home, 'config.toml'))).toBe(true)
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    writeFixtureCodexHome(home, { port: 8, apiKey: FIXTURE_API_KEY })
    expect(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'))).toEqual({
      OPENAI_API_KEY: FIXTURE_API_KEY
    })
  })
})

describe('fixture provider', () => {
  it('answers one scripted assistant turn as SSE and records the request', async () => {
    provider = await startFixtureProvider()
    const res = await post(provider.port, JSON.stringify({ input: 'hello' }))
    expect(res.status).toBe(200)
    expect(res.body).toContain('event: response.created')
    expect(res.body).toContain('"text":"fixture complete"')
    expect(res.body.trimEnd().endsWith('}')).toBe(true)
    const events = res.body
      .split('\n\n')
      .filter(Boolean)
      .map((block) => block.split('\n')[0])
    expect(events).toEqual([
      'event: response.created',
      'event: response.output_item.done',
      'event: response.completed'
    ])
    expect(provider.requests).toEqual([{ input: 'hello' }])
    expect(provider.errors).toEqual([])
  })

  it('scripts per turn off the request index', async () => {
    provider = await startFixtureProvider({
      script: ({ requests }) =>
        requests.length === 1
          ? { type: 'function_call', call_id: 'c1', name: 'fixture_echo', arguments: '{}' }
          : fixtureAssistantMessage('second')
    })
    const first = await post(provider.port, '{}')
    const second = await post(provider.port, '{}')
    expect(first.body).toContain('"name":"fixture_echo"')
    expect(second.body).toContain('"text":"second"')
    expect(provider.requests.length).toBe(2)
  })

  it('refuses a request whose authorization does not match, and records it', async () => {
    provider = await startFixtureProvider({ authorization: FIXTURE_AUTHORIZATION })
    const missing = await post(provider.port, '{}')
    expect(missing.status).toBe(400)
    const wrongPath = await post(provider.port, '{}', {
      path: '/v1/models',
      authorization: FIXTURE_AUTHORIZATION
    })
    expect(wrongPath.status).toBe(400)
    const ok = await post(provider.port, '{}', { authorization: FIXTURE_AUTHORIZATION })
    expect(ok.status).toBe(200)
    expect(provider.requests.length).toBe(1)
    expect(provider.errors).toEqual([
      'unexpected provider request: POST /v1/responses; auth matched: false',
      'unexpected provider request: POST /v1/models; auth matched: true'
    ])
  })

  it('holds a scripted request open, and close() ends it', async () => {
    // The one HTTP behaviour the host probes need that a turn which always
    // answers cannot produce: a request left MID-FLIGHT, so a host can be killed
    // or closed while the model is still talking. Headers go out, the body never
    // does, and `close()` is what finally ends it.
    provider = await startFixtureProvider({ script: () => FIXTURE_HOLD })
    const held = post(provider.port, '{}')
    const raced = await Promise.race([
      held.then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('held'), 300))
    ])
    expect(raced).toBe('held')
    expect(provider.requests).toEqual([{}])
    expect(provider.errors).toEqual([])
    const closing = provider.close()
    provider = undefined
    await closing
    // OBSERVED: `close()` DESTROYS the held response, so the caller sees the
    // connection reset — the same thing a dead app-server's socket looks like,
    // and never a scripted turn that quietly completed after the fact.
    await expect(held).rejects.toMatchObject({ code: 'ECONNRESET' })
  })

  it('records a body that is not JSON instead of answering it', async () => {
    provider = await startFixtureProvider()
    const res = await post(provider.port, 'not json')
    expect(res.status).toBe(400)
    expect(provider.requests).toEqual([])
    expect(provider.errors).toEqual(['invalid provider JSON'])
  })

  it('answers a WebSocket upgrade with 426 so Codex falls back to HTTP', async () => {
    provider = await startFixtureProvider()
    expect(await upgrade(provider.port)).toBe('HTTP/1.1 426 Upgrade Required')
  })

  it('hands the upgrade to a caller that speaks the WebSocket wire', async () => {
    let seen = false
    provider = await startFixtureProvider({
      onUpgrade: (_req, socket) => {
        seen = true
        socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n')
      }
    })
    expect(await upgrade(provider.port)).toBe('HTTP/1.1 101 Switching Protocols')
    expect(seen).toBe(true)
  })

  it('appends into the arrays the caller owns', async () => {
    const requests: Record<string, unknown>[] = []
    const errors: string[] = []
    provider = await startFixtureProvider({ requests, errors })
    await post(provider.port, '{"a":1}')
    await post(provider.port, 'nope')
    expect(requests).toEqual([{ a: 1 }])
    expect(errors).toEqual(['invalid provider JSON'])
    expect(provider.requests).toBe(requests)
  })
})
