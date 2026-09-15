/**
 * The isolated localhost Responses provider every Codex fixture run talks to.
 *
 * ONE copy of this logic. It was born inside
 * `codex-app-server.integration.test.ts` (`setupFixture`) and is now shared with
 * `scripts/codex-fixture-provider.mjs`, which the render-loss stress loop
 * (`scripts/codex-render-stress.mjs`) points a REAL app at: the app drives real
 * Codex turns against this server instead of a paid provider, so a twenty-turn
 * stress run costs nothing and never leaves the machine. A second hand-rolled
 * fixture would drift from the one the integration suite proves, and the stress
 * loop would then be measuring a different provider than the tests do.
 *
 * What it is NOT: a mock of the Responses API. It answers exactly the three SSE
 * events Codex needs to finish a turn (`response.created`, one
 * `response.output_item.done`, `response.completed`) and nothing else. Anything
 * the caller did not ask for — another path, another method, a mismatched
 * `authorization` — is recorded in {@link FixtureProvider.errors} rather than
 * answered, because a fixture that quietly tolerates an unexpected request turns
 * a wiring bug into a green test.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

/** One `response.output_item.done` item — a message, a function call, whatever the script returns. */
export type FixtureOutputItem = Record<string, unknown>

/** What the {@link FixtureProviderOptions.script} sees for one accepted request. */
export interface FixtureTurn {
  /** The parsed request body, already appended to {@link FixtureTurn.requests}. */
  request: Record<string, unknown>
  /** Every request so far INCLUDING this one — the step index the scripts count on. */
  requests: Record<string, unknown>[]
}

/**
 * The API key the fixture home writes into `auth.json` and the provider then
 * requires. Not a credential: it authenticates nothing, it only proves the child
 * read the isolated home we gave it rather than the developer's own.
 */
export const FIXTURE_API_KEY = 'codex-fixture-not-a-real-key'

/** The `authorization` header {@link FIXTURE_API_KEY} produces. */
export const FIXTURE_AUTHORIZATION = `Bearer ${FIXTURE_API_KEY}`

/** The assistant text a scripted turn ends on, and what a harness asserts it rendered. */
export const FIXTURE_ASSISTANT_TEXT = 'fixture complete'

/** The terminal event of every scripted turn, usage included (the app records it). */
export const FIXTURE_COMPLETED = {
  type: 'response.completed',
  response: {
    id: 'resp-fixture',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
  }
}

/** One assistant text message — the default script, and the end of every other one. */
export function fixtureAssistantMessage(
  text: string = FIXTURE_ASSISTANT_TEXT,
  id = 'msg-fixture'
): FixtureOutputItem {
  return { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] }
}

/** The three events one turn is made of. */
export function fixtureResponseEvents(item: FixtureOutputItem): Record<string, unknown>[] {
  return [
    { type: 'response.created', response: { id: 'resp-fixture' } },
    { type: 'response.output_item.done', item },
    FIXTURE_COMPLETED
  ]
}

/** SSE framing: `event:` + `data:` per event, blank line between. */
export function fixtureSseBody(events: Record<string, unknown>[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

export interface FixtureProviderOptions {
  /**
   * The `authorization` header every request must carry. `undefined` means it
   * must be ABSENT — which is what `requires_openai_auth = false` produces, and
   * asserting it is how the fixture proves no real credential reached the child.
   */
  authorization?: string
  /** Request path. Default `/v1/responses` — Codex's Responses wire. */
  path?: string
  /** Interface to bind. Default loopback; never widen it in a test. */
  host?: string
  /** Port. Default 0 (ephemeral) — read the real one off {@link FixtureProvider.port}. */
  port?: number
  /** Chooses the output item per turn. Default: one assistant text message. */
  script?: (turn: FixtureTurn) => FixtureOutputItem
  /**
   * Replaces the default `426 Upgrade Required` answer. The integration suite's
   * native-session probes speak the WebSocket wire and install their own; every
   * other caller wants the 426, which tells Codex to fall back to HTTP streaming
   * instead of waiting on a socket nobody answers.
   */
  onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** Append requests to this array instead of a fresh one (the caller's closures read it). */
  requests?: Record<string, unknown>[]
  /** Append rejections to this array instead of a fresh one. */
  errors?: string[]
}

export interface FixtureProvider {
  server: Server
  port: number
  /** Every accepted request body, oldest first. A WebSocket caller pushes its own here too. */
  requests: Record<string, unknown>[]
  /** Every request the fixture refused. A non-empty array IS a failure. */
  errors: string[]
  close: () => Promise<void>
}

/** Start the provider and resolve once it is listening. */
export async function startFixtureProvider(
  options: FixtureProviderOptions = {}
): Promise<FixtureProvider> {
  const {
    authorization,
    path = '/v1/responses',
    host = '127.0.0.1',
    port = 0,
    script = () => fixtureAssistantMessage(),
    onUpgrade,
    requests = [],
    errors = []
  } = options
  const server = createServer((req, res) => {
    let body = ''
    // A request that never ends would pin the server open past teardown; a body
    // that never stops would exhaust the harness's memory.
    const bodyTimeout = setTimeout(() => req.destroy(), 15000)
    req.on('close', () => clearTimeout(bodyTimeout))
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 4_000_000) req.destroy()
    })
    req.on('error', () => {})
    req.on('end', () => {
      clearTimeout(bodyTimeout)
      if (
        req.method !== 'POST' ||
        req.url !== path ||
        req.headers.authorization !== authorization
      ) {
        errors.push(
          `unexpected provider request: ${req.method} ${req.url}; auth matched: ${req.headers.authorization === authorization}`
        )
        res.writeHead(400).end()
        return
      }
      let request: Record<string, unknown>
      try {
        request = JSON.parse(body)
      } catch {
        errors.push('invalid provider JSON')
        res.writeHead(400).end()
        return
      }
      requests.push(request)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      res.end(fixtureSseBody(fixtureResponseEvents(script({ request, requests }))))
    })
  })
  server.on(
    'upgrade',
    onUpgrade ??
      ((_req, socket) => {
        // Codex asks for the WebSocket wire whenever the provider advertises it.
        // A destroyed socket reads as a network fault and costs a retry; 426 is
        // the protocol's own "use HTTP", which is what this fixture speaks.
        socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n')
      })
  )
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  return {
    server,
    port: (server.address() as { port: number }).port,
    requests,
    errors,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

export interface FixtureConfigOptions {
  /** Where the provider is listening. */
  port: number
  /** `model = "…"`. Omitted when null — Codex then uses the catalog default. */
  model?: string | null
  /** `model_provider`. `openai` is the only value ClaudeUI accepts (`assertCodexProvider`). */
  provider?: string
  /**
   * `openai_base_url = "…"`: the ONLY way to point the built-in `openai`
   * provider at the fixture. Declaring `[model_providers.openai]` instead is
   * refused outright by 0.154 ("model_providers contains reserved built-in
   * provider IDs: `openai`"), and the refusal throws away the WHOLE config file,
   * not just that table — probed 2026-09-15 on Windows x64.
   */
  openaiBaseUrl?: string | null
  /** `approvals_reviewer`: Codex's own guardian, or the host. */
  approvalsReviewer?: 'user' | 'auto_review'
}

/**
 * The fixture `config.toml`.
 *
 * Every switch here exists to keep the child OFF the network and off the
 * developer's machine state: no update check, no web search, no analytics, no
 * feedback, no OTEL exporter, no retries (a retry would double-count turns and
 * hide a fixture rejection), and the credential store pinned to `file` so
 * `auth.json` in the isolated home is what the child reads rather than the OS
 * keychain.
 */
export function renderFixtureConfigToml(options: FixtureConfigOptions): string {
  const {
    port,
    model = null,
    provider = 'fixture',
    openaiBaseUrl = null,
    approvalsReviewer = 'user'
  } = options
  return `${model ? `model = "${model}"` : ''}
model_provider = "${provider}"
${openaiBaseUrl ? `openai_base_url = "${openaiBaseUrl}"` : ''}
approval_policy = "on-request"
approvals_reviewer = "${approvalsReviewer}"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"
[model_providers.fixture]
name = "Isolated localhost fixture"
base_url = "http://127.0.0.1:${port}/v1"
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
}

/** Write `config.toml` (always) and `auth.json` (when an API key is given) into a `CODEX_HOME`. */
export function writeFixtureCodexHome(
  codexHome: string,
  options: FixtureConfigOptions & { apiKey?: string | null }
): void {
  writeFileSync(join(codexHome, 'config.toml'), renderFixtureConfigToml(options))
  if (options.apiKey)
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: options.apiKey }))
}
