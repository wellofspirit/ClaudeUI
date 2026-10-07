/**
 * @vitest-environment node
 *
 * The context meter of a live opencode 2.x session, against the REAL model
 * discovery fed the catalog a fresh 2.0.24 server answers
 * (`fixtures/opencode-v2-catalog-zen-2.0.24.json`, captured from an isolated
 * server: OpenCode Zen's free models).
 *
 * The bug this guards: the meter read the context window from discovery's
 * process-wide capability cache, which every invalidation (a credential or
 * config write, a harness change) drops — and nothing refilled it for a
 * running session, so it showed `–%` for the rest of the session while the
 * token totals kept counting.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../services/sync-host'
import type { OpencodeFeedItem } from '../opencode-event-stream'
import type { OpencodeEvent } from '../protocol-v2/events'
import type { Integration_Info, Model_Info, Provider_Info } from '../protocol-v2/openapi'

// ─── Doubles ────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  class Feed {
    items: unknown[] = []
    private wake: (() => void) | null = null
    push(...items: unknown[]): void {
      this.items.push(...items)
      this.wake?.()
    }
    async *pull(signal?: AbortSignal): AsyncGenerator<unknown, void, undefined> {
      while (!signal?.aborted) {
        if (this.items.length > 0) {
          yield this.items.shift()
          continue
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        this.wake = null
      }
    }
  }
  return {
    Feed,
    feed: new Feed(),
    acquire: vi.fn(),
    client: {} as Record<string, ReturnType<typeof vi.fn>>
  }
})

vi.mock('../OpencodeServerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../OpencodeServerManager')>()),
  opencodeServerManager: {
    acquire: h.acquire,
    releaseIfCurrent: vi.fn(),
    subscribeExit: vi.fn(() => () => {}),
    setServerStartedHook: vi.fn(),
    isBinaryAvailable: () => true
  }
}))
vi.mock('../OpencodeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../OpencodeClient')>()),
  OpencodeClient: vi.fn(function () {
    return h.client
  })
}))
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: () => ({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  }),
  saveClaudePermissions: vi.fn(),
  loadClaudeAutoModeFlags: () => ({ classifyAllShell: false })
}))
vi.mock('../../services/ui-config', async (importOriginal) => ({
  loadEngineConfig: () => ({ autoMode: {} }),
  loadSharedAutoModeConfig: () => ({}),
  normalizeBlockHoldSeconds: (await importOriginal<typeof import('../../services/ui-config')>())
    .normalizeBlockHoldSeconds
}))
vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/fake/persisted'
}))
vi.mock('../command-skill-discovery', () => ({
  discoverOpencodeSkills: vi.fn().mockResolvedValue([])
}))
vi.mock('../claude-mcp-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude-mcp-bridge')>()),
  collectClaudeMcpForOpencode: () => ({})
}))
vi.mock('../../auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: {
    warmCache: vi.fn().mockResolvedValue(undefined),
    buildAccountRef: vi.fn().mockReturnValue(null),
    accountIdentity: vi.fn((vendorId: string) => ({
      accountKey: `opencode:${vendorId}:native`,
      accountLabel: vendorId
    }))
  }
}))
vi.mock('../../services/usage-recorder', () => ({ recordUsageEvent: vi.fn() }))
vi.mock('../../services/block-usage', () => ({
  blockUsageService: { recalculate: vi.fn().mockResolvedValue(undefined) }
}))
vi.mock('../../services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { OpencodeSession } from '../OpencodeSession'
import {
  invalidateOpencodeModelCache,
  setOpencodeDiscoveryConnect,
  type DiscoveryClient
} from '../model-discovery'

// ─── The captured 2.0.24 catalog ────────────────────────────────────────────

const CATALOG = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'opencode-v2-catalog-zen-2.0.24.json'), 'utf8')
) as { models: Model_Info[]; providers: Provider_Info[]; integrations: Integration_Info[] }

const MODEL = 'opencode/nemotron-3.5-lightning-free'
const WINDOW = 262_144

/** How many probes reached the fake server; `down` makes the next ones fail. */
const server = { probes: 0, down: false }

function serveCatalog(): void {
  const client: DiscoveryClient = {
    integrations: async () => CATALOG.integrations,
    providers: async () => CATALOG.providers,
    models: async () => CATALOG.models
  }
  setOpencodeDiscoveryConnect(async () => {
    server.probes++
    if (server.down) throw new Error('opencode is not up yet')
    return { client, startedAt: 0, release: () => {} }
  })
}

// ─── Session harness ────────────────────────────────────────────────────────

const CWD = '/repo/app'
const SID = 'ses_own'
let clock = 1_000
let seq = 0
const event = (type: string, data: Record<string, unknown>): OpencodeFeedItem =>
  ({
    kind: 'event',
    event: {
      id: `evt_${String(++seq).padStart(5, '0')}`,
      type,
      created: ++clock,
      data
    } as unknown as OpencodeEvent
  }) as OpencodeFeedItem

function freshClient(): Record<string, ReturnType<typeof vi.fn>> {
  const info = (id: string) => ({
    id,
    projectID: 'prj',
    agent: 'build',
    model: { providerID: 'opencode', id: 'nemotron-3.5-lightning-free' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: CWD }
  })
  return {
    createSession: vi.fn(async () => info(SID)),
    getSession: vi.fn(async (id: string) => info(id)),
    setSessionPermissions: vi.fn(async () => {}),
    switchAgent: vi.fn(async () => {}),
    switchModel: vi.fn(async () => {}),
    prompt: vi.fn(async (_sid: string, body: { id: string; delivery: string }) => ({
      id: body.id,
      delivery: body.delivery
    })),
    listInbox: vi.fn(async () => []),
    activeSessions: vi.fn(async () => ({})),
    listMessages: vi.fn(async () => []),
    listPermissionRequests: vi.fn(async () => []),
    listForms: vi.fn(async () => []),
    commands: vi.fn(async () => []),
    skills: vi.fn(async () => []),
    mcpServers: vi.fn(async () => []),
    agents: vi.fn(async () => [
      {
        id: 'build',
        name: 'Build',
        mode: 'primary',
        hidden: false,
        request: {},
        permissions: [{ action: '*', resource: '*', effect: 'allow' }]
      }
    ]),
    call: vi.fn(async () => ({
      directory: CWD,
      project: { id: 'prj', directory: '/repo', canonical: '/repo' }
    })),
    subscribeEvents: vi.fn((opts: { signal?: AbortSignal }) => h.feed.pull(opts?.signal))
  }
}

type Sent = [string, ...unknown[]]
let sent: Sent[]
let session: OpencodeSession

const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve))
}
const statusLines = () =>
  sent
    .filter(([c]) => c === 'session:status-line')
    .map(
      ([, , data]) =>
        data as { usedPercentage: number | null; contextWindow: { used: number; size: number } }
    )

function makeSession(): OpencodeSession {
  const win = {
    webContents: { send: (channel: string, ...args: unknown[]) => sent.push([channel, ...args]) }
  }
  subscribeWindowToSync(win)
  return new OpencodeSession('route-1', null, CWD, { model: MODEL })
}

/** Open the session the way the app does (eager connect), then start a turn. */
async function openAndStartTurn(): Promise<void> {
  await session.run(null)
  await flush()
  h.feed.push({ kind: 'connected', reconnected: false, connection: 1 })
  await session.run('hello')
  await flush()
  h.feed.push(event('session.execution.started', { sessionID: SID }))
}

let msg = 0
/** One own step (a 2.0.24-shaped step: input disjoint from the cache read). */
function step(tokens: { input: number; read: number }): void {
  const id = `msg_${++msg}`
  h.feed.push(
    event('session.step.started', {
      sessionID: SID,
      assistantMessageID: id,
      agent: 'build',
      model: { providerID: 'opencode', id: 'nemotron-3.5-lightning-free', variant: 'default' },
      started: clock + 1
    }),
    event('session.step.ended', {
      sessionID: SID,
      assistantMessageID: id,
      finish: 'tool-calls',
      cost: 0,
      tokens: {
        input: tokens.input,
        output: 10,
        reasoning: 5,
        cache: { read: tokens.read, write: 0 }
      }
    })
  )
}

const pct = (used: number) => Math.round((used / WINDOW) * 100)

beforeEach(() => {
  sent = []
  msg = 0
  server.probes = 0
  server.down = false
  invalidateOpencodeModelCache()
  serveCatalog()
  h.feed = new h.Feed()
  h.client = freshClient()
  h.acquire.mockReset().mockResolvedValue({
    baseUrl: 'http://127.0.0.1:1',
    authHeader: 'Basic x',
    directory: CWD,
    startedAt: 0
  })
})

afterEach(() => {
  session?.dispose()
  clearSyncSubscribersForTests()
  setOpencodeDiscoveryConnect(null)
})

describe('the context meter of a live opencode session (real discovery, 2.0.24 catalog)', () => {
  it('reads the window the catalog reports for the session model', async () => {
    session = makeSession()
    await openAndStartTurn()
    step({ input: 8_795, read: 0 })
    await flush()
    expect(statusLines().at(-1)).toMatchObject({
      contextWindow: { used: 8_795, size: WINDOW },
      usedPercentage: pct(8_795)
    })
  })

  it('keeps the percentage after a catalog invalidation mid-session (a credential or config write)', async () => {
    session = makeSession()
    await openAndStartTurn()
    step({ input: 8_795, read: 0 })
    await flush()
    expect(statusLines().at(-1)?.usedPercentage).toBe(pct(8_795))

    // What a credential change, a config write or a harness change does.
    invalidateOpencodeModelCache()
    await flush()
    const before = statusLines().length
    const probes = server.probes
    step({ input: 261, read: 12_000 })
    await flush()

    expect(statusLines().at(-1)).toMatchObject({
      contextWindow: { used: 12_261, size: WINDOW },
      usedPercentage: pct(12_261)
    })
    // Never a `–%` in between, and the dropped catalog was refilled.
    expect(
      statusLines()
        .slice(before)
        .every((l) => l.usedPercentage !== null)
    ).toBe(true)
    expect(server.probes).toBe(probes + 1)
  })

  it('fills the meter in without a new step once discovery answers after a miss', async () => {
    server.down = true
    session = makeSession()
    await openAndStartTurn()
    // Eager discovery failed: the window is unknown for now.
    server.down = false
    step({ input: 4_000, read: 6_000 })
    await flush()

    // No further step: the line the session sends once the catalog is back.
    expect(statusLines().at(-1)).toMatchObject({
      contextWindow: { used: 10_000, size: WINDOW },
      usedPercentage: pct(10_000)
    })
  })

  it('a step reporting no context does not wipe the last reading', async () => {
    session = makeSession()
    await openAndStartTurn()
    step({ input: 261, read: 12_000 })
    step({ input: 0, read: 0 })
    await flush()
    expect(statusLines().at(-1)).toMatchObject({
      contextWindow: { used: 12_261, size: WINDOW },
      usedPercentage: pct(12_261)
    })
  })
})
