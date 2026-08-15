/**
 * The `/remote/auth-info` entry decision (`decideAuthEntry`).
 *
 * This is where the credential the UI can FALL BACK to is chosen, which is a
 * different question from which screen leads — and conflating the two is what
 * left the tailnet origin with no break-glass path at all.
 */

import { describe, it, expect } from 'vitest'
import { decideAuthEntry } from '../auth-entry'
import type { RemoteAuthInfo, RemoteKdfParams } from '../../shared/remote-protocol'

const KDF: RemoteKdfParams = { algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 }
const PASSWORD = { saltHex: 'aabb', kdf: KDF }

const info = (over: Partial<RemoteAuthInfo> = {}): RemoteAuthInfo => ({
  version: 1,
  methods: ['token'],
  ...over
})

describe('decideAuthEntry', () => {
  it('keeps the password params on the TAILNET route (GUARD)', () => {
    // security.md §origin × method matrix: on the tailnet origin the server
    // still accepts a password proof whenever break-glass is on. That origin is
    // the phone, and the phone is exactly where a lost authenticator has to be
    // recoverable — so the UI must be able to offer the fallback there. Dropping
    // the params because ambient identity happened to win the route leaves the
    // passkey screen with no "use password instead" and `auth-rejected` with
    // nothing to recover onto.
    const decision = decideAuthEntry(
      info({
        methods: ['token', 'password', 'tailnet-identity'],
        password: PASSWORD,
        identity: { login: 'owner@example.com' },
        webauthn: { rpId: 'box.tail.ts.net' }
      })
    )
    expect(decision.route).toBe('tailnet')
    expect(decision.passwordParams).toEqual(PASSWORD)
    expect(decision.passkeyAdvertised).toBe(true)
  })

  it('keeps them on the PASSKEY route too', () => {
    const decision = decideAuthEntry(
      info({
        methods: ['token', 'password'],
        password: PASSWORD,
        webauthn: { rpId: 'box.tail.ts.net' }
      })
    )
    expect(decision).toEqual({
      route: 'passkey',
      passwordParams: PASSWORD,
      passkeyAdvertised: true
    })
  })

  it('a tailnet advertisement with a NULL login is not us — fall through', () => {
    // Advertised but not the owner (tagged device, a colleague, a request that
    // did not come through serve): such a caller needs the password form.
    const decision = decideAuthEntry(
      info({
        methods: ['token', 'password', 'tailnet-identity'],
        password: PASSWORD,
        identity: { login: null }
      })
    )
    expect(decision.route).toBe('password')
    expect(decision.passwordParams).toEqual(PASSWORD)
  })

  it('offers nothing when the server has no password and no passkey', () => {
    const decision = decideAuthEntry(info({ methods: ['token'] }))
    expect(decision).toEqual({
      route: 'unavailable',
      passwordParams: null,
      passkeyAdvertised: false
    })
  })

  it('ignores a password block the method list does not advertise', () => {
    // The two must agree; trusting the block alone would show a form for a
    // credential the server will refuse.
    const decision = decideAuthEntry(info({ methods: ['token'], password: PASSWORD }))
    expect(decision.route).toBe('unavailable')
    expect(decision.passwordParams).toBeNull()
  })

  it('refuses an unknown protocol major outright', () => {
    const decision = decideAuthEntry(info({ version: 2 as never, password: PASSWORD }))
    expect(decision).toEqual({
      route: 'unsupported',
      passwordParams: null,
      passkeyAdvertised: false
    })
  })
})
