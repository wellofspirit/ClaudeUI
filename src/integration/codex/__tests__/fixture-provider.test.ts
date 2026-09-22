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
 *
 * The `chatgpt` half (F16) is guarded to the same standard: it is what a drive
 * under an INJECTED ChatGPT identity talks to, and the only thing keeping such a
 * drive off the real `chatgpt.com` backend with a fabricated token.
 *
 * SAFETY: `node:os`.homedir is mocked for the whole file (the pattern
 * `AuthVaultAccounts.test.ts` uses), so the fabricated vault is written and read
 * under a temp directory and the real `~/.claude/ui/auth-vault.json` is never on
 * any path this file computes.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const fakeHome = vi.hoisted(() => ({ value: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => fakeHome.value,
    default: { ...actual, homedir: () => fakeHome.value }
  }
})

import {
  FIXTURE_API_KEY,
  FIXTURE_AUTHORIZATION,
  FIXTURE_HOLD,
  fixtureAssistantMessage,
  fixtureReasoningItem,
  fixtureResponseEvents,
  renderFixtureConfigToml,
  startFixtureProvider,
  writeFabricatedVault,
  writeFixtureCodexHome,
  type FixtureProvider
} from '../fixture-provider'
import { AuthVault, CHATGPT_PROVIDER_ID } from '../../../core/auth/vault/AuthVault'
import { extractAccountId } from '../../../core/auth/vault/codex-oauth'

let provider: FixtureProvider | undefined
let home: string | undefined
afterEach(async () => {
  await provider?.close()
  provider = undefined
  if (home) rmSync(home, { recursive: true, force: true })
  home = undefined
  fakeHome.value = ''
})

function post(
  port: number,
  body: string | Buffer,
  options: {
    path?: string
    method?: string
    authorization?: string
    headers?: Record<string, string>
  } = {}
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
          ...(options.authorization ? { authorization: options.authorization } : {}),
          ...(options.headers ?? {})
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

  it('omits the whole [features] table on request, so the binary keeps its defaults', () => {
    // F17's probe is the only caller: every one of the nine desktop-app flags
    // ships `default_enabled: true`, so a home that declares nothing is the one
    // way to see what a stock `~/.codex` gives a thread. The rest of the file
    // must be untouched — the fixture provider, the disabled network features
    // and the file credential store are what keep the child isolated.
    const defaults = renderFixtureConfigToml({
      port: 41999,
      model: 'mock-model',
      features: 'binary-defaults'
    })
    expect(defaults).toBe(fixtureVariant.slice(0, fixtureVariant.indexOf('[features]')))
    expect(defaults).not.toContain('[features]')
    expect(defaults).toContain('web_search = "disabled"')
  })

  it('appends extra TOML verbatim at the very end', () => {
    const extra = '[shell_environment_policy]\ninherit = "all"\n'
    expect(renderFixtureConfigToml({ port: 41999, model: 'mock-model', extraToml: extra })).toBe(
      `${fixtureVariant}${extra}`
    )
  })

  it('renders exactly the feature keys it is given, in order', () => {
    const toml = renderFixtureConfigToml({
      port: 41999,
      model: 'mock-model',
      features: { browser_use: false, apps: true }
    })
    expect(toml.slice(toml.indexOf('[features]'))).toBe(
      '[features]\nbrowser_use = false\napps = true\n'
    )
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

  it('points the binary at the fixture backend only in chatgpt mode', () => {
    // Under an injected ChatGPT identity the binary calls `chatgpt_base_url`
    // for its own reads (`/wham/*`, `/api/codex/usage`) and attaches the
    // injected bearer to the provider call. Without the redirect those go to
    // the REAL chatgpt.com with a fabricated token and the host dies within
    // seconds (seen live 2026-09-16 on macOS).
    const native = renderFixtureConfigToml({ port: 41999, model: 'mock-model' })
    expect(native).not.toContain('chatgpt_base_url')
    expect(native).toContain('requires_openai_auth = false')
    const injected = renderFixtureConfigToml({ port: 41999, model: 'mock-model', chatgpt: true })
    expect(injected).toContain('chatgpt_base_url = "http://127.0.0.1:41999/backend-api"')
    expect(injected).toContain('requires_openai_auth = true')
    // The redirect is additive: a home that also redirects the built-in
    // provider (what a real app session uses) keeps both lines.
    const both = renderFixtureConfigToml({
      port: 41999,
      provider: 'openai',
      openaiBaseUrl: 'http://127.0.0.1:41999/v1',
      chatgpt: true
    })
    expect(both).toContain('openai_base_url = "http://127.0.0.1:41999/v1"')
    expect(both).toContain('chatgpt_base_url = "http://127.0.0.1:41999/backend-api"')
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

  it('streams a reasoning item the way the wire does, before the message (F19)', async () => {
    // `scripts/probe-codex.py`'s `answer(reasoning=True)` is the shape: the item
    // arrives with an EMPTY summary, the summary text comes as a delta, and only
    // then is the item done. Without the delta the app-server emits no
    // `item/reasoning/summaryTextDelta` at all and nothing streams.
    const events = fixtureResponseEvents([
      fixtureReasoningItem('**Fixture headline**'),
      fixtureAssistantMessage('done')
    ])
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.output_item.done',
      'response.output_item.done',
      'response.completed'
    ])
    expect(events[1]).toMatchObject({
      item: { type: 'reasoning', id: 'reason-fixture', summary: [] }
    })
    expect(events[3]).toEqual({
      type: 'response.reasoning_summary_text.delta',
      summary_index: 0,
      delta: '**Fixture headline**'
    })
    expect(events[4]).toMatchObject({
      item: { summary: [{ type: 'summary_text', text: '**Fixture headline**' }] }
    })
    expect(events[5]).toMatchObject({ item: { type: 'message' } })
  })

  it('keeps a one-item turn at exactly three events', async () => {
    // The framing every existing caller asserts: a scripted item that is not
    // reasoning is still `created` / `output_item.done` / `completed`.
    expect(fixtureResponseEvents(fixtureAssistantMessage()).map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.done',
      'response.completed'
    ])
  })

  it('serves a scripted list of items over the wire in order', async () => {
    provider = await startFixtureProvider({
      script: () => [fixtureReasoningItem('**Fixture headline**'), fixtureAssistantMessage('done')]
    })
    const res = await post(provider.port, '{}')
    expect(res.status).toBe(200)
    expect(
      res.body
        .split('\n\n')
        .filter(Boolean)
        .map((block) => block.split('\n')[0])
    ).toEqual([
      'event: response.created',
      'event: response.output_item.added',
      'event: response.reasoning_summary_part.added',
      'event: response.reasoning_summary_text.delta',
      'event: response.output_item.done',
      'event: response.output_item.done',
      'event: response.completed'
    ])
    expect(res.body).toContain('"delta":"**Fixture headline**"')
    expect(res.body).toContain('"text":"done"')
    expect(provider.errors).toEqual([])
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

describe('fixture provider under an injected ChatGPT identity', () => {
  it("answers the binary's own backend calls 404 and records them outside errors", async () => {
    // These are the calls the binary makes for ITSELF once an external token is
    // injected — profile, workspace check, config bundle, usage — plus the
    // catalog probe. None of them is a turn, none of them is a fixture
    // rejection, and a fixture that 400s them makes the host give up.
    provider = await startFixtureProvider({ chatgpt: true })
    const profile = await post(provider.port, '', {
      method: 'GET',
      path: '/backend-api/wham/profiles/me'
    })
    expect(profile.status).toBe(404)
    expect(profile.body).toBe('{"error":"fixture"}')
    const models = await post(provider.port, '', { method: 'GET', path: '/v1/models' })
    expect(models.status).toBe(404)
    expect(provider.backend).toEqual(['GET /backend-api/wham/profiles/me', 'GET /v1/models'])
    expect(provider.errors).toEqual([])
    expect(provider.requests).toEqual([])
  })

  it('parses a gzip-encoded turn with any bearer and records the bearer', async () => {
    // A session under an injected identity sends its model requests
    // gzip-encoded (handoff, H-series gotcha 2), and the bearer is the vault's
    // fabricated JWT rather than the fixture's own API key.
    provider = await startFixtureProvider({ chatgpt: true })
    const res = await post(provider.port, gzipSync(Buffer.from(JSON.stringify({ input: 'hi' }))), {
      authorization: 'Bearer header.payload.unsigned-fabricated',
      headers: { 'content-encoding': 'gzip' }
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('"text":"fixture complete"')
    expect(provider.requests).toEqual([{ input: 'hi' }])
    expect(provider.authorizations).toEqual(['Bearer header.payload.unsigned-fabricated'])
    expect(provider.errors).toEqual([])
  })

  it('parses a zstd-encoded turn too — what the macOS binary sends under an injected identity', async () => {
    // Windows sent gzip; the macOS build of 0.154 sends zstd (seen live
    // 2026-09-16: `REJECTED invalid provider JSON (content-encoding: zstd)`).
    provider = await startFixtureProvider({ chatgpt: true })
    const res = await post(
      provider.port,
      zstdCompressSync(Buffer.from(JSON.stringify({ input: 'hi' }))),
      {
        authorization: 'Bearer header.payload.unsigned-fabricated',
        headers: { 'content-encoding': 'zstd' }
      }
    )
    expect(res.status).toBe(200)
    expect(provider.requests).toEqual([{ input: 'hi' }])
    expect(provider.errors).toEqual([])
  })

  it('keeps the strict authorization match when chatgpt mode is off', async () => {
    provider = await startFixtureProvider({ authorization: FIXTURE_AUTHORIZATION })
    const wrong = await post(provider.port, '{}', { authorization: 'Bearer somebody-elses-token' })
    expect(wrong.status).toBe(400)
    expect(provider.requests).toEqual([])
    expect(provider.errors).toEqual([
      'unexpected provider request: POST /v1/responses; auth matched: false'
    ])
    // And a backend path is NOT quietly answered when the mode is off: the
    // native fixture has no business serving chatgpt.com's routes.
    const backend = await post(provider.port, '', {
      method: 'GET',
      path: '/backend-api/wham/profiles/me',
      authorization: FIXTURE_AUTHORIZATION
    })
    expect(backend.status).toBe(400)
    expect(provider.backend).toEqual([])
  })

  it('scripts the status of the next turn, which is how a 401 refresh is driven', async () => {
    // `codex-injection.integration.test.ts` needs exactly this: one 401, then
    // the ordinary answer, so the app-server asks the host to refresh.
    const next = [401, 200]
    provider = await startFixtureProvider({
      chatgpt: true,
      statusFor: () => next.shift() ?? 200
    })
    const refused = await post(provider.port, '{"input":"one"}', { authorization: 'Bearer first' })
    expect(refused.status).toBe(401)
    expect(refused.body).toBe('{"error":"scripted"}')
    const answered = await post(provider.port, '{"input":"two"}', {
      authorization: 'Bearer second'
    })
    expect(answered.status).toBe(200)
    // The refused call still counts as a call: its bearer is what tells a test
    // the FIRST attempt carried the pre-refresh token.
    expect(provider.authorizations).toEqual(['Bearer first', 'Bearer second'])
    expect(provider.errors).toEqual([])
  })
})

describe('fabricated vault', () => {
  it('writes N accounts the real AuthVault reads back, the first active', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'codex-fixture-vault-'))
    home = scratch
    fakeHome.value = join(tmpdir(), 'not-the-fixture-home')
    const written = writeFabricatedVault(scratch, { accounts: 2 })
    expect(written.path).toBe(join(scratch, '.claude', 'ui', 'auth-vault.json'))
    expect(written.accounts.map((account) => account.id)).toEqual(['fab-acc-1', 'fab-acc-2'])

    // The real vault reader is the assertion: a shape it silently drops would
    // leave a drive with no identity at all.
    fakeHome.value = scratch
    const vault = new AuthVault()
    const accounts = await vault.listAccounts(CHATGPT_PROVIDER_ID)
    expect(accounts.map((account) => account.id)).toEqual(['fab-acc-1', 'fab-acc-2'])
    expect(await vault.getActiveAccountId(CHATGPT_PROVIDER_ID)).toBe('fab-acc-1')
    expect(accounts[0].email).toBe(written.accounts[0].email)
    expect(accounts[0].accountId).toBe(written.accounts[0].accountId)
    // The JWT is what Codex's own claim reader parses the workspace out of.
    for (const [index, account] of accounts.entries())
      expect(extractAccountId({ access_token: account.credential.access })).toBe(
        written.accounts[index].accountId
      )
    // Far enough ahead that no refresh timer fires during a drive.
    expect(accounts[0].credential.expires).toBeGreaterThan(Date.now() + 7 * 86400_000)
  })

  it('refuses to write into the real home', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'codex-fixture-vault-'))
    home = scratch
    // The writer's own homedir IS this directory for the length of the case, so
    // the refusal is the same one that protects `~/.claude/ui/auth-vault.json`.
    fakeHome.value = scratch
    expect(() => writeFabricatedVault(scratch, { accounts: 1 })).toThrow(/real home/i)
    expect(existsSync(join(scratch, '.claude', 'ui', 'auth-vault.json'))).toBe(false)
  })
})

describe('codex-render-stress --accounts', () => {
  // The flag lives in `scripts/codex-render-stress.mjs`, whose own suite this
  // slice does not own; guarded here because it is the one switch that puts the
  // stress loop under an injected identity, and an unknown flag there is a
  // silent no-op run.
  const stress = resolve(__dirname, '../../../../scripts/codex-render-stress.mjs')
  const parse = async (
    argv: string[]
  ): Promise<{ options: Record<string, unknown>; errors: string[] }> => {
    const mod: {
      parseOptions: (argv: string[]) => { options: Record<string, unknown>; errors: string[] }
    } = await import(stress)
    const parsed = mod.parseOptions(argv)
    return {
      options: parsed.options,
      errors: parsed.errors.filter((error) => !error.includes('out/main/index.js'))
    }
  }

  it('defaults to no vault and takes an account count', async () => {
    expect((await parse([])).options.accounts).toBe(0)
    const injected = await parse(['--accounts', '2'])
    expect(injected.errors).toEqual([])
    expect(injected.options.accounts).toBe(2)
  })

  it('refuses a non-integer account count instead of running without a vault', async () => {
    expect((await parse(['--accounts', 'two'])).errors).toEqual([
      '--accounts must be an integer >= 0 (got "two")'
    ])
  })
})

it('optionally streams message chunks while preserving the default completed-item fixture', () => {
  const item = fixtureAssistantMessage('A streamed answer with several chunks')
  const basic = fixtureResponseEvents(item)
  expect(basic).toHaveLength(3)
  const streamed = fixtureResponseEvents(item, true)
  const chunks = streamed.filter((e) => e.type === 'response.output_text.delta')
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.map((e) => e.delta).join('')).toBe('A streamed answer with several chunks')
  expect(streamed[1]).toMatchObject({ type: 'response.output_item.added', item: { content: [] } })
  expect(streamed.at(-2)).toEqual({ type: 'response.output_item.done', output_index: 0, item })
})
