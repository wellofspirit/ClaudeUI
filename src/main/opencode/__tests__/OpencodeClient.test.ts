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
})
