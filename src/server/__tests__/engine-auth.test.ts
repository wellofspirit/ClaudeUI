/**
 * @vitest-environment node
 *
 * Which engines the headless server will drive a sign-in for (ADR-068 §3,
 * Slice 7 review).
 *
 * The bug this pins: the server refused `requireEngineAuth` for EVERY engine but
 * `codex`, so `vendor-auth:device-code-start('pi', 'openai-codex')` — the whole
 * point of Slice 7, and the flow ADR-068 §3 reserved for exactly this
 * deployment — was refused before the device code was even requested. A
 * hermetic-server drive caught it: the dialog showed "Requesting a code…" and
 * then the refusal.
 *
 * The two providers are stubbed. Importing the real ones here would pull the
 * vault, the credential sync and both engine adapters into a unit test that only
 * needs to know WHICH object comes back, and `CodexAuthProvider` starts timers on
 * construction.
 */
import { describe, it, expect, vi } from 'vitest'

const providers = vi.hoisted(() => ({
  codex: { probe: vi.fn(), __id: 'codex' },
  pi: { probe: vi.fn(), __id: 'pi' }
}))
vi.mock('../../core/auth/CodexAuthProvider', () => ({ codexAuthProvider: providers.codex }))
vi.mock('../../core/auth/PiAuthProvider', () => ({ piAuthProvider: providers.pi }))

import { requireServerEngineAuth, DESKTOP_ONLY_SIGN_IN_MESSAGE } from '../engine-auth'

describe('requireServerEngineAuth', () => {
  it('drives pi — the ChatGPT vault is shared and device code was built for this box (GUARD)', () => {
    expect(requireServerEngineAuth('pi')).toBe(providers.pi)
  })

  it('drives codex, as it always did', () => {
    expect(requireServerEngineAuth('codex')).toBe(providers.codex)
  })

  it('refuses claude and opencode, and says why THOSE two are desktop-bound', () => {
    for (const engineId of ['claude', 'opencode'] as const) {
      expect(() => requireServerEngineAuth(engineId)).toThrow(DESKTOP_ONLY_SIGN_IN_MESSAGE)
    }
  })

  it('the refusal no longer claims sign-in is unavailable outright (GUARD)', () => {
    // The old text said "Engine sign-in is not available on the headless server
    // yet". That is now false — ChatGPT signs in here — and a message that lies
    // about what works is the failure ADR-030 names.
    expect(DESKTOP_ONLY_SIGN_IN_MESSAGE).not.toMatch(/not available on the headless server/i)
    expect(DESKTOP_ONLY_SIGN_IN_MESSAGE).toMatch(/Claude/)
    expect(DESKTOP_ONLY_SIGN_IN_MESSAGE).toMatch(/opencode/)
    expect(DESKTOP_ONLY_SIGN_IN_MESSAGE).toMatch(/device code|paste-back/i)
  })
})

describe('the engine-auth module stays Electron-free', () => {
  it('imports nothing from electron, directly or through the providers it names', async () => {
    // The whole reason pi can be driven here: `src/core/auth/**` has no Electron
    // import, so the server process can hold the same provider the desktop does.
    // A static import of `electron` in this graph would crash the server at boot,
    // not at first use — pin it where the decision is made.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../engine-auth.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from 'electron'/)
    expect(source).not.toMatch(/require\('electron'\)/)
  })
})
