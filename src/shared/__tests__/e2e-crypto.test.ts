/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { E2ECrypto, WebCryptoUnavailableError, webCryptoAvailable } from '../e2e-crypto'

// Generate a valid 32-byte hex key for testing
const TEST_KEY_HEX = 'a'.repeat(64) // 32 bytes of 0xAA

describe('E2ECrypto', () => {
  describe('init', () => {
    it('initializes successfully with a valid 32-byte hex key', async () => {
      const crypto = new E2ECrypto()
      expect(crypto.isReady).toBe(false)
      await crypto.init(TEST_KEY_HEX)
      expect(crypto.isReady).toBe(true)
    })

    it('throws for key shorter than 32 bytes', async () => {
      const crypto = new E2ECrypto()
      await expect(crypto.init('aabb')).rejects.toThrow('E2E key must be 32 bytes')
    })

    it('throws for key longer than 32 bytes', async () => {
      const crypto = new E2ECrypto()
      await expect(crypto.init('a'.repeat(66))).rejects.toThrow('E2E key must be 32 bytes')
    })

    // hardening-5 — parseInt(..., 16) yields NaN for a non-hex pair, which
    // Uint8Array coerces to 0. A malformed but correctly-sized "key" therefore
    // passed the `raw.length !== 32` check and silently became an all-zero
    // secret that both peers agreed on.
    it.each([
      ['a'.repeat(63) + 'g'],
      ['g'.repeat(64)],
      ['zz' + 'a'.repeat(62)],
      ['a'.repeat(62) + '!!'],
      ['a'.repeat(32) + '-'.repeat(32)]
    ])('throws for a 64-char NON-hex key %#  (GUARD — fails pre-fix)', async (bad) => {
      const crypto = new E2ECrypto()
      await expect(crypto.init(bad)).rejects.toThrow(/Invalid hex string/)
      expect(crypto.isReady).toBe(false)
    })

    it('throws for an odd-length hex key instead of a RangeError', async () => {
      const crypto = new E2ECrypto()
      await expect(crypto.init('a'.repeat(65))).rejects.toThrow(/Invalid hex string/)
    })

    it('accepts mixed-case valid hex', async () => {
      const crypto = new E2ECrypto()
      await crypto.init('AbCdEf01'.repeat(8))
      expect(crypto.isReady).toBe(true)
    })
  })

  describe('encrypt/decrypt roundtrip', () => {
    it('encrypts and decrypts a simple object', async () => {
      const crypto = new E2ECrypto()
      await crypto.init(TEST_KEY_HEX)

      const original = { hello: 'world', count: 42 }
      const encrypted = await crypto.encrypt(original)

      expect(typeof encrypted).toBe('string')
      expect(encrypted).not.toContain('hello') // should be encrypted

      const decrypted = await crypto.decrypt(encrypted)
      expect(decrypted).toEqual(original)
    })

    it('handles nested objects', async () => {
      const crypto = new E2ECrypto()
      await crypto.init(TEST_KEY_HEX)

      const original = { nested: { deep: { value: [1, 2, 3] } } }
      const encrypted = await crypto.encrypt(original)
      const decrypted = await crypto.decrypt(encrypted)
      expect(decrypted).toEqual(original)
    })

    it('handles empty objects', async () => {
      const crypto = new E2ECrypto()
      await crypto.init(TEST_KEY_HEX)

      const encrypted = await crypto.encrypt({})
      const decrypted = await crypto.decrypt(encrypted)
      expect(decrypted).toEqual({})
    })

    it('handles objects with unicode strings', async () => {
      const crypto = new E2ECrypto()
      await crypto.init(TEST_KEY_HEX)

      const original = { text: '你好世界 🌍 émojis' }
      const encrypted = await crypto.encrypt(original)
      const decrypted = await crypto.decrypt(encrypted)
      expect(decrypted).toEqual(original)
    })

    it('produces different ciphertext for the same plaintext (random nonce)', async () => {
      const crypto = new E2ECrypto()
      await crypto.init(TEST_KEY_HEX)

      const original = { test: 'data' }
      const enc1 = await crypto.encrypt(original)
      const enc2 = await crypto.encrypt(original)

      expect(enc1).not.toBe(enc2) // different nonces
      expect(await crypto.decrypt(enc1)).toEqual(original)
      expect(await crypto.decrypt(enc2)).toEqual(original)
    })
  })

  describe('decrypt errors', () => {
    it('fails to decrypt with a different key', async () => {
      const crypto1 = new E2ECrypto()
      await crypto1.init(TEST_KEY_HEX)

      const crypto2 = new E2ECrypto()
      await crypto2.init('b'.repeat(64))

      const encrypted = await crypto1.encrypt({ secret: true })
      await expect(crypto2.decrypt(encrypted)).rejects.toThrow()
    })

    it('throws for payload that is too short', async () => {
      const crypto = new E2ECrypto()
      await crypto.init(TEST_KEY_HEX)

      // Base64 of a very short buffer (< 28 bytes = 12 nonce + 16 tag)
      const shortPayload = Buffer.from(new Uint8Array(10)).toString('base64')
      await expect(crypto.decrypt(shortPayload)).rejects.toThrow('E2E payload too short')
    })

    it('throws for tampered ciphertext', async () => {
      const crypto = new E2ECrypto()
      await crypto.init(TEST_KEY_HEX)

      const encrypted = await crypto.encrypt({ data: 'test' })
      // Tamper with the middle of the payload
      const bytes = Buffer.from(encrypted, 'base64')
      bytes[20] ^= 0xff
      const tampered = bytes.toString('base64')

      await expect(crypto.decrypt(tampered)).rejects.toThrow()
    })
  })

  // R4 — per-connection replay protection. A tunnel intermediary must not be
  // able to replay a captured (encrypt-once) frame. Modeled as two instances
  // sharing the key: `sender` encrypts, `receiver` decrypts (its recv counter).
  describe('replay protection', () => {
    it('rejects a replayed (duplicate) frame', async () => {
      const sender = new E2ECrypto()
      const receiver = new E2ECrypto()
      await sender.init(TEST_KEY_HEX)
      await receiver.init(TEST_KEY_HEX)

      const frame = await sender.encrypt({ cmd: 'approve' })
      // First delivery is accepted…
      expect(await receiver.decrypt(frame)).toEqual({ cmd: 'approve' })
      // …a verbatim replay of the SAME frame is rejected.
      await expect(receiver.decrypt(frame)).rejects.toThrow(/replay/i)
    })

    it('accepts strictly-increasing (in-order) frames', async () => {
      const sender = new E2ECrypto()
      const receiver = new E2ECrypto()
      await sender.init(TEST_KEY_HEX)
      await receiver.init(TEST_KEY_HEX)

      const p1 = await sender.encrypt({ n: 1 })
      const p2 = await sender.encrypt({ n: 2 })
      const p3 = await sender.encrypt({ n: 3 })
      expect(await receiver.decrypt(p1)).toEqual({ n: 1 })
      expect(await receiver.decrypt(p2)).toEqual({ n: 2 })
      expect(await receiver.decrypt(p3)).toEqual({ n: 3 })
    })

    it('rejects an out-of-order (stale-seq) frame', async () => {
      const sender = new E2ECrypto()
      const receiver = new E2ECrypto()
      await sender.init(TEST_KEY_HEX)
      await receiver.init(TEST_KEY_HEX)

      const p1 = await sender.encrypt({ n: 1 })
      const p2 = await sender.encrypt({ n: 2 })
      // Deliver p2 first (accepted), then the older p1 — rejected as a replay.
      expect(await receiver.decrypt(p2)).toEqual({ n: 2 })
      await expect(receiver.decrypt(p1)).rejects.toThrow(/replay/i)
    })

    it('counters are per-instance — two directions do not collide', async () => {
      // A single instance encrypts (send dir) AND decrypts (recv dir); the two
      // counters are independent, so encrypting doesn't consume recv seqs.
      const a = new E2ECrypto()
      const b = new E2ECrypto()
      await a.init(TEST_KEY_HEX)
      await b.init(TEST_KEY_HEX)

      const aToB = await a.encrypt({ dir: 'a->b', n: 1 })
      const bToA = await b.encrypt({ dir: 'b->a', n: 1 })
      // Each side's first inbound frame is seq 1 and must be accepted.
      expect(await b.decrypt(aToB)).toEqual({ dir: 'a->b', n: 1 })
      expect(await a.decrypt(bToA)).toEqual({ dir: 'b->a', n: 1 })
    })
  })

  /**
   * The insecure-context case, which is not an edge case: it is EVERY phone
   * browser on the LAN link (`http://192.168.x.x:<port>`), where `crypto.subtle`
   * is `undefined` because the origin is not a secure context. Node always has
   * WebCrypto, so the only way to exercise the pure-JS branch here is to take it
   * away (ADR-056 amendment 2026-08-18).
   */
  describe('a context WITHOUT Web Crypto (the plain-http LAN origin)', () => {
    /** Run `fn` with `crypto.subtle` removed, restoring it whatever happens. */
    async function withoutSubtle<T>(fn: () => Promise<T>): Promise<T> {
      const real = globalThis.crypto
      Object.defineProperty(globalThis, 'crypto', {
        // `getRandomValues` survives: it is NOT gated on a secure context, which
        // is why nonces were never the problem and the fallback needs no PRNG.
        value: { getRandomValues: real.getRandomValues.bind(real) },
        configurable: true
      })
      try {
        return await fn()
      } finally {
        Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true })
      }
    }

    it('webCryptoAvailable() reports the context, both ways', async () => {
      expect(webCryptoAvailable()).toBe(true)
      await withoutSubtle(async () => {
        expect(webCryptoAvailable()).toBe(false)
      })
      expect(webCryptoAvailable()).toBe(true)
    })

    it('initializes and round-trips on the pure-JS path', async () => {
      await withoutSubtle(async () => {
        const crypto = new E2ECrypto()
        await crypto.init(TEST_KEY_HEX)
        expect(crypto.isReady).toBe(true)
        const other = new E2ECrypto()
        await other.init(TEST_KEY_HEX)
        expect(await other.decrypt(await crypto.encrypt({ hello: 'lan' }))).toEqual({
          hello: 'lan'
        })
      })
    })

    /**
     * THE interop pin, and the reason the fallback is a fallback rather than a
     * second protocol. A LAN session is ALWAYS a mixed pair: the phone has no
     * `subtle` and the server always does. If HKDF or the tag placement differed
     * by a byte between the two implementations, every frame would fail its GCM
     * tag and the channel would die in a way that looks exactly like a bad key.
     */
    it('interoperates with a Web Crypto peer, in BOTH directions (GUARD)', async () => {
      const webCryptoPeer = new E2ECrypto()
      await webCryptoPeer.init(TEST_KEY_HEX)

      const noblePeer = await withoutSubtle(async () => {
        const peer = new E2ECrypto()
        await peer.init(TEST_KEY_HEX)
        return peer
      })

      // noble → WebCrypto. Encrypted with `subtle` absent, decrypted with it back.
      const fromNoble = await withoutSubtle(() => noblePeer.encrypt({ dir: 'noble->web', n: 1 }))
      expect(await webCryptoPeer.decrypt(fromNoble)).toEqual({ dir: 'noble->web', n: 1 })

      // WebCrypto → noble.
      const fromWeb = await webCryptoPeer.encrypt({ dir: 'web->noble', n: 1 })
      expect(await withoutSubtle(() => noblePeer.decrypt(fromWeb))).toEqual({
        dir: 'web->noble',
        n: 1
      })
    })

    it('rejects a TAMPERED frame on the pure-JS path too', async () => {
      await withoutSubtle(async () => {
        const a = new E2ECrypto()
        const b = new E2ECrypto()
        await a.init(TEST_KEY_HEX)
        await b.init(TEST_KEY_HEX)
        const payload = await a.encrypt({ secret: 1 })
        const bytes = Buffer.from(payload, 'base64')
        bytes[bytes.length - 1] ^= 0xff // flip a bit of the GCM tag
        await expect(b.decrypt(bytes.toString('base64'))).rejects.toThrow()
      })
    })

    it('a MALFORMED key is still a key error — the only failure init has left', async () => {
      await withoutSubtle(async () => {
        const crypto = new E2ECrypto()
        await expect(crypto.init('zz'.repeat(32))).rejects.toThrow(/Invalid hex string/)
        await expect(crypto.init('aa')).rejects.toThrow('E2E key must be 32 bytes')
      })
    })

    it('the typed context error is now UNREACHABLE from init (GUARD)', async () => {
      await withoutSubtle(async () => {
        const crypto = new E2ECrypto()
        // It used to throw exactly this for a perfectly valid key, which is the
        // regression the amendment removed. The class survives only as an
        // invariant guard for `subtle` vanishing mid-session.
        await expect(crypto.init(TEST_KEY_HEX)).resolves.toBeUndefined()
        expect(new WebCryptoUnavailableError()).toBeInstanceOf(Error)
      })
    })
  })

  describe('not initialized errors', () => {
    it('encrypt throws when not initialized', async () => {
      const crypto = new E2ECrypto()
      await expect(crypto.encrypt({ test: 1 })).rejects.toThrow('E2ECrypto not initialized')
    })

    it('decrypt throws when not initialized', async () => {
      const crypto = new E2ECrypto()
      await expect(crypto.decrypt('dGVzdA==')).rejects.toThrow('E2ECrypto not initialized')
    })
  })
})
