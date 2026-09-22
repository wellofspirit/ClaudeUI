/**
 * @vitest-environment node
 *
 * ADR-068 §3, Slice 7 — `vendor-auth:device-code-start` and `:device-code-status`.
 *
 * The channel is declared ONCE, in `core/ipc/auth-commands.ts`, and both
 * transports spread that declaration; `remote-handlers.ipc.test.ts` pins the
 * reachability half and `web/__tests__/api-adapter.test.ts` the web client's
 * wiring. What THIS file pins is the registration: its capability/kind pair, its
 * refusal on an engine that cannot drive the flow, and — the security half —
 * that the results carry EXACTLY the display fields — never the `device_auth_id`
 * the host polls with, and never anything token-shaped.
 *
 * The pair exists because the WAIT cannot be one long invoke: `web/connection.ts`
 * rejects any invoke that outlives `INVOKE_TIMEOUT_MS` (30 s) and a device code
 * lives for fifteen minutes, on the one client that uses this flow.
 *
 * Nothing here touches a real vault, a real engine or the network: the provider
 * is a stub and the auth family's other singletons are mocked out, exactly as
 * `provider-registry-ipc.test.ts` does.
 */

import { describe, it, expect, vi } from 'vitest'
import type { EngineAuthProvider } from '../../../core/auth/EngineAuthProvider'

vi.mock('../../../core/shared-providers', () => ({ sharedProviderService: {} }))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { authCommands, type AuthCommandDeps } from '../../../core/ipc/auth-commands'

const CHANNEL = 'vendor-auth:device-code-start'
const STATUS_CHANNEL = 'vendor-auth:device-code-status'

function build(provider: Partial<EngineAuthProvider>): ReturnType<typeof authCommands> {
  return authCommands({
    requireEngineAuth: (engineId) => {
      if (engineId === 'claude') return { probe: vi.fn() } as unknown as EngineAuthProvider
      return { probe: vi.fn(), ...provider } as unknown as EngineAuthProvider
    },
    setAccountEnabled: () => {
      throw new Error('not used')
    }
  } as unknown as AuthCommandDeps)
}

function handlerFor(
  commands: ReturnType<typeof authCommands>,
  channel = CHANNEL
): (engineId: string, vendorId?: string) => Promise<unknown> {
  const found = commands.find((c) => c.channel === channel)
  if (!found) throw new Error(`no registration for ${channel}`)
  return found.handler as (engineId: string, vendorId?: string) => Promise<unknown>
}

describe('vendor-auth:device-code-start', () => {
  it('is declared exactly once, as a `config` command', () => {
    const commands = build({})
    expect(commands.filter((c) => c.channel === CHANNEL)).toHaveLength(1)
    expect(commands.find((c) => c.channel === CHANNEL)).toMatchObject({
      capability: 'config',
      kind: 'command'
    })
  })

  it('returns EXACTLY the three display fields — no device_auth_id, no token', async () => {
    const deviceCodeStart = vi.fn(async () => ({
      verificationUrl: 'https://issuer.test/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: 1_700_000_000_000,
      // A field the flow object could grow: it must NOT reach the client.
      deviceAuthId: 'dev-secret-1'
    }))
    const handler = handlerFor(build({ deviceCodeStart } as Partial<EngineAuthProvider>))

    const result = (await handler('pi', 'openai-codex')) as {
      ok: boolean
      data: Record<string, unknown>
    }

    expect(deviceCodeStart).toHaveBeenCalledWith('openai-codex')
    expect(result.ok).toBe(true)
    expect(Object.keys(result.data).sort()).toEqual(['expiresAt', 'userCode', 'verificationUrl'])
    expect(JSON.stringify(result.data)).not.toContain('dev-secret-1')
  })

  it('refuses an engine that does not drive the flow, inside the safeHandler envelope', async () => {
    const handler = handlerFor(build({}))
    await expect(handler('claude', 'anthropic')).resolves.toEqual({
      ok: false,
      error: 'Engine "claude" does not support deviceCodeStart'
    })
  })

  it('carries the provider own refusal back verbatim', async () => {
    const deviceCodeStart = vi.fn(async () => {
      throw new Error(
        "PiAuthProvider.deviceCodeStart: only 'openai-codex' is driven; got 'anthropic'"
      )
    })
    const handler = handlerFor(build({ deviceCodeStart } as Partial<EngineAuthProvider>))
    await expect(handler('pi', 'anthropic')).resolves.toEqual({
      ok: false,
      error: "PiAuthProvider.deviceCodeStart: only 'openai-codex' is driven; got 'anthropic'"
    })
  })
})

describe('vendor-auth:device-code-status', () => {
  it('is declared exactly once, as a `config` QUERY — the wait is polled, not held open', () => {
    const commands = build({})
    expect(commands.filter((c) => c.channel === STATUS_CHANNEL)).toHaveLength(1)
    expect(commands.find((c) => c.channel === STATUS_CHANNEL)).toMatchObject({
      capability: 'config',
      kind: 'query'
    })
  })

  it('carries the state and, on a failure, the host message — and nothing else', async () => {
    const deviceCodeStatus = vi.fn(async () => ({
      state: 'error' as const,
      error: 'device auth timed out after 15 minutes',
      // Fields the holder carries that must NOT reach the client.
      startedAt: 1,
      expiresAt: 2
    }))
    const handler = handlerFor(build({ deviceCodeStatus } as never), STATUS_CHANNEL)
    const result = (await handler('pi')) as { ok: boolean; data: Record<string, unknown> }
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({
      state: 'error',
      error: 'device auth timed out after 15 minutes'
    })
  })

  it('a non-error state carries no message field at all', async () => {
    const deviceCodeStatus = vi.fn(async () => ({ state: 'pending' as const }))
    const handler = handlerFor(build({ deviceCodeStatus } as never), STATUS_CHANNEL)
    const result = (await handler('pi')) as { ok: boolean; data: Record<string, unknown> }
    expect(Object.keys(result.data)).toEqual(['state'])
  })

  it('refuses an engine that does not drive the flow', async () => {
    const handler = handlerFor(build({}), STATUS_CHANNEL)
    await expect(handler('claude')).resolves.toEqual({
      ok: false,
      error: 'Engine "claude" does not support deviceCodeStart'
    })
  })
})
