// ---------------------------------------------------------------------------
// E2E Encryption — AES-256-GCM, Web Crypto where it exists, pure JS where it
// does not (isomorphic Node.js + Browser, secure context or not)
// ---------------------------------------------------------------------------

import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const SALT = new TextEncoder().encode('ClaudeUI-E2E-v1')
const INFO = new TextEncoder().encode('aes-gcm-256')
const NONCE_BYTES = 12
/** Width of the per-connection monotonic sequence counter prepended to the
 *  authenticated plaintext (uint32, big-endian). 4 billion frames per
 *  connection is far beyond any realistic session. */
const SEQ_BYTES = 4

/**
 * End-to-end encryption using AES-256-GCM.
 *
 * Key derivation: HKDF-SHA256 from the raw 32-byte pre-shared key.
 * Wire format:    base64( nonce[12] || AES-GCM( seq[4] || json )[+16 tag] )
 *
 * ## Two implementations, ONE wire format (ADR-056 amendment 2026-08-18)
 *
 * Web Crypto is the primary path and is used whenever `crypto.subtle` exists —
 * Node always, and any browser in a secure context. It is NOT always there: a
 * browser exposes `SubtleCrypto` only on a secure origin, and the LAN link is a
 * plain `http://<ip>:<port>` address, which is not one. That is not an edge
 * case, it is every phone on the LAN channel — the origin ADR-056 makes this
 * encryption MANDATORY for — and as first shipped it made the channel
 * unopenable from any browser (found by owner live-test).
 *
 * So when `subtle` is absent the same primitives run in pure JS
 * (`@noble/ciphers` AES-GCM, `@noble/hashes` HKDF-SHA256). Both paths derive the
 * same key from the same salt/info by RFC 5869, and AES-GCM ciphertext carries
 * its 16-byte tag appended in both — so the two are byte-identical on the wire
 * and interoperate in either direction. That matters concretely: the SERVER
 * always has Web Crypto, so every LAN session is already a mixed pair, and
 * `interoperates with a WebCrypto peer` is pinned in the unit suite.
 *
 * Pure JS was already half the story on this origin — the password proof is
 * `@noble/hashes` scrypt for the same reason (WebCrypto has no scrypt) — so this
 * completes it rather than introducing a new kind of dependency.
 *
 * Replay protection (xhigh#2): each encrypted frame carries a monotonic
 * per-connection sequence number INSIDE the authenticated plaintext, so it
 * cannot be forged or shifted without failing the GCM tag. The receiver
 * rejects any frame whose seq is <= the last one it accepted (per direction),
 * which stops a tunnel intermediary from replaying a captured
 * prompt/approval/config-write frame. A fresh {@link E2ECrypto} instance is
 * created per E2E session on both ends, so the counters reset per connection.
 *
 * Limit: this defends against replay, not against a live man-in-the-middle who
 * also holds the pre-shared key — which E2E already precludes (the key travels
 * only in the QR/link fragment, never over the wire).
 */
export class E2ECrypto {
  /** The Web Crypto session key — null when this instance took the pure-JS path. */
  private key: CryptoKey | null = null
  /**
   * The DERIVED 32-byte AES key, held only on the pure-JS path (noble's `gcm`
   * takes raw bytes, where Web Crypto takes a non-extractable `CryptoKey`).
   *
   * Exactly one of {@link E2ECrypto.key} and this is ever set. Keeping the raw
   * bytes in memory is strictly worse than a non-extractable `CryptoKey`, which
   * is why it is the FALLBACK and not the default — but on a context with no
   * `subtle` there is no non-extractable anything to have, and the alternative
   * is no channel at all.
   */
  private rawKey: Uint8Array | null = null
  /** Next outbound sequence number (this direction). */
  private sendSeq = 0
  /** Highest inbound sequence number accepted so far (this direction). */
  private recvSeq = 0

  /** Derive the AES-256-GCM key from a hex-encoded 32-byte secret. */
  async init(e2eKeyHex: string): Promise<void> {
    const raw = hexToBytes(e2eKeyHex)
    if (raw.length !== 32) {
      throw new Error(`E2E key must be 32 bytes (got ${raw.length})`)
    }

    // The path is chosen ONCE, here, and the instance never switches: an
    // instance is per-connection and a context does not gain `subtle` mid-session.
    if (!webCryptoAvailable()) {
      // RFC 5869 HKDF-Extract+Expand — the same function `subtle.deriveKey`
      // computes below, over the same salt, info and 32-byte length. Equality of
      // the two is what makes the wire format shared rather than merely similar,
      // and it is pinned by the interop test rather than asserted here.
      this.rawKey = hkdf(sha256, raw, SALT, INFO, 32)
      return
    }

    const subtle = getSubtle()

    // Import the raw key as HKDF input
    const baseKey = await subtle.importKey('raw', raw.buffer as ArrayBuffer, 'HKDF', false, [
      'deriveKey'
    ])

    // Derive AES-256-GCM key
    this.key = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  }

  /** Whether `init()` has completed successfully, on either path. */
  get isReady(): boolean {
    return this.key !== null || this.rawKey !== null
  }

  /**
   * Encrypt a JSON-serializable message.
   * @returns base64-encoded `nonce || AES-GCM( seq || json )`
   */
  async encrypt(msg: object): Promise<string> {
    if (!this.isReady) throw new Error('E2ECrypto not initialized')

    const json = new TextEncoder().encode(JSON.stringify(msg))

    // Prepend a monotonic seq to the plaintext so it is authenticated by the
    // GCM tag (tamper-evident) and available to the receiver's replay check.
    const seq = ++this.sendSeq
    const framed = new Uint8Array(SEQ_BYTES + json.length)
    new DataView(framed.buffer).setUint32(0, seq, false) // big-endian
    framed.set(json, SEQ_BYTES)

    const nonce = getRandomValues(NONCE_BYTES)
    // Both branches produce ciphertext WITH the 16-byte GCM tag appended — that
    // is the format Web Crypto defines and the one noble follows — so the bytes
    // below are the same either way.
    const ciphertext = this.rawKey
      ? gcm(this.rawKey, nonce).encrypt(framed)
      : new Uint8Array(
          await getSubtle().encrypt(
            { name: 'AES-GCM', iv: nonce as BufferSource },
            this.key!,
            framed
          )
        )

    // Concatenate nonce + ciphertext (which includes the 16-byte GCM auth tag)
    const out = new Uint8Array(NONCE_BYTES + ciphertext.byteLength)
    out.set(nonce, 0)
    out.set(ciphertext, NONCE_BYTES)

    return bytesToBase64(out)
  }

  /**
   * Decrypt a base64-encoded payload back to a parsed object.
   * @throws if decryption fails (wrong key, tampered data, replayed frame, …)
   */
  async decrypt(payload: string): Promise<unknown> {
    if (!this.isReady) throw new Error('E2ECrypto not initialized')

    const data = base64ToBytes(payload)

    if (data.length < NONCE_BYTES + SEQ_BYTES + 16) {
      throw new Error('E2E payload too short')
    }

    const nonce = data.slice(0, NONCE_BYTES)
    const ciphertext = data.slice(NONCE_BYTES)

    // A failed tag throws on both paths (noble raises, Web Crypto rejects), which
    // is what the caller's catch already treats as "drop this frame".
    const framed = this.rawKey
      ? gcm(this.rawKey, nonce).decrypt(ciphertext)
      : new Uint8Array(
          await getSubtle().decrypt({ name: 'AES-GCM', iv: nonce }, this.key!, ciphertext)
        )

    // Reject replays: a captured frame carries its original seq, which is <=
    // the last one we accepted. In-order frames strictly increase.
    const seq = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(
      0,
      false
    )
    if (seq <= this.recvSeq) {
      throw new Error(`E2E replay detected (seq ${seq} <= ${this.recvSeq})`)
    }
    this.recvSeq = seq

    return JSON.parse(new TextDecoder().decode(framed.subarray(SEQ_BYTES)))
  }
}

// ---------------------------------------------------------------------------
// Helpers (isomorphic)
// ---------------------------------------------------------------------------

/**
 * `crypto.subtle` vanished between {@link E2ECrypto.init} choosing the Web Crypto
 * path and a later call on it — an INVARIANT breach, not a reachable state.
 *
 * Kept as a typed throw rather than a bare `Error` so that if it ever does
 * surface it is unmistakable in a log, and so nothing downstream can mistake it
 * for the malformed-key errors `init()` raises. There is no user-facing copy for
 * it any more: since the pure-JS fallback landed, a context WITHOUT `subtle`
 * simply never reaches this function.
 */
export class WebCryptoUnavailableError extends Error {
  constructor() {
    super('Web Crypto API not available (requires HTTPS or localhost)')
    this.name = 'WebCryptoUnavailableError'
  }
}

/**
 * Does this context have Web Crypto — i.e. should {@link E2ECrypto} take the
 * primary path rather than the pure-JS one?
 *
 * `SubtleCrypto` is exposed ONLY in a secure context. Node always has it, and so
 * does a browser on `https://…` or `http://localhost` — but a browser at a plain
 * LAN address (`http://192.168.x.x:<port>`) does not: `window.isSecureContext`
 * is false there and `crypto.subtle` is `undefined`, while `getRandomValues`
 * stays available (it is not gated). That asymmetry is the whole reason the
 * fallback exists: it is the origin ADR-056 makes the channel MANDATORY for.
 *
 * Deliberately probes `importKey` rather than truthiness of `subtle`: that is the
 * first call `init()` makes, so the predicate cannot answer yes to a context
 * where the object exists but is a stub.
 */
export function webCryptoAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.importKey === 'function'
}

function getSubtle(): SubtleCrypto {
  if (!webCryptoAvailable()) throw new WebCryptoUnavailableError()
  return globalThis.crypto.subtle
}

function getRandomValues(length: number): Uint8Array {
  const buf = new Uint8Array(length)
  globalThis.crypto.getRandomValues(buf)
  return buf
}

/**
 * Strict hex decode. `parseInt(..., 16)` returns NaN for a non-hex pair, which
 * Uint8Array coerces to 0 — so a malformed 64-char "key" silently became an
 * all-zero secret that both ends would happily agree on (opus5 hardening-5).
 * Reject anything that is not an even-length run of hex digits instead.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string (expected an even-length run of hex digits)')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  // Works in both Node.js and browsers
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  // Browser fallback
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'))
  }
  // Browser fallback
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
