/**
 * @vitest-environment node
 *
 * The opencode 2.x session (ADR-093 S5) against a fake 2.x client and a
 * scripted event feed: lifecycle, the inbox-backed queue, approvals (every
 * reject and form cancel carries a message), subagent child rulesets and their
 * backstop, interrupt, reconnect, usage. The mapper, the permission compiler,
 * the host pre-check and the judge pipeline are REAL — only the wire and the
 * host's settings/auth/discovery are doubles.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    judge: vi.fn()
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
  peekOpencodeModels: () => null,
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
vi.mock('../../services/block-usage', () => ({
  blockUsageService: { recalculate: vi.fn().mockResolvedValue(undefined) }
}))
// The judge is ClaudeUI's own HTTP call (ADR-081), mocked at its boundaries
// only: `h.judge` plays the judge MODEL (see test/helpers/fake-judge).
vi.mock('../../automode/judge-route', async () => {
  const { fakeJudgeRoute } = await import('../../../test/helpers/fake-judge')
  return { resolveJudgeRoute: async () => ({ ok: true, route: fakeJudgeRoute() }) }
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
import { OpencodePermissionGuardError } from '../OpencodeServerManager'
import { OpencodeApiError } from '../OpencodeClient'
import { buildSessionRuleset, THROWAWAY_RULESET } from '../permission-v2'
import { childSessionRuleset } from '../subagent-permissions'
import { PLAN_MODE_DENY_REASON_NO_EXIT_TOOL } from '../../pi/permission-engine'
import type { OpencodeMapperOutput } from '../v2-event-mapper'
import { convertOpencodeHistory } from '../v2-history'

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
})

afterEach(() => {
  session?.dispose()
  clearSyncSubscribersForTests()
  // ADR-093 §3 / review #4c: whatever a test did, nothing went out without a message.
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
      worktree: '/repo'
    })
    expect(body).toEqual({
      agent: 'build',
      model: { providerID: 'openai', id: 'gpt-x' },
      permissions: expected.rules
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

// ─── Queue = the native inbox (ADR-093 §9) ──────────────────────────────────

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
