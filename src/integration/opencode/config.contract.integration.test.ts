/**
 * opencode 2.x contract: ClaudeUI's config writers (S8, ADR-097 §6 / S8).
 *
 * The PRODUCTION writers (`writeOpencodeNativeConfig`, `patchOpencodeNativeRaw`,
 * `saveAgent`) write the isolated user config dir (`OPENCODE_CONFIG_DIR`, set
 * for this worker only), the PRODUCTION server manager reloads
 * (`reloadConfig` → `POST /api/location/reload` + readiness), and the real
 * pinned engine reads the result back. Isolation as in every contract file:
 * HOME/XDG under `.cache/`, a refusing proxy, the loopback sandbox, the
 * fixture model only.
 *
 * Proves:
 * - a 1.x-shaped user file (the one 2.x warns about) is moved entry by entry
 *   on ClaudeUI's edit, 2.x reads the moved entry and a model variant written
 *   by the raw writer, and the moved file logs NO normalization diagnostic;
 * - a markdown agent saved with ClaudeUI's permission grid is 2.x-native
 *   (`GET /api/agent` carries its rule) and is ENFORCED in a turn: a
 *   `read: deny` agent is never offered `read`;
 * - a disabled provider (2.x `experimental.policies`) leaves the catalog and
 *   comes back on re-enable;
 * - a reload never runs over a pending ask: with an execution running the
 *   server is left to opencode's watcher and the ask survives.
 */
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, it, type TestContext } from 'vitest'
import {
  OpencodeServerManager,
  locatePluginDir,
  type ServerConnection
} from '../../core/opencode/OpencodeServerManager'
import { endStdioServer, spawnStdioServer } from '../../core/opencode/opencode-server-spawn'
import {
  readOpencodeNativeConfig,
  writeOpencodeNativeConfig
} from '../../core/opencode/opencode-config'
import { patchOpencodeNativeRaw } from '../../core/opencode/opencode-native-raw'
import { AGENT_GRID_ACTIONS, readAgent, saveAgent } from '../../core/opencode/opencode-agents'
import { parse as jsoncParse } from 'jsonc-parser'
import type { HarnessLaunch } from '../../core/harness/launch'
import { formatRequests, formatTrace } from './harness/diagnostics'
import {
  createApi,
  createHome,
  describeV2,
  EventFeed,
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
import { NOTES_FILE, startFixtureProvider, type FixtureProvider } from './harness/fixture-provider'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describeV2('opencode 2.x contract: config writers (S8)', () => {
  let home: TestHome
  let proxy: RefusingProxy
  let fixture: FixtureProvider
  let manager: OpencodeServerManager
  let configDir: string
  let configFile: string
  let ws: string
  let conn: ServerConnection
  let api: Api
  let feed: EventFeed
  const ends: Promise<{ forced: boolean }>[] = []
  const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

  /** The engine's own log (the file logger: WARN and up land here). */
  const engineLog = (): string => {
    const dir = join(home.env.XDG_DATA_HOME, 'opencode', 'log')
    if (!existsSync(dir)) return ''
    return readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n')
  }
  /**
   * Normalization diagnostics opencode logged for `file` (one per line),
   * stamped at or after `since` (ISO; the logger writes asynchronously, so a
   * line's timestamp, not its position, says when it was parsed).
   */
  const diagnosticsFor = (file: string, since = ''): string[] =>
    engineLog()
      .split('\n')
      .filter(
        (line) =>
          line.includes('configuration normalization diagnostic') &&
          line.includes(file) &&
          (/timestamp=(\S+)/.exec(line)?.[1] ?? '') >= since
      )
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  beforeAll(async () => {
    home = createHome('config')
    proxy = await startRefusingProxy()
    fixture = await startFixtureProvider()
    configDir = join(home.env.XDG_CONFIG_HOME, 'opencode')
    mkdirSync(configDir, { recursive: true })
    configFile = join(configDir, 'opencode.jsonc')
    // The user's own JSONC file, in the 1.x shape a real 1.x user has: 2.x
    // reads it (and warns about the model's `attachment`), comments and all.
    writeFileSync(
      configFile,
      [
        '{',
        '  // my opencode setup',
        '  "model": "fixture/fixture-model",',
        '  "disabled_providers": ["zzz-gone"],',
        '  "provider": {',
        '    // the local fixture gateway',
        '    "fixture": {',
        '      "name": "Fixture",',
        '      "npm": "@ai-sdk/openai-compatible", // the adapter',
        `      "options": { "baseURL": "${fixture.baseURL}", "apiKey": "fixture-key-from-config" },`,
        '      "models": {',
        '        "fixture-model": {',
        '          "name": "Fixture Model",',
        '          "attachment": false,',
        '          "limit": { "context": 100000, "output": 4096 }',
        '        }',
        '      }',
        '    }',
        '  }',
        '}'
      ].join('\n')
    )
    // The production writers resolve the config dir from the env, per call.
    process.env.OPENCODE_CONFIG_DIR = configDir
    const env = { ...isolatedEnv(home, proxy), OPENCODE_CONFIG_DIR: configDir }
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
    ws = home.workspace('main')
    writeFileSync(join(ws, NOTES_FILE), 'alpha\n')
    conn = await manager.acquire(ws)
    api = createApi(conn.baseUrl, conn.password, ws)
    feed = await EventFeed.subscribe({ url: conn.baseUrl, password: conn.password } as V2Server)
  }, 60_000)

  beforeEach((context: TestContext) => {
    context.onTestFailed(() => {
      home.keep = true
      console.error(
        [
          `── opencode 2.x config contract failure: ${context.task.name}`,
          `events (redacted):\n${formatTrace(feed?.raw ?? [])}`,
          `model requests:\n${formatRequests(fixture)}`,
          `outbound attempts (refused): ${JSON.stringify(proxy.attempts)}`,
          `config file:\n${existsSync(configFile) ? readFileSync(configFile, 'utf8') : '(none)'}`,
          `kept: ${home.root}`
        ].join('\n')
      )
    })
  })

  afterAll(async () => {
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
    feed?.close()
    manager?.dispose()
    const results = await Promise.all(ends)
    await fixture?.close()
    await proxy?.close()
    home?.cleanup()
    if (results.some((r) => r.forced))
      throw new Error('an opencode server ignored stdin EOF and had to be killed')
  }, 30_000)

  /** The config document 2.x loaded from `file`. */
  async function documentFor(file: string): Promise<Record<string, any> | undefined> {
    const entries = (await api.ok('config.get', {})) as unknown as {
      type: string
      path?: string
      info?: Record<string, any>
    }[]
    return entries.find((entry) => entry.type === 'document' && entry.path === file)?.info
  }

  it('moves an edited 1.x provider to its 2.x key; 2.x reads it and a raw-written variant, with no diagnostic', async () => {
    // Before: 2.x warns about the 1.x model's `attachment` in the user's file.
    for (let i = 0; i < 30 && diagnosticsFor(configFile).length === 0; i++) await sleep(100)
    expect(diagnosticsFor(configFile).join('\n')).toContain('attachment')

    const modelBefore = (await api.ok('model.list', {})).data.find(
      (m) => m.providerID === 'fixture' && m.id === 'fixture-model'
    )
    const capabilitiesBefore = modelBefore?.capabilities.input

    // ClaudeUI's provider pane renames it (projection writer) …
    const current = readOpencodeNativeConfig()
    writeOpencodeNativeConfig({
      ...current,
      providers: {
        ...current.providers,
        fixture: { ...current.providers!.fixture, name: 'Fixture (edited)' }
      }
    })
    // … and the capability editor adds a variant (raw writer).
    patchOpencodeNativeRaw([
      {
        path: ['providers', 'fixture', 'models', 'fixture-model', 'variants'],
        value: [{ id: 'hot', body: { temperature: 0.9 } }]
      }
    ])
    const text = readFileSync(configFile, 'utf8')
    // JSONC comments survive the move (the entry's own gathered above it).
    for (const comment of [
      '// my opencode setup',
      '// the local fixture gateway',
      '// the adapter'
    ])
      expect(text).toContain(comment)
    const written = jsoncParse(text)
    expect(written.provider).toEqual({})
    // The inert 1.x `attachment:false` stays inert: no capabilities appear (F4).
    expect(written.providers.fixture.models['fixture-model']).toEqual({
      name: 'Fixture Model',
      variants: [{ id: 'hot', body: { temperature: 0.9 } }],
      limit: { context: 100_000, output: 4096 }
    })

    const writtenAt = new Date().toISOString()
    await expect(manager.reloadConfig()).resolves.toEqual({ reloaded: 1, busy: 0, failed: 0 })

    const info = await documentFor(configFile)
    expect(info?.providers?.fixture?.name).toBe('Fixture (edited)')
    const models = (await api.ok('model.list', {})).data
    const model = models.find((m) => m.providerID === 'fixture' && m.id === 'fixture-model')
    expect(model?.variants.map((v) => v.id)).toEqual(['hot'])
    // …and the runtime capabilities are what they were before the move.
    expect(model?.capabilities.input).toEqual(capabilitiesBefore)
    // The reloaded location parsed the moved file without a single diagnostic
    // (the logger flushes asynchronously: give it time to).
    await sleep(1500)
    expect(diagnosticsFor(configFile, writtenAt)).toEqual([])
    // A turn still runs on the moved provider (settings.baseURL, package).
    const sessionID = (
      await api.ok('session.create', {
        body: {
          location: { directory: ws },
          permissions: [{ action: '*', resource: '*', effect: 'allow' }]
        }
      })
    ).data.id
    const from = feed.mark()
    await api.ok('session.prompt', { params: { sessionID }, body: { text: nonce('moved') } })
    expect((await feed.waitForTurnEnd(sessionID, from)).type).toBe('session.execution.succeeded')
  })

  it('a ClaudeUI-authored agent is 2.x-native, read back by the engine, and enforced in a turn', async () => {
    saveAgent({
      name: 'reader-less',
      scope: 'global',
      mode: 'primary',
      description: 'Cannot read',
      prompt: 'You never read files.',
      model: 'fixture/fixture-model',
      permission: { read: 'deny', shell: 'allow' }
    })
    expect(readAgent('reader-less', 'global')).toMatchObject({
      permission: { read: 'deny' },
      restrict: true
    })
    await manager.reloadConfig()
    const agents = (await api.ok('agent.list', {})).data
    const agent = agents.find((a) => a.id === 'reader-less')
    expect(agent?.system).toBe('You never read files.')
    expect(agent?.permissions).toContainEqual({ action: 'read', resource: '*', effect: 'deny' })

    // Enforced: on this agent the model is never offered `read`; on build it is.
    const run = async (agentID: string): Promise<readonly string[]> => {
      const sessionID = (
        await api.ok('session.create', {
          body: {
            location: { directory: ws },
            agent: agentID,
            permissions: [{ action: 'shell', resource: '*', effect: 'ask' }]
          }
        })
      ).data.id
      const tag = nonce(`agent-${agentID}`)
      const from = feed.mark()
      await api.ok('session.prompt', { params: { sessionID }, body: { text: `[read] ${tag}` } })
      await feed.waitForTurnEnd(sessionID, from)
      return fixture.mentioning(tag)[0]?.tools ?? []
    }
    expect(await run('build')).toContain('read')
    expect(await run('reader-less')).not.toContain('read')
  })

  it('a disabled provider (experimental.policies) leaves the catalog and returns on re-enable', async () => {
    const providerIds = async (): Promise<string[]> =>
      (await api.ok('provider.list', {})).data.map((p) => p.id)
    expect(await providerIds()).toContain('fixture')

    expect(readOpencodeNativeConfig().disabledProviders).toEqual(['zzz-gone'])
    writeOpencodeNativeConfig({
      ...readOpencodeNativeConfig(),
      disabledProviders: ['zzz-gone', 'fixture']
    })
    // The 1.x list moved into the 2.x policies, in 2.x's own order.
    const moved = jsoncParse(readFileSync(configFile, 'utf8'))
    expect(moved).not.toHaveProperty('disabled_providers')
    expect(moved.experimental.policies).toEqual([
      { action: 'provider.use', resource: 'zzz-gone', effect: 'deny' },
      { action: 'provider.use', resource: 'fixture', effect: 'deny' }
    ])
    await manager.reloadConfig()
    expect(await providerIds()).not.toContain('fixture')

    writeOpencodeNativeConfig({ ...readOpencodeNativeConfig(), disabledProviders: ['zzz-gone'] })
    await manager.reloadConfig()
    expect(await providerIds()).toContain('fixture')
    expect(jsoncParse(readFileSync(configFile, 'utf8')).experimental.policies).toEqual([
      { action: 'provider.use', resource: 'zzz-gone', effect: 'deny' }
    ])
  })

  it('a 1.x agent file migrates on save with its effective permissions unchanged in a real turn (F1)', async () => {
    // The common 1.x shape: allow everything, deny bash.
    mkdirSync(join(configDir, 'agents'), { recursive: true })
    writeFileSync(
      join(configDir, 'agents', 'rev.md'),
      '---\ndescription: reviewer\nmodel: fixture/fixture-model\npermission:\n  "*": allow\n  bash: deny\n---\nReview code.\n'
    )
    await manager.reloadConfig()
    const offered = async (): Promise<readonly string[]> => {
      const sessionID = (
        await api.ok('session.create', {
          body: {
            location: { directory: ws },
            agent: 'rev',
            permissions: [{ action: 'question', resource: '*', effect: 'ask' }]
          }
        })
      ).data.id
      const tag = nonce('rev')
      const from = feed.mark()
      await api.ok('session.prompt', { params: { sessionID }, body: { text: `[read] ${tag}` } })
      await feed.waitForTurnEnd(sessionID, from)
      return fixture.mentioning(tag)[0]?.tools ?? []
    }
    const before = await offered()
    expect(before).toContain('read')
    expect(before).not.toContain('shell')

    // The editor's save with nothing but the description changed.
    const detail = readAgent('rev', 'global')!
    expect(detail.legacy).toBe(true)
    saveAgent({
      name: 'rev',
      scope: 'global',
      mode: detail.mode,
      model: detail.model,
      description: 'reviewer (edited)',
      prompt: detail.prompt,
      permission: Object.fromEntries(
        AGENT_GRID_ACTIONS.map((a) => [a, detail.permission?.[a] ?? 'allow'])
      )
    })
    const saved = readAgent('rev', 'global')!
    expect(saved.description).toBe('reviewer (edited)')
    expect(saved.legacy).toBeUndefined()
    await manager.reloadConfig()
    const agent = (await api.ok('agent.list', {})).data.find((a) => a.id === 'rev')
    expect(agent?.description).toBe('reviewer (edited)')
    // The file's order survived: its `*` allow still comes BEFORE its shell deny.
    const rules = agent?.permissions ?? []
    const allowAll = rules.findLastIndex(
      (r) => r.action === '*' && r.resource === '*' && r.effect === 'allow'
    )
    const denyShell = rules.findLastIndex(
      (r) => r.action === 'shell' && r.resource === '*' && r.effect === 'deny'
    )
    expect(allowAll).toBeGreaterThanOrEqual(0)
    expect(denyShell).toBeGreaterThan(allowAll)
    const after = await offered()
    expect(after).toContain('read')
    expect(after).not.toContain('shell')
  })

  it('never reloads over a pending ask; the watcher still applies the write', async () => {
    const sessionID = (
      await api.ok('session.create', {
        body: {
          location: { directory: ws },
          permissions: [
            { action: '*', resource: '*', effect: 'allow' },
            { action: 'shell', resource: '*', effect: 'ask' }
          ]
        }
      })
    ).data.id
    const from = feed.mark()
    await api.ok('session.prompt', { params: { sessionID }, body: { text: '[tool] pending' } })
    const asked = await feed.waitFor('permission.asked', { sessionID, after: from })

    writeOpencodeNativeConfig({
      ...readOpencodeNativeConfig(),
      smallModel: 'fixture/fixture-model'
    })
    await expect(manager.reloadConfig()).resolves.toEqual({ reloaded: 0, busy: 1, failed: 0 })
    // The ask is still pending (a reload would have cancelled it)…
    await new Promise((r) => setTimeout(r, 1000))
    expect(feed.select('permission.replied', { sessionID, after: from })).toEqual([])
    // … and opencode's own watcher picked the write up anyway.
    const title = (await api.ok('agent.list', {})).data.find((a) => a.id === 'title')
    expect(title?.model).toMatchObject({ id: 'fixture-model', providerID: 'fixture' })

    await api.ok('session.permission.reply', {
      params: { sessionID, requestID: asked.data.id },
      body: { decision: 'reject', message: 'contract: not now' }
    })
    await feed.waitForTurnEnd(sessionID, from)
  })
})
