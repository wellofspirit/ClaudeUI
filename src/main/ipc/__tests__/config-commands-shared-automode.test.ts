/**
 * @vitest-environment node
 *
 * ADR-065 phase 4 — `config:load-shared-automode` / `config:save-shared-automode`.
 *
 * Both are `config`, so an ordinary authenticated remote connection reaches
 * them (`remote-channel-parity.test.ts` pins that half). What THIS file pins is
 * the payload perimeter: the save writes a file that is fed verbatim into the
 * judge's prompt on the next session, and a malformed one is not a crash — it is
 * a silently mis-specified classifier environment. There is no id in the path,
 * so shape validation is the only guard there is.
 *
 * The service is mocked: this asserts the perimeter, exactly as the traversal
 * cases in `remote-handlers.ipc.test.ts` do. `ui-config.ts`'s own behaviour
 * (union, absent-key-for-empty) is covered in
 * `core/services/__tests__/ui-config-shared-automode.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const uiConfigMocks = vi.hoisted(() => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({})),
  saveEngineConfig: vi.fn(),
  loadVendorConfig: vi.fn(() => ({})),
  saveVendorConfig: vi.fn(),
  loadSharedAutoModeConfig: vi.fn(() => ({ trustedDomains: ['files.acme.com'] })),
  saveSharedAutoModeConfig: vi.fn()
}))
vi.mock('../../../core/services/ui-config', () => uiConfigMocks)

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { configCommands } from '../../../core/ipc/config-commands'
import type { SessionManager } from '../../../core/services/session-manager'

const commands = configCommands({} as unknown as SessionManager)

function commandFor(channel: string): (typeof commands)[number] {
  const found = commands.find((c) => c.channel === channel)
  if (!found) throw new Error(`no registration for ${channel}`)
  return found
}

/** Invoke a registration's handler with the given payload. */
function invoke(channel: string, ...args: unknown[]): unknown {
  return (commandFor(channel).handler as (...a: unknown[]) => unknown)(...args)
}

beforeEach(() => {
  uiConfigMocks.saveSharedAutoModeConfig.mockClear()
  uiConfigMocks.loadSharedAutoModeConfig.mockClear()
})

describe('config:load-shared-automode', () => {
  it('is a `config` query and answers the service verbatim', () => {
    expect(commandFor('config:load-shared-automode')).toMatchObject({
      capability: 'config',
      kind: 'query'
    })
    expect(invoke('config:load-shared-automode')).toEqual({ trustedDomains: ['files.acme.com'] })
  })
})

describe('config:save-shared-automode', () => {
  it('is a `config` command', () => {
    expect(commandFor('config:save-shared-automode')).toMatchObject({
      capability: 'config',
      kind: 'command'
    })
  })

  it('accepts the three optional string arrays, in any subset', () => {
    invoke('config:save-shared-automode', {})
    invoke('config:save-shared-automode', { trustedDomains: ['files.acme.com'] })
    invoke('config:save-shared-automode', {
      trustedDomains: ['files.acme.com'],
      trustedRegistries: ['https://npm.acme.internal'],
      protectedPatterns: ['acme-live-*']
    })
    expect(uiConfigMocks.saveSharedAutoModeConfig).toHaveBeenCalledTimes(3)
  })

  it('refuses a non-array list', () => {
    expect(() =>
      invoke('config:save-shared-automode', { trustedDomains: 'files.acme.com' })
    ).toThrow(/must be an array of strings/)
    expect(uiConfigMocks.saveSharedAutoModeConfig).not.toHaveBeenCalled()
  })

  it('refuses an empty or untrimmed entry', () => {
    for (const bad of ['', '   ', ' files.acme.com', 'files.acme.com ']) {
      expect(
        () => invoke('config:save-shared-automode', { trustedRegistries: [bad] }),
        JSON.stringify(bad)
      ).toThrow(/non-empty trimmed strings/)
    }
    expect(uiConfigMocks.saveSharedAutoModeConfig).not.toHaveBeenCalled()
  })

  it('refuses a non-string entry', () => {
    expect(() => invoke('config:save-shared-automode', { protectedPatterns: ['ok', 42] })).toThrow(
      /non-empty trimmed strings/
    )
    expect(uiConfigMocks.saveSharedAutoModeConfig).not.toHaveBeenCalled()
  })

  it('refuses a payload that is not a plain object', () => {
    for (const bad of [null, undefined, 'nope', 7, ['trustedDomains']]) {
      expect(() => invoke('config:save-shared-automode', bad), JSON.stringify(bad)).toThrow(
        /expected an object/
      )
    }
    expect(uiConfigMocks.saveSharedAutoModeConfig).not.toHaveBeenCalled()
  })

  it('refuses an unknown key rather than writing it into the judge environment', () => {
    expect(() =>
      invoke('config:save-shared-automode', { trustedDomains: [], enabled: false })
    ).toThrow(/unknown key "enabled"/)
    expect(uiConfigMocks.saveSharedAutoModeConfig).not.toHaveBeenCalled()
  })
})
