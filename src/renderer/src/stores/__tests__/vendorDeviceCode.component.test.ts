/**
 * The store half of ADR-068 §3 / Slice 7 — device-code sign-in for ChatGPT.
 *
 * `authorizeVendorDeviceCode` is ONE action spanning two IPC calls: the start
 * (which returns display material only and ALSO starts the host-side wait) parks
 * the flow at `stage: 'device-code'` so the panel can render, and then the action
 * POLLS `vendor-auth:device-code-status` until the host has an answer.
 *
 * It has to be a poll. `web/connection.ts` rejects any invoke that outlives
 * `INVOKE_TIMEOUT_MS` (30 s) and a device code lives for fifteen minutes — on the
 * one client that uses this flow — so holding the old `vendor-auth:oauth-callback`
 * open was never going to work, and a dropped socket would have lost the wait
 * even inside thirty seconds. There is a guard below that the device path never
 * touches that verb again.
 *
 * Every test passes `pollIntervalMs: 0`, so the loop is driven by the event loop
 * rather than a timer. Nothing here reaches a real host, and no fixture carries
 * anything token-shaped (the user code is display material by design).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'

vi.mock('electron', async () => await import('../../../../test/stubs/electron-shim'))

const START = {
  verificationUrl: 'https://auth.openai.com/codex/device',
  userCode: 'ABCD-1234',
  expiresAt: 1_700_000_900_000
}

type Status = { state: 'pending' | 'done' | 'error' | 'cancelled'; error?: string }

function stubApi(overrides: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform: 'web',
    vendorAuthDeviceCodeStart: vi.fn(async () => START),
    vendorAuthDeviceCodeStatus: vi.fn(async (): Promise<Status> => ({ state: 'done' })),
    vendorAuthOauthCallback: vi.fn(async () => true),
    vendorAuthOauthCancel: vi.fn(async () => {}),
    listProviderRegistry: vi.fn(async () => ({ entries: [], opencodeInstalled: false })),
    ...overrides
  }
}

/** A status verb that answers each scripted step in turn, then repeats the last. */
function statusScript(...answers: Status[]): Record<string, unknown> {
  const queue = [...answers]
  return {
    vendorAuthDeviceCodeStatus: vi.fn(async () => queue.shift() ?? answers[answers.length - 1])
  }
}

/** Never answers — the flow stays parked so the panel state can be inspected. */
function statusNeverAnswers(): Record<string, unknown> {
  return { vendorAuthDeviceCodeStatus: vi.fn(() => new Promise<Status>(() => {})) }
}

const run = (): Promise<{ ok: boolean; error?: string }> =>
  useSessionStore.getState().authorizeVendorDeviceCode('pi', 'openai-codex', 0)

/** Let the start + the first poll get away. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  useSessionStore.setState({ vendorOAuth: null, vendorAuth: null })
})

describe('authorizeVendorDeviceCode', () => {
  it('parks the flow at stage "device-code" with the three display fields, then polls the host', async () => {
    stubApi(statusNeverAnswers())
    void run()
    await settle()

    expect(window.api.vendorAuthDeviceCodeStart).toHaveBeenCalledWith('pi', 'openai-codex')
    expect(useSessionStore.getState().vendorOAuth).toMatchObject({
      engineId: 'pi',
      vendorId: 'openai-codex',
      stage: 'device-code',
      verificationUrl: START.verificationUrl,
      userCode: START.userCode,
      expiresAt: START.expiresAt
    })
    expect(window.api.vendorAuthDeviceCodeStatus).toHaveBeenCalledWith('pi')
  })

  it('NEVER holds vendor-auth:oauth-callback open — that invoke dies at 30 s on the web (GUARD)', async () => {
    stubApi(statusScript({ state: 'pending' }, { state: 'pending' }, { state: 'done' }))
    await expect(run()).resolves.toEqual({ ok: true })
    expect(window.api.vendorAuthOauthCallback).not.toHaveBeenCalled()
    expect(window.api.vendorAuthDeviceCodeStatus).toHaveBeenCalledTimes(3)
  })

  it('keeps polling while the host says pending, then runs the success tail on done', async () => {
    stubApi(statusScript({ state: 'pending' }, { state: 'done' }))
    await expect(run()).resolves.toEqual({ ok: true })
    expect(useSessionStore.getState().vendorOAuth).toBeNull()
    // The registry re-read is what makes the Slice 6 entry points stop claiming
    // the provider is signed out.
    expect(window.api.listProviderRegistry).toHaveBeenCalled()
  })

  it('a failed start becomes a terminal error card carrying the host message', async () => {
    stubApi({
      vendorAuthDeviceCodeStart: vi.fn(async () => {
        throw new Error('device code login is not enabled for this Codex server.')
      })
    })
    const result = await run()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not enabled for this Codex server/)
    expect(useSessionStore.getState().vendorOAuth).toMatchObject({
      stage: 'error',
      error: expect.stringContaining('not enabled for this Codex server')
    })
    expect(window.api.vendorAuthDeviceCodeStatus).not.toHaveBeenCalled()
  })

  it('an error status becomes a terminal error card carrying the host message', async () => {
    stubApi(
      statusScript(
        { state: 'pending' },
        { state: 'error', error: 'device auth timed out after 15 minutes' }
      )
    )
    await expect(run()).resolves.toEqual({
      ok: false,
      error: 'device auth timed out after 15 minutes'
    })
    expect(useSessionStore.getState().vendorOAuth).toMatchObject({
      stage: 'error',
      error: 'device auth timed out after 15 minutes'
    })
  })

  it('a rejected status POLL becomes a terminal error card', async () => {
    stubApi({
      vendorAuthDeviceCodeStatus: vi.fn(async () => {
        throw new Error('Permission denied')
      })
    })
    await expect(run()).resolves.toEqual({ ok: false, error: 'Permission denied' })
    expect(useSessionStore.getState().vendorOAuth).toMatchObject({ stage: 'error' })
  })

  it('a cancelled status stops the poll silently — the host holds no flow', async () => {
    stubApi(statusScript({ state: 'cancelled' }))
    await expect(run()).resolves.toEqual({ ok: false })
    // No error card: either the user cancelled, or nothing is live to report on.
    expect(useSessionStore.getState().vendorOAuth).toMatchObject({ stage: 'device-code' })
  })

  it('a CANCEL abandons the in-flight poll — a late `done` cannot claim the sign-in', async () => {
    let answer!: (status: Status) => void
    const parked = new Promise<Status>((resolve) => {
      answer = resolve
    })
    stubApi({ vendorAuthDeviceCodeStatus: vi.fn(() => parked) })

    const running = run()
    await settle()

    useSessionStore.getState().cancelVendorOAuth()
    expect(window.api.vendorAuthOauthCancel).toHaveBeenCalledWith('pi')
    expect(useSessionStore.getState().vendorOAuth).toBeNull()

    // The host answers AFTER the cancel — the flow token moved, so this must not
    // resurrect a card over whatever the user is looking at now, nor report a
    // sign-in they abandoned.
    answer({ state: 'done' })
    await expect(running).resolves.toEqual({ ok: false })
    expect(useSessionStore.getState().vendorOAuth).toBeNull()
  })
})
