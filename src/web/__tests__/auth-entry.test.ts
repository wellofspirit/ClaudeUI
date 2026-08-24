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
  // Legitimately empty since ADR-056 retired the token: a host with no password
  // and no passkey advertises nothing at all.
  methods: [],
  ...over
})

describe('decideAuthEntry', () => {
  it('an identified tailnet caller takes the PASSKEY route, not an ambient one (ADR-056)', () => {
    // The `tailnet` route is retired: it meant "connect with an empty credential
    // and let the server's unsolicited accept drive the rest", which is ambient
    // admission. An identified caller now takes the same two routes as anyone
    // else, and `identity.login` decides nothing. RED before ADR-056, which
    // routed this to `'tailnet'`.
    //
    // The password params are still captured either way, which is the older
    // guard this case also carries: that origin is the phone, and the phone is
    // exactly where a lost authenticator has to be recoverable.
    const decision = decideAuthEntry(
      info({
        methods: ['password', 'tailnet-identity'],
        password: PASSWORD,
        identity: { login: 'owner@example.com' },
        webauthn: { rpId: 'box.tail.ts.net' }
      })
    )
    expect(decision.route).toBe('passkey')
    expect(decision.passwordParams).toEqual(PASSWORD)
    expect(decision.passkeyAdvertised).toBe(true)
  })

  it('an identified tailnet caller with NO passkey takes the PASSWORD route', () => {
    const decision = decideAuthEntry(
      info({
        methods: ['password', 'tailnet-identity'],
        password: PASSWORD,
        identity: { login: 'owner@example.com' }
      })
    )
    expect(decision.route).toBe('password')
    expect(decision.passwordParams).toEqual(PASSWORD)
  })

  it('keeps them on the PASSKEY route too', () => {
    const decision = decideAuthEntry(
      info({
        methods: ['password'],
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
        methods: ['password', 'tailnet-identity'],
        password: PASSWORD,
        identity: { login: null }
      })
    )
    expect(decision.route).toBe('password')
    expect(decision.passwordParams).toEqual(PASSWORD)
  })

  it('offers nothing when the server has no password and no passkey', () => {
    const decision = decideAuthEntry(info({ methods: [] }))
    expect(decision).toEqual({
      route: 'unavailable',
      passwordParams: null,
      passkeyAdvertised: false
    })
  })

  it('ignores a password block the method list does not advertise', () => {
    // The two must agree; trusting the block alone would show a form for a
    // credential the server will refuse.
    const decision = decideAuthEntry(info({ methods: ['tailnet-identity'], password: PASSWORD }))
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
