/**
 * @vitest-environment node
 *
 * The opencode 2.x session (ADR-097 S5) against a fake 2.x client and a
 * scripted event feed: lifecycle, the inbox-backed queue, approvals (every
 * reject and form cancel carries a message), subagent child rulesets and their
 * backstop, interrupt, reconnect, usage. The mapper, the permission compiler,
 * the host pre-check and the judge pipeline are REAL — only the wire and the
 * host's settings/auth/discovery are doubles.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onHostPlatform } from '../../../test/helpers/host-platform'
import { foldOutputs, normalizeTranscript } from '../../../test/helpers/opencode-v2-transcript'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../services/sync-host'
import type { OpencodeFeedItem } from '../opencode-event-stream'
import type { OpencodeEvent } from '../protocol-v2/events'

// ─── Doubles ────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  /** A scripted feed: tests push items, the session's `for await` pulls them. */
  class Feed {
    items: unknown[] = []
    private wake: (() => void) | null = null
    subscriptions = 0
    push(...items: unknown[]): void {
      this.items.push(...items)
      this.wake?.()
    }
    async *pull(signal?: AbortSignal): AsyncGenerator<unknown, void, undefined> {
      this.subscriptions++
      while (!signal?.aborted) {
        if (this.items.length > 0) {
          const item = this.items.shift() as { throw?: Error }
          if (item?.throw) throw item.throw
          yield item
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
    releaseIfCurrent: vi.fn(),
    subscribeExit: vi.fn(() => () => {}),
    client: {} as Record<string, ReturnType<typeof vi.fn>>,
    permissions: { allow: [] as string[], deny: [] as string[], ask: [] as string[] },
    engineConfig: { autoMode: {} as Record<string, unknown> },
    recordUsageEvent: vi.fn(),
    shared: {} as Record<string, unknown>,
    judge: vi.fn(),
    /** Per-model route answers for the judge's route resolver; null = every model resolves. */
    resolveRoute: null as
      | null
      | ((
          engine: string,
          value: string,
          options?: { chatgptAccountId?: string }
        ) => Promise<unknown>),
    // The vault's ChatGPT accounts as the fallback judge learns them (see judge-accounts below).
    chatgptVault: {
      activeId: null as string | null,
      accounts: [] as Array<{ id: string; planType?: string }>
    },
    /** What `peekOpencodeModels()` answers (the catalog cache); null = cold. */
    peekModels: null as null | unknown[],
    /** Replaces `sessionToolsGate` for one test (the real gate answers when null). */
    sessionGate: null as null | ((...args: unknown[]) => unknown)
  }
})

vi.mock('../OpencodeServerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../OpencodeServerManager')>()),
  opencodeServerManager: {
    acquire: h.acquire,
    releaseIfCurrent: h.releaseIfCurrent,
    subscribeExit: h.subscribeExit
  }
}))

vi.mock('../OpencodeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../OpencodeClient')>()),
  OpencodeClient: vi.fn(function () {
    return h.client
  })
}))

vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: (scope: string) =>
    scope === 'user'
      ? { ...h.permissions, additionalDirectories: [], defaultMode: undefined }
      : { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined },
  saveClaudePermissions: vi.fn(),
  loadClaudeAutoModeFlags: () => ({ classifyAllShell: false })
}))
vi.mock('../../services/ui-config', async (importOriginal) => ({
  loadEngineConfig: () => h.engineConfig,
  loadSharedAutoModeConfig: () => h.shared,
  normalizeBlockHoldSeconds: (await importOriginal<typeof import('../../services/ui-config')>())
    .normalizeBlockHoldSeconds
}))
vi.mock('../model-discovery', () => ({
  getOpencodeModelContextWindow: () => 100_000,
  getOpencodeModelCapabilities: () => undefined,
  discoverOpencodeModels: vi.fn().mockResolvedValue([]),
  peekOpencodeModels: () => h.peekModels,
  invalidateOpencodeModelCache: vi.fn(),
  parseModelString: (model: string) => {
    const slash = model.indexOf('/')
    return slash < 0
      ? { providerID: 'opencode', modelID: model }
      : { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
  }
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
vi.mock('../../services/usage-recorder', () => ({ recordUsageEvent: h.recordUsageEvent }))
// The session tools' gate is REAL unless a test replaces it (the ask / scope matrix is the
// service's own suite; here the subject is how opencode's asks are routed through it).
vi.mock('../../services/session-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/session-tools')>()
  return {
    ...actual,
    sessionToolsGate: (...args: Parameters<typeof actual.sessionToolsGate>) =>
      h.sessionGate ? h.sessionGate(...args) : actual.sessionToolsGate(...args)
  }
})
vi.mock('../../services/block-usage', () => ({
  blockUsageService: { recalculate: vi.fn().mockResolvedValue(undefined) }
}))
// The judge is ClaudeUI's own HTTP call (ADR-081), mocked at its boundaries
// only: `h.judge` plays the judge MODEL (see test/helpers/fake-judge).
vi.mock('../../automode/judge-route', async () => {
  const { fakeJudgeRoute } = await import('../../../test/helpers/fake-judge')
  return {
    resolveJudgeRoute: async (
      engine: string,
      value: string,
      _deps?: object,
      options?: { chatgptAccountId?: string }
    ) =>
      h.resolveRoute
        ? h.resolveRoute(engine, value, options)
        : { ok: true, route: fakeJudgeRoute() }
  }
})
// A fixture instead of the dev machine's own vault (`refreshChatgptAccounts` would read it).
vi.mock('../../automode/judge-accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../automode/judge-accounts')>()
  return {
    ...actual,
    refreshChatgptAccounts: () => actual.refreshChatgptAccounts(async () => h.chatgptVault)
  }
})
vi.mock('../../automode/judge-usage', () => ({ recordJudgeUsage: vi.fn() }))
vi.mock('../../automode/judge-http/net', async () => {
  const { fakeJudgeFetch } = await import('../../../test/helpers/fake-judge')
  return { pickJudgeFetch: async () => fakeJudgeFetch(h.judge) }
})
vi.mock('../../automode/ground-truth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automode/ground-truth')>()),
  captureGitConfigArmed: vi.fn().mockResolvedValue(null),
  captureGitRemotes: vi.fn().mockResolvedValue([]),
  captureGitStatus: vi.fn().mockResolvedValue(null),
  captureRepoVisibility: vi.fn().mockResolvedValue('unknown')
}))

import { OpencodeSession, CLAUDEUI_INBOX_PREFIX } from '../OpencodeSession'
import { slimTranscript } from '../../automode/classifier'
import { resetChatgptAccounts } from '../../automode/judge-accounts'
import { deleteSessionInbox, heldInboxItems, listAuditLog } from '../../services/db'
import { logger } from '../../services/logger'
import { refFor } from '../../services/session-links'
import { startRunningDispatch } from '../../../test/helpers/running-dispatch'
import { deliver } from '../../services/session-delivery'
import type { SessionManager } from '../../services/session-manager'
import { OpencodePermissionGuardError } from '../OpencodeServerManager'
import { OpencodeApiError } from '../OpencodeClient'
import { buildSessionRuleset, THROWAWAY_RULESET, type V2Rule } from '../permission-v2'
import { resolveOpencodeOwnDirAllows, type OwnDirClient } from '../own-dirs'
import { childSessionRuleset } from '../subagent-permissions'
import { PLAN_MODE_DENY_REASON_NO_EXIT_TOOL } from '../../pi/permission-engine'
import type { OpencodeMapperOutput } from '../event-mapper'
import { convertOpencodeHistory } from '../history'
import { setOpencodeAuthHooks } from '../opencode-auth-hooks'
import { discoverOpencodeModels } from '../model-discovery'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CWD = '/repo/app'
const SID = 'ses_own'
const CHILD = 'ses_child'
const MSG = 'msg_a1'
const TOKENS = { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } }
const CONN = { baseUrl: 'http://127.0.0.1:1', authHeader: 'Basic x', directory: CWD }
const AGENTS = [
  {
    id: 'build',
    name: 'Build',
    mode: 'primary',
    hidden: false,
    request: {},
    permissions: [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'external_directory', resource: '*', effect: 'ask' },
      {
        action: 'external_directory',
        resource: '/home/u/.local/share/opencode/tool-output/*',
        effect: 'allow'
      }
    ]
  },
  {
    id: 'plan',
    name: 'Plan',
    mode: 'primary',
    hidden: false,
    request: {},
    permissions: [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'edit', resource: '*', effect: 'deny' }
    ]
  },
  {
    id: 'explore',
    name: 'Explore',
    mode: 'subagent',
    hidden: false,
    request: {},
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'grep', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'allow' }
    ]
  },
  {
    id: 'pusher',
    name: 'Pusher',
    mode: 'subagent',
    hidden: false,
    request: {},
    permissions: [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'shell', resource: 'git push*', effect: 'deny' }
    ]
  }
]

let clock = 1_000
let seq = 0
function ev(type: string, data: Record<string, unknown>): OpencodeEvent {
  clock++
  return {
    id: `evt_${String(++seq).padStart(5, '0')}`,
    type,
    created: clock,
    data
  } as unknown as OpencodeEvent
}
const event = (type: string, data: Record<string, unknown>): OpencodeFeedItem =>
  ({ kind: 'event', event: ev(type, data) }) as OpencodeFeedItem
const connected = (reconnected = false): OpencodeFeedItem => ({
  kind: 'connected',
  reconnected,
  connection: 1
})

function sessionInfo(id = SID, extra: Record<string, unknown> = {}) {
  return {
    id,
    projectID: 'prj',
    agent: 'build',
    model: { providerID: 'openai', id: 'gpt-x' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: CWD },
    ...extra
  }
}

function freshClient(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    createSession: vi.fn(async (body: Record<string, unknown>) =>
      sessionInfo(SID, { agent: body.agent, model: body.model })
    ),
    getSession: vi.fn(async (id: string) => sessionInfo(id)),
    setSessionPermissions: vi.fn(async () => {}),
    switchAgent: vi.fn(async () => {}),
    switchModel: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    prompt: vi.fn(async (_sid: string, body: { id: string; delivery: string }) => ({
      id: body.id,
      delivery: body.delivery
    })),
    runCommand: vi.fn(async () => {}),
    cancelInbox: vi.fn(async () => {}),
    setInboxDelivery: vi.fn(async () => {}),
    listInbox: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    interrupt: vi.fn(async () => true),
    activeSessions: vi.fn(async () => ({})),
    listMessages: vi.fn(async () => []),
    listPermissionRequests: vi.fn(async () => []),
    listForms: vi.fn(async () => []),
    replyPermission: vi.fn(
      (_s: string, _r: string, reply: { decision: string; message?: string }) => {
        if (reply.decision === 'reject' && !reply.message?.trim())
          throw new TypeError('reject needs a message')
        return Promise.resolve()
      }
    ),
    replyForm: vi.fn(async () => {}),
    cancelForm: vi.fn((_s: string, _f: string, message: string) => {
      if (!message?.trim()) throw new TypeError('cancel needs a message')
      return Promise.resolve()
    }),
    commands: vi.fn(async () => [{ name: 'review', description: 'Review' }]),
    skills: vi.fn(async () => []),
    mcpServers: vi.fn(async () => []),
    agents: vi.fn(async () => AGENTS),
    call: vi.fn(async (op: string) => {
      if (op === 'server.info') return { paths: { tmp: '/srv/tmp/opencode' } }
      if (op === 'location.get')
        return { directory: CWD, project: { id: 'prj', directory: '/repo', canonical: '/repo' } }
      throw new OpencodeApiError('session.message.get', 404, { _tag: 'MessageNotFoundError' })
    }),
    generate: vi.fn(async () => 'side answer'),
    shellOutput: vi.fn(async () => ({ output: 'hello\n', cursor: 6, size: 6, truncated: false })),
    getShell: vi.fn(async () => ({ status: 'exited' })),
    subscribeEvents: vi.fn((opts: { signal?: AbortSignal }) => h.feed.pull(opts?.signal))
  }
}

// ─── Harness ────────────────────────────────────────────────────────────────

type Sent = [string, ...unknown[]]
let sent: Sent[]
let session: OpencodeSession

function makeSession(opts: Record<string, unknown> = {}): OpencodeSession {
  const win = {
    webContents: { send: (channel: string, ...args: unknown[]) => sent.push([channel, ...args]) }
  }
  subscribeWindowToSync(win)
  return new OpencodeSession('route-1', null, CWD, { model: 'openai/gpt-x', ...opts })
}

describe('OpencodeSession voice capability (ADR-101 §8)', () => {
  it('follows the host: on where the speech pack has a runtime, off where it has none', () => {
    expect(onHostPlatform('linux', 'x64', () => makeSession().capabilities.voice)).toBe(true)
    expect(onHostPlatform('freebsd', 'x64', () => makeSession().capabilities.voice)).toBe(false)
  })
})

const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve))
}
const payloads = (channel: string) =>
  sent.filter(([c]) => c === channel).map(([, , data]) => data as Record<string, unknown>)

/** Start a turn: the feed connects first, the prompt follows. */
async function startTurn(text = 'hello'): Promise<void> {
  h.feed.push(connected())
  await session.run(text)
  await flush()
}

beforeEach(() => {
  sent = []
  clock = 1_000
  h.feed = new h.Feed()
  h.client = freshClient()
  h.acquire.mockReset().mockResolvedValue(CONN)
  h.releaseIfCurrent.mockReset()
  h.subscribeExit.mockReset().mockReturnValue(() => {})
  h.recordUsageEvent.mockReset()
  h.permissions.allow = []
  h.permissions.deny = []
  h.permissions.ask = []
  h.engineConfig.autoMode = {}
  h.shared = {}
  h.judge.mockReset()
  h.resolveRoute = null
  h.peekModels = null
  h.sessionGate = null
})

afterEach(() => {
  session?.dispose()
  clearSyncSubscribersForTests()
  // ADR-097 §3 / review #4c: whatever a test did, nothing went out without a message.
  for (const [, , reply] of h.client.replyPermission?.mock.calls ?? []) {
    const r = reply as { decision: string; message?: string }
    if (r.decision === 'reject') expect(r.message?.trim()).toBeTruthy()
  }
  for (const [, , message] of h.client.cancelForm?.mock.calls ?? [])
    expect(String(message ?? '').trim()).toBeTruthy()
})

// ─── Lifecycle ──────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('acquires a turn lease, creates the session WITH its ruleset/agent/model, follows the feed, then posts the prompt with a ClaudeUI inbox id', async () => {
    session = makeSession()
    await startTurn('hello there')

    // A turn-running acquire (no waitForHostedTools:false) — it probes the guard.
    expect(h.acquire).toHaveBeenCalledWith(CWD)
    const body = h.client.createSession.mock.calls[0][0]
    const expected = buildSessionRuleset({
      mode: 'default',
      autoMode: false,
      permissions: {
        allow: [],
        deny: [],
        ask: [],
        additionalDirectories: [],
        defaultMode: undefined
      },
      mcpServers: ['claudeui'],
      cwd: CWD,
      worktree: '/repo',
      externalDirAllows: await resolveOpencodeOwnDirAllows({
        call: h.client.call as OwnDirClient['call']
      })
    })
    expect(body).toEqual({
      agent: 'build',
      model: { providerID: 'openai', id: 'gpt-x' },
      permissions: expected.rules
    })
    // 2.0.25+: the session states the external_directory ask itself, with the server's tmp dir allowed after it.
    const external = body.permissions.filter((rule: V2Rule) => rule.action === 'external_directory')
    expect(external[0]).toEqual({ action: 'external_directory', resource: '*', effect: 'ask' })
    expect(external).toContainEqual({
      action: 'external_directory',
      resource: '/srv/tmp/opencode/*',
      effect: 'allow'
    })
    expect(body.permissions).toContainEqual({ action: 'execute', resource: '*', effect: 'deny' })
    // The ruleset went on the create: no PATCH of the same rules again.
    expect(h.client.setSessionPermissions).not.toHaveBeenCalled()
    expect(h.client.subscribeEvents).toHaveBeenCalledTimes(1)
    const [sid, prompt] = h.client.prompt.mock.calls[0]
    expect(sid).toBe(SID)
    expect(prompt).toMatchObject({ text: 'hello there', delivery: 'steer' })
    expect(prompt.id).toMatch(new RegExp(`^${CLAUDEUI_INBOX_PREFIX}[0-9a-f]{32}$`))
    expect(h.client.subscribeEvents.mock.invocationCallOrder[0]).toBeLessThan(
      h.client.prompt.mock.invocationCallOrder[0]
    )
    expect(payloads('session:status').at(-1)).toMatchObject({ state: 'running', sessionId: SID })
  })

  it('a missing permission guard fails the turn with its explanation and creates nothing', async () => {
    h.acquire.mockRejectedValue(new OpencodePermissionGuardError(CWD, 'no guard RPC'))
    session = makeSession()
    await session.run('hi')
    await flush()
    const errors = payloads('session:error') as unknown as string[]
    expect(errors.some((e) => /safety plugin is not active \(no guard RPC\)/.test(String(e)))).toBe(
      true
    )
    expect(h.client.createSession).not.toHaveBeenCalled()
    expect(payloads('session:status').at(-1)).toMatchObject({ state: 'disconnected' })
  })

  it('resume: replays history, seeds the mapper, catches up on the first connect, purges stale ClaudeUI inbox items, and re-PATCHes', async () => {
    const userRow = {
      id: 'msg_u1',
      type: 'user',
      text: 'old question',
      time: { created: 10 }
    }
    const assistantRow = {
      id: 'msg_a0',
      type: 'assistant',
      agent: 'build',
      model: { providerID: 'openai', id: 'gpt-x' },
      content: [{ type: 'text', text: 'old answer' }],
      cost: 0.01,
      tokens: TOKENS,
      time: { created: 11, completed: 12 }
    }
    const idleRow = { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: 13 } }
    h.client.listMessages.mockResolvedValue([userRow, assistantRow, idleRow])
    h.client.listInbox.mockResolvedValue([
      { id: `${CLAUDEUI_INBOX_PREFIX}stale`, type: 'user', delivery: 'steer' },
      { id: 'msg_other_client', type: 'user', delivery: 'queue' }
    ])
    session = makeSession({ resumeSessionId: SID })
    h.feed.push(connected())
    await session.run('next')
    await flush()

    expect(h.client.createSession).not.toHaveBeenCalled()
    const replayed = payloads('session:message').map((m) => m.id)
    expect(replayed).toEqual(expect.arrayContaining(['msg_u1', 'msg_a0']))
    // The catch-up read ran (activeSessions first) and re-emitted nothing old.
    expect(h.client.activeSessions).toHaveBeenCalled()
    expect(payloads('session:message').filter((m) => m.id === 'msg_a0')).toHaveLength(1)
    // Only ClaudeUI's own stale item is cancelled; another client's is not ours.
    expect(h.client.cancelInbox).toHaveBeenCalledWith(SID, `${CLAUDEUI_INBOX_PREFIX}stale`)
    expect(h.client.cancelInbox).not.toHaveBeenCalledWith(SID, 'msg_other_client')
    // A resumed session's rules are re-asserted (PATCH replaces).
    expect(h.client.setSessionPermissions).toHaveBeenCalledWith(SID, expect.any(Array))
    expect(h.client.prompt).toHaveBeenCalled()
    // History cost seeds the status line.
    expect(payloads('session:status-line').at(-1)).toMatchObject({ totalInputTokens: 100 })
  })

  it('a prompt arriving while the eager resume still replays waits for it: one read, seeded before the feed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    h.client.listMessages.mockImplementation(async (id: string) => {
      if (id === SID) await gate
      return id === SID ? [{ id: 'msg_u1', type: 'user', text: 'old', time: { created: 10 } }] : []
    })
    session = makeSession({ resumeSessionId: SID })
    h.feed.push(connected())
    void session.run(null)
    await flush()
    expect(h.client.listMessages).toHaveBeenCalledWith(SID) // the eager replay is in flight
    const run = session.run('next')
    await flush()
    // Nothing follows the session before its history is seeded.
    expect(h.client.subscribeEvents).not.toHaveBeenCalled()
    release()
    await run
    await flush()
    expect(h.client.getSession.mock.calls.filter(([id]) => id === SID)).toHaveLength(1)
    expect(payloads('session:message').filter((m) => m.id === 'msg_u1')).toHaveLength(1)
    expect(h.client.subscribeEvents).toHaveBeenCalledTimes(1)
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
  })

  it('a resumed chat reports an idle status once its connection and session are up (the flush edge, ADR-105 §3)', async () => {
    session = makeSession({ resumeSessionId: SID })
    const seen: string[] = []
    const send = session.sendStatus.bind(session)
    session.sendStatus = (): void => {
      seen.push(`${session.status.state}:${session.isEngineLive() ? 'live' : 'down'}`)
      send()
    }
    h.feed.push(connected())
    await session.run(null)
    await flush()
    expect(session.isEngineLive()).toBe(true)
    expect(seen.at(-1)).toBe('idle:live')

    // A respawn after the connection was dropped says it again once the client is back.
    session.cancel()
    seen.length = 0
    h.feed.push(connected())
    await session.run(null)
    await flush()
    expect(session.isEngineLive()).toBe(true)
    expect(seen).toContain('idle:live')
  })

  it('a reconnect re-reads state and shows what the gap hid (a pending ask)', async () => {
    session = makeSession()
    await startTurn()
    h.client.activeSessions.mockResolvedValue({ [SID]: {} })
    h.client.listPermissionRequests.mockResolvedValue([
      {
        id: 'per_gap',
        sessionID: SID,
        action: 'shell',
        resources: ['ls'],
        metadata: { command: 'ls' }
      }
    ])
    h.feed.push(connected(true))
    await flush()
    expect(h.client.listMessages).toHaveBeenCalledWith(SID)
    expect(payloads('session:approval-request').map((a) => a.requestId)).toContain('per_gap')
  })
})

// ─── Streaming, tools, turn ends ────────────────────────────────────────────

describe('dispatch', () => {
  const step = () =>
    event('session.step.started', {
      sessionID: SID,
      assistantMessageID: MSG,
      agent: 'build',
      model: { providerID: 'openai', id: 'gpt-x' },
      started: clock + 1
    })

  it('streams text as item open/delta/seal and ends the turn with session:result', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      event('session.execution.started', { sessionID: SID }),
      step(),
      event('session.text.started', { sessionID: SID, assistantMessageID: MSG, ordinal: 0 }),
      event('session.text.delta', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        delta: 'Hi '
      }),
      event('session.text.delta', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        delta: 'there'
      }),
      event('session.text.ended', {
        sessionID: SID,
        assistantMessageID: MSG,
        ordinal: 0,
        text: 'Hi there'
      }),
      event('session.step.ended', {
        sessionID: SID,
        assistantMessageID: MSG,
        finish: 'stop',
        cost: 0.002,
        tokens: TOKENS
      }),
      event('session.execution.succeeded', { sessionID: SID })
    )
    await flush()
    expect(sent.some(([c]) => c === 'session:item-open')).toBe(true)
    expect(sent.some(([c]) => c === 'session:item-delta')).toBe(true)
    const seal = payloads('session:item-seal').at(-1) as { message: { content: unknown[] } }
    expect(seal.message.content).toEqual([{ type: 'text', text: 'Hi there' }])
    expect(payloads('session:result')).toHaveLength(1)
    expect(payloads('session:status').at(-1)).toMatchObject({ state: 'idle' })
    // One ledger row per step, under the step's id.
    expect(h.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: MSG, origin: 'session', modelId: 'gpt-x' })
    )
    expect(payloads('session:status-line').at(-1)).toMatchObject({
      contextWindow: { used: 110, size: 100_000 }
    })
  })

  it('follows a running shell by polling its output, stops at the result', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      event('session.execution.started', { sessionID: SID }),
      step(),
      event('session.tool.input.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sh',
        name: 'shell'
      }),
      event('session.tool.called', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sh',
        input: { command: 'echo hello' },
        executed: false
      }),
      event('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sh',
        metadata: { shellID: 'sh_1' }
      })
    )
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(h.client.shellOutput).toHaveBeenCalledWith('sh_1', expect.any(Object))
    expect(payloads('session:bash-output').at(-1)).toMatchObject({
      toolUseId: 'call_sh',
      output: 'hello\n'
    })
    h.feed.push(
      event('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sh',
        content: [{ type: 'text', text: 'hello' }],
        executed: true
      })
    )
    await flush()
    expect(payloads('session:tool-result').at(-1)).toMatchObject({
      toolUseId: 'call_sh',
      result: 'hello',
      isError: false
    })
  })

  it('synthetic inbox items (plan reminders, notices) render nothing and touch no queue', async () => {
    session = makeSession()
    await startTurn()
    const before = sent.length
    h.feed.push(
      event('session.inbox.enqueued', {
        sessionID: SID,
        inboxID: 'msg_syn',
        item: { type: 'synthetic', payload: { text: '<system-reminder>' }, delivery: 'steer' }
      }),
      event('session.inbox.delivered', { sessionID: SID, inboxID: 'msg_syn' })
    )
    await flush()
    const after = sent.slice(before).map(([c]) => c)
    expect(after).not.toContain('session:message')
    expect(after).not.toContain('session:queue-changed')
  })

  it('a user prompt another client posted is painted; ours never twice', async () => {
    session = makeSession()
    await startTurn('mine')
    const ourId = h.client.prompt.mock.calls[0][1].id as string
    h.feed.push(
      event('session.inbox.enqueued', {
        sessionID: SID,
        inboxID: ourId,
        item: { type: 'user', payload: { text: 'mine' }, delivery: 'steer' }
      }),
      event('session.inbox.delivered', { sessionID: SID, inboxID: ourId }),
      event('session.inbox.enqueued', {
        sessionID: SID,
        inboxID: 'msg_foreign',
        item: { type: 'user', payload: { text: 'from the TUI' }, delivery: 'steer' }
      }),
      event('session.inbox.delivered', { sessionID: SID, inboxID: 'msg_foreign' })
    )
    await flush()
    const ids = payloads('session:message').map((m) => m.id)
    expect(ids).not.toContain(ourId)
    expect(ids).toContain('msg_foreign')
  })
})

// ─── Queue = the native inbox (ADR-097 §9) ──────────────────────────────────

describe('queue via the inbox', () => {
  const queueItems = () =>
    (payloads('session:queue-changed').at(-1)?.items ?? []) as {
      itemId: string
      text: string
      state: string
    }[]

  async function queued(...texts: string[]) {
    for (const text of texts) session.enqueuePrompt(text)
    await flush()
    return h.client.prompt.mock.calls.slice(-texts.length).map(([, body]) => body.id as string)
  }

  it('a prompt typed mid-turn is posted at once as a steer with its own id; delivered → consumed', async () => {
    session = makeSession()
    await startTurn()
    expect(session.willQueue).toBe(true)
    const [inboxID] = await queued('feedback')
    expect(h.client.prompt.mock.calls.at(-1)?.[1]).toMatchObject({
      id: inboxID,
      text: 'feedback',
      delivery: 'steer'
    })
    expect(queueItems()).toMatchObject([{ text: 'feedback', state: 'queued' }])
    h.feed.push(
      event('session.inbox.enqueued', {
        sessionID: SID,
        inboxID,
        item: { type: 'user', payload: { text: 'feedback' }, delivery: 'steer' }
      }),
      event('session.inbox.delivered', { sessionID: SID, inboxID })
    )
    await flush()
    expect(queueItems()).toMatchObject([{ text: 'feedback', state: 'consumed' }])
    // The consumed item is the transcript row (steer-<itemId>); the delivered row is not repeated.
    expect(payloads('session:message').map((m) => m.id)).not.toContain(inboxID)
    expect(session.getMessages().map((m) => m.id)).toContain(`steer-${queueItems()[0].itemId}`)
  })

  it('queue 2, take one back: DELETE …/inbox/:id; only the other remains (and is delivered)', async () => {
    session = makeSession()
    await startTurn()
    const [first, second] = await queued('one', 'two')
    expect(first).not.toBe(second)
    const firstItem = queueItems().find((item) => item.text === 'one')!
    expect(await session.dequeueItem(firstItem.itemId)).toBe(true)
    expect(h.client.cancelInbox).toHaveBeenCalledWith(SID, first)
    expect(h.client.cancelInbox).not.toHaveBeenCalledWith(SID, second)
    expect(queueItems()).toEqual([
      expect.objectContaining({ text: 'one', state: 'recalled' }),
      expect.objectContaining({ text: 'two', state: 'queued' })
    ])
    h.feed.push(
      event('session.inbox.enqueued', {
        sessionID: SID,
        inboxID: second,
        item: { type: 'user', payload: { text: 'two' }, delivery: 'steer' }
      }),
      event('session.inbox.delivered', { sessionID: SID, inboxID: second })
    )
    await flush()
    expect(queueItems()).toEqual([expect.objectContaining({ text: 'two', state: 'consumed' })])
  })

  it('take-back races delivery: the stored row wins (not recalled, consumed by its event)', async () => {
    session = makeSession()
    await startTurn()
    const [inboxID] = await queued('raced')
    // DELETE answers 204 for a delivered item too; the row is what tells.
    h.client.call.mockImplementation(async (op: string) => {
      if (op === 'session.message.get') return { data: { id: inboxID } }
      return { directory: CWD, project: { id: 'p', directory: '/repo', canonical: '/repo' } }
    })
    expect(await session.recallQueued()).toEqual({ recalled: [], notRecalled: 1 })
    expect(queueItems()).toMatchObject([{ state: 'queued' }])
  })

  it('steer ↔ queue is a PATCH of the item', async () => {
    session = makeSession()
    await startTurn()
    const [inboxID] = await queued('later')
    const item = queueItems()[0]
    expect(await session.setQueuedItemDelivery(item.itemId, 'queue')).toBe(true)
    expect(h.client.setInboxDelivery).toHaveBeenCalledWith(SID, inboxID, 'queue')
    expect(await session.setQueuedItemDelivery('nope', 'steer')).toBe(false)
  })

  it('an item cancelled elsewhere is recalled', async () => {
    session = makeSession()
    await startTurn()
    const [inboxID] = await queued('gone')
    h.feed.push(
      event('session.inbox.enqueued', {
        sessionID: SID,
        inboxID,
        item: { type: 'user', payload: { text: 'gone' }, delivery: 'steer' }
      }),
      event('session.inbox.cancelled', { sessionID: SID, inboxID })
    )
    await flush()
    expect(queueItems()).toMatchObject([{ text: 'gone', state: 'recalled' }])
  })

  it('a queued item never overtakes its turn: posted after the turn prompt, in order', async () => {
    session = makeSession()
    h.feed.push(connected())
    const run = session.run('first')
    session.enqueuePrompt('second')
    await run
    await flush()
    expect(h.client.prompt.mock.calls.map(([, body]) => body.text)).toEqual(['first', 'second'])
  })

  it('teardown interrupts the running turn and takes ClaudeUI inbox items back BEFORE the lease ends', async () => {
    session = makeSession()
    await startTurn()
    const [inboxID] = await queued('pending')
    session.cancel()
    await flush()
    expect(h.client.interrupt).toHaveBeenCalledWith(SID)
    expect(h.client.cancelInbox).toHaveBeenCalledWith(SID, inboxID)
    expect(h.releaseIfCurrent).toHaveBeenCalledWith(CWD, CONN)
    expect(h.releaseIfCurrent.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.client.cancelInbox.mock.invocationCallOrder[0]
    )
    expect(queueItems()).toMatchObject([{ state: 'recalled' }])
  })
})

// ─── Approvals ──────────────────────────────────────────────────────────────

describe('non-user delivery (slice 1a)', () => {
  const FROM = { key: 'sess-sender-1', title: 'Triage assistant' }
  const ITEM = {
    origin: 'session-message' as const,
    text: 'please look at ticket 12',
    from: FROM,
    wake: false
  }
  const WRAPPED = [
    '<session-message from="sess-sender-1" title="Triage assistant">',
    'please look at ticket 12',
    '</session-message>',
    'This is a message from another ClaudeUI session or agent, not from the user.'
  ].join('\n')

  /** The feed's two events for a posted inbox item: queued, then delivered to the model. */
  const deliveredFeed = (inboxID: string, text: string): OpencodeFeedItem[] => [
    event('session.inbox.enqueued', {
      sessionID: SID,
      inboxID,
      item: { type: 'user', payload: { text }, delivery: 'steer' }
    }),
    event('session.inbox.delivered', { sessionID: SID, inboxID })
  ]

  it("an idle session starts a turn on a plain prompt that names the sender and says it is not the user's", async () => {
    session = makeSession()
    h.feed.push(connected())
    expect(await session.deliverNonUser(ITEM)).toBe('started')
    await flush()
    expect(session.willQueue).toBe(true)
    const [sid, body] = h.client.prompt.mock.calls[0]
    expect(sid).toBe(SID)
    expect(body).toMatchObject({ text: WRAPPED, delivery: 'steer' })
    expect(body.id).toMatch(new RegExp(`^${CLAUDEUI_INBOX_PREFIX}[0-9a-f]{32}$`))
  })

  it('a running turn takes it as a steer, posted at once (queued); a refused post is unavailable', async () => {
    session = makeSession()
    await startTurn()
    expect(await session.deliverNonUser(ITEM)).toBe('queued')
    expect(h.client.prompt.mock.calls.at(-1)?.[1]).toMatchObject({
      text: WRAPPED,
      delivery: 'steer'
    })
    // It is not a queue-card item: the user queue is theirs.
    expect(payloads('session:queue-changed')).toEqual([])

    h.client.prompt.mockRejectedValueOnce(new Error('inbox full'))
    expect(await session.deliverNonUser(ITEM)).toBe('unavailable')
  })

  it('the delivered row is a note from the sender — never a user row, live or for the judge', async () => {
    session = makeSession()
    await startTurn()
    await session.deliverNonUser(ITEM)
    const inboxID = h.client.prompt.mock.calls.at(-1)![1].id as string
    h.feed.push(...deliveredFeed(inboxID, WRAPPED))
    await flush()

    const notes = payloads('session:message').filter((m) => m.role === 'system')
    expect(notes).toHaveLength(1)
    expect(notes[0].content).toEqual([
      {
        type: 'context_note',
        title: 'Message from Triage assistant',
        fragments: [
          { text: 'please look at ticket 12', label: 'from another session, not from you' }
        ]
      }
    ])
    expect(payloads('session:message').some((m) => m.role === 'user')).toBe(false)
    expect(session.getMessages().filter((m) => m.role === 'user')).toHaveLength(1) // the first prompt
    expect(slimTranscript(session.getMessages())).not.toContain('ticket 12')
  })

  it("an X-Agent's result (dispatch-result) is worded as its own X-Agent's, and its row is a 'Report from X-Agent' note", async () => {
    session = makeSession()
    await startTurn()
    const RESULT = {
      origin: 'dispatch-result' as const,
      text: 'X-Agent impl-e1 finished: done',
      from: { key: 's-abc234', title: 'impl-e1' },
      wake: true
    }
    expect(await session.deliverNonUser(RESULT)).toBe('queued')
    const [, body] = h.client.prompt.mock.calls.at(-1)!
    expect(body.text).toBe(
      [
        '<session-message from="x-agent:s-abc234" title="impl-e1">',
        'X-Agent impl-e1 finished: done',
        '</session-message>',
        'This is the result of an X-Agent you launched with dispatch_agent, not a message from the user.'
      ].join('\n')
    )
    h.feed.push(...deliveredFeed(body.id as string, body.text as string))
    await flush()
    const notes = payloads('session:message').filter((m) => m.role === 'system')
    expect(notes).toHaveLength(1)
    expect(notes[0].content).toEqual([
      {
        type: 'context_note',
        title: 'Report from X-Agent impl-e1',
        fragments: [
          { text: 'X-Agent impl-e1 finished: done', label: 'from an X-Agent, not from you' }
        ]
      }
    ])
  })

  it("a reconnect's purge leaves a posted, undelivered item alone", async () => {
    session = makeSession()
    await startTurn()
    await session.deliverNonUser(ITEM)
    const inboxID = h.client.prompt.mock.calls.at(-1)![1].id as string
    h.client.listInbox.mockResolvedValue([{ id: inboxID, type: 'user' }])
    ;(session as unknown as { needsPurge: boolean }).needsPurge = true
    await (session as unknown as { purgeStaleInbox(): Promise<void> }).purgeStaleInbox()
    expect(h.client.cancelInbox).not.toHaveBeenCalled()
  })
})

describe('non-user delivery that opencode never reads (slice 1a review)', () => {
  const FROM = { key: 'sess-sender-1', title: 'Triage assistant' }
  const ITEM = {
    origin: 'session-message' as const,
    text: 'please look at ticket 12',
    from: FROM,
    wake: false
  }
  const held = () => heldInboxItems('route-1').map((r) => r.body)

  beforeEach(() => {
    deleteSessionInbox('route-1')
  })

  it('an idle delivery whose post is rejected is unavailable — the caller holds it, no turn or taint is counted (N4)', async () => {
    session = makeSession()
    h.feed.push(connected())
    h.client.prompt.mockRejectedValue(new Error('inbox full'))

    expect(await session.deliverNonUser(ITEM)).toBe('unavailable')

    // The adapter holds nothing itself — the caller does, so it is held once.
    expect(held()).toEqual([])
    expect(session.willQueue).toBe(false)
  })

  it('through the service: held as engine-unavailable, nothing tainted or counted (N4)', async () => {
    session = makeSession()
    await startTurn()
    h.client.prompt.mockRejectedValue(new Error('inbox full'))
    const manager = { get: () => session } as unknown as SessionManager

    expect(await deliver(manager, 'route-1', ITEM)).toEqual({
      result: 'held',
      why: 'engine-unavailable'
    })

    expect(held()).toEqual(['please look at ticket 12'])
    expect(session.originLedger.userOriginClean).toBe(true)
    expect(session.originLedger.agentTurnStartsSinceUser).toBe(0)
  })

  it('an idle delivery answers started only once opencode has the item (N4)', async () => {
    session = makeSession()
    h.feed.push(connected())
    expect(await session.deliverNonUser(ITEM)).toBe('started')
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
  })

  it('an item opencode cancels (never delivered) comes back too', async () => {
    session = makeSession()
    await startTurn()
    await session.deliverNonUser(ITEM)
    const inboxID = h.client.prompt.mock.calls.at(-1)![1].id as string
    expect(held()).toEqual([])
    h.feed.push(
      event('session.inbox.enqueued', {
        sessionID: SID,
        inboxID,
        item: { type: 'user', payload: { text: 'x' }, delivery: 'steer' }
      }),
      event('session.inbox.cancelled', { sessionID: SID, inboxID })
    )
    await flush()
    expect(held()).toEqual(['please look at ticket 12'])
  })

  it('a Stop takes the steer back out of opencode and holds it once — a copy left in the server would be read twice (N1)', async () => {
    session = makeSession()
    await startTurn()
    await session.deliverNonUser(ITEM)
    const inboxID = h.client.prompt.mock.calls.at(-1)![1].id as string
    expect(held()).toEqual([])

    session.cancel()
    await flush()

    expect(h.client.cancelInbox).toHaveBeenCalledWith(SID, inboxID)
    expect(held()).toEqual(['please look at ticket 12'])
  })

  it('a server that is gone has nothing to cancel: one held row, no cancel (N1)', async () => {
    session = makeSession()
    await startTurn()
    await session.deliverNonUser(ITEM)
    h.client.cancelInbox.mockClear()

    const onExit = (h.subscribeExit.mock.calls.at(-1) as unknown as [unknown, () => void])[1]
    onExit()
    await flush()

    expect(h.client.cancelInbox).not.toHaveBeenCalled()
    expect(held()).toEqual(['please look at ticket 12'])
  })

  it('the model reading the item taints the session, whatever the user prompt did meanwhile (N2)', async () => {
    session = makeSession()
    await startTurn()
    await session.deliverNonUser(ITEM)
    const inboxID = h.client.prompt.mock.calls.at(-1)![1].id as string
    session.originLedger.userPrompt()
    expect(session.originLedger.userOriginClean).toBe(true)
    h.feed.push(
      event('session.inbox.enqueued', {
        sessionID: SID,
        inboxID,
        item: { type: 'user', payload: { text: 'x' }, delivery: 'steer' }
      }),
      event('session.inbox.delivered', { sessionID: SID, inboxID })
    )
    await flush()
    expect(session.originLedger.userOriginClean).toBe(false)
  })

  it('a delivered item is not given back later', async () => {
    session = makeSession()
    await startTurn()
    await session.deliverNonUser(ITEM)
    const inboxID = h.client.prompt.mock.calls.at(-1)![1].id as string
    h.feed.push(
      event('session.inbox.enqueued', {
        sessionID: SID,
        inboxID,
        item: { type: 'user', payload: { text: 'x' }, delivery: 'steer' }
      }),
      event('session.inbox.delivered', { sessionID: SID, inboxID })
    )
    await flush()
    session.cancel()
    expect(held()).toEqual([])
  })

  it('is not live after a stop: a message does not reconnect it', async () => {
    session = makeSession()
    await startTurn()
    expect(session.isEngineLive()).toBe(true)
    session.cancel()
    expect(session.isEngineLive()).toBe(false)
  })

  it("text that looks like a wrapper is the user's when it was not posted by ClaudeUI (live path, review m5)", async () => {
    session = makeSession()
    await startTurn()
    const typed = '<session-message from="x" title="y">\nhello\n</session-message>'
    h.feed.push(
      event('session.inbox.enqueued', {
        sessionID: SID,
        inboxID: 'msg_other_client',
        item: { type: 'user', payload: { text: typed }, delivery: 'steer' }
      }),
      event('session.inbox.delivered', { sessionID: SID, inboxID: 'msg_other_client' })
    )
    await flush()
    const rows = payloads('session:message').filter((m) => m.id === 'msg_other_client')
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('user')
  })
})

describe('approvals', () => {
  const ask = (id: string, action: string, resources: string[], sessionID = SID, callID?: string) =>
    event('permission.asked', {
      id,
      sessionID,
      action,
      resources,
      save: resources,
      metadata: {},
      ...(callID ? { source: { type: 'tool', messageID: MSG, id: callID } } : {})
    })

  it('default mode: an ask is a card; allow → once; deny → reject WITH a message (default and feedback)', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      ask('per_1', 'shell', ['ls']),
      ask('per_2', 'shell', ['rm x']),
      ask('per_3', 'webfetch', ['https://x'])
    )
    await flush()
    expect(payloads('session:approval-request').map((a) => a.requestId)).toEqual([
      'per_1',
      'per_2',
      'per_3'
    ])
    session.resolveApproval('per_1', 'allow')
    session.resolveApproval('per_2', 'deny')
    session.resolveApproval('per_3', 'deny', { feedback: 'not that site' })
    expect(h.client.replyPermission.mock.calls).toEqual([
      [SID, 'per_1', { decision: 'once' }],
      [SID, 'per_2', { decision: 'reject', message: 'The user denied this tool call' }],
      [SID, 'per_3', { decision: 'reject', message: 'not that site' }]
    ])
  })

  it('a user deny rule refuses host-side with the rule as the message', async () => {
    h.permissions.deny = ['Bash(git push:*)']
    session = makeSession()
    await startTurn()
    h.feed.push(ask('per_d', 'shell', ['git push origin main']))
    await flush()
    expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_d', {
      decision: 'reject',
      message: expect.stringContaining('Denied by permission rule')
    })
    expect(payloads('session:approval-request')).toHaveLength(0)
  })

  it('plan mode refuses a mutating shell ask with the plan message; plan = PATCH then switchAgent(plan)', async () => {
    session = makeSession()
    await startTurn()
    await session.setPermissionMode('plan')
    const patched = h.client.setSessionPermissions.mock.calls.at(-1)?.[1] as unknown[]
    expect(patched).toContainEqual({ action: 'edit', resource: '*', effect: 'deny' })
    expect(h.client.switchAgent).toHaveBeenCalledWith(SID, 'plan')
    expect(h.client.setSessionPermissions.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      h.client.switchAgent.mock.invocationCallOrder.at(-1)!
    )
    h.feed.push(ask('per_p', 'shell', ['rm -rf build']))
    await flush()
    expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_p', {
      decision: 'reject',
      message: PLAN_MODE_DENY_REASON_NO_EXIT_TOOL
    })
    // Leaving plan goes back to the default agent.
    await session.setPermissionMode('default')
    expect(h.client.switchAgent).toHaveBeenLastCalledWith(SID, 'build')
    // An unchanged mode re-sends nothing.
    const patches = h.client.setSessionPermissions.mock.calls.length
    await session.setPermissionMode('default')
    expect(h.client.setSessionPermissions.mock.calls.length).toBe(patches)
  })

  it('a failed PATCH fails the turn closed: no prompt is posted', async () => {
    session = makeSession({ resumeSessionId: SID })
    h.client.setSessionPermissions.mockRejectedValue(new Error('500'))
    h.feed.push(connected())
    await session.run('x')
    await flush()
    expect(h.client.prompt).not.toHaveBeenCalled()
    expect(
      payloads('session:error')
        .map(String)
        .some((e) => /Could not apply permission mode/.test(e))
    ).toBe(true)
  })

  it('a session allow answers the next covered ask without a card', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(ask('per_a', 'webfetch', ['https://a.example/x']))
    await flush()
    session.resolveApproval('per_a', 'allowForSession')
    h.feed.push(ask('per_b', 'webfetch', ['https://a.example/x']))
    await flush()
    expect(h.client.replyPermission).toHaveBeenLastCalledWith(SID, 'per_b', { decision: 'once' })
    expect(payloads('session:approval-request').map((a) => a.requestId)).toEqual(['per_a'])
  })

  it('an external_directory ask is an ordinary card in default mode', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(ask('per_x', 'external_directory', ['/etc/*']))
    await flush()
    expect(payloads('session:approval-request')).toMatchObject([
      { requestId: 'per_x', toolName: 'external_directory' }
    ])
  })

  it('auto mode: a plainly read-only shell call is allowed by the static gate, no judge', async () => {
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()
    h.feed.push(
      event('session.step.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        agent: 'build',
        model: { providerID: 'openai', id: 'gpt-x' },
        started: clock + 1
      }),
      event('session.tool.input.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_ls',
        name: 'shell'
      }),
      event('session.tool.called', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_ls',
        input: { command: 'ls' },
        executed: false
      }),
      ask('per_ls', 'shell', ['ls'], SID, 'call_ls')
    )
    await flush(60)
    expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_ls', { decision: 'once' })
    expect(payloads('session:tool-review').at(-1)).toMatchObject({ toolUseId: 'call_ls' })
    expect(payloads('session:approval-request')).toHaveLength(0)
  })

  it('forms: AskUserQuestion; the answer carries the OPTION VALUE (string / list); a dismissal cancels WITH a message', async () => {
    session = makeSession()
    await startTurn()
    const form = (id: string) =>
      event('form.created', {
        form: {
          id,
          sessionID: SID,
          title: 'Q',
          metadata: { kind: 'question', tool: { messageID: MSG, id: `call_${id}` } },
          fields: [
            {
              key: 'q0',
              type: 'string',
              title: 'Fruit',
              description: 'Pick a fruit?',
              options: [
                { value: 'apple', label: 'Apple' },
                { value: 'banana', label: 'Banana' }
              ]
            },
            {
              key: 'q1',
              type: 'multiselect',
              title: 'Many',
              description: 'Pick many?',
              options: [
                { value: 'r', label: 'Red' },
                { value: 'g', label: 'Green' }
              ]
            }
          ]
        }
      })
    h.feed.push(form('frm_1'), form('frm_2'))
    await flush()
    expect(payloads('session:approval-request')).toMatchObject([
      { requestId: 'frm_1', toolName: 'AskUserQuestion' },
      { requestId: 'frm_2', toolName: 'AskUserQuestion' }
    ])
    session.resolveApproval('frm_1', 'allow', {
      'Pick a fruit?': 'Banana',
      'Pick many?': 'Red, Green'
    })
    expect(h.client.replyForm).toHaveBeenCalledWith(SID, 'frm_1', { q0: 'banana', q1: ['r', 'g'] })
    session.resolveApproval('frm_2', 'deny')
    expect(h.client.cancelForm).toHaveBeenCalledWith(
      SID,
      'frm_2',
      'The user dismissed the question without answering'
    )
  })

  it('Stop: interrupt (resume queued steers); a user stop shows no error and retracts the open card', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      event('session.execution.started', { sessionID: SID }),
      ask('per_s', 'shell', ['sleep 9'])
    )
    await flush()
    await session.interrupt()
    expect(h.client.interrupt).toHaveBeenCalledWith(SID, { resume: true })
    h.feed.push(event('session.execution.interrupted', { sessionID: SID, reason: 'user' }))
    await flush()
    expect(payloads('session:error')).toHaveLength(0)
    expect(payloads('session:warning')).toHaveLength(0)
    expect(payloads('session:approval-dismiss')).toContainEqual({ requestId: 'per_s' })
    expect(payloads('session:result')).toHaveLength(1)
    expect(payloads('session:status').at(-1)).toMatchObject({ state: 'idle' })
  })

  it('a shutdown stop is explained (it resumes later), not an error', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      event('session.execution.started', { sessionID: SID }),
      event('session.execution.interrupted', { sessionID: SID, reason: 'shutdown' })
    )
    await flush()
    expect(payloads('session:error')).toHaveLength(0)
    expect(sent.filter(([c]) => c === 'session:warning').map(([, , w]) => w)).toEqual([
      expect.stringMatching(/resumes the turn/)
    ])
  })
})

// ─── Subagent children ──────────────────────────────────────────────────────

describe('subagent children', () => {
  const created = (id: string, parentID: string, agent: string) =>
    event('session.created', {
      sessionID: id,
      parentID,
      agent,
      projectID: 'prj',
      location: { directory: CWD },
      slug: id,
      version: '2'
    })

  it('session.created{parentID} → PATCH childSessionRuleset(parent, agent); re-PATCH on parent re-apply and on an agent switch', async () => {
    session = makeSession()
    await startTurn()
    const parentRules = h.client.createSession.mock.calls[0][0].permissions
    h.feed.push(created(CHILD, SID, 'explore'))
    await flush()
    expect(h.client.setSessionPermissions).toHaveBeenCalledWith(
      CHILD,
      childSessionRuleset(parentRules, AGENTS[2].permissions as never)
    )
    const explore = h.client.setSessionPermissions.mock.calls.at(-1)?.[1] as unknown[]
    // explore denies edit wholly → re-denied after the parent's gates (hidden).
    expect(explore.at(-1)).toMatchObject({ effect: 'deny', resource: '*' })

    await session.setPermissionMode('acceptEdits')
    const acceptRules = h.client.setSessionPermissions.mock.calls.find(([id]) => id === SID)?.[1]
    expect(h.client.setSessionPermissions).toHaveBeenLastCalledWith(
      CHILD,
      childSessionRuleset(acceptRules as never, AGENTS[2].permissions as never)
    )

    h.feed.push(event('session.agent.selected', { sessionID: CHILD, agent: 'pusher' }))
    await flush()
    expect(h.client.setSessionPermissions).toHaveBeenLastCalledWith(
      CHILD,
      childSessionRuleset(acceptRules as never, AGENTS[3].permissions as never)
    )
  })

  const childPatches = (id: string) =>
    h.client.setSessionPermissions.mock.calls.filter(([sid]) => sid === id)

  it('every parent apply re-PATCHes each child computed from another parent ruleset — settled ones too; an unchanged one is skipped', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(created(CHILD, SID, 'explore'), created('ses_done', SID, 'explore'))
    await flush()
    // ses_done's call ended long ago; a later call can resume it with its id.
    h.feed.push(
      event('session.step.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        agent: 'build',
        model: { providerID: 'openai', id: 'gpt-x' },
        started: clock + 1
      }),
      event('session.tool.input.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_d',
        name: 'subagent'
      }),
      event('session.tool.called', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_d',
        input: { agent: 'explore' },
        executed: false
      }),
      event('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_d',
        metadata: { sessionID: 'ses_done' }
      }),
      event('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_d',
        content: [{ type: 'text', text: 'done' }],
        executed: true
      })
    )
    await flush()
    h.client.setSessionPermissions.mockClear()
    await session.setPermissionMode('acceptEdits')
    await flush()
    expect(childPatches(CHILD)).toHaveLength(1)
    expect(childPatches('ses_done')).toHaveLength(1)
    // Same parent rules again → nothing re-sent.
    h.client.setSessionPermissions.mockClear()
    await session.notifySettingsChanged()
    await flush()
    expect(h.client.setSessionPermissions).not.toHaveBeenCalled()
  })

  it('a switchAgent that fails AFTER the PATCH still re-PATCHes the children, and the next apply retries the agent', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(created(CHILD, SID, 'explore'))
    await flush()
    h.client.switchAgent.mockRejectedValueOnce(new Error('switch failed'))
    await session.setPermissionMode('plan')
    await flush()
    expect(
      payloads('session:error')
        .map(String)
        .some((e) => /switch failed/.test(e))
    ).toBe(true)
    const planRules = h.client.setSessionPermissions.mock.calls
      .filter(([id]) => id === SID)
      .at(-1)![1]
    expect(childPatches(CHILD).at(-1)?.[1]).toEqual(
      childSessionRuleset(planRules as never, AGENTS[2].permissions as never)
    )
    await session.setPermissionMode('plan')
    expect(h.client.switchAgent).toHaveBeenLastCalledWith(SID, 'plan')
    expect(h.client.switchAgent).toHaveBeenCalledTimes(2)
  })

  it('child PATCHes are serialized: a slow older PATCH can never land after a newer one', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(created(CHILD, SID, 'explore'))
    await flush()
    let releaseFirst!: () => void
    let inFlight = 0
    let overlapped = false
    h.client.setSessionPermissions.mockImplementation(async (id: string) => {
      if (id !== CHILD) return
      inFlight++
      if (inFlight > 1) overlapped = true
      if (!releaseFirst) await new Promise<void>((resolve) => (releaseFirst = resolve))
      inFlight--
    })
    const first = session.setPermissionMode('acceptEdits')
    await flush()
    const second = session.setPermissionMode('plan')
    await flush()
    releaseFirst()
    await Promise.all([first, second])
    await flush()
    expect(overlapped).toBe(false)
    const planRules = h.client.setSessionPermissions.mock.calls
      .filter(([id]) => id === SID)
      .at(-1)![1]
    expect(childPatches(CHILD).at(-1)?.[1]).toEqual(
      childSessionRuleset(planRules as never, AGENTS[2].permissions as never)
    )
  })

  it('a child PATCH that fails twice fails CLOSED: the child is interrupted and its asks refused (with a message)', async () => {
    session = makeSession()
    await startTurn()
    h.client.setSessionPermissions.mockImplementation(async (id: string) => {
      if (id === CHILD) throw new Error('patch failed')
    })
    h.feed.push(created(CHILD, SID, 'explore'))
    await flush()
    expect(childPatches(CHILD)).toHaveLength(2)
    expect(h.client.interrupt).toHaveBeenCalledWith(CHILD)
    h.feed.push(
      event('session.tool.input.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_c',
        name: 'subagent'
      }),
      event('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_c',
        metadata: { sessionID: CHILD }
      }),
      event('permission.asked', {
        id: 'per_c',
        sessionID: CHILD,
        action: 'read',
        resources: ['a.txt'],
        metadata: {}
      })
    )
    await flush()
    expect(h.client.replyPermission).toHaveBeenCalledWith(CHILD, 'per_c', {
      decision: 'reject',
      message: expect.stringContaining("could not apply this subagent's permission rules")
    })
    expect(payloads('session:approval-request')).toHaveLength(0)
  })

  it("a resumed chat adopts its stored children and brings them to this process's parent rules", async () => {
    h.client.listSessions.mockImplementation(async ({ parentID }: { parentID: string }) =>
      parentID === SID ? [sessionInfo('ses_old_child', { parentID: SID, agent: 'explore' })] : []
    )
    session = makeSession({ resumeSessionId: SID })
    h.feed.push(connected())
    await session.run('next')
    await flush()
    const ownRules = h.client.setSessionPermissions.mock.calls.find(([id]) => id === SID)![1]
    expect(childPatches('ses_old_child').at(-1)?.[1]).toEqual(
      childSessionRuleset(ownRules as never, AGENTS[2].permissions as never)
    )
  })

  it('backstop: a child ask its own agent denies is refused (with a message) before the PATCH lands; replies go to the CHILD', async () => {
    session = makeSession()
    await startTurn()
    // The PATCH is slow: the child's first call asks before it lands.
    let land!: () => void
    h.client.setSessionPermissions.mockImplementation((id: string) =>
      id === CHILD ? new Promise<void>((resolve) => (land = resolve)) : Promise.resolve()
    )
    h.feed.push(
      event('session.execution.started', { sessionID: SID }),
      event('session.step.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        agent: 'build',
        model: { providerID: 'openai', id: 'gpt-x' },
        started: clock + 1
      }),
      event('session.tool.input.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sub',
        name: 'subagent'
      }),
      event('session.tool.called', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sub',
        input: { agent: 'pusher', description: 'push it', prompt: 'push' },
        executed: false
      }),
      created(CHILD, SID, 'pusher'),
      event('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sub',
        metadata: { sessionID: CHILD }
      }),
      event('permission.asked', {
        id: 'per_child_push',
        sessionID: CHILD,
        action: 'shell',
        resources: ['git push origin main'],
        metadata: {}
      }),
      event('permission.asked', {
        id: 'per_child_ls',
        sessionID: CHILD,
        action: 'shell',
        resources: ['ls'],
        metadata: {}
      })
    )
    await flush()
    expect(h.client.replyPermission).toHaveBeenCalledWith(CHILD, 'per_child_push', {
      decision: 'reject',
      message: expect.stringContaining("pusher agent's permission rules")
    })
    // An ask the agent allows still reaches the human, and its reply goes to the child.
    expect(payloads('session:approval-request').map((a) => a.requestId)).toEqual(['per_child_ls'])
    session.resolveApproval('per_child_ls', 'allow')
    expect(h.client.replyPermission).toHaveBeenLastCalledWith(CHILD, 'per_child_ls', {
      decision: 'once'
    })
    land()
  })
})

// ─── Usage, side question ───────────────────────────────────────────────────

describe('usage and side questions', () => {
  it('child steps and overhead count in the headline; only own steps move the context meter', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      event('session.execution.started', { sessionID: SID }),
      event('session.step.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        agent: 'build',
        model: { providerID: 'openai', id: 'gpt-x' },
        started: clock + 1
      }),
      event('session.tool.input.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sub',
        name: 'subagent'
      }),
      event('session.tool.called', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sub',
        input: { agent: 'explore', description: 'look', prompt: 'look' },
        executed: false
      }),
      event('session.created', {
        sessionID: CHILD,
        parentID: SID,
        agent: 'explore',
        projectID: 'p',
        location: { directory: CWD },
        slug: 'c',
        version: '2'
      }),
      event('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sub',
        metadata: { sessionID: CHILD }
      }),
      event('session.step.started', {
        sessionID: CHILD,
        assistantMessageID: 'msg_c1',
        agent: 'explore',
        model: { providerID: 'openai', id: 'gpt-mini' },
        started: clock + 1
      }),
      event('session.step.ended', {
        sessionID: CHILD,
        assistantMessageID: 'msg_c1',
        finish: 'stop',
        cost: 0,
        tokens: { input: 5000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
      }),
      event('session.step.ended', {
        sessionID: SID,
        assistantMessageID: MSG,
        finish: 'tool-calls',
        cost: 0,
        tokens: TOKENS
      }),
      event('session.usage.updated', {
        sessionID: SID,
        cost: 0,
        tokens: { input: 130, output: 25, reasoning: 5, cache: { read: 10, write: 0 } }
      }),
      event('session.execution.succeeded', { sessionID: SID })
    )
    await flush()
    const line = payloads('session:status-line').at(-1)!
    // own 100 + child 5000 + title overhead 30
    expect(line.totalInputTokens).toBe(5130)
    expect(line.contextWindow).toEqual({ used: 110, size: 100_000 })
    expect(h.recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg_c1',
        origin: 'child',
        sessionId: CHILD,
        modelId: 'gpt-mini',
        parentRoutingId: 'route-1'
      })
    )
  })

  it('a side question generates from the chat context when its session exists, else on a tool-less throwaway', async () => {
    session = makeSession()
    expect(await session.askSideQuestion('what?')).toBe('side answer')
    expect(h.client.createSession).toHaveBeenCalledWith({
      title: 'side-question',
      model: { providerID: 'openai', id: 'gpt-x' },
      permissions: [...THROWAWAY_RULESET]
    })
    expect(h.client.deleteSession).toHaveBeenCalledWith(SID)

    h.client.createSession.mockClear()
    await startTurn()
    h.client.createSession.mockClear()
    expect(await session.askSideQuestion('why?')).toBe('side answer')
    expect(h.client.generate).toHaveBeenLastCalledWith(SID, expect.stringContaining('why?'))
    expect(h.client.createSession).not.toHaveBeenCalled()
  })
})

// ─── Teardown, give-up, serialization, judge rejects (S5 review) ────────────

describe('teardown and recovery', () => {
  const ask = (id: string, sessionID = SID) =>
    event('permission.asked', {
      id,
      sessionID,
      action: 'shell',
      resources: ['make deploy'],
      save: ['make deploy'],
      metadata: { command: 'make deploy' }
    })

  it('feed give-up: the cards go, and a reconnect re-raises the ask the server still holds', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(event('session.execution.started', { sessionID: SID }), ask('per_g'))
    await flush()
    expect(payloads('session:approval-request').map((a) => a.requestId)).toEqual(['per_g'])
    // The server is unreachable for the teardown's stops.
    h.client.interrupt.mockRejectedValue(new Error('unreachable'))
    h.feed.push({ throw: new Error('gave-up') })
    await flush()
    expect(payloads('session:approval-dismiss')).toContainEqual({ requestId: 'per_g' })
    expect(payloads('session:status').at(-1)).toMatchObject({ state: 'disconnected' })
    // Back: the re-read finds the ask still pending.
    h.client.activeSessions.mockResolvedValue({ [SID]: {} })
    h.client.listPermissionRequests.mockResolvedValue([
      {
        id: 'per_g',
        sessionID: SID,
        action: 'shell',
        resources: ['make deploy'],
        metadata: { command: 'make deploy' }
      }
    ])
    h.feed.push(connected())
    await session.run('again')
    await flush()
    expect(payloads('session:approval-request').map((a) => a.requestId)).toEqual(['per_g', 'per_g'])
  })

  it('feed give-up tears down like cancel(): interrupt, take ClaudeUI inbox items back, THEN release', async () => {
    session = makeSession()
    await startTurn()
    session.enqueuePrompt('pending')
    await flush()
    const inboxID = h.client.prompt.mock.calls.at(-1)![1].id
    h.feed.push({ throw: new Error('gave-up') })
    await flush()
    expect(h.client.interrupt).toHaveBeenCalledWith(SID)
    expect(h.client.cancelInbox).toHaveBeenCalledWith(SID, inboxID)
    expect(h.releaseIfCurrent).toHaveBeenCalledWith(CWD, CONN)
    expect(h.releaseIfCurrent.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.client.cancelInbox.mock.invocationCallOrder[0]
    )
  })

  it('cancel() interrupts even an idle chat and its open children, and releases only once the server lists none active', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      event('session.execution.started', { sessionID: SID }),
      event('session.step.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        agent: 'build',
        model: { providerID: 'openai', id: 'gpt-x' },
        started: clock + 1
      }),
      event('session.tool.input.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_bg',
        name: 'subagent'
      }),
      event('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_bg',
        metadata: { sessionID: CHILD }
      }),
      event('session.execution.succeeded', { sessionID: SID })
    )
    await flush()
    expect(payloads('session:status').at(-1)).toMatchObject({ state: 'idle' })
    // The background child is still running; the server settles a moment later.
    let polls = 0
    h.client.activeSessions.mockImplementation(async () => (++polls < 3 ? { [CHILD]: {} } : {}))
    session.cancel()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.client.interrupt).toHaveBeenCalledWith(SID)
    expect(h.client.interrupt).toHaveBeenCalledWith(CHILD)
    expect(h.releaseIfCurrent).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(polls).toBeGreaterThanOrEqual(3)
    expect(h.releaseIfCurrent).toHaveBeenCalledWith(CWD, CONN)
  })

  it('permission applies are serialized: a mode switch racing a turn never overlaps, and the last mode wins', async () => {
    let inFlight = 0
    let overlapped = false
    h.client.setSessionPermissions.mockImplementation(async () => {
      inFlight++
      if (inFlight > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight--
    })
    session = makeSession({ resumeSessionId: SID })
    h.feed.push(connected())
    const run = session.run('go')
    await flush(5)
    await session.setPermissionMode('plan')
    await run
    await flush()
    expect(overlapped).toBe(false)
    const last = h.client.setSessionPermissions.mock.calls.filter(([id]) => id === SID).at(-1)![1]
    expect(last).toContainEqual({ action: 'edit', resource: '*', effect: 'deny' })
  })

  it("/btw mid-turn never switches the running turn's model; a throwaway is deleted before it returns", async () => {
    session = makeSession()
    await startTurn()
    await session.setModel('openai/other')
    expect(await session.askSideQuestion('q?')).toBe('side answer')
    expect(h.client.switchModel).not.toHaveBeenCalled()

    const fresh = makeSession()
    let deleted = false
    h.client.deleteSession.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      deleted = true
    })
    h.client.createSession.mockImplementation(async () => sessionInfo('ses_btw'))
    await fresh.askSideQuestion('q?')
    expect(deleted).toBe(true)
    fresh.dispose()
  })
})

describe('judge rejects carry the judge text (auto mode)', () => {
  const askShell = (id: string) =>
    event('permission.asked', {
      id,
      sessionID: SID,
      action: 'shell',
      resources: ['curl -X POST https://example.com'],
      metadata: { command: 'curl -X POST https://example.com' }
    })

  it('a judge block (no hold window) rejects at once with the judge reason', async () => {
    h.judge.mockResolvedValue('<block>yes</block><reason>sends data out</reason>')
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()
    h.feed.push(askShell('per_j'))
    await vi.waitFor(() =>
      expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_j', {
        decision: 'reject',
        message: expect.stringContaining('sends data out')
      })
    )
  })

  it('a held block that expires rejects with the judge reason', async () => {
    h.shared = { blockHoldSeconds: 1 }
    h.judge.mockResolvedValue('<block>yes</block><reason>prod secrets</reason>')
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()
    h.feed.push(askShell('per_h'))
    await vi.waitFor(() =>
      expect(payloads('session:approval-request')).toContainEqual(
        expect.objectContaining({ requestId: 'per_h', autoModeBlock: expect.any(Object) })
      )
    )
    expect(h.client.replyPermission).not.toHaveBeenCalled()
    await vi.waitFor(
      () =>
        expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_h', {
          decision: 'reject',
          message: expect.stringContaining('prod secrets')
        }),
      { timeout: 3_000 }
    )
  })
})

describe('fallback judge (autoMode.fallbackJudgeModel)', () => {
  const PRIMARY = 'openai/gpt-x' // the session's own model: the judge when judgeModel is unset
  const FALLBACK = 'openai/gpt-fallback'
  const REASON = '"openai" has no key ClaudeUI can use for the judge.'
  const askShell = (id: string) =>
    event('permission.asked', {
      id,
      sessionID: SID,
      action: 'shell',
      resources: ['curl -X POST https://example.com'],
      metadata: { command: 'curl -X POST https://example.com' }
    })
  const errors = (): string[] => payloads('session:error') as unknown as string[]
  const cantJudge = (reason: string): string =>
    `Auto-mode can't judge here: ${reason} Every gated action will ask you instead. ` +
    'Change the judge model in Settings › Sessions & autonomy › Auto-mode judge (opencode).'

  /** The given models have no route; every other one resolves to a route named after it. */
  async function noRouteFor(...values: string[]): Promise<void> {
    const { fakeJudgeRoute } = await import('../../../test/helpers/fake-judge')
    h.resolveRoute = async (_engine, value) =>
      values.includes(value)
        ? { ok: false, code: 'no-shared-provider', reason: REASON }
        : { ok: true, route: fakeJudgeRoute(value) }
  }

  const catalog = (...values: string[]): unknown[] => [
    {
      engineId: 'opencode',
      vendorId: 'openai',
      vendorName: 'OpenAI',
      models: values.map((value) => ({ value, displayName: value }))
    }
  ]

  it('the primary has no route: the fallback judges, and the banner says so (once)', async () => {
    h.engineConfig.autoMode = { fallbackJudgeModel: ` ${FALLBACK} `, twoStageMode: 'fast' }
    await noRouteFor(PRIMARY)
    h.judge.mockResolvedValue('<block>no</block>')
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()

    h.feed.push(askShell('per_f1'))
    await vi.waitFor(() =>
      expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_f1', { decision: 'once' })
    )
    h.feed.push(askShell('per_f2'))
    await vi.waitFor(() =>
      expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_f2', { decision: 'once' })
    )

    expect(h.judge.mock.calls.map(([call]) => call.body.model)).toEqual([FALLBACK, FALLBACK])
    expect(payloads('session:approval-request')).toHaveLength(0)
    expect(errors()).toEqual([
      `Auto-mode judge unavailable: ${REASON} ${FALLBACK} is judging instead until it recovers. ` +
        'Change the judge models in Settings › Sessions & autonomy › Auto-mode judge (opencode).'
    ])
  })

  it('both judges unavailable: the human decides, with one banner per judge', async () => {
    h.engineConfig.autoMode = { fallbackJudgeModel: FALLBACK, twoStageMode: 'fast' }
    await noRouteFor(PRIMARY, FALLBACK)
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()

    h.feed.push(askShell('per_f3'))
    await vi.waitFor(() => expect(payloads('session:approval-request')).toHaveLength(1))
    h.feed.push(askShell('per_f4'))
    await vi.waitFor(() => expect(payloads('session:approval-request')).toHaveLength(2))

    expect(h.judge).not.toHaveBeenCalled()
    expect(errors()).toEqual([
      `Auto-mode judge unavailable: ${REASON} ${FALLBACK} is judging instead until it recovers. ` +
        'Change the judge models in Settings › Sessions & autonomy › Auto-mode judge (opencode).',
      cantJudge(`fallback ${FALLBACK}: ${REASON}`)
    ])
  })

  it('no fallback configured, or one equal to the effective primary: the original banner', async () => {
    h.engineConfig.autoMode = { fallbackJudgeModel: PRIMARY, twoStageMode: 'fast' }
    await noRouteFor(PRIMARY)
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()

    h.feed.push(askShell('per_f5'))
    await vi.waitFor(() => expect(payloads('session:approval-request')).toHaveLength(1))

    expect(errors()).toEqual([cantJudge(REASON)])
  })

  it('a fallback opencode no longer offers is no fallback: the human decides, one log line', async () => {
    h.engineConfig.autoMode = { fallbackJudgeModel: 'openai/gone', twoStageMode: 'fast' }
    h.peekModels = catalog(PRIMARY, FALLBACK)
    await noRouteFor(PRIMARY)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      session = makeSession({ permissionMode: 'auto' })
      await startTurn()

      h.feed.push(askShell('per_f6'))
      await vi.waitFor(() => expect(payloads('session:approval-request')).toHaveLength(1))
      h.feed.push(askShell('per_f7'))
      await vi.waitFor(() => expect(payloads('session:approval-request')).toHaveLength(2))

      expect(h.judge).not.toHaveBeenCalled()
      expect(errors()).toEqual([cantJudge(REASON)])
      expect(
        warn.mock.calls.filter(([, msg]) => String(msg).includes('fallback judge'))
      ).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  describe('on another ChatGPT account (autoMode.fallbackJudgeAccount)', () => {
    beforeEach(() => {
      h.chatgptVault.activeId = 'acct-plus'
      h.chatgptVault.accounts = [
        { id: 'acct-plus', planType: 'plus' },
        { id: 'acct-biz', planType: 'business' }
      ]
    })
    afterEach(() => resetChatgptAccounts())

    /** The active account has no route; the named one resolves to a route named after it. */
    async function activeAccountDown(): Promise<void> {
      const { fakeJudgeRoute } = await import('../../../test/helpers/fake-judge')
      h.resolveRoute = async (_engine, _value, options) =>
        options?.chatgptAccountId
          ? { ok: true, route: fakeJudgeRoute(`model-on-${options.chatgptAccountId}`) }
          : { ok: false, code: 'rate-limited', reason: REASON }
    }

    it('the same model on a different account is a fallback: it resolves on that account, and the banner names its plan', async () => {
      h.engineConfig.autoMode = {
        judgeModel: PRIMARY,
        fallbackJudgeModel: PRIMARY,
        fallbackJudgeAccount: 'acct-biz',
        twoStageMode: 'fast'
      }
      await activeAccountDown()
      h.judge.mockResolvedValue('<block>no</block>')
      session = makeSession({ permissionMode: 'auto' })
      await startTurn()

      h.feed.push(askShell('per_a1'))
      await vi.waitFor(() =>
        expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_a1', { decision: 'once' })
      )

      expect(h.judge.mock.calls.map(([call]) => call.body.model)).toEqual(['model-on-acct-biz'])
      expect(errors()).toEqual([
        `Auto-mode judge unavailable: ${REASON} ${PRIMARY} (Business account) is judging instead ` +
          'until it recovers. Change the judge models in Settings › Sessions & autonomy › ' +
          'Auto-mode judge (opencode).'
      ])
    })

    it('the same model on the ACTIVE account is no fallback (the original banner)', async () => {
      h.engineConfig.autoMode = {
        judgeModel: PRIMARY,
        fallbackJudgeModel: PRIMARY,
        fallbackJudgeAccount: 'acct-plus',
        twoStageMode: 'fast'
      }
      await activeAccountDown()
      session = makeSession({ permissionMode: 'auto' })
      await startTurn()

      h.feed.push(askShell('per_a2'))
      await vi.waitFor(() => expect(payloads('session:approval-request')).toHaveLength(1))

      expect(h.judge).not.toHaveBeenCalled()
      expect(errors()).toEqual([cantJudge(REASON)])
    })
  })

  it('a stale PRIMARY is judged by the fallback, and the banner says so', async () => {
    h.engineConfig.autoMode = {
      judgeModel: 'openai/gone',
      fallbackJudgeModel: FALLBACK,
      twoStageMode: 'fast'
    }
    h.peekModels = catalog(FALLBACK)
    await noRouteFor()
    h.judge.mockResolvedValue('<block>no</block>')
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()

    h.feed.push(askShell('per_f8'))
    await vi.waitFor(() =>
      expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_f8', { decision: 'once' })
    )

    expect(h.judge.mock.calls.map(([call]) => call.body.model)).toEqual([FALLBACK])
    expect(errors()).toEqual([
      'Auto-mode judge model "openai/gone" is no longer available — ' +
        `${FALLBACK} is judging instead. Change the judge models in Settings › Sessions & ` +
        'autonomy › Auto-mode judge (opencode).'
    ])
  })
})

// ─── Recorded 2.0.24 sequences through the PRODUCTION dispatch ──────────────

describe('recorded sequences: what the session emits folds to the cold history', () => {
  interface Recording {
    scenario: string
    sessionID: string
    events: OpencodeEvent[]
    messages: unknown[]
    children: Record<string, unknown[]>
  }
  const DIR = join(__dirname, 'fixtures', 'opencode-v2')
  const recordings: Recording[] = readdirSync(DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Recording)

  /** The session's emitted channels back as the mapper outputs the reducer-like fold reads. */
  function asOutputs(): OpencodeMapperOutput[] {
    const out: OpencodeMapperOutput[] = []
    for (const [channel, , data] of sent) {
      const d = data as Record<string, never>
      switch (channel) {
        case 'session:message':
          out.push({ kind: 'message', message: data as never })
          break
        case 'session:subagent-message':
          out.push({ kind: 'message', message: d.message, ownerToolUseId: d.toolUseId })
          break
        case 'session:item-open':
          out.push({ kind: 'item-open', open: data as never })
          break
        case 'session:item-delta':
          out.push({ kind: 'item-delta', target: d.target, chunk: d.chunk })
          break
        case 'session:item-seal':
          out.push({ kind: 'item-seal', seal: data as never })
          break
        case 'session:tool-result':
          out.push({ kind: 'tool-result', result: data as never })
          break
        case 'session:subagent-tool-result': {
          const { toolUseId, toolResultToolUseId, ...rest } = d
          out.push({
            kind: 'tool-result',
            result: { ...(rest as object), toolUseId: toolResultToolUseId } as never,
            ownerToolUseId: toolUseId
          })
          break
        }
        case 'session:task-notification':
          out.push({ kind: 'task-notification', notification: data as never })
          break
      }
    }
    return out
  }

  it.each(recordings.map((r) => [r.scenario, r] as const))('%s', async (_name, recording) => {
    h.client.createSession.mockImplementation(async () => sessionInfo(recording.sessionID))
    session = makeSession()
    await startTurn('replay')
    sent = []
    h.feed.push(...recording.events.map((e) => ({ kind: 'event', event: e }) as OpencodeFeedItem))
    await flush(80)
    const live = normalizeTranscript(foldOutputs(asOutputs()))
    const cold = normalizeTranscript(
      convertOpencodeHistory(
        recording.messages as never,
        new Map(Object.entries(recording.children)) as never
      )
    )
    expect(live).toEqual(cold)
  })
})

// ─── ChatGPT credentials (ADR-097 §5, S7) ─────────────────────────────────────

describe('the ChatGPT credential gate and recovery', () => {
  afterEach(() => setOpencodeAuthHooks(null))

  it('a turn the gate holds is never sent: an auth notice, the status leaves running, queued items wait', async () => {
    const beforeTurn = vi.fn(async () => 'ChatGPT sign-in could not be refreshed')
    setOpencodeAuthHooks({ beforeTurn, authFailed: vi.fn() })
    session = makeSession()
    h.feed.push(connected())
    const run = session.run('hello')
    session.enqueuePrompt('queued meanwhile')
    await run
    await flush()
    expect(beforeTurn).toHaveBeenCalledWith('openai')
    expect(h.client.prompt).not.toHaveBeenCalled()
    const auth = sent.filter(([channel]) => channel === 'session:auth-required')
    expect(auth).toHaveLength(1)
    expect(JSON.stringify(auth[0])).toContain('ChatGPT sign-in could not be refreshed')
    expect(session.status.state).toBe('idle')
  })

  it('a turn the gate lets go is posted as before', async () => {
    const beforeTurn = vi.fn(async () => null)
    setOpencodeAuthHooks({ beforeTurn, authFailed: vi.fn() })
    session = makeSession()
    await startTurn('go')
    expect(beforeTurn).toHaveBeenCalledWith('openai')
    expect(h.client.prompt.mock.calls.map(([, body]) => body.text)).toEqual(['go'])
  })

  it('a turn that fails provider.auth asks the vault to refresh and rotate', async () => {
    const authFailed = vi.fn()
    setOpencodeAuthHooks({ beforeTurn: async () => null, authFailed })
    session = makeSession()
    await startTurn()
    h.feed.push(
      event('session.execution.started', { sessionID: SID }),
      event('session.execution.failed', {
        sessionID: SID,
        error: { type: 'provider.auth', message: 'Request failed: 401' }
      })
    )
    await flush()
    expect(authFailed).toHaveBeenCalledWith('openai')
    expect(sent.some(([channel]) => channel === 'session:auth-required')).toBe(true)
  })

  it('eager connect discovers on ClaudeUI’s global server, never on the session’s (no project config leak)', async () => {
    const discover = vi.mocked(discoverOpencodeModels)
    discover.mockClear()
    h.client.forDirectory = vi.fn()
    session = makeSession()
    void session.run(null)
    await flush()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(discover.mock.calls[0]).toEqual([])
    expect(h.client.forDirectory).not.toHaveBeenCalled()
  })
})

// ─── The session tools' asks (slice 2) ──────────────────────────────────────

describe('session tool asks (claudeui_session_*)', () => {
  /** An ask for a hosted session tool, with the call's input known to the mapper first (as 2.x publishes it). */
  const sessionAsk = (
    id: string,
    tool: string,
    input: Record<string, unknown> | null,
    sessionID = SID,
    callID = `call_${id}`
  ): OpencodeFeedItem[] => [
    ...(input
      ? [
          event('session.tool.input.started', {
            sessionID,
            assistantMessageID: MSG,
            id: callID,
            name: `claudeui_${tool}`
          }),
          event('session.tool.called', {
            sessionID,
            assistantMessageID: MSG,
            id: callID,
            input,
            executed: false
          })
        ]
      : []),
    event('permission.asked', {
      id,
      sessionID,
      action: `claudeui_${tool}`,
      resources: ['*'],
      save: ['*'],
      metadata: {},
      source: { type: 'tool', messageID: MSG, id: callID }
    })
  ]
  const replies = () => h.client.replyPermission.mock.calls.map(([, id, reply]) => [id, reply])
  const auditRows = (sessionRef: string) =>
    listAuditLog({ limit: 500 }).filter((row) => row.connectionId === `session:${sessionRef}`)

  it('a read the gate allows (session_list) is answered once, silently — no card', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(...sessionAsk('per_l', 'session_list', { scope: 'linked' }))
    await flush()
    expect(replies()).toEqual([['per_l', { decision: 'once' }]])
    expect(payloads('session:approval-request')).toHaveLength(0)
  })

  it('a gate "ask" is a card; the card offers no always-allow, and an allow-for-session click does not stick', async () => {
    h.sessionGate = () => ({ behavior: 'ask' })
    session = makeSession()
    await startTurn()
    h.feed.push(...sessionAsk('per_a', 'session_read', { session: 's-other1' }))
    await flush()
    const cards = payloads('session:approval-request')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      requestId: 'per_a',
      toolName: 'claudeui_session_read',
      input: { session: 's-other1' }
    })
    // Neither a persisted-rule suggestion nor the session-allow key travels with it.
    expect(cards[0]).not.toHaveProperty('suggestions')
    expect(cards[0]).not.toHaveProperty('always')
    session.resolveApproval('per_a', 'allowForSession')
    expect(replies()).toEqual([['per_a', { decision: 'once' }]])
    // The same tool asks again: the click remembered nothing.
    h.feed.push(...sessionAsk('per_b', 'session_read', { session: 's-other1' }))
    await flush()
    expect(payloads('session:approval-request').map((card) => card.requestId)).toEqual([
      'per_a',
      'per_b'
    ])
    expect(replies()).toHaveLength(1)
  })

  it('a deny click rejects with a message, as for any card', async () => {
    h.sessionGate = () => ({ behavior: 'ask' })
    session = makeSession()
    await startTurn()
    h.feed.push(...sessionAsk('per_d', 'session_stop', { session: 's-other1' }))
    await flush()
    session.resolveApproval('per_d', 'deny')
    expect(replies()).toEqual([['per_d', { decision: 'reject', message: expect.any(String) }]])
  })

  it('a gate "deny" rejects with its reason, shows the denial on the call, and audits an acting tool', async () => {
    session = makeSession()
    await startTurn()
    await session.setPermissionMode('plan')
    h.feed.push(...sessionAsk('per_p', 'session_start', { prompt: 'x', background: 'y' }))
    await flush()
    expect(replies()).toEqual([
      [
        'per_p',
        { decision: 'reject', message: expect.stringContaining('not available in plan mode') }
      ]
    ])
    expect(payloads('session:approval-request')).toHaveLength(0)
    expect(payloads('session:permission-denial')).toMatchObject([
      { toolUseId: 'call_per_p', denial: { source: 'rule' } }
    ])
    const rows = auditRows(refFor('opencode', session.routingId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      channel: 'session-tools:session_start',
      outcome: 'error',
      method: 'agent'
    })
  })

  it('a refused READ leaves no audit row (reads are not audited, as in the service)', async () => {
    h.sessionGate = () => ({ behavior: 'deny', message: 'no' })
    session = makeSession()
    await startTurn()
    h.feed.push(...sessionAsk('per_r', 'session_read', { session: 's-x' }))
    await flush()
    expect(replies()).toEqual([['per_r', { decision: 'reject', message: 'no' }]])
    expect(auditRows(refFor('opencode', session.routingId))).toHaveLength(0)
  })

  it("the gate is called as this chat, in its live mode, with the ask's input", async () => {
    const gate = vi.fn(() => ({ behavior: 'allow' }))
    h.sessionGate = gate
    session = makeSession({ permissionMode: 'acceptEdits' })
    await startTurn()
    h.feed.push(...sessionAsk('per_g', 'session_message', { session: 's-a', message: 'hi' }))
    await flush()
    expect(gate).toHaveBeenCalledTimes(1)
    const [caller, tool, input, ctx] = gate.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
      unknown,
      unknown
    ]
    expect(caller).toMatchObject({
      routingId: session.routingId,
      engine: 'opencode',
      cwd: CWD,
      permissionMode: 'acceptEdits'
    })
    expect(tool).toBe('session_message')
    expect(input).toEqual({ session: 's-a', message: 'hi' })
    expect(ctx).toEqual({ agentId: undefined })
  })

  it("an ask that arrives without the call's input (tool part not seen) cannot be scoped: it goes to the user, not to the gate", async () => {
    const gate = vi.fn(() => ({ behavior: 'allow' }))
    h.sessionGate = gate
    session = makeSession()
    await startTurn()
    h.feed.push(...sessionAsk('per_n', 'session_message', null))
    await flush()
    expect(gate).not.toHaveBeenCalled()
    expect(payloads('session:approval-request').map((card) => card.requestId)).toEqual(['per_n'])
    // The card says it could not be scoped, so the user is not approving a blank input.
    expect(payloads('session:approval-request')[0].decisionReason).toMatch(
      /could not see this call.s arguments yet/
    )
    // The two tools the gate allows without looking at a target still go straight through.
    h.feed.push(...sessionAsk('per_u', 'session_usage', null))
    await flush()
    expect(gate).toHaveBeenCalledTimes(1)
    expect(replies()).toEqual([['per_u', { decision: 'once' }]])
    // A scoped ask that goes to the user carries no such caveat.
    h.sessionGate = () => ({ behavior: 'ask' })
    h.feed.push(...sessionAsk('per_s', 'session_message', { session: 's-a', message: 'hi' }))
    await flush()
    const scoped = payloads('session:approval-request').find((card) => card.requestId === 'per_s')
    expect(scoped).toBeDefined()
    expect(scoped).not.toHaveProperty('decisionReason')
  })

  it('a user deny rule written for the Claude spelling holds first, with the rule as the reason', async () => {
    h.permissions.deny = ['mcp__claude-ui-sessions__session_start']
    h.sessionGate = () => {
      throw new Error('the gate must not be asked')
    }
    session = makeSession()
    await startTurn()
    h.feed.push(...sessionAsk('per_x', 'session_start', { prompt: 'x' }))
    await flush()
    expect(replies()).toEqual([
      [
        'per_x',
        { decision: 'reject', message: expect.stringContaining('Denied by permission rule') }
      ]
    ])
    expect(auditRows(refFor('opencode', session.routingId))).toHaveLength(1)
  })

  it('auto mode: the judge is never asked about a session tool (an ask goes to the user, a deny is refused)', async () => {
    h.sessionGate = () => ({ behavior: 'ask' })
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()
    h.feed.push(...sessionAsk('per_j', 'session_get', { session: 's-x' }))
    await flush(60)
    expect(h.judge).not.toHaveBeenCalled()
    expect(payloads('session:approval-request').map((card) => card.requestId)).toEqual(['per_j'])
    expect(payloads('session:tool-review')).toHaveLength(0)
  })

  it("a subagent child's ask reaches the gate as a subagent: an acting tool is refused, whatever the user would say", async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      event('session.created', {
        sessionID: CHILD,
        parentID: SID,
        agent: 'pusher',
        projectID: 'prj',
        location: { directory: CWD },
        slug: CHILD,
        version: '2'
      }),
      event('session.tool.input.started', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sub',
        name: 'subagent'
      }),
      event('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_sub',
        metadata: { sessionID: CHILD }
      })
    )
    await flush()
    h.feed.push(
      ...sessionAsk('per_c', 'session_message', { session: 's-a', message: 'hi' }, CHILD, 'call_c')
    )
    await flush()
    expect(replies()).toEqual([
      [
        'per_c',
        { decision: 'reject', message: expect.stringContaining('main agent, not by a subagent') }
      ]
    ])
    expect(payloads('session:approval-request')).toHaveLength(0)
  })

  it('other asks are untouched: a shell ask still takes the ordinary card path', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      event('permission.asked', {
        id: 'per_sh',
        sessionID: SID,
        action: 'shell',
        resources: ['ls'],
        save: ['ls'],
        metadata: {}
      })
    )
    await flush()
    expect(payloads('session:approval-request')).toMatchObject([
      { requestId: 'per_sh', always: ['ls'] }
    ])
  })
})

describe('the idle timer holds for a running X-Agent (ADR-105 §3)', () => {
  const IDLE_MS = 60_000
  afterEach(() => vi.useRealTimers())

  it('does not auto-disconnect while an X-Agent runs, and does once it has ended and the dispatcher re-arms it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    session = makeSession()
    const endRun = startRunningDispatch('route-1')
    const cancel = vi.spyOn(session, 'cancel').mockImplementation(() => {})
    session.setInactivityTimeout(IDLE_MS)
    // An idle, connected session (the connect itself is covered by the lifecycle suite).
    vi.spyOn(session, 'isEngineLive').mockReturnValue(true)
    await session.run(null)
    await flush()

    vi.advanceTimersByTime(5 * IDLE_MS)
    expect(cancel).not.toHaveBeenCalled()

    endRun()
    session.rearmIdleTimer()
    vi.advanceTimersByTime(IDLE_MS + 1)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

// ─── Auto mode: the judge's context for subagent children, and spawn/websearch/skill asks ──────

describe('auto mode: subagent children are judged with their own context (ADR-088 D1, ADR-091 §4)', () => {
  const MODEL = { providerID: 'openai', id: 'gpt-x' }
  const created = (id: string, parentID: string, agent: string) =>
    event('session.created', {
      sessionID: id,
      parentID,
      agent,
      projectID: 'prj',
      location: { directory: CWD },
      slug: id,
      version: '2'
    })
  const step = (sessionID: string, msg: string, started: number) =>
    event('session.step.started', {
      sessionID,
      assistantMessageID: msg,
      agent: 'build',
      model: MODEL,
      started
    })
  const called = (
    sessionID: string,
    msg: string,
    id: string,
    name: string,
    input: Record<string, unknown>
  ): OpencodeFeedItem[] => [
    event('session.tool.input.started', { sessionID, assistantMessageID: msg, id, name }),
    event('session.tool.called', { sessionID, assistantMessageID: msg, id, input, executed: false })
  ]
  /** `owner`'s step starts the `subagent` call `callId`, which links `childId` (2.x publishes `sessionID` in the progress). */
  const spawn = (
    childId: string,
    callId: string,
    agent: string,
    owner = SID,
    ownerMsg = MSG,
    extra: Record<string, unknown> = {}
  ): OpencodeFeedItem[] => [
    created(childId, owner, agent),
    ...called(owner, ownerMsg, callId, 'subagent', {
      agent,
      description: `task of ${childId}`,
      prompt: `do the ${childId} work`,
      ...extra
    }),
    event('session.tool.progress', {
      sessionID: owner,
      assistantMessageID: ownerMsg,
      id: callId,
      metadata: { sessionID: childId }
    })
  ]
  /** A child step that ran a shell call and settled it (an error, or not). */
  const ran = (
    sessionID: string,
    msg: string,
    callId: string,
    command: string,
    started: number,
    isError = false
  ): OpencodeFeedItem[] => [
    step(sessionID, msg, started),
    ...called(sessionID, msg, callId, 'shell', { command }),
    isError
      ? event('session.tool.failed', {
          sessionID,
          assistantMessageID: msg,
          id: callId,
          error: { type: 'unknown', message: 'boom' },
          executed: true
        })
      : event('session.tool.success', {
          sessionID,
          assistantMessageID: msg,
          id: callId,
          content: [{ type: 'text', text: 'ok' }],
          executed: true
        })
  ]
  /** A shell ask from `sessionID`'s call `callId` (its input known first, as 2.x publishes it). */
  const shellAsk = (
    sessionID: string,
    msg: string,
    reqId: string,
    callId: string,
    command: string,
    started = Date.now()
  ): OpencodeFeedItem[] => [
    ...(sessionID === SID ? [] : [step(sessionID, msg, started)]),
    ...called(sessionID, msg, callId, 'shell', { command }),
    event('permission.asked', {
      id: reqId,
      sessionID,
      action: 'shell',
      resources: [command],
      save: [command],
      metadata: {},
      source: { type: 'tool', messageID: msg, id: callId }
    })
  ]
  const replies = () => h.client.replyPermission.mock.calls.map(([, id, reply]) => [id, reply])
  const rejected = (id: string) =>
    replies().some(
      ([rid, reply]) => rid === id && (reply as { decision: string }).decision === 'reject'
    )
  const judgeUser = (n: number): string => h.judge.mock.calls[n][0].user as string
  /** The judge input of the ask whose command carries `marker`. */
  const judgeAbout = (marker: string): string | undefined =>
    h.judge.mock.calls.map(([call]) => call.user as string).find((u) => u.includes(marker))
  const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
  const cardFor = (id: string) =>
    payloads('session:approval-request').find((a) => a.requestId === id)

  beforeEach(() => {
    h.engineConfig.autoMode = { twoStageMode: 'fast' }
    h.judge.mockResolvedValue('<block>no</block>')
  })

  async function autoTurn(text = 'please tidy the repo'): Promise<void> {
    session = makeSession({ permissionMode: 'auto' })
    await startTurn(text)
    await pause()
  }

  it('a child ask is judged on the parent transcript, its queued user turns and ONLY that child’s trajectory, in time order', async () => {
    await autoTurn()
    h.feed.push(...spawn('ses_a', 'call_a', 'explore'), ...spawn('ses_b', 'call_b', 'explore'))
    await flush()
    h.feed.push(
      ...ran('ses_a', 'msg_a1', 'call_a1', 'git status A-MARK', Date.now()),
      ...ran('ses_b', 'msg_b1', 'call_b1', 'git status B-MARK', Date.now())
    )
    await flush()
    await pause()
    session.enqueuePrompt('also remove dist')
    await flush()
    await pause()
    h.feed.push(...shellAsk('ses_a', 'msg_a2', 'per_a', 'call_a2', 'npm publish A-ASK'))
    await vi.waitFor(() => expect(h.judge).toHaveBeenCalledTimes(1))
    const user = judgeUser(0)
    expect(user).toContain('please tidy the repo')
    expect(user).toContain('A-MARK')
    expect(user).not.toContain('B-MARK')
    expect(user).toContain('also remove dist')
    // Parent prompt, then the child's step, then the prompt typed after it — by timestamp.
    expect(user.indexOf('please tidy the repo')).toBeLessThan(user.indexOf('A-MARK'))
    expect(user.indexOf('A-MARK')).toBeLessThan(user.indexOf('also remove dist'))
    // The header names the acting child and the call that spawned it.
    expect(user).toContain('"explore" subagent')
    expect(user).toContain('do the ses_a work')

    h.feed.push(...shellAsk('ses_b', 'msg_b2', 'per_b', 'call_b2', 'npm publish B-ASK'))
    await vi.waitFor(() => expect(h.judge).toHaveBeenCalledTimes(2))
    expect(judgeUser(1)).toContain('B-MARK')
    expect(judgeUser(1)).not.toContain('A-MARK')
  })

  it('a grandchild is judged without the intermediate child’s trajectory (D1)', async () => {
    await autoTurn()
    h.feed.push(...spawn('ses_a', 'call_a', 'general'))
    await flush()
    h.feed.push(...ran('ses_a', 'msg_a1', 'call_a1', 'git status A-MARK', Date.now()))
    await flush()
    // The child's own spawn (depth >= 2: the user raised experimental.subagent_depth).
    h.feed.push(...spawn('ses_g', 'call_g', 'explore', 'ses_a', 'msg_a1'))
    await flush()
    h.feed.push(...ran('ses_g', 'msg_g1', 'call_g1', 'git status G-MARK', Date.now()))
    await flush()
    h.feed.push(...shellAsk('ses_g', 'msg_g2', 'per_g', 'call_g2', 'npm publish G-ASK'))
    await vi.waitFor(() => expect(h.judge).toHaveBeenCalledTimes(1))
    const user = judgeUser(0)
    expect(user).toContain('please tidy the repo')
    expect(user).toContain('G-MARK')
    expect(user).not.toContain('A-MARK')
    expect(user).toContain('do the ses_g work')
  })

  it('a resumed child keeps its earlier trajectory: the second run’s ask still sees the first run’s calls', async () => {
    await autoTurn()
    h.feed.push(...spawn('ses_a', 'call_a', 'explore'))
    await flush()
    h.feed.push(...ran('ses_a', 'msg_a1', 'call_a1', 'git status RUN1-MARK', Date.now()))
    await flush()
    // A later call resumes the same child session.
    h.feed.push(
      ...called(SID, 'msg_p2', 'call_a_again', 'subagent', {
        agent: 'explore',
        description: 'again',
        prompt: 'continue',
        sessionID: 'ses_a'
      }),
      event('session.tool.progress', {
        sessionID: SID,
        assistantMessageID: 'msg_p2',
        id: 'call_a_again',
        metadata: { sessionID: 'ses_a' }
      })
    )
    await flush()
    h.feed.push(...shellAsk('ses_a', 'msg_a2', 'per_a', 'call_a2', 'npm publish RUN2-ASK'))
    await vi.waitFor(() => expect(h.judge).toHaveBeenCalledTimes(1))
    expect(judgeUser(0)).toContain('RUN1-MARK')
  })

  it('outcomes are per child: its tool results and its own blocks ride under its calls, never the parent’s or a sibling’s', async () => {
    h.shared = { blockHoldSeconds: 0 }
    h.judge.mockResolvedValue('<block>yes</block><reason>no</reason>')
    await autoTurn()
    h.feed.push(...spawn('ses_a', 'call_a', 'explore'), ...spawn('ses_b', 'call_b', 'explore'))
    await flush()
    h.feed.push(...ran('ses_a', 'msg_a1', 'call_a1', 'git status A-MARK', Date.now(), true))
    await flush()
    h.feed.push(...shellAsk('ses_a', 'msg_a2', 'per_a1', 'call_a2', 'npm publish A-BLOCKED'))
    await vi.waitFor(() => expect(rejected('per_a1')).toBe(true))
    h.feed.push(...shellAsk('ses_a', 'msg_a3', 'per_a2', 'call_a3', 'npm publish A-NEXT'))
    // (a block takes two samples: find the call that judged THIS ask)
    await vi.waitFor(() => expect(judgeAbout('A-NEXT')).toBeDefined())
    const second = judgeAbout('A-NEXT') as string
    // The failed result of call_a1 and the block of call_a2 are the child's outcomes.
    expect(second).toMatch(/A-MARK[^\n]*\n\{"outcome":"error"\}/)
    expect(second).toMatch(/A-BLOCKED[^\n]*\n\{"outcome":"automode-blocked"\}/)
    await vi.waitFor(() => expect(rejected('per_a2')).toBe(true))

    h.feed.push(...shellAsk('ses_b', 'msg_b1', 'per_b', 'call_b1', 'npm publish B-ASK'))
    await vi.waitFor(() => expect(judgeAbout('B-ASK')).toBeDefined())
    expect(judgeAbout('B-ASK')).not.toContain('outcome')
  })

  it('the denial caps are per child: a cap tripped in child A leaves child B and the parent alone', async () => {
    h.shared = { blockHoldSeconds: 0 }
    h.judge.mockResolvedValue('<block>yes</block><reason>no</reason>')
    await autoTurn()
    h.feed.push(...spawn('ses_a', 'call_a', 'explore'), ...spawn('ses_b', 'call_b', 'explore'))
    await flush()
    const ask = async (who: string, msg: string, id: string): Promise<void> => {
      h.feed.push(...shellAsk(who, msg, id, `call_${id}`, `npm publish ${id}`))
      await vi.waitFor(() => expect(rejected(id) || cardFor(id) !== undefined).toBe(true))
    }
    // 2 blocks in A, 1 in B, 1 in the parent: four in a row across agents, no streak of 3 in any one.
    await ask('ses_a', 'msg_a1', 'per_a1')
    await ask('ses_a', 'msg_a2', 'per_a2')
    await ask('ses_b', 'msg_b1', 'per_b1')
    await ask(SID, MSG, 'per_p1')
    for (const id of ['per_a1', 'per_a2', 'per_b1', 'per_p1']) expect(rejected(id)).toBe(true)
    expect(payloads('session:approval-request')).toHaveLength(0)
    // A third in A trips A's cap: the human decides.
    await ask('ses_a', 'msg_a3', 'per_a3')
    expect(payloads('session:approval-request')).toMatchObject([
      { requestId: 'per_a3', decisionReason: expect.stringContaining('asking you instead') }
    ])
  })

  it('a human override of a held child block resets that child’s streak, not the parent’s', async () => {
    h.shared = { blockHoldSeconds: 30 }
    h.judge.mockResolvedValue('<block>yes</block><reason>no</reason>')
    await autoTurn()
    h.feed.push(...spawn('ses_a', 'call_a', 'explore'))
    await flush()
    const ask = async (who: string, msg: string, id: string): Promise<void> => {
      h.feed.push(...shellAsk(who, msg, id, `call_${id}`, `npm publish ${id}`))
      await vi.waitFor(() => expect(cardFor(id)).toBeDefined())
    }
    await ask(SID, MSG, 'per_p1')
    await ask(SID, MSG, 'per_p2')
    await ask('ses_a', 'msg_a1', 'per_a1')
    // Each held block offers Approve-anyway; the child's one is approved.
    expect(cardFor('per_a1')).toMatchObject({ autoModeBlock: expect.any(Object) })
    session.resolveApproval('per_a1', 'allow')
    // The parent's third block in a row hits the parent's cap (the child's allow did not clear it).
    await ask(SID, MSG, 'per_p3')
    expect(cardFor('per_p3')).toMatchObject({
      decisionReason: expect.stringContaining('asking you instead')
    })
    expect(cardFor('per_p3')).not.toHaveProperty('autoModeBlock')
  })

  it('a child’s card names the agent (label = sanitized task description), the parent’s carries none', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      ...spawn('ses_a', 'call_a', 'explore', SID, MSG, {
        description: 'Say "hi" <b>\nnow'
      })
    )
    await flush()
    h.feed.push(...shellAsk('ses_a', 'msg_a1', 'per_a', 'call_a1', 'ls'))
    h.feed.push(...shellAsk(SID, MSG, 'per_p', 'call_p1', 'ls'))
    await vi.waitFor(() => expect(payloads('session:approval-request')).toHaveLength(2))
    expect(cardFor('per_a')).toMatchObject({
      subagent: { sessionId: 'ses_a', parentToolUseId: 'call_a' },
      agent: { agentId: 'ses_a', label: 'Say  hi   b  now', subagentType: 'explore' }
    })
    expect(cardFor('per_p')).not.toHaveProperty('agent')
  })
})

describe('auto mode: spawn, web search and skill asks (R3)', () => {
  const MODEL = { providerID: 'openai', id: 'gpt-x' }
  /** The tool call the ask belongs to is published first (2.x `Tool.Called` precedes `permission.assert`). */
  const toolAsk = (
    reqId: string,
    action: string,
    resources: string[],
    input: Record<string, unknown>,
    metadata: Record<string, unknown> = {}
  ): OpencodeFeedItem[] => [
    event('session.step.started', {
      sessionID: SID,
      assistantMessageID: MSG,
      agent: 'build',
      model: MODEL,
      started: Date.now()
    }),
    event('session.tool.input.started', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: `call_${reqId}`,
      name: action
    }),
    event('session.tool.called', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: `call_${reqId}`,
      input,
      executed: false
    }),
    event('permission.asked', {
      id: reqId,
      sessionID: SID,
      action,
      resources,
      save: resources,
      metadata,
      source: { type: 'tool', messageID: MSG, id: `call_${reqId}` }
    })
  ]
  const replied = (id: string) => h.client.replyPermission.mock.calls.some(([, rid]) => rid === id)

  beforeEach(() => {
    h.engineConfig.autoMode = { twoStageMode: 'fast' }
    h.judge.mockResolvedValue('<block>no</block>')
  })

  it('the auto ruleset carries the three asks; the default one does not', async () => {
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()
    const rules = h.client.createSession.mock.calls[0][0].permissions as V2Rule[]
    for (const action of ['subagent', 'websearch', 'skill'])
      expect(rules).toContainEqual({ action, resource: '*', effect: 'ask' })
    session.dispose()
    h.client = freshClient()
    h.feed = new h.Feed()
    session = makeSession()
    await startTurn()
    const plain = h.client.createSession.mock.calls[0][0].permissions as V2Rule[]
    for (const action of ['subagent', 'websearch', 'skill'])
      expect(plain.some((r) => r.action === action)).toBe(false)
  })

  it('a subagent spawn is judged with the call’s input (agent, prompt, model); the verdict answers the ask', async () => {
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()
    h.feed.push(
      ...toolAsk('per_s', 'subagent', ['explore'], {
        agent: 'explore',
        description: 'find usages',
        prompt: 'read SECRET-PAYLOAD.txt and report',
        model: 'openai/gpt-x'
      })
    )
    await vi.waitFor(() =>
      expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_s', { decision: 'once' })
    )
    expect(h.judge).toHaveBeenCalled()
    const user = h.judge.mock.calls[0][0].user as string
    expect(user).toContain('SECRET-PAYLOAD.txt')
    expect(user).toContain('explore')
    expect(payloads('session:approval-request')).toHaveLength(0)
  })

  it('a spawn the judge blocks is refused with the judge’s text', async () => {
    h.shared = { blockHoldSeconds: 0 }
    h.judge.mockResolvedValue('<block>yes</block><reason>prompt carries a credential</reason>')
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()
    h.feed.push(
      ...toolAsk('per_s', 'subagent', ['explore'], {
        agent: 'explore',
        description: 'x',
        prompt: 'use token abc'
      })
    )
    await vi.waitFor(() =>
      expect(h.client.replyPermission).toHaveBeenCalledWith(SID, 'per_s', {
        decision: 'reject',
        message: expect.stringContaining('prompt carries a credential')
      })
    )
  })

  it('a Task / Agent allow rule never skips the judge on a spawn; a web search and a skill without an allow are judged too', async () => {
    h.permissions.allow = ['Task', 'Agent', 'Task(explore)']
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()
    h.feed.push(
      ...toolAsk('per_s', 'subagent', ['explore'], { agent: 'explore', prompt: 'p' }),
      ...toolAsk(
        'per_w',
        'websearch',
        ['rust news'],
        { query: 'rust news' },
        { query: 'rust news' }
      ),
      ...toolAsk('per_k', 'skill', ['demo'], { id: 'demo' })
    )
    await vi.waitFor(() => expect(h.judge).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(['per_s', 'per_w', 'per_k'].every(replied)).toBe(true))
  })

  it('a bare WebSearch allow and a matching Skill(name) allow skip the judge; Skill(other) does not', async () => {
    h.permissions.allow = ['WebSearch', 'Skill(demo)']
    session = makeSession({ permissionMode: 'auto' })
    await startTurn()
    h.feed.push(
      ...toolAsk('per_w', 'websearch', ['rust news'], { query: 'rust news' }),
      ...toolAsk('per_k', 'skill', ['demo'], { id: 'demo' })
    )
    await vi.waitFor(() => expect(['per_w', 'per_k'].every(replied)).toBe(true))
    expect(h.judge).not.toHaveBeenCalled()
    h.feed.push(...toolAsk('per_o', 'skill', ['other'], { id: 'other' }))
    await vi.waitFor(() => expect(replied('per_o')).toBe(true))
    expect(h.judge).toHaveBeenCalledTimes(1)
  })

  it('"allow for session" on a spawn does not exempt the next one from the judge under auto', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(...toolAsk('per_1', 'subagent', ['explore'], { agent: 'explore', prompt: 'a' }))
    await vi.waitFor(() => expect(payloads('session:approval-request')).toHaveLength(1))
    session.resolveApproval('per_1', 'allowForSession')
    // Default mode: the session allow answers the repeat without a card.
    h.feed.push(...toolAsk('per_2', 'subagent', ['explore'], { agent: 'explore', prompt: 'b' }))
    await vi.waitFor(() => expect(replied('per_2')).toBe(true))
    expect(payloads('session:approval-request')).toHaveLength(1)
    expect(h.judge).not.toHaveBeenCalled()
    // Auto mode: the same ask goes to the judge.
    await session.setPermissionMode('auto')
    h.feed.push(...toolAsk('per_3', 'subagent', ['explore'], { agent: 'explore', prompt: 'c' }))
    await vi.waitFor(() => expect(h.judge).toHaveBeenCalledTimes(1))
    expect(h.judge.mock.calls[0][0].user).toContain('"prompt":"c"')
  })

  it('plan mode still refuses the `general` spawn and gates none of the three', async () => {
    session = makeSession()
    await startTurn()
    await session.setPermissionMode('plan')
    const patched = h.client.setSessionPermissions.mock.calls.at(-1)?.[1] as V2Rule[]
    expect(patched).toContainEqual({ action: 'subagent', resource: 'general', effect: 'deny' })
    expect(patched.some((r) => r.action === 'websearch' || r.action === 'skill')).toBe(false)
    expect(patched.some((r) => r.action === 'subagent' && r.effect === 'ask')).toBe(false)
  })
})

// ─── The task lifecycle on the wire, and the idle timer around a background child ──────────────

describe('subagent task lifecycle: events and the idle timer', () => {
  const IDLE_MS = 60_000
  const MODEL = { providerID: 'openai', id: 'gpt-x' }
  afterEach(() => vi.useRealTimers())

  /** The own session's step runs a `subagent` call that links `child`; `background` is the model's own flag. */
  const spawn = (callId: string, child: string, input: Record<string, unknown> = {}) => [
    event('session.created', {
      sessionID: child,
      parentID: SID,
      agent: 'explore',
      projectID: 'prj',
      location: { directory: CWD },
      slug: child,
      version: '2'
    }),
    event('session.tool.input.started', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callId,
      name: 'subagent'
    }),
    event('session.tool.called', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callId,
      input: { agent: 'explore', description: `task ${callId}`, prompt: 'go', ...input },
      executed: false
    }),
    event('session.tool.progress', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callId,
      metadata: { sessionID: child, status: 'running' }
    })
  ]
  const settled = (callId: string, child: string, status: 'running' | 'completed') =>
    event('session.tool.success', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callId,
      content: [
        { type: 'text', text: `<subagent sessionID="${child}" state="${status}">\nok\n</subagent>` }
      ],
      metadata: { sessionID: child, status },
      executed: false
    })
  const ownTurn = () => [
    event('session.execution.started', { sessionID: SID }),
    event('session.step.started', {
      sessionID: SID,
      assistantMessageID: MSG,
      agent: 'build',
      model: MODEL,
      started: clock + 1
    })
  ]
  const ownEnds = () => [
    event('session.step.ended', {
      sessionID: SID,
      assistantMessageID: MSG,
      finish: 'tool-calls',
      cost: 0.01,
      tokens: TOKENS
    }),
    event('session.execution.succeeded', { sessionID: SID })
  ]
  const childRuns = (child: string) => [
    event('session.execution.started', { sessionID: child }),
    event('session.step.started', {
      sessionID: child,
      assistantMessageID: 'msg_c1',
      agent: 'explore',
      model: MODEL,
      started: clock + 1
    }),
    event('session.step.ended', {
      sessionID: child,
      assistantMessageID: 'msg_c1',
      finish: 'stop',
      cost: 0.01,
      tokens: TOKENS
    })
  ]
  const childEnds = (child: string) => event('session.execution.succeeded', { sessionID: child })

  async function idleSession(): Promise<ReturnType<typeof vi.spyOn>> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    session = makeSession()
    const cancel = vi.spyOn(session, 'cancel').mockImplementation(() => {})
    session.setInactivityTimeout(IDLE_MS)
    await startTurn()
    return cancel
  }

  it('sends task-started, task-progress and the notification with the run’s figures', async () => {
    await idleSession()
    h.feed.push(...ownTurn(), ...spawn('call_a', CHILD), ...childRuns(CHILD), childEnds(CHILD))
    h.feed.push(settled('call_a', CHILD, 'completed'), ...ownEnds())
    await flush()
    expect(payloads('session:task-started')).toEqual([
      {
        toolUseId: 'call_a',
        taskId: CHILD,
        taskType: 'local_agent',
        runIndex: 1,
        startedAt: expect.any(Number),
        wakesParent: true,
        description: 'task call_a'
      }
    ])
    expect(payloads('session:task-progress')).toMatchObject([
      {
        toolUseId: 'call_a',
        toolName: 'subagent',
        parentToolUseId: null,
        usage: { totalTokens: 125 }
      }
    ])
    expect(payloads('session:task-notification')).toMatchObject([
      { toolUseId: 'call_a', status: 'completed', runIndex: 1, usage: { totalTokens: 125 } }
    ])
  })

  it('does not auto-disconnect while a background child runs, and does once it has ended', async () => {
    const cancel = await idleSession()
    h.feed.push(
      ...ownTurn(),
      ...spawn('call_a', CHILD, { background: true }),
      settled('call_a', CHILD, 'running'),
      ...ownEnds()
    )
    await flush()
    expect(payloads('session:task-started')).toMatchObject([
      { toolUseId: 'call_a', isBackgrounded: true }
    ])
    // The parent's turn is over; only the child still works.
    vi.advanceTimersByTime(5 * IDLE_MS)
    expect(cancel).not.toHaveBeenCalled()

    h.feed.push(...childRuns(CHILD), childEnds(CHILD))
    await flush()
    expect(payloads('session:task-notification')).toMatchObject([
      { toolUseId: 'call_a', status: 'completed', isBackgrounded: true }
    ])
    // The held timer is armed again by the child's end, and runs its full length.
    vi.advanceTimersByTime(IDLE_MS - 1)
    expect(cancel).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('a foreground child does not hold the timer', async () => {
    const cancel = await idleSession()
    h.feed.push(
      ...ownTurn(),
      ...spawn('call_a', CHILD),
      ...childRuns(CHILD),
      childEnds(CHILD),
      settled('call_a', CHILD, 'completed'),
      ...ownEnds()
    )
    await flush()
    vi.advanceTimersByTime(IDLE_MS + 1)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('a call that turns out backgrounded (moved by another client) holds the timer from then on', async () => {
    const cancel = await idleSession()
    h.feed.push(
      ...ownTurn(),
      ...spawn('call_a', CHILD),
      settled('call_a', CHILD, 'running'),
      ...ownEnds()
    )
    await flush()
    expect(payloads('session:task-started').map((d) => d.isBackgrounded)).toEqual([undefined, true])
    vi.advanceTimersByTime(5 * IDLE_MS)
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('a reopened chat resumes a stored child', () => {
  const OLD = 'ses_old_child'
  const MODEL = { providerID: 'openai', id: 'gpt-x' }
  const storedCall = {
    type: 'tool',
    id: 'call_old',
    name: 'subagent',
    state: {
      status: 'completed',
      input: { agent: 'explore', description: 'first look', prompt: 'look' },
      content: [
        { type: 'text', text: `<subagent sessionID="${OLD}" state="completed">\nseen\n</subagent>` }
      ],
      metadata: { sessionID: OLD, status: 'completed' }
    },
    time: { created: 11, ran: 12, completed: 30 }
  }
  const ownRows = [
    { id: 'msg_u1', type: 'user', text: 'old question', time: { created: 10 } },
    {
      id: 'msg_a0',
      type: 'assistant',
      agent: 'build',
      model: MODEL,
      content: [storedCall],
      cost: 0.01,
      tokens: TOKENS,
      time: { created: 11, completed: 31 }
    },
    { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: 32 } }
  ]
  const childRows = [
    {
      id: 'msg_c0',
      type: 'assistant',
      agent: 'explore',
      model: MODEL,
      content: [
        {
          type: 'tool',
          id: 'call_c0',
          name: 'shell',
          state: {
            status: 'completed',
            input: { command: 'git status OLD-MARK' },
            content: [{ type: 'text', text: 'clean' }],
            metadata: {}
          },
          time: { created: 20, ran: 20, completed: 21 }
        }
      ],
      cost: 0.01,
      tokens: TOKENS,
      time: { created: 20, completed: 25 }
    },
    { id: 'msg_cidle', type: 'idle', outcome: 'succeeded', time: { created: 29 } }
  ]

  async function reopened(): Promise<void> {
    h.client.listMessages.mockImplementation(async (id: string) =>
      id === SID ? ownRows : id === OLD ? childRows : []
    )
    h.engineConfig.autoMode = { twoStageMode: 'fast' }
    h.judge.mockResolvedValue('<block>no</block>')
    session = makeSession({ resumeSessionId: SID, permissionMode: 'auto' })
    h.feed.push(connected())
    await session.run('next')
    await flush()
  }
  const resumeCall = () => [
    event('session.execution.started', { sessionID: SID }),
    event('session.step.started', {
      sessionID: SID,
      assistantMessageID: 'msg_new',
      agent: 'build',
      model: MODEL,
      started: Date.now()
    }),
    event('session.tool.input.started', {
      sessionID: SID,
      assistantMessageID: 'msg_new',
      id: 'call_new',
      name: 'subagent'
    }),
    event('session.tool.called', {
      sessionID: SID,
      assistantMessageID: 'msg_new',
      id: 'call_new',
      input: { agent: 'explore', description: 'second look', prompt: 'again', sessionID: OLD },
      executed: false
    }),
    event('session.tool.progress', {
      sessionID: SID,
      assistantMessageID: 'msg_new',
      id: 'call_new',
      metadata: { sessionID: OLD, status: 'running' }
    })
  ]

  it('the resuming call is the child’s next run', async () => {
    await reopened()
    h.feed.push(...resumeCall())
    await flush()
    expect(payloads('session:task-started')).toMatchObject([
      { toolUseId: 'call_new', taskId: OLD, runIndex: 2, description: 'second look' }
    ])
  })

  it('the resumed child is judged knowing what it did before the reopen', async () => {
    await reopened()
    h.feed.push(
      ...resumeCall(),
      event('session.step.started', {
        sessionID: OLD,
        assistantMessageID: 'msg_c1',
        agent: 'explore',
        model: MODEL,
        started: Date.now()
      }),
      event('session.tool.input.started', {
        sessionID: OLD,
        assistantMessageID: 'msg_c1',
        id: 'call_c1',
        name: 'shell'
      }),
      event('session.tool.called', {
        sessionID: OLD,
        assistantMessageID: 'msg_c1',
        id: 'call_c1',
        input: { command: 'npm publish NEW-ASK' },
        executed: false
      }),
      event('permission.asked', {
        id: 'per_c1',
        sessionID: OLD,
        action: 'shell',
        resources: ['npm publish NEW-ASK'],
        save: ['npm publish NEW-ASK'],
        metadata: {},
        source: { type: 'tool', messageID: 'msg_c1', id: 'call_c1' }
      })
    )
    await vi.waitFor(() => expect(h.judge).toHaveBeenCalled())
    const user = h.judge.mock.calls[0][0].user as string
    expect(user).toContain('NEW-ASK')
    expect(user).toContain('OLD-MARK')
    expect(user.indexOf('OLD-MARK')).toBeLessThan(user.indexOf('NEW-ASK'))
  })
})

describe('a per-subagent Stop (stopTask)', () => {
  const MODEL = { providerID: 'openai', id: 'gpt-x' }
  const GRAND = 'ses_grand'
  const OTHER = 'ses_other'
  const CMSG = 'msg_c1'

  /** A `subagent` call made in `session` (own session unless a child's step message is given). */
  const spawn = (
    callId: string,
    child: string,
    input: Record<string, unknown> = {},
    session = SID,
    msg = MSG
  ) => [
    ...(session === SID
      ? []
      : [
          event('session.step.started', {
            sessionID: session,
            assistantMessageID: msg,
            agent: 'explore',
            model: MODEL,
            started: clock + 1
          })
        ]),
    event('session.created', {
      sessionID: child,
      parentID: session,
      agent: 'explore',
      projectID: 'prj',
      location: { directory: CWD },
      slug: child,
      version: '2'
    }),
    event('session.tool.input.started', {
      sessionID: session,
      assistantMessageID: msg,
      id: callId,
      name: 'subagent'
    }),
    event('session.tool.called', {
      sessionID: session,
      assistantMessageID: msg,
      id: callId,
      input: { agent: 'explore', description: `task ${callId}`, prompt: 'go', ...input },
      executed: false
    }),
    event('session.tool.progress', {
      sessionID: session,
      assistantMessageID: msg,
      id: callId,
      metadata: { sessionID: child, status: 'running' }
    })
  ]
  const running = (sessionID: string) => event('session.execution.started', { sessionID })
  const interrupted = (sessionID: string) =>
    event('session.execution.interrupted', { sessionID, reason: 'user' })
  const ownTurn = () => [
    running(SID),
    event('session.step.started', {
      sessionID: SID,
      assistantMessageID: MSG,
      agent: 'build',
      model: MODEL,
      started: clock + 1
    })
  ]
  const cancelled = (callId: string) =>
    event('session.tool.failed', {
      sessionID: SID,
      assistantMessageID: MSG,
      id: callId,
      error: { type: 'unknown', message: 'Subagent cancelled (sessionID: ses_child)' },
      executed: false
    })
  const interrupts = () => h.client.interrupt.mock.calls.map(([id]) => id)

  /** Live: own turn running, C (call_c) with a background grandchild G, and a sibling O. */
  async function liveTree(): Promise<void> {
    session = makeSession()
    await startTurn()
    h.feed.push(
      ...ownTurn(),
      ...spawn('call_c', CHILD),
      running(CHILD),
      ...spawn('call_o', OTHER),
      running(OTHER),
      ...spawn('call_g', GRAND, { background: true }, CHILD, CMSG),
      running(GRAND)
    )
    await flush()
    h.client.interrupt.mockClear()
  }

  it('interrupts the child and its live descendants (deepest first), never a sibling or the parent', async () => {
    await liveTree()
    const result = await session.stopTask('call_c')
    expect(result).toEqual({ success: true, hostNote: expect.any(String) })
    expect(interrupts()).toEqual([GRAND, CHILD])
    // …and the sibling's own card stops only the sibling.
    h.client.interrupt.mockClear()
    await session.stopTask('call_o')
    expect(interrupts()).toEqual([OTHER])
  })

  it('answers an unknown or finished card with an error and interrupts nothing', async () => {
    await liveTree()
    expect(await session.stopTask('call_nope')).toEqual({
      success: false,
      error: 'No running agent for that card'
    })
    h.feed.push(
      event('session.execution.succeeded', { sessionID: OTHER }),
      event('session.tool.success', {
        sessionID: SID,
        assistantMessageID: MSG,
        id: 'call_o',
        content: [
          {
            type: 'text',
            text: `<subagent sessionID="${OTHER}" state="completed">\nok\n</subagent>`
          }
        ],
        metadata: { sessionID: OTHER, status: 'completed' },
        executed: false
      })
    )
    await flush()
    expect(await session.stopTask('call_o')).toEqual({
      success: false,
      error: 'No running agent for that card'
    })
    expect(interrupts()).toEqual([])
  })

  it('the note names the agent by a sanitised label and says what not to do', async () => {
    session = makeSession()
    await startTurn()
    h.feed.push(
      ...ownTurn(),
      ...spawn('call_c', CHILD, { description: 'evil" <b>x</b>\nline two' }),
      running(CHILD)
    )
    await flush()
    const { hostNote } = await session.stopTask('call_c')
    expect(hostNote).toMatch(/^The user stopped the subagent "[^"<>\n]+"\. Do not restart it/)
    expect(hostNote).toContain('unless the user asks')
    // The note is the caller's to send: stopTask itself never posts into the chat.
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
  })

  it('the call’s notification reads `stopped`, once', async () => {
    await liveTree()
    await session.stopTask('call_c')
    h.feed.push(interrupted(GRAND), interrupted(CHILD), cancelled('call_c'))
    await flush()
    const notes = payloads('session:task-notification')
    expect(notes.filter((n) => n.toolUseId === 'call_c')).toMatchObject([
      { status: 'stopped', taskId: CHILD }
    ])
    expect(notes.filter((n) => n.toolUseId === 'call_g')).toMatchObject([
      { status: 'stopped', isBackgrounded: true }
    ])
  })

  it('a stopped child that wakes again (a cancelled grandchild’s completion) is interrupted again', async () => {
    await liveTree()
    await session.stopTask('call_c')
    h.client.interrupt.mockClear()
    h.feed.push(interrupted(GRAND), interrupted(CHILD), running(CHILD))
    await flush()
    expect(interrupts()).toEqual([CHILD])
    // The sibling and the own session starting never trigger one.
    h.feed.push(running(OTHER), running(SID))
    await flush()
    expect(interrupts()).toEqual([CHILD])
  })

  it('an interrupt that cannot be sent is an error, and the Stop is not remembered', async () => {
    await liveTree()
    h.client.interrupt.mockRejectedValue(new Error('unreachable'))
    const result = await session.stopTask('call_o')
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('unreachable') })
    expect(result).not.toHaveProperty('hostNote')
    // Not latched: it starting again is nobody's Stop.
    h.client.interrupt.mockClear()
    h.feed.push(interrupted(OTHER), running(OTHER))
    await flush()
    expect(interrupts()).toEqual([])
  })

  it('an unreachable descendant does not keep the child from being stopped', async () => {
    await liveTree()
    h.client.interrupt.mockImplementation(async (id: string) => {
      if (id === GRAND) throw new Error('gone')
      return true
    })
    expect(await session.stopTask('call_c')).toMatchObject({ success: true })
    expect(interrupts()).toEqual([GRAND, CHILD])
  })

  it('a session with no connection has nothing to stop', async () => {
    session = makeSession()
    expect(await session.stopTask('call_c')).toEqual({
      success: false,
      error: 'No running agent for that card'
    })
  })

  it('teardown and a parent interrupt stop things, but never tell the model anything', async () => {
    await liveTree()
    const prompts = h.client.prompt.mock.calls.length
    await session.interrupt()
    session.cancel()
    await flush()
    expect(h.client.prompt.mock.calls.length).toBe(prompts)
  })

  it('the capability gate is on, without a `backgroundTask` (R1: no Send to background)', () => {
    session = makeSession()
    expect(session.capabilities.backgroundTasks).toBe(true)
    expect((session as unknown as { backgroundTask?: unknown }).backgroundTask).toBeUndefined()
  })
})
