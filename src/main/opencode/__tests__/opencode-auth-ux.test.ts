/**
 * @vitest-environment node
 *
 * Unit tests for Feature #7 (native auto OAuth) and Feature #2 (structured 401 card):
 *   - OpencodeClient.oauthCallback optional code parameter
 *   - event-mapper session.error → auth-required vs error routing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpencodeClient } from '../OpencodeClient'
import { mapEvent, type MessageAccumulator } from '../event-mapper'
import type { OpencodeEvent } from '../protocol/types'

const BASE_URL = 'http://127.0.0.1:9999'
const AUTH = 'Basic dGVzdDp0ZXN0'
const SESSION_ID = 'ses_test123'
const START_TIME = Date.now()

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: new Headers({ 'Content-Type': 'application/json' })
    })
  )
}

function makeEvent(type: string, properties: Record<string, unknown>): OpencodeEvent {
  return { id: 'evt_1', type, properties }
}

function callMapEvent(event: OpencodeEvent): ReturnType<typeof mapEvent> {
  return mapEvent(
    event,
    SESSION_ID,
    new Map<string, MessageAccumulator>(),
    START_TIME,
    { value: 0 },
    new Map()
  )
}

// ── OpencodeClient.oauthCallback ──────────────────────────────────────────────

describe('OpencodeClient.oauthCallback', () => {
  let client: OpencodeClient

  beforeEach(() => {
    client = new OpencodeClient(BASE_URL, AUTH)
  })

  it('auto flow: omits code from POST body when code is undefined', async () => {
    const mock = mockFetch(200, true)
    vi.stubGlobal('fetch', mock)

    await client.oauthCallback('openai', 0)

    const [, init] = mock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toHaveProperty('method', 0)
    expect(body).not.toHaveProperty('code')
  })

  it('paste flow: includes code in POST body when code is provided', async () => {
    const mock = mockFetch(200, true)
    vi.stubGlobal('fetch', mock)

    await client.oauthCallback('openai', 1, 'ABC123')

    const [, init] = mock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toHaveProperty('method', 1)
    expect(body).toHaveProperty('code', 'ABC123')
  })

  it('auto flow: calls correct URL', async () => {
    const mock = mockFetch(200, true)
    vi.stubGlobal('fetch', mock)

    await client.oauthCallback('my-vendor', 2)

    const [url] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE_URL}/provider/my-vendor/oauth/callback`)
  })
})

// ── event-mapper: session.error routing ──────────────────────────────────────

describe('event-mapper: session.error → auth-required or error', () => {
  it('ProviderAuthError with providerID → {kind:"auth-required", vendorId, message}', () => {
    const ev = makeEvent('session.error', {
      sessionID: SESSION_ID,
      error: {
        name: 'ProviderAuthError',
        data: { providerID: 'openai', message: 'Token expired' }
      }
    })
    const out = callMapEvent(ev)
    expect(out.kind).toBe('auth-required')
    if (out.kind === 'auth-required') {
      expect(out.vendorId).toBe('openai')
      expect(out.message).toBe('Token expired')
    }
  })

  it('ProviderAuthError with providerID uses default message when data.message absent', () => {
    const ev = makeEvent('session.error', {
      sessionID: SESSION_ID,
      error: {
        name: 'ProviderAuthError',
        data: { providerID: 'anthropic' }
      }
    })
    const out = callMapEvent(ev)
    expect(out.kind).toBe('auth-required')
    if (out.kind === 'auth-required') {
      expect(out.vendorId).toBe('anthropic')
      expect(out.message).toBe('Authentication required')
    }
  })

  it('ProviderAuthError WITHOUT providerID → {kind:"error"} generic hint fallback', () => {
    const ev = makeEvent('session.error', {
      sessionID: SESSION_ID,
      error: {
        name: 'ProviderAuthError',
        data: { message: 'No provider' }
      }
    })
    const out = callMapEvent(ev)
    expect(out.kind).toBe('error')
    if (out.kind === 'error') {
      expect(out.message).toContain('Authentication required')
    }
  })

  it('non-auth error → {kind:"error"} unchanged', () => {
    const ev = makeEvent('session.error', {
      sessionID: SESSION_ID,
      error: {
        name: 'UnknownError',
        data: { message: 'Something went wrong' }
      }
    })
    const out = callMapEvent(ev)
    expect(out.kind).toBe('error')
    if (out.kind === 'error') {
      expect(out.message).toBe('Something went wrong')
    }
  })

  it('session.error with empty error object → {kind:"error"} with fallback message', () => {
    const ev = makeEvent('session.error', {
      sessionID: SESSION_ID,
      error: {}
    })
    const out = callMapEvent(ev)
    expect(out.kind).toBe('error')
    if (out.kind === 'error') {
      expect(out.message).toBe('An error occurred')
    }
  })
})
