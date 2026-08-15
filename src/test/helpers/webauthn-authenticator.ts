/**
 * A minimal VIRTUAL WEBAUTHN AUTHENTICATOR for tests — real ES256 keys, real
 * signatures, real CBOR.
 *
 * The point of this file is that nothing about verification is stubbed. Tests
 * that mocked `verifyRegistrationResponse` / `verifyAuthenticationResponse`
 * would prove only that our plumbing calls a function; the property worth
 * guarding is that a genuine P-256 signature over the server's own challenge is
 * what passes, and that a tampered one — wrong origin, wrong RP ID, replayed or
 * foreign challenge, forged signature — is what fails.
 *
 * It implements exactly the slice of the WebAuthn data model the ClaudeUI server
 * uses (ADR-052): ES256 (`alg: -7`) credentials, `attestationType: 'none'`,
 * `userVerification: 'required'`. It is NOT a general authenticator emulator —
 * no RSA, no attestation statements, no extensions.
 *
 * Layout references (W3C WebAuthn L2 §6.1 authenticator data):
 *   rpIdHash (32) | flags (1) | signCount (4 BE) | [attestedCredentialData]
 *   attestedCredentialData = aaguid (16) | credIdLen (2 BE) | credId | COSE key
 */

import * as crypto from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON
} from '@simplewebauthn/server'

/** Authenticator-data flag bits we care about. */
const FLAG_UP = 0x01 // user present
const FLAG_UV = 0x04 // user verified (the biometric gate)
const FLAG_BE = 0x08 // backup eligible
const FLAG_BS = 0x10 // backup state (currently synced)
const FLAG_AT = 0x40 // attested credential data present

const b64url = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('base64url')

function sha256(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest()
}

/** Big-endian uint32. */
function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}

/** Big-endian uint16. */
function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n & 0xffff, 0)
  return b
}

export interface VirtualAuthenticatorOptions {
  /** Advertise as a synced/multi-device credential (sets BE+BS). */
  backedUp?: boolean
  /** Report `userVerified: false` — should be REFUSED by our `required` policy. */
  skipUserVerification?: boolean
  /** 16-byte AAGUID. Defaults to all zeros, which is what platform authenticators send. */
  aaguid?: Buffer
}

/**
 * One credential living in one virtual device. Create it, `register()` once
 * against a challenge, then `authenticate()` as many times as the test needs.
 */
export class VirtualAuthenticator {
  readonly credId: string
  private readonly credIdBytes: Buffer
  private readonly privateKey: crypto.KeyObject
  private readonly cosePublicKey: Buffer
  private readonly aaguid: Buffer
  private readonly opts: VirtualAuthenticatorOptions
  /** Increments on every assertion, like a real (non-synced) authenticator. */
  signCount = 0

  constructor(opts: VirtualAuthenticatorOptions = {}) {
    this.opts = opts
    this.aaguid = opts.aaguid ?? Buffer.alloc(16, 0)
    this.credIdBytes = crypto.randomBytes(32)
    this.credId = b64url(this.credIdBytes)

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = privateKey
    // JWK gives us the raw affine coordinates without hand-parsing SPKI.
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    const x = Buffer.from(jwk.x, 'base64url')
    const y = Buffer.from(jwk.y, 'base64url')

    // COSE_Key for ES256 (RFC 8152 §13.1.1): kty=EC2(2), alg=ES256(-7),
    // crv=P-256(1), x, y. A Map (not an object) because CBOR label keys are
    // negative integers, which a JS object cannot express.
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(x)],
      [-3, new Uint8Array(y)]
    ])
    this.cosePublicKey = Buffer.from(isoCBOR.encode(cose))
  }

  private flags(includeAttested: boolean): number {
    let f = FLAG_UP
    if (!this.opts.skipUserVerification) f |= FLAG_UV
    if (this.opts.backedUp) f |= FLAG_BE | FLAG_BS
    if (includeAttested) f |= FLAG_AT
    return f
  }

  private authData(rpId: string, includeAttested: boolean): Buffer {
    const parts = [sha256(Buffer.from(rpId, 'utf-8')), Buffer.from([this.flags(includeAttested)]), u32(this.signCount)]
    if (includeAttested) {
      parts.push(this.aaguid, u16(this.credIdBytes.length), this.credIdBytes, this.cosePublicKey)
    }
    return Buffer.concat(parts)
  }

  private clientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
      'utf-8'
    )
  }

  /** Produce a `RegistrationResponseJSON` for a `fmt: 'none'` attestation. */
  register(args: {
    challenge: string
    origin: string
    rpId: string
    transports?: string[]
  }): RegistrationResponseJSON {
    const clientDataJSON = this.clientDataJSON('webauthn.create', args.challenge, args.origin)
    const authData = this.authData(args.rpId, true)
    // `fmt: 'none'` — no attestation statement to forge, which is exactly the
    // posture ADR-052 chose (we do not care WHICH authenticator, only that the
    // key lives in one).
    const attestationObject = Buffer.from(
      isoCBOR.encode(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', new Uint8Array(authData)]
        ]) as never
      )
    )
    return {
      id: this.credId,
      rawId: this.credId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: args.transports as never
      }
    }
  }

  /** Produce an `AuthenticationResponseJSON` with a genuine ES256 signature. */
  authenticate(args: {
    challenge: string
    origin: string
    rpId: string
    /** Corrupt the signature — the negative-path lever. */
    forgeSignature?: boolean
    /** Assert under a different credential id than the one that signed. */
    credIdOverride?: string
  }): AuthenticationResponseJSON {
    this.signCount += 1
    const clientDataJSON = this.clientDataJSON('webauthn.get', args.challenge, args.origin)
    const authData = this.authData(args.rpId, false)
    // WebAuthn §6.3.3: sign over authData || SHA-256(clientDataJSON).
    const signed = Buffer.concat([authData, sha256(clientDataJSON)])
    const signature = args.forgeSignature
      ? crypto.sign('sha256', Buffer.from('not the real payload'), this.privateKey)
      : crypto.sign('sha256', signed, this.privateKey)
    return {
      id: args.credIdOverride ?? this.credId,
      rawId: args.credIdOverride ?? this.credId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: b64url(Buffer.from('claudeui-owner', 'utf-8'))
      }
    }
  }
}
