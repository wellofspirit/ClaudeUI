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
 *
 * TWO modes. The default is native auth: the child reads the fixture's own API
 * key out of `auth.json` and the `authorization` header is matched exactly.
 * {@link FixtureProviderOptions.chatgpt} is the INJECTED-identity mode a
 * fabricated vault account needs — the binary's own backend calls are answered
 * and recorded instead of refused, and the bearer is the vault's token, which
 * the fixture cannot know and therefore records instead of matching. Everything
 * else, including the rule above, is the same in both.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib'

/** One `response.output_item.done` item — a message, a function call, whatever the script returns. */
export type FixtureOutputItem = Record<string, unknown>

/**
 * Return this from a {@link FixtureProviderOptions.script} instead of an item to
 * leave the request OPEN: the headers go out and nothing else, so the turn stays
 * MID-FLIGHT until the child dies or the provider closes.
 *
 * It exists for the host probes (`codex-host-probes.integration.test.ts`), which
 * have to kill a host, close its stdin, and delete its thread WHILE the model is
 * still talking — states a turn that always answers can never reach. A symbol,
 * not a string or a shape, so it can never collide with a real output item.
 */
export const FIXTURE_HOLD = Symbol('fixture-hold')

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
  script?: (turn: FixtureTurn) => FixtureOutputItem | typeof FIXTURE_HOLD
  /**
   * The HTTP status an accepted turn is answered with. Anything other than 200
   * ends the request with `{"error":"scripted"}` and no SSE — the ONLY way to
   * make the app-server ask its host to refresh an injected token
   * (`external_auth.rs` treats a 401 from the provider as recoverable auth), so
   * `codex-injection.integration.test.ts` scripts one 401 and then a 200.
   * Default: every turn is answered.
   */
  statusFor?: (turn: FixtureTurn) => number
  /**
   * Serve an INJECTED ChatGPT identity (ADR-068 §1) instead of an API key.
   *
   * The binary under an injected token does three things a native-auth run
   * never does: it calls `chatgpt_base_url` for its own reads (`/wham/*`,
   * `/api/codex/usage`), it probes `GET /v1/models`, and it attaches the
   * INJECTED bearer — the vault's token, not {@link FIXTURE_AUTHORIZATION} — to
   * the provider call. With this on, the backend paths are answered `404
   * {"error":"fixture"}` and recorded in {@link FixtureProvider.backend} (they
   * are the binary's business, not a fixture rejection) and the provider call
   * takes any bearer, recording it. Off, none of that exists and the strict
   * `authorization` match stands.
   *
   * Without it a drive with a fabricated vault account sends those reads to the
   * REAL `chatgpt.com/backend-api` with a made-up token, and the host dies
   * within seconds (seen live 2026-09-16 on macOS).
   */
  chatgpt?: boolean
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
  /** Append the binary's own backend calls to this array instead of a fresh one. */
  backend?: string[]
  /** Append accepted `authorization` headers to this array instead of a fresh one. */
  authorizations?: string[]
}

export interface FixtureProvider {
  server: Server
  port: number
  /** Every accepted request body, oldest first. A WebSocket caller pushes its own here too. */
  requests: Record<string, unknown>[]
  /** Every request the fixture refused. A non-empty array IS a failure. */
  errors: string[]
  /**
   * The binary's OWN calls — `chatgpt_base_url` backend routes and the catalog
   * probe — answered 404 in {@link FixtureProviderOptions.chatgpt} mode. Never a
   * failure: they say the injected identity reached the child.
   */
  backend: string[]
  /**
   * The `authorization` header of every ACCEPTED provider call, in order,
   * including one answered with a scripted error. It is how a test tells the
   * pre-refresh token from the rotated one.
   */
  authorizations: string[]
  close: () => Promise<void>
}

/**
 * The request body, decoded per `content-encoding`.
 *
 * A session running under an injected ChatGPT identity sends its model requests
 * compressed — gzip on the Windows H-series drives, zstd on macOS (both seen
 * live 2026-09-16) — so a fixture
 * that parses the raw bytes sees garbage and records a rejection for a request
 * that was perfectly well formed. Decoding runs in BOTH modes — the encoding is
 * the client's choice, not the mode's.
 */
function decodeBody(raw: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return raw
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(raw)
    case 'deflate':
      return inflateSync(raw)
    case 'br':
      return brotliDecompressSync(raw)
    case 'zstd':
      // The macOS build of 0.154 sends zstd under an injected identity where
      // the Windows build sent gzip (seen live 2026-09-16).
      return zstdDecompressSync(raw)
    default:
      throw new Error(`unsupported content-encoding: ${encoding}`)
  }
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
    statusFor,
    chatgpt = false,
    onUpgrade,
    requests = [],
    errors = [],
    backend = [],
    authorizations = []
  } = options
  /** Responses a {@link FIXTURE_HOLD} script left open, ended by {@link FixtureProvider.close}. */
  const held = new Set<ServerResponse>()
  const server = createServer((req, res) => {
    // BYTES, not a string: an injected-identity turn arrives gzip-encoded, and
    // concatenating those chunks onto a string corrupts them beyond recovery.
    const chunks: Buffer[] = []
    let length = 0
    // A request that never ends would pin the server open past teardown; a body
    // that never stops would exhaust the harness's memory.
    const bodyTimeout = setTimeout(() => req.destroy(), 15000)
    req.on('close', () => clearTimeout(bodyTimeout))
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      length += chunk.length
      if (length > 4_000_000) req.destroy()
    })
    req.on('error', () => {})
    req.on('end', () => {
      clearTimeout(bodyTimeout)
      // The binary's own calls under an injected identity. Answered, recorded,
      // and never counted as a rejection — the turn is the POST below.
      if (
        chatgpt &&
        (req.url?.startsWith('/backend-api/') ||
          (req.method === 'GET' && req.url?.startsWith('/v1/models')))
      ) {
        backend.push(`${req.method} ${req.url}`)
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"fixture"}')
        return
      }
      // An injected bearer is the VAULT's token, which the fixture cannot know;
      // it is recorded instead of matched. Native mode keeps the strict match:
      // there, the header is the proof the child read the isolated home.
      const authorized = chatgpt || req.headers.authorization === authorization
      if (req.method !== 'POST' || req.url !== path || !authorized) {
        errors.push(
          `unexpected provider request: ${req.method} ${req.url}; auth matched: ${req.headers.authorization === authorization}`
        )
        res.writeHead(400).end()
        return
      }
      authorizations.push(String(req.headers.authorization ?? ''))
      const encoding = req.headers['content-encoding']
      let request: Record<string, unknown>
      try {
        request = JSON.parse(decodeBody(Buffer.concat(chunks), encoding).toString('utf8'))
      } catch {
        // The encoding is named: a body this fixture could not inflate reads
        // exactly like malformed JSON, and that cost a drive an afternoon.
        errors.push(`invalid provider JSON${encoding ? ` (content-encoding: ${encoding})` : ''}`)
        res.writeHead(400).end()
        return
      }
      requests.push(request)
      const status = statusFor?.({ request, requests }) ?? 200
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' }).end('{"error":"scripted"}')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      const item = script({ request, requests })
      if (item === FIXTURE_HOLD) {
        // Headers only. The response is tracked so `close()` can end a hold the
        // caller never released; a socket the child closed removes itself.
        held.add(res)
        res.on('close', () => held.delete(res))
        return
      }
      res.end(fixtureSseBody(fixtureResponseEvents(item)))
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
    backend,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        for (const response of held) response.destroy()
        held.clear()
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
  /**
   * The home an INJECTED ChatGPT identity runs on (the server-side twin of
   * {@link FixtureProviderOptions.chatgpt}). Two lines follow from it:
   *
   *  - `chatgpt_base_url` points the binary's own backend reads at the fixture
   *    rather than the real `chatgpt.com`, which a fabricated token cannot talk
   *    to and which kills the host within seconds when it tries.
   *  - `requires_openai_auth = true`, so the injected token is actually ATTACHED
   *    to the provider call and a 401 is recoverable auth rather than an
   *    ordinary failure — without it nothing would ever ask the host to refresh.
   */
  chatgpt?: boolean
  /**
   * What `[features]` the fixture home declares.
   *
   *  - `'fixture'` (default) — the block every existing probe has always run
   *    under: `apps`, `plugins`, `remote_plugin`, `browser_use`, `computer_use`
   *    and `shell_snapshot` all `false`, so nothing in the child reaches for an
   *    app connector, a plugin registry or a browser.
   *  - `'binary-defaults'` — NO `[features]` table at all, so every flag keeps
   *    the `default_enabled` its `FeatureSpec` carries
   *    (`codex-rs/features/src/lib.rs`). The one way to observe what the pinned
   *    binary does on a stock home; used by `codex-desktop-entries` and nothing
   *    else, because a probe that starts from our own overrides can only ever
   *    re-measure them.
   *  - a record — exactly those keys, in the given order, and nothing else.
   */
  features?: 'fixture' | 'binary-defaults' | Record<string, boolean>
  /**
   * TOML appended verbatim to the end of the file, for tables the options above
   * do not model.
   *
   * It exists for `codex-desktop-entries.integration.test.ts`, which has to
   * reproduce a DESKTOP-APP home — `[mcp_servers.node_repl]`,
   * `[marketplaces.openai-bundled]`, `[plugins."browser@openai-bundled"]` and
   * the `[shell_environment_policy]` its stub server needs to boot. Modelling
   * four one-off tables as options would put that one probe's shape into every
   * other suite's config type; appended text keeps it where it belongs. It lands
   * AFTER `[features]`, so the caller must open its own table header first.
   */
  extraToml?: string
}

/** The `[features]` block every fixture home has carried since the first probe. */
export const FIXTURE_FEATURES: Readonly<Record<string, boolean>> = {
  apps: false,
  plugins: false,
  remote_plugin: false,
  browser_use: false,
  computer_use: false,
  shell_snapshot: false
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
    approvalsReviewer = 'user',
    chatgpt = false,
    features = 'fixture',
    extraToml = ''
  } = options
  const featureKeys =
    features === 'binary-defaults' ? null : features === 'fixture' ? FIXTURE_FEATURES : features
  return `${model ? `model = "${model}"` : ''}
model_provider = "${provider}"
${openaiBaseUrl ? `openai_base_url = "${openaiBaseUrl}"` : ''}
${chatgpt ? `chatgpt_base_url = "http://127.0.0.1:${port}/backend-api"\n` : ''}approval_policy = "on-request"
approvals_reviewer = "${approvalsReviewer}"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"
[model_providers.fixture]
name = "Isolated localhost fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = ${chatgpt ? 'true' : 'false'}
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
${
  featureKeys
    ? `[features]
${Object.entries(featureKeys)
  .map(([key, value]) => `${key} = ${value}`)
  .join('\n')}\n`
    : ''
}${extraToml}`
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

// ---------------------------------------------------------------------------
// The fabricated vault a drive under an injected identity needs
// ---------------------------------------------------------------------------

/** One fabricated account, as the caller needs to name it afterwards. */
export interface FabricatedVaultAccount {
  /** The vault's own handle — what a radio button and a session pin name. */
  id: string
  email: string
  /** The ChatGPT WORKSPACE id, read back off the JWT by `extractAccountId`. */
  accountId: string
  planType: string
}

export interface FabricatedVaultOptions {
  /** How many accounts to fabricate. Default 1; the FIRST is active. */
  accounts?: number
  /**
   * How far ahead the credentials expire. Default 20 days: far enough that no
   * refresh timer fires during a drive (a refresh would hit the real token
   * endpoint with a made-up refresh token), and still inside the timer's clamp
   * so nothing treats the account as broken.
   */
  expiresInDays?: number
}

/** An UNSIGNED, obviously synthetic ChatGPT-shaped JWT. Never a real token. */
function fabricatedJwt(account: FabricatedVaultAccount, expiresAt: number): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url').replace(/=+$/, '')
  return [
    part({ alg: 'none', typ: 'JWT' }),
    part({
      exp: Math.floor(expiresAt / 1000),
      email: account.email,
      // The claim `extractAccountId` / `parse_chatgpt_jwt_claims` read. The
      // binary only base64-decodes the payload, so the third segment is free.
      'https://api.openai.com/auth': {
        chatgpt_account_id: account.accountId,
        chatgpt_plan_type: account.planType,
        chatgpt_user_id: `user-${account.id}`
      }
    }),
    `unsigned-${account.id}`
  ].join('.')
}

/**
 * Write a FABRICATED `auth-vault.json` (v3) into a scratch home.
 *
 * A drive that needs a stored ChatGPT account cannot use the developer's vault
 * and must not need a sign-in, so the accounts are minted here: unsigned
 * `alg: none` JWTs, made-up emails and workspace ids, and a `refresh` that would
 * fail if anything ever tried it. The shape is exactly what `AuthVault.readAll`
 * accepts — a drifted key would leave the drive with no identity at all, which
 * is what the guard test pins by reading the file back through the real vault.
 *
 * SAFETY: it writes under `<home>/.claude/ui/` and refuses a `home` that IS the
 * running user's home directory, so no run of this can overwrite the real vault.
 */
export function writeFabricatedVault(
  home: string,
  options: FabricatedVaultOptions = {}
): { path: string; accounts: FabricatedVaultAccount[] } {
  const { accounts: count = 1, expiresInDays = 20 } = options
  const target = resolve(home)
  if (target === resolve(homedir()))
    throw new Error(
      `writeFabricatedVault: refusing to write into the real home (${target}); pass a scratch home`
    )
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`writeFabricatedVault: accounts must be an integer >= 1 (got ${count})`)
  const now = Date.now()
  const expires = now + expiresInDays * 86400_000
  const accounts: FabricatedVaultAccount[] = Array.from({ length: count }, (_unused, index) => ({
    id: `fab-acc-${index + 1}`,
    email: `fab-owner-${index + 1}@example.test`,
    accountId: `ws-fabricated-${String(index + 1).padStart(4, '0')}`,
    planType: 'pro'
  }))
  const file = {
    v: 3,
    credentials: {},
    accounts: {
      chatgpt: {
        activeId: accounts[0].id,
        list: accounts.map((account, index) => ({
          id: account.id,
          email: account.email,
          accountId: account.accountId,
          planType: account.planType,
          credential: {
            type: 'oauth',
            access: fabricatedJwt(account, expires),
            refresh: `fabricated-refresh-${account.id}`,
            expires,
            email: account.email,
            accountId: account.accountId,
            planType: account.planType
          },
          addedAt: now - index
        }))
      }
    }
  }
  const directory = join(target, '.claude', 'ui')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'auth-vault.json')
  writeFileSync(path, JSON.stringify(file))
  return { path, accounts }
}
