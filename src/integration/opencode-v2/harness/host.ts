/**
 * Host side of the opencode 2.x contract suite (ADR-093 §8.1): spawn a real
 * `opencode serve --stdio`, talk to it through the GENERATED operation table,
 * and read its SSE feed as the curated event union.
 *
 * Isolation (non-negotiable — this runs a real engine on a developer box):
 * - HOME and every XDG dir live under `<repo>/.cache/opencode-v2-it/…`;
 * - the only model is the in-process localhost fixture, models.dev fetch and
 *   autoupdate are off, and every proxy env var points at a proxy that refuses
 *   (and records) everything;
 * - on darwin the engine also runs under `sandbox-exec` with loopback-only
 *   networking, so even a request that ignored the proxy cannot leave the box.
 * Every process is ended by closing stdin (the `--stdio` lease), SIGKILLed if
 * it outlives the grace period, and SIGKILLed on worker exit regardless.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, type TestContext } from 'vitest'
import {
  OPERATIONS,
  type Config_InfoEncoded,
  type OperationId,
  type Operations
} from '../../../core/opencode/protocol-v2/openapi'
import {
  eventSessionID,
  isOpencodeEvent,
  type EventOf,
  type OpencodeEvent,
  type OpencodeEventType
} from '../../../core/opencode/protocol-v2/events'
import { harnessManifest } from '../../../core/harness/manifests'
import { installDir } from '../../../core/harness/store'
import { formatRequests, formatTrace, redact } from './diagnostics'
import { startFixtureProvider, type FixtureProvider } from './fixture-provider'

// --- Gate -------------------------------------------------------------------

export const V2_ENABLED = process.env.OPENCODE_V2_INTEGRATION === '1'
/**
 * The binary under test: `OPENCODE_V2_BIN`, else the managed store's copy of
 * the manifest's tested version (`bun run ensure-opencode`; honours
 * `CLAUDEUI_HARNESS_STORE`).
 */
export const V2_BIN =
  process.env.OPENCODE_V2_BIN ||
  join(
    installDir('opencode', harnessManifest('opencode').tested),
    process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  )
if (V2_ENABLED && !existsSync(V2_BIN))
  throw new Error(
    `OPENCODE_V2_INTEGRATION=1: no opencode at ${V2_BIN}. Run \`bun run ensure-opencode\`, or set OPENCODE_V2_BIN=<absolute path to an opencode 2.x binary>`
  )
/** Skips cleanly unless the suite is explicitly enabled. */
export const describeV2 = describe.skipIf(!V2_ENABLED)

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
export const FIXTURES_DIR = join(HARNESS_DIR, '..', 'fixtures')
const REPO_ROOT = resolve(HARNESS_DIR, '..', '..', '..', '..')
const CACHE_ROOT = join(REPO_ROOT, '.cache', 'opencode-v2-it')
export const SANDBOX_AVAILABLE =
  process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

/** `promise`'s value, or null once `ms` pass first (the timer never outlives the race). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)))
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// --- Isolated home ----------------------------------------------------------

export interface TestHome {
  readonly root: string
  readonly env: Record<string, string>
  /** A project directory under the home (created on demand). */
  workspace(name: string): string
  /** Set on failure: the directory (engine logs included) is left for inspection. */
  keep: boolean
  cleanup(): void
}

export function createHome(label: string): TestHome {
  mkdirSync(CACHE_ROOT, { recursive: true })
  const root = mkdtempSync(join(CACHE_ROOT, `${label}-`))
  const dir = (...parts: string[]) => {
    const path = join(root, ...parts)
    mkdirSync(path, { recursive: true })
    return path
  }
  const home = dir('home')
  const env: Record<string, string> = {
    HOME: home,
    XDG_DATA_HOME: dir('home', '.local', 'share'),
    XDG_CONFIG_HOME: dir('home', '.config'),
    XDG_CACHE_HOME: dir('home', '.cache'),
    XDG_STATE_HOME: dir('home', '.local', 'state')
  }
  if (process.platform === 'win32') {
    Object.assign(env, {
      USERPROFILE: home,
      APPDATA: dir('home', 'AppData', 'Roaming'),
      LOCALAPPDATA: dir('home', 'AppData', 'Local')
    })
  }
  const result: TestHome = {
    root,
    env,
    workspace: (name) => dir('ws', name),
    keep: process.env.OPENCODE_V2_KEEP === '1',
    cleanup: () => {
      if (!result.keep) rmSync(root, { recursive: true, force: true })
    }
  }
  return result
}

// --- Refusing proxy ---------------------------------------------------------

export interface RefusingProxy {
  readonly url: string
  /** Every outbound attempt that reached the proxy (CONNECT host:port or absolute URL). */
  readonly attempts: { method: string; target: string }[]
  close(): Promise<void>
}

export async function startRefusingProxy(): Promise<RefusingProxy> {
  const attempts: { method: string; target: string }[] = []
  const server: Server = createServer((req, res) => {
    req.socket.on('error', () => {})
    attempts.push({ method: req.method ?? '?', target: req.url ?? '?' })
    res.writeHead(403).end('contract-suite proxy refuses')
  })
  server.on('connect', (req, socket) => {
    socket.on('error', () => {})
    attempts.push({ method: 'CONNECT', target: req.url ?? '?' })
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    attempts,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

// --- Fixture plugins --------------------------------------------------------

/**
 * Installs `fixtures/<file>` as a v2 DIRECTORY plugin under the home (2.x
 * refuses a plugin path that is a file) and returns the directory.
 */
export function installPlugin(home: TestHome, name: string, file: string): string {
  const directory = join(home.root, 'plugins', name)
  mkdirSync(directory, { recursive: true })
  copyFileSync(join(FIXTURES_DIR, file), join(directory, 'index.js'))
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name, type: 'module', main: 'index.js' })
  )
  return directory
}

// --- Server -----------------------------------------------------------------

export interface ExitInfo {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** True when stdin EOF did not end it within the grace period. */
  readonly forced: boolean
}

export interface ServerOptions {
  readonly home: TestHome
  readonly cwd: string
  readonly config: Config_InfoEncoded
  readonly proxy: RefusingProxy
  /** darwin only; defaults to on when available. */
  readonly sandbox?: boolean
  readonly env?: Record<string, string>
}

export interface V2Server {
  readonly url: string
  readonly api: Api
  readonly password: string
  /** Engine stderr (its `--print-logs` output), last lines. */
  logTail(lines?: number): string
  stop(): Promise<ExitInfo>
}

const live = new Set<ChildProcess>()
process.once('exit', () => {
  for (const child of live) child.kill('SIGKILL')
})

const SANDBOX_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network-outbound)',
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow network-outbound (remote unix-socket))'
].join('\n')

/**
 * The isolated engine environment every contract server runs with: home + XDG
 * under `.cache/`, models.dev fetch off, every proxy var at the refusing proxy.
 * (No password, config or autoupdate switch: the caller — the harness's own
 * `startServer`, or the production spawn path — adds those.)
 */
export function isolatedEnv(home: TestHome, proxy: RefusingProxy): Record<string, string> {
  return {
    PATH: process.platform === 'win32' ? (process.env.PATH ?? '') : '/usr/bin:/bin:/usr/sbin:/sbin',
    ...(process.platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    ...home.env,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
    https_proxy: proxy.url,
    http_proxy: proxy.url,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost'
  }
}

/** Writes the loopback-only `sandbox-exec` profile under the home; returns its path. */
export function sandboxProfile(home: TestHome): string {
  const profile = join(home.root, 'loopback-only.sb')
  writeFileSync(profile, SANDBOX_PROFILE)
  return profile
}

let serverCount = 0

export async function startServer(options: ServerOptions): Promise<V2Server> {
  const { home, proxy } = options
  const password = randomBytes(18).toString('base64url')
  const index = ++serverCount
  const env: Record<string, string> = {
    ...isolatedEnv(home, proxy),
    OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
    ...options.env
  }
  const args = [
    'serve',
    '--stdio',
    '--port',
    '0',
    '--print-logs',
    '--log-level',
    process.env.OPENCODE_V2_LOG_LEVEL ?? 'warn'
  ]
  const sandbox = (options.sandbox ?? true) && SANDBOX_AVAILABLE
  let command = V2_BIN
  if (sandbox) {
    args.unshift('-f', sandboxProfile(home), V2_BIN)
    command = '/usr/bin/sandbox-exec'
  }
  const child = spawn(command, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  live.add(child)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once('exit', (code, signal) => {
      live.delete(child)
      done({ code, signal })
    })
  )
  const stderr: string[] = []
  createInterface({ input: child.stderr! }).on('line', (line) => {
    stderr.push(line)
    if (stderr.length > 400) stderr.shift()
  })
  const logTail = (lines = 40) => stderr.slice(-lines).join('\n')
  const stdout = createInterface({ input: child.stdout! })
  let timer: NodeJS.Timeout | undefined
  const first = await Promise.race([
    new Promise<string>((done) => stdout.once('line', done)),
    exited.then(({ code, signal }) => {
      throw new Error(`opencode exited (${code ?? signal}) before printing its url\n${logTail()}`)
    }),
    new Promise<never>((_, fail) => {
      timer = setTimeout(
        () => fail(new Error(`opencode printed no url within 30 s\n${logTail()}`)),
        30_000
      )
    })
  ])
    .catch((error: unknown) => {
      child.kill('SIGKILL')
      throw error
    })
    .finally(() => clearTimeout(timer))
  let url: string
  try {
    url = (JSON.parse(first) as { url: string }).url
  } catch {
    child.kill('SIGKILL')
    throw new Error(`--stdio first line is not {url}: ${JSON.stringify(first)}`)
  }
  let stopping: Promise<ExitInfo> | null = null
  const stop = () =>
    (stopping ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null)
        return { code: child.exitCode, signal: child.signalCode, forced: false }
      child.stdin!.end()
      const graceful = await within(exited, 10_000)
      if (graceful) return { ...graceful, forced: false }
      child.kill('SIGKILL')
      return { ...(await exited), forced: true }
    })().finally(() => {
      writeFileSync(join(home.root, `server-${index}.log`), stderr.join('\n'))
    }))
  return {
    url,
    password,
    api: createApi(url, password, options.cwd),
    logTail,
    stop
  }
}

// --- Typed API over the generated operation table ---------------------------

type Field<Name extends string, T> = [T] extends [never]
  ? { readonly [P in Name]?: undefined }
  : undefined extends T
    ? { readonly [P in Name]?: T }
    : { readonly [P in Name]: T }

export type CallInit<K extends OperationId> = Field<'params', Operations[K]['params']> & {
  readonly query?: [Operations[K]['query']] extends [never] ? undefined : Operations[K]['query']
} & Field<'body', Operations[K]['body']> & {
    /** `x-opencode-directory`; defaults to the server's cwd. */
    readonly directory?: string
  }

export type CallResult<K extends OperationId> =
  | { readonly ok: true; readonly status: number; readonly data: Operations[K]['response'] }
  | { readonly ok: false; readonly status: number; readonly error: unknown }

export interface Api {
  call<K extends OperationId>(id: K, init?: CallInit<K>): Promise<CallResult<K>>
  /** `call`, but a non-2xx answer throws with the (redacted) body. */
  ok<K extends OperationId>(id: K, init?: CallInit<K>): Promise<Operations[K]['response']>
}

export function createApi(baseUrl: string, password: string, directory: string): Api {
  const authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
  const call = async <K extends OperationId>(id: K, init?: CallInit<K>): Promise<CallResult<K>> => {
    const operation = OPERATIONS[id]
    const params = (init?.params ?? {}) as Record<string, string>
    const path = operation.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (params[name] === undefined) throw new Error(`${id}: missing path param ${name}`)
      return encodeURIComponent(params[name])
    })
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries((init?.query ?? {}) as Record<string, unknown>))
      if (value !== undefined && value !== null) search.set(key, String(value))
    const query = search.toString() ? `?${search}` : ''
    const response = await fetch(baseUrl + path + query, {
      method: operation.method,
      headers: {
        authorization,
        'x-opencode-directory': init?.directory ?? directory,
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
    })
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      // not JSON: keep the text
    }
    if (!response.ok) return { ok: false, status: response.status, error: parsed }
    return { ok: true, status: response.status, data: parsed as Operations[K]['response'] }
  }
  return {
    call,
    ok: async (id, init) => {
      const result = await call(id, init)
      if (!result.ok)
        throw new Error(
          `${id} → ${result.status}: ${JSON.stringify(redact(result.error)).slice(0, 600)}`
        )
      return result.data
    }
  }
}

// --- SSE feed ---------------------------------------------------------------

type TurnEnd =
  | EventOf<'session.execution.succeeded'>
  | EventOf<'session.execution.failed'>
  | EventOf<'session.execution.interrupted'>

export interface WaitOptions<T extends OpencodeEventType> {
  readonly sessionID?: string
  /** Only events at or after this `mark()`. */
  readonly after?: number
  readonly where?: (event: EventOf<T>) => boolean
  readonly timeoutMs?: number
}

export class EventFeed {
  /** Every frame, curated or not (diagnostics). */
  readonly raw: unknown[] = []
  /** Frames in the curated union, in arrival order. */
  readonly events: OpencodeEvent[] = []
  private readonly waiters = new Set<() => void>()
  private failure: unknown = null

  private constructor(private readonly controller: AbortController) {}

  static async subscribe(server: V2Server): Promise<EventFeed> {
    const feed = new EventFeed(new AbortController())
    const response = await fetch(server.url + OPERATIONS['event.subscribe'].path, {
      headers: {
        authorization: 'Basic ' + Buffer.from(`opencode:${server.password}`).toString('base64'),
        accept: 'text/event-stream'
      },
      signal: feed.controller.signal
    })
    if (!response.ok || !response.body) throw new Error(`event.subscribe → ${response.status}`)
    void feed.pump(response.body)
    await feed.waitFor('server.connected', { timeoutMs: 10_000 })
    return feed
  }

  private async pump(body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (!data) continue
          let frame: { type?: unknown }
          try {
            frame = JSON.parse(data)
          } catch {
            continue
          }
          this.raw.push(frame)
          if (isOpencodeEvent(frame)) this.events.push(frame)
          for (const wake of [...this.waiters]) wake()
        }
      }
    } catch (error) {
      if ((error as { name?: string }).name !== 'AbortError') this.failure = error
    }
    for (const wake of [...this.waiters]) wake()
  }

  mark(): number {
    return this.events.length
  }

  select<T extends OpencodeEventType>(type: T, options: WaitOptions<T> = {}): EventOf<T>[] {
    return this.events
      .slice(options.after ?? 0)
      .filter(
        (event): event is EventOf<T> =>
          event.type === type &&
          (options.sessionID === undefined || eventSessionID(event) === options.sessionID) &&
          (!options.where || options.where(event as EventOf<T>))
      )
  }

  waitFor<T extends OpencodeEventType>(type: T, options: WaitOptions<T> = {}): Promise<EventOf<T>> {
    const label = type + (options.sessionID ? ` on ${options.sessionID}` : '')
    return this.until(() => this.select(type, options)[0], label, options.timeoutMs)
  }

  /** The first execution end of `sessionID` at or after `after`. */
  waitForTurnEnd(sessionID: string, after: number, timeoutMs?: number): Promise<TurnEnd> {
    const isEnd = (event: OpencodeEvent): event is TurnEnd =>
      /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)
    return this.until(
      () =>
        this.events
          .slice(after)
          .find((event): event is TurnEnd => isEnd(event) && event.data.sessionID === sessionID),
      `the turn end of ${sessionID}`,
      timeoutMs
    )
  }

  private until<R>(probe: () => R | undefined, label: string, timeoutMs = 30_000): Promise<R> {
    return new Promise((done, fail) => {
      const check = () => {
        const hit = probe()
        if (hit !== undefined) {
          finish()
          done(hit)
        } else if (this.failure) {
          finish()
          fail(new Error(`event feed failed: ${String(this.failure)}`))
        }
      }
      const timer = setTimeout(() => {
        finish()
        fail(
          new Error(
            `timed out after ${timeoutMs} ms waiting for ${label}\n` +
              `event sequence:\n${formatTrace(this.raw, { last: 60 })}`
          )
        )
      }, timeoutMs)
      const finish = () => {
        clearTimeout(timer)
        this.waiters.delete(check)
      }
      this.waiters.add(check)
      check()
    })
  }

  /** Text streamed by `session.text.delta` for a session since `after`. */
  streamedText(sessionID: string, after = 0): string {
    return this.select('session.text.delta', { sessionID, after })
      .map((event) => event.data.delta)
      .join('')
  }

  close() {
    this.controller.abort()
  }
}

// --- Rig: one server + feed + fixture per test file -------------------------

export interface Rig {
  readonly home: TestHome
  readonly proxy: RefusingProxy
  readonly fixture: FixtureProvider
  readonly cwd: string
  server: V2Server
  feed: EventFeed
  readonly api: Api
  /** Stops the server (stdin EOF) and starts a new one on the same home. */
  restart(): Promise<ExitInfo>
  /** A permissive session in `cwd` (shell asks), returning its id. */
  createSession(init?: Operations['session.create']['body']): Promise<string>
  /** Prompts and waits for the turn's end event. */
  turn(sessionID: string, text: string): Promise<{ end: TurnEnd; from: number }>
}

export interface RigOptions {
  /** Engine config; `fixtureConfig(fixture)` is the baseline. */
  readonly config?: (fixture: FixtureProvider, home: TestHome) => Config_InfoEncoded
  readonly sandbox?: boolean
  readonly env?: (fixture: FixtureProvider, home: TestHome) => Record<string, string>
  readonly slowChunkMs?: number
}

/** The fixture as the default model, with or without a configured key. */
export function fixtureConfig(
  fixture: FixtureProvider,
  options: { apiKey?: string | null } = {}
): Config_InfoEncoded {
  const apiKey = options.apiKey === undefined ? 'fixture-key-from-config' : options.apiKey
  return {
    model: 'fixture/fixture-model',
    providers: {
      fixture: {
        name: 'Fixture',
        package: '@ai-sdk/openai-compatible',
        settings: { baseURL: fixture.baseURL, ...(apiKey === null ? {} : { apiKey }) },
        models: {
          'fixture-model': {
            name: 'Fixture Model',
            limit: { context: 100_000, output: 4096 },
            cost: { input: 1, output: 2 }
          }
        }
      }
    }
  }
}

/** Rules every contract session starts with: everything allowed except shell, which asks. */
export const SHELL_ASKS: Operations['session.create']['body'] = {
  permissions: [
    { action: '*', resource: '*', effect: 'allow' },
    { action: 'shell', resource: '*', effect: 'ask' }
  ]
}

/** A unique tag for prompts, so fixture requests can be matched to one test. */
export const nonce = (label: string) => `${label}-${randomBytes(4).toString('hex')}`

/**
 * Registers beforeAll/afterAll/beforeEach for one file and returns an accessor.
 * On a failed test it prints the redacted event sequence, what the model was
 * sent, outbound attempts, and the engine log, and keeps the home directory.
 */
export function useRig(label: string, options: RigOptions = {}): () => Rig {
  let rig: Rig | undefined
  beforeAll(async () => {
    const home = createHome(label)
    const proxy = await startRefusingProxy()
    const fixture = await startFixtureProvider({ slowChunkMs: options.slowChunkMs })
    const cwd = home.workspace('main')
    const serverOptions = (): ServerOptions => ({
      home,
      cwd,
      proxy,
      sandbox: options.sandbox,
      config: (options.config ?? fixtureConfig)(fixture, home),
      env: options.env?.(fixture, home)
    })
    const server = await startServer(serverOptions())
    const feed = await EventFeed.subscribe(server)
    const value: Rig = {
      home,
      proxy,
      fixture,
      cwd,
      server,
      feed,
      get api() {
        return value.server.api
      },
      async restart() {
        value.feed.close()
        const exit = await value.server.stop()
        value.server = await startServer(serverOptions())
        value.feed = await EventFeed.subscribe(value.server)
        return exit
      },
      async createSession(init = SHELL_ASKS) {
        const created = await value.api.ok('session.create', {
          body: { location: { directory: cwd }, ...init }
        })
        return created.data.id
      },
      async turn(sessionID, text) {
        const from = value.feed.mark()
        await value.api.ok('session.prompt', { params: { sessionID }, body: { text } })
        return { end: await value.feed.waitForTurnEnd(sessionID, from), from }
      }
    }
    rig = value
  }, 60_000)
  beforeEach((context: TestContext) => {
    context.onTestFailed(() => {
      if (!rig) return
      rig.home.keep = true
      console.error(
        [
          `── opencode 2.x contract failure: ${context.task.name}`,
          `events (redacted):\n${formatTrace(rig.feed.raw)}`,
          `model requests:\n${formatRequests(rig.fixture)}`,
          `outbound attempts (refused): ${JSON.stringify(rig.proxy.attempts)}`,
          `engine log tail:\n${rig.server.logTail()}`,
          `kept: ${rig.home.root}`
        ].join('\n')
      )
    })
  })
  afterAll(async () => {
    if (!rig) return
    rig.feed.close()
    const exit = await rig.server.stop()
    await rig.fixture.close()
    await rig.proxy.close()
    rig.home.cleanup()
    if (exit.forced) throw new Error('opencode ignored stdin EOF and had to be SIGKILLed')
  }, 30_000)
  return () => {
    if (!rig) throw new Error('rig not started')
    return rig
  }
}
