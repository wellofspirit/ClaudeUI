// ---------------------------------------------------------------------------
// E2E Encryption — AES-256-GCM via Web Crypto API (isomorphic Node.js + Browser)
// ---------------------------------------------------------------------------

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
 * Both Node.js (via `globalThis.crypto.subtle`) and browsers
 * (`window.crypto.subtle`) implement the Web Crypto API, so this
 * module is isomorphic — zero npm dependencies.
 *
 * Key derivation: HKDF-SHA256 from the raw 32-byte pre-shared key.
 * Wire format:    base64( nonce[12] || AES-GCM( seq[4] || json )[+16 tag] )
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
  private key: CryptoKey | null = null
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

  /** Whether `init()` has completed successfully. */
  get isReady(): boolean {
    return this.key !== null
  }

  /**
   * Encrypt a JSON-serializable message.
   * @returns base64-encoded `nonce || AES-GCM( seq || json )`
   */
  async encrypt(msg: object): Promise<string> {
    if (!this.key) throw new Error('E2ECrypto not initialized')

    const subtle = getSubtle()
    const json = new TextEncoder().encode(JSON.stringify(msg))

    // Prepend a monotonic seq to the plaintext so it is authenticated by the
    // GCM tag (tamper-evident) and available to the receiver's replay check.
    const seq = ++this.sendSeq
    const framed = new Uint8Array(SEQ_BYTES + json.length)
    new DataView(framed.buffer).setUint32(0, seq, false) // big-endian
    framed.set(json, SEQ_BYTES)

    const nonce = getRandomValues(NONCE_BYTES)
    const ciphertext = await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      this.key,
      framed
    )

    // Concatenate nonce + ciphertext (which includes the 16-byte GCM auth tag)
    const out = new Uint8Array(NONCE_BYTES + ciphertext.byteLength)
    out.set(nonce, 0)
    out.set(new Uint8Array(ciphertext), NONCE_BYTES)

    return bytesToBase64(out)
  }

  /**
   * Decrypt a base64-encoded payload back to a parsed object.
   * @throws if decryption fails (wrong key, tampered data, replayed frame, …)
   */
  async decrypt(payload: string): Promise<unknown> {
    if (!this.key) throw new Error('E2ECrypto not initialized')

    const subtle = getSubtle()
    const data = base64ToBytes(payload)

    if (data.length < NONCE_BYTES + SEQ_BYTES + 16) {
      throw new Error('E2E payload too short')
    }

    const nonce = data.slice(0, NONCE_BYTES)
    const ciphertext = data.slice(NONCE_BYTES)

    const framed = new Uint8Array(
      await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, this.key, ciphertext)
    )

    // Reject replays: a captured frame carries its original seq, which is <=
    // the last one we accepted. In-order frames strictly increase.
    const seq = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(0, false)
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

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('Web Crypto API not available (requires HTTPS or localhost)')
  }
  return subtle
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
