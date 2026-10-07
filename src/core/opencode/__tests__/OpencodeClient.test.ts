/**
 * @vitest-environment node
 *
 * The opencode 2.x client: request building per operation (path params,
 * query styles, the directory header, auth), response kinds, typed errors,
 * the reject-needs-a-message invariant, timeouts/abort, and cursor paging.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  GENERATE_TIMEOUT_MS,
  OpencodeApiError,
  OpencodeClient,
  OpencodeTimeoutError,
  encodeQuery,
  isOpencodeApiError
} from '../OpencodeClient'
import type { FetchFn } from '../opencode-event-stream'

const BASE = 'http://127.0.0.1:4096'
const AUTH = 'Basic b3BlbmNvZGU6cHc='
const DIR = '/Users/me/My Project/ünï#1'

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A fetch that answers from `reply` and records what was sent. */
function fakeFetch(reply: (sent: Sent, n: number) => Response | Promise<Response>) {
  const sent: Sent[] = []
  const fetchFn = vi.fn<FetchFn>(async (url, init) => {
    const entry: Sent = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        typeof init?.body === 'string'
          ? JSON.parse(init.body)
          : init?.body instanceof Uint8Array
            ? init.body
            : undefined
    }
    sent.push(entry)
    return reply(entry, sent.length - 1)
  })
  return { fetchFn, sent }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const empty = () => new Response(null, { status: 204 })

const session = (id: string) => ({
  id,
  projectID: 'prj',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  location: { directory: DIR }
})

function client(reply: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(reply)
  return {
    ...fake,
    api: new OpencodeClient(
      { baseUrl: BASE + '/', authHeader: AUTH, directory: DIR },
      { fetch: fake.fetchFn }
    )
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('request building', () => {
  it('sends Basic auth and the URI-encoded directory on every request', async () => {
    const { api, sent } = client(() => json({ data: session('ses_1') }))
    await api.getSession('ses_1')
    expect(sent[0].url).toBe(`${BASE}/api/session/ses_1`)
    expect(sent[0].method).toBe('GET')
    expect(sent[0].headers.authorization).toBe(AUTH)
    expect(sent[0].headers['x-opencode-directory']).toBe(encodeURIComponent(DIR))
    // The server decodeURIComponent()s it back (packages/server/src/location.ts).
    expect(decodeURIComponent(sent[0].headers['x-opencode-directory'])).toBe(DIR)
    // A GET carries no body and no content-type.
    expect(sent[0].headers['content-type']).toBeUndefined()
    expect(sent[0].body).toBeUndefined()
  })

  it('a per-call directory and forDirectory() re-target the header', async () => {
    const { api, sent } = client(() => json({ data: session('ses_1') }))
    await api.getSession('ses_1', { directory: '/other' })
    await api.forDirectory('/third dir').getSession('ses_1')
    expect(sent[0].headers['x-opencode-directory']).toBe(encodeURIComponent('/other'))
    expect(sent[1].headers['x-opencode-directory']).toBe(encodeURIComponent('/third dir'))
    expect(sent[1].headers.authorization).toBe(AUTH)
  })

  it('refuses to exist without a directory', () => {
    expect(() => new OpencodeClient({ baseUrl: BASE, authHeader: AUTH, directory: '' })).toThrow(
      /directory is required/
    )
  })

  it('encodes path params and refuses a missing one before sending', async () => {
    const { api, sent, fetchFn } = client(() => empty())
    await api.cancelInbox('ses_a/b', 'msg 1')
    expect(sent[0]).toMatchObject({
      method: 'DELETE',
      url: `${BASE}/api/session/ses_a%2Fb/inbox/msg%201`
    })
    await expect(api.call('session.get', { params: { sessionID: '' } })).rejects.toThrow(
      /missing path param sessionID/
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('encodes queries: scalars, skipped undefined, deepObject objects', () => {
    expect(encodeQuery({ directory: '/a b', parentID: 'null', limit: undefined })).toBe(
      '?directory=%2Fa+b&parentID=null'
    )
    expect(encodeQuery({ location: { directory: '/x', other: null } })).toBe(
      '?location%5Bdirectory%5D=%2Fx'
    )
    expect(encodeQuery({ a: ['1', '2'] })).toBe('?a=1&a=2')
    expect(encodeQuery({})).toBe('')
    expect(encodeQuery(undefined)).toBe('')
  })

  it('createSession locates the session in the client directory unless told otherwise', async () => {
    const { api, sent } = client(() => json({ data: session('ses_new') }))
    const created = await api.createSession({ title: 't', permissions: [] })
    expect(created.id).toBe('ses_new')
    expect(sent[0]).toMatchObject({ method: 'POST', url: `${BASE}/api/session` })
    expect(sent[0].headers['content-type']).toBe('application/json')
    expect(sent[0].body).toEqual({ location: { directory: DIR }, title: 't', permissions: [] })
    await api.createSession({ location: { directory: '/elsewhere' } })
    expect(sent[1].body).toEqual({ location: { directory: '/elsewhere' } })
  })

  it('prompt posts the inbox item with the caller id and delivery, and returns it', async () => {
    const item = {
      id: 'msg_claudeui_1',
      sessionID: 'ses_1',
      time: { created: 1 },
      type: 'user',
      payload: { text: 'hi' },
      delivery: 'queue'
    }
    const { api, sent } = client(() => json({ data: item }))
    const result = await api.prompt('ses_1', {
      id: 'msg_claudeui_1',
      text: 'hi',
      delivery: 'queue'
    })
    expect(result).toEqual(item)
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/api/session/ses_1/prompt`,
      body: { id: 'msg_claudeui_1', text: 'hi', delivery: 'queue' }
    })
  })

  it('inbox delivery, interrupt (with resume), session patch, agent/model switch, rpc', async () => {
    const { api, sent } = client((s) =>
      s.url.includes('/interrupt')
        ? json({ interrupted: true })
        : s.url.includes('/api/rpc/')
          ? json({ output: ['claudeui_echo'] })
          : empty()
    )
    await api.setInboxDelivery('ses_1', 'msg_1', 'steer')
    expect(await api.interrupt('ses_1')).toBe(true)
    await api.interrupt('ses_1', { resume: true })
    await api.setSessionPermissions('ses_1', [{ action: 'shell', resource: '*', effect: 'ask' }])
    await api.renameSession('ses_1', 'New title')
    await api.switchAgent('ses_1', 'plan')
    await api.switchModel('ses_1', { providerID: 'p', id: 'm' })
    expect(await api.rpc('claudeui-xeng', 'tools', {})).toEqual(['claudeui_echo'])
    expect(sent.map((s) => `${s.method} ${s.url.slice(BASE.length)}`)).toEqual([
      'PATCH /api/session/ses_1/inbox/msg_1',
      'POST /api/session/ses_1/interrupt',
      'POST /api/session/ses_1/interrupt?resume=true',
      'PATCH /api/session/ses_1',
      'PATCH /api/session/ses_1',
      'POST /api/session/ses_1/agent',
      'POST /api/session/ses_1/model',
      'POST /api/rpc/claudeui-xeng/tools'
    ])
    expect(sent.map((s) => s.body)).toEqual([
      { delivery: 'steer' },
      undefined,
      undefined,
      { permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] },
      { title: 'New title' },
      { agent: 'plan' },
      { model: { providerID: 'p', id: 'm' } },
      { input: {} }
    ])
  })

  it('credential CRUD + activate and location reload hit the v2 routes', async () => {
    const entry = {
      id: 'cred_claudeui_x_v1',
      integrationID: 'x',
      label: 'claudeui:x',
      active: true,
      value: { type: 'key', key: 'k' }
    }
    const { api, sent } = client((s) =>
      s.method === 'POST' && s.url.endsWith('/api/credential') ? json({ data: entry }) : empty()
    )
    expect(
      await api.createCredential({
        id: 'cred_claudeui_x_v1',
        integrationID: 'x',
        label: 'claudeui:x',
        value: { type: 'key', key: 'k' },
        activate: true
      })
    ).toEqual(entry)
    await api.updateCredentialLabel('cred_claudeui_x_v1', 'renamed')
    await api.activateCredential('cred_claudeui_x_v1')
    await api.removeCredential('cred_claudeui_x_v1')
    await api.reloadLocation()
    expect(sent.map((s) => `${s.method} ${s.url.slice(BASE.length)}`)).toEqual([
      'POST /api/credential',
      'PATCH /api/credential/cred_claudeui_x_v1',
      'POST /api/credential/cred_claudeui_x_v1/activate',
      'DELETE /api/credential/cred_claudeui_x_v1',
      'POST /api/location/reload'
    ])
    expect(sent[1].body).toEqual({ label: 'renamed' })
  })

  it('form reply and cancel (the reason rides as ?message)', async () => {
    const { api, sent } = client(() => empty())
    await api.replyForm('ses_1', 'frm_1', { q0: 'Banana' })
    await api.cancelForm('ses_1', 'frm_1', 'user dismissed')
    expect(sent.map((s) => `${s.method} ${s.url.slice(BASE.length)}`)).toEqual([
      'POST /api/session/ses_1/form/frm_1/reply',
      'DELETE /api/session/ses_1/form/frm_1?message=user+dismissed'
    ])
    expect(sent[0].body).toEqual({ answer: { q0: 'Banana' } })
  })

  it('refuses a form cancel without a non-empty message, before sending anything (review #4c)', () => {
    const { api, fetchFn } = client(() => empty())
    // @ts-expect-error — the type makes the message mandatory
    expect(() => api.cancelForm('ses_1', 'frm_2')).toThrow(/non-empty message/)
    expect(() => api.cancelForm('ses_1', 'frm_2', '   ')).toThrow(/non-empty message/)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('permission replies (ADR-097 §3)', () => {
  it('refuses a reject without a non-empty message, before sending anything', async () => {
    const { api, fetchFn } = client(() => empty())
    // @ts-expect-error — the type makes the message mandatory on reject
    expect(() => api.replyPermission('ses_1', 'per_1', { decision: 'reject' })).toThrow(
      /non-empty message/
    )
    expect(() =>
      api.replyPermission('ses_1', 'per_1', { decision: 'reject', message: '   ' })
    ).toThrow(/non-empty message/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('sends reject with its message, once/always without one', async () => {
    const { api, sent } = client(() => empty())
    await api.replyPermission('ses_1', 'per_1', {
      decision: 'reject',
      message: 'Denied by your rule'
    })
    await api.replyPermission('ses_1', 'per_2', { decision: 'once' })
    await api.replyPermission('ses_1', 'per_3', { decision: 'always', message: '' })
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: `${BASE}/api/session/ses_1/permission/per_1/reply`,
      body: { decision: 'reject', message: 'Denied by your rule' }
    })
    expect(sent[1].body).toEqual({ decision: 'once' })
    expect(sent[2].body).toEqual({ decision: 'always' })
  })
})

describe('responses', () => {
  it('unwraps data envelopes; empty answers are undefined', async () => {
    const agents = [
      { id: 'build', name: 'build', mode: 'primary', hidden: false, request: {}, permissions: [] }
    ]
    const { api } = client((s) =>
      s.url.endsWith('/api/agent')
        ? json({ location: { directory: DIR }, data: agents })
        : s.url.endsWith('/api/integration')
          ? json({ location: { directory: DIR }, data: [] })
          : empty()
    )
    expect(await api.agents()).toEqual(agents)
    await expect(api.deleteSession('ses_1')).resolves.toBeUndefined()
  })

  it('reads binary answers as bytes', async () => {
    const { api } = client(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    const bytes = await api.call('fs.read', {})
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect([...bytes]).toEqual([1, 2, 3])
  })

  it('a 2xx that is not JSON where JSON is expected is an error', async () => {
    const { api } = client(() => new Response('<html>', { status: 200 }))
    await expect(api.getSession('ses_1')).rejects.toThrow(/session.get: response is not JSON/)
  })

  it('generate returns the text', async () => {
    const { api, sent } = client(() => json({ data: { text: 'short answer' } }))
    expect(await api.generate('ses_1', 'why?')).toBe('short answer')
    expect(sent[0]).toMatchObject({
      url: `${BASE}/api/session/ses_1/generate`,
      body: { prompt: 'why?' }
    })
  })
})

describe('errors', () => {
  it('a tagged error body becomes a typed OpencodeApiError', async () => {
    const { api } = client(() =>
      json(
        { _tag: 'SessionNotFoundError', sessionID: 'ses_x', message: 'Session not found: ses_x' },
        404
      )
    )
    const err = await api.getSession('ses_x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OpencodeApiError)
    if (!isOpencodeApiError(err, 'session.get')) throw new Error('not an api error')
    expect(err.status).toBe(404)
    expect(err.tag).toBe('SessionNotFoundError')
    expect(err.message).toBe(
      'opencode session.get (GET /api/session/{sessionID}) → 404 SessionNotFoundError: Session not found: ses_x'
    )
    expect(err.is('SessionNotFoundError')).toBe(true)
    if (err.is('SessionNotFoundError')) expect(err.error.sessionID).toBe('ses_x')
    expect(err.is('InvalidRequestError')).toBe(false)
    expect(isOpencodeApiError(err, 'session.list')).toBe(false)
  })

  it('an inbox id owned by another session is a 409 ConflictError', async () => {
    const { api } = client(() =>
      json(
        { _tag: 'ConflictError', message: 'Prompt message ID conflicts', resource: 'msg_1' },
        409
      )
    )
    const err = await api.prompt('ses_1', { id: 'msg_1', text: 'x' }).catch((e: unknown) => e)
    expect(isOpencodeApiError(err, 'session.prompt') && err.is('ConflictError')).toBe(true)
  })

  it('an untagged body (plain-text 404) keeps the body and has no typed error', async () => {
    const { api } = client(() => new Response('Not Found', { status: 404 }))
    const err = (await api.getSession('ses_1').catch((e: unknown) => e)) as OpencodeApiError
    expect(err.tag).toBeUndefined()
    expect(err.error).toBeUndefined()
    expect(err.body).toBe('Not Found')
    expect(err.message).toContain('→ 404: Not Found')
  })
})

describe('timeouts and abort', () => {
  /** A fetch that only ever settles by its signal aborting. */
  const hanging: FetchFn = (_url, init) =>
    new Promise((_, reject) =>
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      )
    )

  it('times out control-plane calls with OpencodeTimeoutError', async () => {
    const api = new OpencodeClient(
      { baseUrl: BASE, authHeader: AUTH, directory: DIR },
      { fetch: hanging }
    )
    const err = await api.getSession('ses_1', { timeoutMs: 20 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OpencodeTimeoutError)
    expect(err).toMatchObject({ operation: 'session.get', timeoutMs: 20 })
  })

  it('uses 60 s by default and 240 s (under undici’s 300 s headersTimeout) for generate', async () => {
    vi.useFakeTimers()
    const api = new OpencodeClient(
      { baseUrl: BASE, authHeader: AUTH, directory: DIR },
      { fetch: hanging }
    )
    const control = api.getSession('ses_1').catch((e: unknown) => e)
    const gen = api.generate('ses_1', 'q').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(await control).toBeInstanceOf(OpencodeTimeoutError)
    let settled = false
    void gen.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(GENERATE_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await gen).toMatchObject({
      operation: 'session.generate',
      timeoutMs: GENERATE_TIMEOUT_MS
    })
    expect(GENERATE_TIMEOUT_MS).toBeLessThan(300_000)
  })

  it('a caller abort propagates as the abort, not a timeout', async () => {
    const api = new OpencodeClient(
      { baseUrl: BASE, authHeader: AUTH, directory: DIR },
      { fetch: hanging }
    )
    const ac = new AbortController()
    const pending = api.listInbox('ses_1', { signal: ac.signal }).catch((e: unknown) => e)
    ac.abort()
    const err = await pending
    expect(err).not.toBeInstanceOf(OpencodeTimeoutError)
    expect((err as Error).name).toBe('AbortError')
  })

  it('an already-aborted signal never reaches the server', async () => {
    const fetchFn = vi.fn<FetchFn>(hanging)
    const api = new OpencodeClient(
      { baseUrl: BASE, authHeader: AUTH, directory: DIR },
      { fetch: fetchFn }
    )
    const ac = new AbortController()
    ac.abort()
    await expect(api.listInbox('ses_1', { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('cold-location barrier', () => {
  const catalog = () => json({ location: { directory: DIR }, data: [] }, 200)

  it('waits for plugin activation (integration.list) before the first catalog read, once per directory', async () => {
    const { api, sent } = client(catalog)
    await api.agents()
    await api.skills()
    await api.models()
    await api.skills({ directory: '/other' })
    expect(
      sent.map(
        (s) =>
          `${new URL(s.url).pathname} @${decodeURIComponent(s.headers['x-opencode-directory'])}`
      )
    ).toEqual([
      `/api/integration @${DIR}`,
      `/api/agent @${DIR}`,
      `/api/skill @${DIR}`,
      `/api/model @${DIR}`,
      '/api/integration @/other',
      '/api/skill @/other'
    ])
  })

  it('takes the barrier again after a location reload', async () => {
    const { api, sent } = client((s) => (s.url.endsWith('/reload') ? empty() : catalog()))
    await api.commands()
    await api.reloadLocation()
    await api.commands()
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual([
      '/api/integration',
      '/api/command',
      '/api/location/reload',
      '/api/integration',
      '/api/command'
    ])
  })

  it('does not memoize a failed barrier', async () => {
    let failFirst = true
    const { api, sent } = client((s) => {
      if (s.url.endsWith('/api/integration') && failFirst) {
        failFirst = false
        return json({ _tag: 'UnknownError', message: 'boom' }, 500)
      }
      return catalog()
    })
    await expect(api.providers()).rejects.toBeInstanceOf(OpencodeApiError)
    await api.providers()
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual([
      '/api/integration',
      '/api/integration',
      '/api/provider'
    ])
  })
})

describe('paging', () => {
  it('listMessages reads oldest-first and follows cursors, re-sending the type filter', async () => {
    const page = (ids: string[], next: string | null) =>
      json({ data: ids.map((id) => ({ id, type: 'assistant' })), cursor: { previous: null, next } })
    const full = Array.from({ length: 200 }, (_, i) => `msg_${i}`)
    const { api, sent } = client((_, n) => (n === 0 ? page(full, 'c1') : page(['msg_200'], 'c2')))
    const all = await api.listMessages('ses_1', { type: 'assistant' })
    expect(all).toHaveLength(201)
    const queries = sent.map((s) => new URL(s.url).searchParams)
    expect(Object.fromEntries(queries[0])).toEqual({
      type: 'assistant',
      order: 'asc',
      limit: '200'
    })
    expect(Object.fromEntries(queries[1])).toEqual({
      type: 'assistant',
      cursor: 'c1',
      limit: '200'
    })
    // A short page is the end, even though the server sent a next cursor.
    expect(sent).toHaveLength(2)
  })

  it('listRootSessions filters by directory and roots only, and stops on a null cursor', async () => {
    const { api, sent } = client(() => json({ data: [session('ses_1')], cursor: { next: null } }))
    expect((await api.listRootSessions()).map((s) => s.id)).toEqual(['ses_1'])
    expect(Object.fromEntries(new URL(sent[0].url).searchParams)).toEqual({
      directory: DIR,
      parentID: 'null',
      limit: '200'
    })
  })
})
