import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpencodeClient } from '../OpencodeClient'

const BASE_URL = 'http://127.0.0.1:9999'
const AUTH = 'Basic dGVzdDp0ZXN0'

function mockFetch(status: number, body: unknown, headers?: Record<string, string>) {
  const responseHeaders = new Headers({
    'Content-Type': 'application/json',
    ...headers,
  })
  return vi.fn().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: responseHeaders,
    })
  )
}

describe('OpencodeClient', () => {
  let client: OpencodeClient

  beforeEach(() => {
    client = new OpencodeClient(BASE_URL, AUTH)
  })

  describe('getConfigProviders', () => {
    it('sends GET /config/providers with auth header', async () => {
      const mock = mockFetch(200, { providers: [], default: {} })
      vi.stubGlobal('fetch', mock)

      const result = await client.getConfigProviders()
      expect(result).toEqual({ providers: [], default: {} })
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/config/providers`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: AUTH }),
        })
      )
    })
  })

  describe('getProviderAuth', () => {
    it('sends GET /provider/auth', async () => {
      const authData = { openai: [{ type: 'api', label: 'API Key' }] }
      const mock = mockFetch(200, authData)
      vi.stubGlobal('fetch', mock)

      const result = await client.getProviderAuth()
      expect(result).toEqual(authData)
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/provider/auth`,
        expect.objectContaining({ method: 'GET' })
      )
    })
  })

  describe('setAuth', () => {
    it('sends PUT /auth/{id} with credentials', async () => {
      const mock = mockFetch(200, true)
      vi.stubGlobal('fetch', mock)

      const credentials = { type: 'api' as const, key: 'sk-abc123' }
      const result = await client.setAuth('openai', credentials)
      expect(result).toBe(true)
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/auth/openai`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(credentials),
        })
      )
    })

    it('encodes provider ID in URL', async () => {
      const mock = mockFetch(200, true)
      vi.stubGlobal('fetch', mock)
      await client.setAuth('github-copilot', { type: 'api', key: 'tok' })
      expect(mock).toHaveBeenCalledWith(`${BASE_URL}/auth/github-copilot`, expect.anything())
    })
  })

  describe('session operations', () => {
    it('createSession sends POST /session', async () => {
      const session = { id: 'ses_1', slug: 'test' }
      const mock = mockFetch(200, session)
      vi.stubGlobal('fetch', mock)

      const result = await client.createSession({ title: 'My Session' })
      expect(result).toEqual(session)
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/session`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'My Session' }),
        })
      )
    })

    it('abortSession sends POST /session/{id}/abort', async () => {
      const mock = mockFetch(200, true)
      vi.stubGlobal('fetch', mock)

      await client.abortSession('ses_abc')
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/session/ses_abc/abort`,
        expect.objectContaining({ method: 'POST' })
      )
    })

    it('deleteSession sends DELETE /session/{id}', async () => {
      const mock = mockFetch(200, true)
      vi.stubGlobal('fetch', mock)

      await client.deleteSession('ses_abc')
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/session/ses_abc`,
        expect.objectContaining({ method: 'DELETE' })
      )
    })

    it('forkSession sends POST /session/{id}/fork', async () => {
      const session = { id: 'ses_2', parentID: 'ses_1' }
      const mock = mockFetch(200, session)
      vi.stubGlobal('fetch', mock)

      const result = await client.forkSession('ses_1', { messageID: 'msg_1' })
      expect(result).toEqual(session)
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/session/ses_1/fork`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ messageID: 'msg_1' }),
        })
      )
    })
  })

  describe('error handling', () => {
    it('throws with status on non-ok response', async () => {
      const mock = mockFetch(401, '')
      vi.stubGlobal('fetch', mock)

      await expect(client.listSessions()).rejects.toThrow('401')
    })

    it('throws on 500 with body in message', async () => {
      const mock = mockFetch(500, 'Internal Server Error')
      vi.stubGlobal('fetch', mock)

      await expect(client.getConfigProviders()).rejects.toThrow('500')
    })
  })

  describe('trailing slash handling', () => {
    it('strips trailing slash from baseUrl', async () => {
      const clientWithSlash = new OpencodeClient(BASE_URL + '/', AUTH)
      const mock = mockFetch(200, [])
      vi.stubGlobal('fetch', mock)

      await clientWithSlash.listSessions()
      expect(mock).toHaveBeenCalledWith(`${BASE_URL}/session`, expect.anything())
    })
  })

  describe('listCommands', () => {
    it('sends GET /command with auth header', async () => {
      const commands = [
        { name: 'init', description: 'Initialize project', template: '/init' },
        { name: 'review', description: 'Code review', template: '/review $ARGUMENTS', subtask: true }
      ]
      const mock = mockFetch(200, commands)
      vi.stubGlobal('fetch', mock)

      const result = await client.listCommands()
      expect(result).toEqual(commands)
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/command`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: AUTH })
        })
      )
    })
  })

  describe('runCommand', () => {
    it('sends POST /session/{id}/command with correct body', async () => {
      const response = { info: { id: 'msg_1', role: 'assistant' }, parts: [] }
      const mock = mockFetch(200, response)
      vi.stubGlobal('fetch', mock)

      const result = await client.runCommand('ses_abc', { command: 'review', arguments: 'pr 42' })
      expect(result).toEqual(response)
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/session/ses_abc/command`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ command: 'review', arguments: 'pr 42' })
        })
      )
    })

    it('encodes session ID in URL', async () => {
      const mock = mockFetch(200, {})
      vi.stubGlobal('fetch', mock)

      await client.runCommand('ses with spaces', { command: 'init', arguments: '' })
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/session/ses%20with%20spaces/command`,
        expect.anything()
      )
    })

    it('throws on 400 BadRequest (unknown command)', async () => {
      const mock = mockFetch(400, 'Available commands: init, review')
      vi.stubGlobal('fetch', mock)

      await expect(client.runCommand('ses_1', { command: 'nonexistent', arguments: '' })).rejects.toThrow('400')
    })
  })

  describe('replyPermission', () => {
    it('sends POST /permission/{id}/reply without message key when none given', async () => {
      const mock = mockFetch(200, {})
      vi.stubGlobal('fetch', mock)

      await client.replyPermission('per_abc', 'once')
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/permission/per_abc/reply`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ reply: 'once' })
        })
      )
    })

    it('includes message in the body on reject with feedback', async () => {
      const mock = mockFetch(200, {})
      vi.stubGlobal('fetch', mock)

      await client.replyPermission('per_abc', 'reject', 'Auto mode blocked: unsafe')
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/permission/per_abc/reply`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ reply: 'reject', message: 'Auto mode blocked: unsafe' })
        })
      )
    })
  })

  describe('replyQuestion', () => {
    it('sends POST /question/{id}/reply with answers body', async () => {
      const mock = mockFetch(200, {})
      vi.stubGlobal('fetch', mock)

      await client.replyQuestion('que_abc', [['Option A'], ['Option B', 'Option C']])
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/question/que_abc/reply`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ answers: [['Option A'], ['Option B', 'Option C']] })
        })
      )
    })

    it('encodes question ID in URL', async () => {
      const mock = mockFetch(200, {})
      vi.stubGlobal('fetch', mock)

      await client.replyQuestion('que/with/slashes', [['yes']])
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/question/que%2Fwith%2Fslashes/reply`,
        expect.anything()
      )
    })
  })

  describe('rejectQuestion', () => {
    it('sends POST /question/{id}/reject with no body', async () => {
      const mock = mockFetch(200, {})
      vi.stubGlobal('fetch', mock)

      await client.rejectQuestion('que_xyz')
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/question/que_xyz/reject`,
        expect.objectContaining({
          method: 'POST',
          body: undefined
        })
      )
    })
  })

  describe('listSkills', () => {
    it('sends GET /skill with auth header', async () => {
      const skills = [
        { name: 'my-skill', description: 'Does something', location: '/home/user/.claude/skills/my-skill/SKILL.md', content: '# My Skill\nContent here.' }
      ]
      const mock = mockFetch(200, skills)
      vi.stubGlobal('fetch', mock)

      const result = await client.listSkills()
      expect(result).toEqual(skills)
      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/skill`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: AUTH })
        })
      )
    })

    it('returns empty array when no skills', async () => {
      const mock = mockFetch(200, [])
      vi.stubGlobal('fetch', mock)

      const result = await client.listSkills()
      expect(result).toEqual([])
    })
  })

  describe('request timeout + abort (M-OC5)', () => {
    /** A fetch that never resolves until its AbortSignal fires (a hung server). */
    function hangingFetch() {
      return vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal as AbortSignal
            const fail = (): void =>
              reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
            if (signal.aborted) return fail()
            signal.addEventListener('abort', fail, { once: true })
          })
      )
    }

    it('times out a hung request and surfaces a clear, actionable error', async () => {
      vi.stubGlobal('fetch', hangingFetch())
      // Pre-fix this promise never settled — the caller hung forever.
      await expect(
        client.prompt('ses_1', { parts: [{ type: 'text', text: 'hi' }] }, { timeoutMs: 20 })
      ).rejects.toThrow(/timed out after 20ms/)
    })

    it('aborts an in-flight request when the caller signal fires (not a timeout)', async () => {
      vi.stubGlobal('fetch', hangingFetch())
      const ac = new AbortController()
      const p = client.prompt(
        'ses_1',
        { parts: [{ type: 'text', text: 'hi' }] },
        { timeoutMs: 0, signal: ac.signal }
      )
      ac.abort()
      // Caller-initiated abort re-throws the AbortError verbatim — NOT the
      // "timed out" wrapper (which is reserved for our own timer).
      await expect(p).rejects.toThrow(/aborted/i)
    })

    it('passes an AbortSignal to fetch on every request', async () => {
      const mock = mockFetch(200, [])
      vi.stubGlobal('fetch', mock)
      await client.listSessions()
      const init = mock.mock.calls[0][1] as RequestInit
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('a fast response resolves normally (timeout never fires)', async () => {
      const mock = mockFetch(200, [{ id: 'ses_1' }])
      vi.stubGlobal('fetch', mock)
      await expect(client.listSessions()).resolves.toEqual([{ id: 'ses_1' }])
    })
  })

  describe('promptAsync — reasoning variant', () => {
    it('includes variant in POST body when present', async () => {
      const mock = mockFetch(200, {})
      vi.stubGlobal('fetch', mock)

      const req = {
        parts: [{ type: 'text' as const, text: 'Hello' }],
        model: { providerID: 'minimax', modelID: 'minimax-01' },
        variant: 'thinking'
      }
      await client.promptAsync('ses_abc', req)

      expect(mock).toHaveBeenCalledWith(
        `${BASE_URL}/session/ses_abc/prompt_async`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(req)
        })
      )
      const body = JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string)
      expect(body).toHaveProperty('variant', 'thinking')
    })

    it('omits variant from POST body when not provided', async () => {
      const mock = mockFetch(200, {})
      vi.stubGlobal('fetch', mock)

      const req = {
        parts: [{ type: 'text' as const, text: 'Hello' }],
        model: { providerID: 'openai', modelID: 'gpt-4o' }
      }
      await client.promptAsync('ses_abc', req)

      const body = JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string)
      expect(body).not.toHaveProperty('variant')
    })
  })
})
