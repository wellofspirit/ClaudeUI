/**
 * @vitest-environment node
 *
 * Behavioral tests for CodexDeviceCodeFlow (ADR-068 §3, Slice 7) — the port of
 * Codex's `login/src/device_code_auth.rs`.
 *
 * SAFETY: every request here goes through an INJECTED `deps.fetch` against a
 * fake issuer (`https://issuer.test`); nothing in this file can reach
 * auth.openai.com. The clock and the inter-poll sleep are injected too, so the
 * 15-minute cap is exercised in microseconds and no test waits on a real timer.
 * No token in these fixtures resembles a real one.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  CodexDeviceCodeFlow,
  DeviceCodeCancelledError,
  DEVICE_CODE_MAX_WAIT_MS,
  DEVICE_CODE_MIN_INTERVAL_MS,
  DEVICE_CODE_TIMEOUT_MESSAGE,
  DEVICE_CODE_UNSUPPORTED_MESSAGE,
  parsePollIntervalMs
} from '../../../../core/auth/vault/codex-device-code'
import type { OAuthDeps } from '../../../../core/auth/vault/codex-oauth'

const ISSUER = 'https://issuer.test'
const USERCODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`
const TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`
const EXCHANGE_URL = `${ISSUER}/oauth/token`

interface FakeResponse {
  ok: boolean
  status: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

function ok(body: unknown): FakeResponse {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}
function fail(status: number): FakeResponse {
  return { ok: false, status, json: async () => ({}), text: async () => '' }
}

/** One `fetch` double that answers by URL, with a scripted queue for the poll endpoint. */
function makeDeps(options: {
  usercode?: FakeResponse | (() => Promise<FakeResponse>)
  polls?: FakeResponse[]
  exchange?: FakeResponse
}): {
  deps: OAuthDeps
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const polls = [...(options.polls ?? [])]
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, init })
    if (init?.signal?.aborted) throw new Error('The operation was aborted.')
    if (href === USERCODE_URL) {
      const usercode = options.usercode ?? ok({ device_auth_id: 'dev-1', user_code: 'ABCD-1234' })
      return typeof usercode === 'function' ? await usercode() : usercode
    }
    if (href === TOKEN_URL) {
      const next = polls.shift()
      if (!next) throw new Error(`unexpected extra poll (${polls.length} scripted left)`)
      return next
    }
    if (href === EXCHANGE_URL) {
      return (
        options.exchange ??
        ok({ access_token: 'access-x', refresh_token: 'refresh-x', expires_in: 60 })
      )
    }
    throw new Error(`unexpected fetch: ${href}`)
  })
  return { deps: { fetch: fetchFn as unknown as typeof fetch, issuer: ISSUER }, calls }
}

/** A clock the test advances, plus a sleep that advances it instead of waiting. */
function fakeClock(start = 1_000_000): {
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  slept: number[]
} {
  let current = start
  const slept: number[] = []
  return {
    now: () => current,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new DeviceCodeCancelledError()
      slept.push(ms)
      current += ms
    },
    slept
  }
}

function bodyOf(init: RequestInit | undefined): unknown {
  return JSON.parse(String(init?.body ?? '{}'))
}

describe('parsePollIntervalMs', () => {
  it('reads a number, a string, a missing field and 0 — and floors every one at 1 s', () => {
    expect(parsePollIntervalMs(5)).toBe(5000)
    // device_code_auth.rs's `deserialize_interval` parses a JSON STRING.
    expect(parsePollIntervalMs('5')).toBe(5000)
    expect(parsePollIntervalMs(' 7 ')).toBe(7000)
    // `#[serde(default)]` on a missing interval yields 0 in the Rust; honouring
    // that literally would hot-poll the token endpoint for fifteen minutes.
    expect(parsePollIntervalMs(undefined)).toBe(DEVICE_CODE_MIN_INTERVAL_MS)
    expect(parsePollIntervalMs(0)).toBe(DEVICE_CODE_MIN_INTERVAL_MS)
    expect(parsePollIntervalMs('nonsense')).toBe(DEVICE_CODE_MIN_INTERVAL_MS)
  })
})

describe('CodexDeviceCodeFlow.start', () => {
  it('POSTs the usercode request Codex sends and returns only the three display fields', async () => {
    const { deps, calls } = makeDeps({
      usercode: ok({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '4' })
    })
    const clock = fakeClock()
    const flow = new CodexDeviceCodeFlow({ deps, now: clock.now, sleep: clock.sleep })

    const started = await flow.start()

    expect(calls[0].url).toBe(USERCODE_URL)
    expect(calls[0].init?.method).toBe('POST')
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    )
    expect(bodyOf(calls[0].init)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })
    expect(started).toEqual({
      verificationUrl: `${ISSUER}/codex/device`,
      userCode: 'ABCD-1234',
      expiresAt: clock.now() + DEVICE_CODE_MAX_WAIT_MS
    })
    // Never the device_auth_id — the host polls with it and the client cannot see it.
    expect(Object.keys(started).sort()).toEqual(['expiresAt', 'userCode', 'verificationUrl'])
  })

  it('accepts the `usercode` spelling the server also ships', async () => {
    const { deps } = makeDeps({ usercode: ok({ device_auth_id: 'dev-1', usercode: 'WXYZ-9' }) })
    const clock = fakeClock()
    const flow = new CodexDeviceCodeFlow({ deps, now: clock.now, sleep: clock.sleep })
    await expect(flow.start()).resolves.toMatchObject({ userCode: 'WXYZ-9' })
  })

  it('turns a 404 into the "not enabled for this server" message and any other status into a status error', async () => {
    const notFound = makeDeps({ usercode: fail(404) })
    await expect(
      new CodexDeviceCodeFlow({ deps: notFound.deps, sleep: fakeClock().sleep }).start()
    ).rejects.toThrow(DEVICE_CODE_UNSUPPORTED_MESSAGE)

    const boom = makeDeps({ usercode: fail(500) })
    await expect(
      new CodexDeviceCodeFlow({ deps: boom.deps, sleep: fakeClock().sleep }).start()
    ).rejects.toThrow('device code request failed with status 500')
  })
})

describe('CodexDeviceCodeFlow.waitForCompletion', () => {
  it('treats 403 and 404 as "not yet", then exchanges the SERVER verifier against deviceauth/callback', async () => {
    const { deps, calls } = makeDeps({
      usercode: ok({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 3 }),
      polls: [
        fail(403),
        fail(404),
        ok({
          authorization_code: 'auth-code-1',
          code_verifier: 'server-verifier',
          code_challenge: 'server-challenge'
        })
      ],
      exchange: ok({ access_token: 'access-x', refresh_token: 'refresh-x', expires_in: 60 })
    })
    const clock = fakeClock()
    const flow = new CodexDeviceCodeFlow({ deps, now: clock.now, sleep: clock.sleep })

    await flow.start()
    const cred = await flow.waitForCompletion()

    const pollCalls = calls.filter((c) => c.url === TOKEN_URL)
    expect(pollCalls).toHaveLength(3)
    expect(bodyOf(pollCalls[0].init)).toEqual({ device_auth_id: 'dev-1', user_code: 'ABCD-1234' })
    // Two "not yet" answers ⇒ two sleeps of the server-supplied interval.
    expect(clock.slept).toEqual([3000, 3000])

    const exchange = calls.find((c) => c.url === EXCHANGE_URL)
    const params = new URLSearchParams(String(exchange?.init?.body))
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('auth-code-1')
    expect(params.get('redirect_uri')).toBe(`${ISSUER}/deviceauth/callback`)
    expect(params.get('code_verifier')).toBe('server-verifier')

    expect(cred.access).toBe('access-x')
    expect(cred.refresh).toBe('refresh-x')
    expect(cred.expires).toBe(clock.now() + 60_000)
    expect(flow.isSettled()).toBe(true)
  })

  it('fails at once on any other poll status, with the status in the message', async () => {
    const { deps } = makeDeps({ polls: [fail(500)] })
    const clock = fakeClock()
    const flow = new CodexDeviceCodeFlow({ deps, now: clock.now, sleep: clock.sleep })
    await flow.start()
    await expect(flow.waitForCompletion()).rejects.toThrow('device auth failed with status 500')
    expect(clock.slept).toEqual([])
  })

  it('gives up at the 15-minute cap and never sleeps past it', async () => {
    const clock = fakeClock()
    // interval 10 min: one sleep of 10 min, then a second capped to the 5 min left.
    const { deps } = makeDeps({
      usercode: ok({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 600 }),
      polls: [fail(403), fail(403), fail(403)]
    })
    const flow = new CodexDeviceCodeFlow({ deps, now: clock.now, sleep: clock.sleep })
    await flow.start()
    await expect(flow.waitForCompletion()).rejects.toThrow(DEVICE_CODE_TIMEOUT_MESSAGE)
    expect(clock.slept).toEqual([600_000, 300_000])
  })

  it('cancel() during the sleep rejects with the cancellation and never exchanges', async () => {
    let cancel = (): void => {}
    const clock = fakeClock()
    const { deps, calls } = makeDeps({
      polls: [fail(403), ok({ authorization_code: 'c', code_verifier: 'v', code_challenge: 'h' })]
    })
    const flow = new CodexDeviceCodeFlow({
      deps,
      now: clock.now,
      // Cancel from INSIDE the sleep — the exact race the Cancel button creates.
      sleep: async (ms, signal) => {
        cancel()
        return clock.sleep(ms, signal)
      }
    })
    cancel = () => flow.cancel()

    await flow.start()
    await expect(flow.waitForCompletion()).rejects.toBeInstanceOf(DeviceCodeCancelledError)
    expect(calls.some((c) => c.url === EXCHANGE_URL)).toBe(false)
    expect(flow.isSettled()).toBe(true)
  })

  it('cancel() during the poll fetch rejects with the cancellation and never exchanges', async () => {
    const clock = fakeClock()
    const calls: string[] = []
    // A holder, because the fetch double has to reach the flow that owns it.
    const live: { flow?: CodexDeviceCodeFlow } = {}
    const deps: OAuthDeps = {
      issuer: ISSUER,
      fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url)
        calls.push(href)
        if (href === USERCODE_URL) return ok({ device_auth_id: 'dev-1', user_code: 'AB-12' })
        // Abort mid-flight, the way an in-flight request dies when the socket closes.
        live.flow?.cancel()
        if (init?.signal?.aborted) throw new Error('The operation was aborted.')
        return fail(403)
      }) as unknown as typeof fetch
    }
    const flow = new CodexDeviceCodeFlow({ deps, now: clock.now, sleep: clock.sleep })
    live.flow = flow

    await flow.start()
    await expect(flow.waitForCompletion()).rejects.toBeInstanceOf(DeviceCodeCancelledError)
    expect(calls).not.toContain(EXCHANGE_URL)
  })

  it('cancel() settles the wait even when the injected sleep ignores the abort signal', async () => {
    // The vault cancels a live device flow and takes the slot without waiting
    // (AuthVault.claimLoginSlot), so a cancel that did not settle this promise
    // would leave a zombie poller running for the rest of the fifteen minutes.
    const { deps } = makeDeps({ polls: [fail(403)] })
    const flow = new CodexDeviceCodeFlow({
      deps,
      now: () => 1_000_000,
      sleep: () => new Promise<void>(() => {})
    })
    await flow.start()
    const wait = flow.waitForCompletion()
    flow.cancel()
    await expect(wait).rejects.toBeInstanceOf(DeviceCodeCancelledError)
  })

  it('isSettled() is false while the flow is live, so the vault will not supersede it', async () => {
    const { deps } = makeDeps({ polls: [fail(403)] })
    const clock = fakeClock()
    const flow = new CodexDeviceCodeFlow({ deps, now: clock.now, sleep: clock.sleep })
    expect(flow.isSettled()).toBe(false)
    await flow.start()
    expect(flow.isSettled()).toBe(false)
  })
})
