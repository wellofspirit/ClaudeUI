/**
 * @vitest-environment node
 *
 * The token keeper (claude-host-token.ts): Claude Desktop 2.9939.2's contract
 * for a host-owned OAuth token, against real credential FIXTURES in a temp
 * directory and a mocked `fetch`. No real credential or home directory is
 * reachable, no request leaves the process, and every token string below is
 * invented.
 *
 * Timers are faked (setTimeout / clearTimeout / Date only) so the renewal
 * timing can be stepped; file I/O stays real, and `until` waits on it with the
 * real setImmediate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  ClaudeHostTokenKeeper,
  hostTokenLogin,
  renewalDueIn,
  RENEW_AHEAD_MS,
  RENEW_FLOOR_MS,
  RENEW_MAX_DELAY_MS,
  RENEW_RETRY_MS
} from '../claude-host-token'
import {
  fetchClaudeUsage,
  refreshClaudeToken,
  resetClaudeRefreshMemo,
  type OAuthCredentials
} from '../claude-usage-api'
import { claudeRefreshGuard } from '../claude-refresh-guard'
import { setSecurestorageEnv } from '../../sdk/securestorage-env'
import { setEndpointEnv } from '../../sdk/endpoint-env'
import { HostTokenUnavailableError, type HostTokenSession } from '../../sdk/host-token'
import { query } from '../../sdk/query'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.UTC(2026, 8, 27, 12, 0, 0)

let root: string
let dirA: string
let dirB: string
let fetchMock: ReturnType<typeof vi.fn>
let keeper: ClaudeHostTokenKeeper

const fileOf = (dir: string): string => join(dir, '.credentials.json')

async function writeCreds(
  dir: string,
  over: Partial<OAuthCredentials> & { expiresAt: number }
): Promise<void> {
  await writeFile(
    fileOf(dir),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fake-access-1',
        refreshToken: 'fake-refresh-1',
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
        ...over
      }
    }),
    'utf-8'
  )
}

async function storedToken(dir: string): Promise<string> {
  return JSON.parse(await readFile(fileOf(dir), 'utf-8')).claudeAiOauth.accessToken
}

function ok(body: Record<string, unknown>): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function status(code: number): Response {
  return { ok: false, status: code, json: async () => ({}) } as unknown as Response
}

/** The refresh endpoint's answer, rotating to `n`. */
function rotated(n: number, expiresIn = 8 * 60 * 60): Response {
  return ok({
    access_token: `fake-access-${n}`,
    refresh_token: `fake-refresh-${n}`,
    expires_in: expiresIn
  })
}

const refreshPosts = (): unknown[] =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('oauth/token'))

/**
 * Wait for real file I/O to land. Bounded by REAL time (`performance.now` is
 * not faked), not by a turn count: under a loaded full-suite run the thread
 * pool can take far more event-loop turns than usual.
 */
async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  const deadline = performance.now() + 4_000
  while (performance.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
  if (!cond()) throw new Error(`${what} never held`)
}

function session(
  dir: string,
  token = 'fake-access-1'
): HostTokenSession & {
  push: ReturnType<typeof vi.fn>
} {
  return { dir, token, push: vi.fn(async () => true) }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(T0)
  root = await mkdtemp(join(tmpdir(), 'claudeui-host-token-'))
  dirA = join(root, 'acct-a')
  dirB = join(root, 'acct-b')
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  claudeRefreshGuard.reset()
  resetClaudeRefreshMemo()
  setEndpointEnv(null)
  setSecurestorageEnv({ dir: dirA })
  keeper = new ClaudeHostTokenKeeper()
  keeper.start()
})

afterEach(async () => {
  keeper.stop()
  setSecurestorageEnv(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // A rotation's write-back (temp file + rename) may still be landing.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ---------------------------------------------------------------------------

describe('renewalDueIn', () => {
  it('renews five minutes ahead of a long-lived token', () => {
    expect(renewalDueIn(T0 + HOUR, T0, null)).toBe(HOUR - RENEW_AHEAD_MS)
  })

  it('renews at half the remaining life of a short one', () => {
    expect(renewalDueIn(T0 + 4 * MIN, T0, null)).toBe(2 * MIN)
  })

  it('is never sooner than 60 s after the last token write', () => {
    expect(renewalDueIn(T0 + 90_000, T0, T0)).toBe(RENEW_FLOOR_MS)
  })

  it('is due now for an expired token', () => {
    expect(renewalDueIn(T0 - MIN, T0, null)).toBe(0)
  })
})

describe('the renewal timer', () => {
  it('refreshes the token in use at expiresAt − 5 min, and pushes the new one', async () => {
    await writeCreds(dirA, { expiresAt: T0 + HOUR })
    fetchMock.mockResolvedValue(rotated(2))
    const live = session(dirA)
    keeper.attach(live)
    await until(() => vi.getTimerCount() === 1, 'timer armed')

    vi.advanceTimersByTime(HOUR - RENEW_AHEAD_MS - 1)
    await Promise.resolve()
    expect(refreshPosts()).toHaveLength(0)

    vi.advanceTimersByTime(1)
    await until(() => live.push.mock.calls.length === 1, 'push')
    expect(refreshPosts()).toHaveLength(1)
    expect(live.push).toHaveBeenCalledWith('fake-access-2')
    expect(await storedToken(dirA)).toBe('fake-access-2')
    await until(() => live.token === 'fake-access-2', 'token recorded')
  })

  it('renews a four-minute token after two minutes', async () => {
    await writeCreds(dirA, { expiresAt: T0 + 4 * MIN })
    fetchMock.mockResolvedValue(rotated(2))
    keeper.attach(session(dirA))
    await until(() => vi.getTimerCount() === 1, 'timer armed')

    vi.advanceTimersByTime(2 * MIN - 1)
    await Promise.resolve()
    expect(refreshPosts()).toHaveLength(0)
    vi.advanceTimersByTime(1)
    await until(() => refreshPosts().length === 1, 'refresh')
  })

  it('caps the timer at 6 h and re-arms when the cap fires first', async () => {
    await writeCreds(dirA, { expiresAt: T0 + 8 * HOUR })
    fetchMock.mockResolvedValue(rotated(2))
    keeper.attach(session(dirA))
    await until(() => vi.getTimerCount() === 1, 'timer armed')

    vi.advanceTimersByTime(RENEW_MAX_DELAY_MS)
    // The capped timer fired: it re-reads the file and re-arms, spending nothing.
    await until(() => vi.getTimerCount() === 1, 're-armed')
    expect(refreshPosts()).toHaveLength(0)

    vi.advanceTimersByTime(8 * HOUR - RENEW_AHEAD_MS - RENEW_MAX_DELAY_MS)
    await until(() => refreshPosts().length === 1, 'refresh')
  })

  it('waits 60 s after a rotation before renewing a short-lived new token', async () => {
    await writeCreds(dirA, { expiresAt: T0 + HOUR })
    const live = session(dirA)
    keeper.attach(live)
    await until(() => vi.getTimerCount() === 1, 'timer armed')

    // Someone else (the usage fetcher, say) rotates to a 90-second token.
    fetchMock.mockResolvedValueOnce(rotated(2, 90))
    const creds = JSON.parse(await readFile(fileOf(dirA), 'utf-8')).claudeAiOauth
    await refreshClaudeToken(creds, fileOf(dirA))
    await until(() => live.token === 'fake-access-2', 'pushed')

    fetchMock.mockResolvedValueOnce(rotated(3))
    vi.advanceTimersByTime(RENEW_FLOOR_MS - 1)
    await Promise.resolve()
    expect(refreshPosts()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    await until(() => refreshPosts().length === 2, 'renewal after the floor')
  })

  it('retries a failed renewal after 60 s, and stops on a refusal', async () => {
    await writeCreds(dirA, { expiresAt: T0 + 10 * MIN })
    keeper.attach(session(dirA))
    await until(() => vi.getTimerCount() === 1, 'timer armed')

    fetchMock.mockResolvedValueOnce(status(503))
    vi.advanceTimersByTime(5 * MIN)
    await until(() => refreshPosts().length === 1 && vi.getTimerCount() === 1, 'retry armed')

    fetchMock.mockResolvedValueOnce(status(400))
    vi.advanceTimersByTime(RENEW_RETRY_MS)
    await until(() => refreshPosts().length === 2, 'retry')
    await until(() => vi.getTimerCount() === 0, 'timer stopped')
    // ADR-071 §6: the refusal marks the account needing a sign-in.
    expect(hostTokenLogin()).toEqual({ signedIn: false, subscriptionType: 'max' })
  })

  it('stops when the last session on the account goes', async () => {
    await writeCreds(dirA, { expiresAt: T0 + HOUR })
    const detach = keeper.attach(session(dirA))
    await until(() => vi.getTimerCount() === 1, 'timer armed')
    detach()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('answering oauth_token_refresh', () => {
  it('fences a session spawned for another account: identity_changed', async () => {
    await writeCreds(dirB, { expiresAt: T0 - MIN })
    const stale = session(dirB)
    await expect(keeper.answerRefresh(stale)).resolves.toEqual({
      accessToken: null,
      reason: 'identity_changed'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers signed_out when the account has no credential', async () => {
    await expect(keeper.answerRefresh(session(dirA))).resolves.toEqual({
      accessToken: null,
      reason: 'signed_out'
    })
  })

  it('returns a token someone else already rotated, spending nothing', async () => {
    await writeCreds(dirA, { accessToken: 'fake-access-2', expiresAt: T0 + HOUR })
    const live = session(dirA, 'fake-access-1')
    await expect(keeper.answerRefresh(live)).resolves.toEqual({ accessToken: 'fake-access-2' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(live.token).toBe('fake-access-2')
  })

  it('refreshes the token the session holds, and records the new one', async () => {
    await writeCreds(dirA, { expiresAt: T0 + HOUR })
    fetchMock.mockResolvedValueOnce(rotated(2))
    const live = session(dirA)
    await expect(keeper.answerRefresh(live)).resolves.toEqual({ accessToken: 'fake-access-2' })
    expect(live.token).toBe('fake-access-2')
    expect(await storedToken(dirA)).toBe('fake-access-2')
    // The session got its token in the answer; it is not pushed the same one.
    expect(live.push).not.toHaveBeenCalled()
  })

  it('answers refresh_failed on a refusal, and does not offer the grant again', async () => {
    await writeCreds(dirA, { expiresAt: T0 + HOUR })
    fetchMock.mockResolvedValue(status(400))
    const live = session(dirA)
    await expect(keeper.answerRefresh(live)).resolves.toEqual({
      accessToken: null,
      reason: 'refresh_failed'
    })
    await expect(keeper.answerRefresh(live)).resolves.toEqual({
      accessToken: null,
      reason: 'refresh_failed'
    })
    expect(refreshPosts()).toHaveLength(1)
  })

  it('answers transient on a 5xx or a dropped connection, and may try again', async () => {
    await writeCreds(dirA, { expiresAt: T0 + HOUR })
    fetchMock.mockResolvedValueOnce(status(503)).mockRejectedValueOnce(new Error('ECONNRESET'))
    const live = session(dirA)
    await expect(keeper.answerRefresh(live)).resolves.toEqual({
      accessToken: null,
      reason: 'transient'
    })
    await expect(keeper.answerRefresh(live)).resolves.toEqual({
      accessToken: null,
      reason: 'transient'
    })
    expect(refreshPosts()).toHaveLength(2)
    expect(hostTokenLogin()?.signedIn).toBe(true)
  })

  it('spends ONE grant for four requests: three concurrent, one straggling', async () => {
    // The orchestrator's probe: an invalid token at spawn drew four
    // oauth_token_refresh requests (parallel startup calls plus a retry).
    await writeCreds(dirA, { expiresAt: T0 + HOUR })
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    fetchMock.mockImplementation(async () => {
      await gate
      return rotated(2)
    })
    const live = session(dirA)

    const concurrent = [
      keeper.answerRefresh(live),
      keeper.answerRefresh(live),
      keeper.answerRefresh(live)
    ]
    release()
    const answers = await Promise.all(concurrent)
    const straggler = await keeper.answerRefresh(live)

    expect(refreshPosts()).toHaveLength(1)
    for (const answer of [...answers, straggler]) {
      expect(answer).toEqual({ accessToken: 'fake-access-2' })
    }
  })

  it('refreshes again once the straggler window has passed', async () => {
    await writeCreds(dirA, { expiresAt: T0 + HOUR })
    fetchMock.mockResolvedValueOnce(rotated(2)).mockResolvedValueOnce(rotated(3))
    const live = session(dirA)
    await keeper.answerRefresh(live)

    vi.advanceTimersByTime(RENEW_FLOOR_MS)
    await expect(keeper.answerRefresh(live)).resolves.toEqual({ accessToken: 'fake-access-3' })
    expect(refreshPosts()).toHaveLength(2)
  })
})

describe('ensureFresh (before a spawn)', () => {
  it('spends nothing on a token good for more than five minutes', async () => {
    await writeCreds(dirA, { expiresAt: T0 + RENEW_AHEAD_MS + 1 })
    await keeper.ensureFresh()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes a token that expires within five minutes', async () => {
    await writeCreds(dirA, { expiresAt: T0 + RENEW_AHEAD_MS })
    fetchMock.mockResolvedValueOnce(rotated(2))
    await keeper.ensureFresh()
    expect(await storedToken(dirA)).toBe('fake-access-2')
  })

  it('refuses the spawn when the account has no credential', async () => {
    await expect(keeper.ensureFresh()).rejects.toMatchObject({
      name: 'HostTokenUnavailableError',
      reason: 'signed-out'
    })
  })

  it('refuses the spawn when an expired token is refused a refresh', async () => {
    await writeCreds(dirA, { expiresAt: T0 - MIN })
    fetchMock.mockResolvedValue(status(401))
    await expect(keeper.ensureFresh()).rejects.toMatchObject({ reason: 'needs-sign-in' })
    // …and does not ask again for the same version of the file.
    await expect(keeper.ensureFresh()).rejects.toBeInstanceOf(HostTokenUnavailableError)
    expect(refreshPosts()).toHaveLength(1)
  })

  it('refuses the spawn when an expired token cannot be renewed right now', async () => {
    await writeCreds(dirA, { expiresAt: T0 - MIN })
    fetchMock.mockResolvedValue(status(503))
    await expect(keeper.ensureFresh()).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('lets a still-valid token carry the spawn when the renewal fails', async () => {
    await writeCreds(dirA, { expiresAt: T0 + 2 * MIN })
    fetchMock.mockResolvedValue(status(503))
    await expect(keeper.ensureFresh()).resolves.toBeUndefined()
  })

  it('does nothing under an endpoint profile or in single-account mode', async () => {
    setEndpointEnv({ ANTHROPIC_BASE_URL: 'https://gateway.invalid', ANTHROPIC_AUTH_TOKEN: 'x' })
    await expect(keeper.ensureFresh()).resolves.toBeUndefined()
    setEndpointEnv(null)
    setSecurestorageEnv(null)
    await expect(keeper.ensureFresh()).resolves.toBeUndefined()
  })
})

describe('hostTokenLogin', () => {
  it('is null when spawns carry no host token', () => {
    setSecurestorageEnv(null)
    expect(hostTokenLogin()).toBeNull()
  })

  it('reads the account signed in from its own credential', async () => {
    await writeCreds(dirA, { expiresAt: T0 - MIN })
    // An expired token is still a sign-in: the next spawn renews it.
    expect(hostTokenLogin()).toEqual({ signedIn: true, subscriptionType: 'max' })
  })

  it('reads a missing credential as signed out', () => {
    expect(hostTokenLogin()).toEqual({ signedIn: false, subscriptionType: null })
  })
})

// ---------------------------------------------------------------------------
// Through query(), with a fake cli.js child: the exact frames on the wire.
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
  written: Array<Record<string, unknown>> = []

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) this.written.push(JSON.parse(line))
      }
    })
  }

  frames(type: string): Array<Record<string, unknown>> {
    return this.written.filter((line) => line.type === type)
  }

  send(line: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(line) + '\n')
  }

  close(): void {
    this.emit('exit', 0, null)
    this.stdout.end()
    this.emit('close', 0, null)
  }
}

describe('a live session on the host token', () => {
  const children: FakeChild[] = []

  function spawn(): FakeChild {
    const child = new FakeChild()
    children.push(child)
    const handle = query({
      prompt: 'hi',
      options: { spawnClaudeCodeProcess: () => child as never }
    })
    void (async () => {
      for await (const _ of handle) void _
    })().catch(() => {})
    return child
  }

  afterEach(() => {
    for (const child of children.splice(0)) child.close()
  })

  it('is pushed the token a USAGE READ rotated, as the exact Desktop frame', async () => {
    await writeCreds(dirA, { expiresAt: T0 + 30_000 })
    const child = spawn()

    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('oauth/token')
        ? rotated(2)
        : ok({ five_hour: { utilization: 1, resets_at: null } })
    )
    const read = await fetchClaudeUsage({
      credentialsPath: fileOf(dirA),
      allowRefresh: true,
      userAgent: 'claude-code/test'
    })
    expect('usage' in read).toBe(true)

    await until(() => child.frames('update_environment_variables').length === 1, 'push frame')
    const [frame] = child.frames('update_environment_variables')
    expect(frame).toEqual({
      type: 'update_environment_variables',
      variables: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-access-2' },
      request_id: expect.any(String)
    })
    // cli.js acknowledges it the way 2.1.280's processLine does.
    child.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: frame.request_id }
    })
  })

  it('answers cli.js’s oauth_token_refresh on the wire by default', async () => {
    await writeCreds(dirA, { expiresAt: T0 + HOUR })
    fetchMock.mockResolvedValueOnce(rotated(2))
    const child = spawn()

    child.send({
      type: 'control_request',
      request_id: 'refresh-1',
      request: { subtype: 'oauth_token_refresh' }
    })

    await until(
      () =>
        child
          .frames('control_response')
          .some((l) => (l.response as { request_id?: string }).request_id === 'refresh-1'),
      'refresh answer'
    )
    const answer = child
      .frames('control_response')
      .find((l) => (l.response as { request_id?: string }).request_id === 'refresh-1')
    expect(answer).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'refresh-1',
        response: { accessToken: 'fake-access-2' }
      }
    })
  })

  it('stops pushing to a session once the account is switched away', async () => {
    await writeCreds(dirA, { expiresAt: T0 + HOUR })
    await writeCreds(dirB, { expiresAt: T0 + HOUR })
    const child = spawn()

    setSecurestorageEnv({ dir: dirB })
    fetchMock.mockResolvedValueOnce(rotated(2)).mockResolvedValueOnce(rotated(3))
    const credsA = JSON.parse(await readFile(fileOf(dirA), 'utf-8')).claudeAiOauth
    const credsB = JSON.parse(await readFile(fileOf(dirB), 'utf-8')).claudeAiOauth
    await refreshClaudeToken(credsA, fileOf(dirA))
    await refreshClaudeToken(credsB, fileOf(dirB))
    // Rotation pushes are synchronous with the rotation; give a stray one a
    // chance to reach the pipe before asserting there is none.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))

    expect(child.frames('update_environment_variables')).toHaveLength(0)

    // And its own refresh request is fenced.
    child.send({
      type: 'control_request',
      request_id: 'refresh-2',
      request: { subtype: 'oauth_token_refresh' }
    })
    await until(() => child.frames('control_response').length > 0, 'fenced answer')
    expect(child.frames('control_response')[0]).toMatchObject({
      response: {
        request_id: 'refresh-2',
        response: { accessToken: null, reason: 'identity_changed' }
      }
    })
  })

  it('refuses to spawn at all when the active account has no credential', () => {
    expect(() => spawn()).toThrow(HostTokenUnavailableError)
  })
})
