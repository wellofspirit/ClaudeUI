/**
 * opencode 2.x contract: the sidebar's session list through opencode's API
 * (ADR-093 §6, S9) — the production `opencode-session-list` module on the
 * production server manager and the real pinned engine. Test-side
 * substitutions only: the isolated home/proxy env, the fixture model, and the
 * read lease's directory (`PERSISTED_SESSIONS_DIR`) inside the test home.
 *
 * Proves:
 * - `GET /api/session?parentID=null` is GLOBAL: root sessions of two
 *   directories come back in one listing, each with its own cwd, and a
 *   subagent child does not;
 * - `directory` narrows it to one directory;
 * - a delete drops the session from the listing at once, and from opencode;
 * - the history of a listed session loads through the same lease.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, it, vi, type TestContext } from 'vitest'

const holder = vi.hoisted(() => ({
  manager: null as unknown as Record<string, (...args: never[]) => unknown>,
  persisted: ''
}))

vi.mock('../../core/opencode/OpencodeServerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/opencode/OpencodeServerManager')>()),
  opencodeServerManager: new Proxy(
    {},
    {
      get: (_target, key: string) => {
        if (key === 'setServerStartedHook' && !holder.manager) return () => {}
        // The binary under test is the contract's own, whatever this machine selected.
        if (key === 'isBinaryAvailable') return () => true
        const value = holder.manager?.[key]
        return typeof value === 'function' ? value.bind(holder.manager) : value
      }
    }
  )
}))
vi.mock('../../core/services/persisted-sessions-dir', () => ({
  get PERSISTED_SESSIONS_DIR() {
    return holder.persisted
  }
}))
vi.mock('../../core/auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: { warmCache: async () => {}, buildAccountRef: () => null }
}))

import { OpencodeServerManager, locatePluginDir } from '../../core/opencode/OpencodeServerManager'
import { OpencodeClient } from '../../core/opencode/OpencodeClient'
import { endStdioServer, spawnStdioServer } from '../../core/opencode/opencode-server-spawn'
import {
  __resetOpencodeSessionListForTests,
  deleteOpencodeSession,
  listOpencodeSessionsForReconcile,
  listOpencodeSessionsGlobal,
  loadOpencodeSessionHistory,
  readOpencodeSessions
} from '../../core/services/opencode-session-list'
import type { HarnessLaunch } from '../../core/harness/launch'
import { formatRequests } from './harness/diagnostics'
import {
  createApi,
  createHome,
  describeV2,
  EventFeed,
  fixtureConfig,
  isolatedEnv,
  nonce,
  SANDBOX_AVAILABLE,
  sandboxProfile,
  startRefusingProxy,
  V2_BIN,
  type Api,
  type RefusingProxy,
  type TestHome,
  type V2Server
} from './harness/host'
import { startFixtureProvider, type FixtureProvider } from './harness/fixture-provider'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ALLOW_ALL = [{ action: '*', resource: '*', effect: 'allow' as const }]

describeV2('opencode 2.x contract: the session list through the API', () => {
  let home: TestHome
  let proxy: RefusingProxy
  let fixture: FixtureProvider
  let manager: OpencodeServerManager
  let api: Api
  let feed: EventFeed
  const ends: Promise<{ forced: boolean }>[] = []

  beforeAll(async () => {
    home = createHome('session-list')
    proxy = await startRefusingProxy()
    fixture = await startFixtureProvider()
    const configDir = join(home.env.XDG_CONFIG_HOME, 'opencode')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(fixtureConfig(fixture)))
    holder.persisted = home.workspace('persisted')
    const env = isolatedEnv(home, proxy)
    const launch: HarnessLaunch = SANDBOX_AVAILABLE
      ? { command: '/usr/bin/sandbox-exec', args: ['-f', sandboxProfile(home), V2_BIN] }
      : { command: V2_BIN, args: [] }
    const pluginDir = locatePluginDir(REPO_ROOT)
    if (!pluginDir) throw new Error(`claudeui-xeng plugin not found under ${REPO_ROOT}`)
    manager = new OpencodeServerManager({
      locateBinaryFn: () => launch,
      spawnFn: (l, options) => spawnStdioServer(l, options, { env }),
      configInputFn: () => ({ bridgedMcp: {}, pluginDir }),
      endServerFn: (child) => {
        ends.push(endStdioServer(child))
      },
      serverCwd: home.workspace('server-cwd')
    })
    holder.manager = manager as never
    __resetOpencodeSessionListForTests()
    // A lease of the test's own for the setup (the list takes its own read leases).
    const conn = await manager.acquire(home.workspace('one'), { waitForHostedTools: false })
    api = createApi(conn.baseUrl, conn.password, home.workspace('one'))
    feed = await EventFeed.subscribe({ url: conn.baseUrl, password: conn.password } as V2Server)
  }, 60_000)

  beforeEach((context: TestContext) => {
    context.onTestFailed(() => {
      home.keep = true
      console.error(
        [
          `── opencode 2.x session-list contract failure: ${context.task.name}`,
          `model requests:\n${formatRequests(fixture)}`,
          `kept: ${home.root}`
        ].join('\n')
      )
    })
  })

  afterAll(async () => {
    feed?.close()
    manager?.dispose()
    const results = await Promise.all(ends)
    await fixture?.close()
    await proxy?.close()
    home?.cleanup()
    if (results.some((r) => r.forced))
      throw new Error('an opencode server ignored stdin EOF and had to be killed')
  }, 60_000)

  async function session(directory: string, title: string, prompt?: string): Promise<string> {
    const created = await api.ok('session.create', {
      body: { location: { directory }, title, permissions: ALLOW_ALL }
    })
    const sessionID = created.data.id
    if (prompt) {
      const from = feed.mark()
      await api.ok('session.prompt', { params: { sessionID }, body: { text: prompt } })
      const end = await feed.waitForTurnEnd(sessionID, from)
      expect(end.type).toBe('session.execution.succeeded')
    }
    return sessionID
  }

  let a1: string
  let a2: string
  let b1: string

  it('one global listing: root sessions of two directories, each with its cwd; a subagent child is not one', async () => {
    const one = home.workspace('one')
    const two = home.workspace('two')
    a1 = await session(one, 'alpha one', `[sub] ${nonce('child')}`)
    a2 = await session(one, 'alpha two')
    b1 = await session(two, 'beta one')
    const children = await api.ok('session.list', { query: { parentID: a1 } })
    expect(children.data).toHaveLength(1)

    const listed = await listOpencodeSessionsForReconcile()
    const byId = new Map(listed.map((info) => [info.sessionId, info]))
    expect(byId.get(a1)).toMatchObject({ cwd: one, title: 'alpha one', engineId: 'opencode' })
    expect(byId.get(a2)).toMatchObject({ cwd: one, title: 'alpha two' })
    expect(byId.get(b1)).toMatchObject({ cwd: two, title: 'beta one' })
    expect(byId.has(children.data[0].id)).toBe(false)
    // Newest first.
    const order = listed.map((info) => info.sessionId)
    expect(order.indexOf(b1)).toBeLessThan(order.indexOf(a2))
    // The sidebar call serves that listing at once (no wait on a server).
    expect((await listOpencodeSessionsGlobal()).map((info) => info.sessionId)).toEqual(order)
  })

  it('the directory query narrows the listing to one directory', async () => {
    const conn = await manager.acquire(home.workspace('one'), { waitForHostedTools: false })
    try {
      const client = new OpencodeClient(conn)
      const two = await readOpencodeSessions(client, home.workspace('two'))
      expect(two.map((info) => info.sessionId)).toEqual([b1])
      const one = await readOpencodeSessions(client, home.workspace('one'))
      expect(one.map((info) => info.sessionId).sort()).toEqual([a1, a2].sort())
    } finally {
      manager.releaseIfCurrent(home.workspace('one'), conn)
    }
  })

  it("a listed session's history loads; a delete drops it from the listing and from opencode", async () => {
    const history = await loadOpencodeSessionHistory(a1)
    expect(history.messages.some((m) => m.role === 'assistant')).toBe(true)

    await deleteOpencodeSession(a2)
    expect((await listOpencodeSessionsGlobal()).some((info) => info.sessionId === a2)).toBe(false)
    const gone = await api.call('session.get', { params: { sessionID: a2 } })
    expect(gone.status).toBe(404)
    expect((await listOpencodeSessionsForReconcile()).some((info) => info.sessionId === a2)).toBe(
      false
    )
  })
})
