// ---------------------------------------------------------------------------
// E2E Encryption — AES-256-GCM via Web Crypto API (isomorphic Node.js + Browser)
// ---------------------------------------------------------------------------

const SALT = new TextEncoder().encode('ClaudeUI-E2E-v1')
const INFO = new TextEncoder().encode('aes-gcm-256')
const NONCE_BYTES = 12

/**
 * End-to-end encryption using AES-256-GCM.
 *
 * Both Node.js (via `globalThis.crypto.subtle`) and browsers
 * (`window.crypto.subtle`) implement the Web Crypto API, so this
 * module is isomorphic — zero npm dependencies.
 *
 * Key derivation: HKDF-SHA256 from the raw 32-byte pre-shared key.
 * Wire format:    base64( nonce[12] || ciphertext || gcm_tag[16] )
 */
export class E2ECrypto {
  private key: CryptoKey | null = null

  /** Derive the AES-256-GCM key from a hex-encoded 32-byte secret. */
  async init(e2eKeyHex: string): Promise<void> {
    const raw = hexToBytes(e2eKeyHex)
    if (raw.length !== 32) {
      throw new Error(`E2E key must be 32 bytes (got ${raw.length})`)
    }

    const subtle = getSubtle()

    // Import the raw key as HKDF input
    const baseKey = await subtle.importKey('raw', raw.buffer as ArrayBuffer, 'HKDF', false, ['deriveKey'])

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
   * @returns base64-encoded `nonce || ciphertext || gcm_tag`
   */
  async encrypt(msg: object): Promise<string> {
    if (!this.key) throw new Error('E2ECrypto not initialized')

    const subtle = getSubtle()
    const plaintext = new TextEncoder().encode(JSON.stringify(msg))
    const nonce = getRandomValues(NONCE_BYTES)

    const ciphertext = await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      this.key,
      plaintext
    )

    // Concatenate nonce + ciphertext (which includes the 16-byte GCM auth tag)
    const out = new Uint8Array(NONCE_BYTES + ciphertext.byteLength)
    out.set(nonce, 0)
    out.set(new Uint8Array(ciphertext), NONCE_BYTES)

    return bytesToBase64(out)
  }

  /**
   * Decrypt a base64-encoded payload back to a parsed object.
   * @throws if decryption fails (wrong key, tampered data, etc.)
   */
  async decrypt(payload: string): Promise<unknown> {
    if (!this.key) throw new Error('E2ECrypto not initialized')

    const subtle = getSubtle()
    const data = base64ToBytes(payload)

    if (data.length < NONCE_BYTES + 16) {
      throw new Error('E2E payload too short')
    }

    const nonce = data.slice(0, NONCE_BYTES)
    const ciphertext = data.slice(NONCE_BYTES)

    const plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      this.key,
      ciphertext
    )

    return JSON.parse(new TextDecoder().decode(plaintext))
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

function hexToBytes(hex: string): Uint8Array {
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
