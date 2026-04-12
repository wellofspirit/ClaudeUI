/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { E2ECrypto } from '../e2e-crypto'

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
