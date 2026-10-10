/**
 * @vitest-environment node
 *
 * The host's content-addressed blob store (ADR-087).
 *
 * What these pin is what the wire contract leans on: the id names the BYTES
 * (so a screenshot arriving from a live event, a transcript re-read and a
 * subagent file is one entry), eviction is by recency of use rather than of
 * insertion, and nothing a hostile or merely broken producer hands in can
 * intern as something other than the bytes it decodes to.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { BLOB_STORE_MAX_BYTES, BlobStore, blobStore, internAttachments } from '../blob-store'

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** `n` deterministic, distinct-per-seed bytes. */
function bytesOf(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 17 + 7) & 0xff
  return b
}

describe('BlobStore.put / get', () => {
  it('round-trips bytes and media type under the SHA-256 of the decoded bytes', () => {
    const store = new BlobStore()
    const bytes = bytesOf(2048, 1)

    const ref = store.put('image/png', bytes.toString('base64'))

    expect(ref).toEqual({ blobId: sha256(bytes), bytes: 2048 })
    const got = store.get(ref!.blobId)
    expect(got?.mediaType).toBe('image/png')
    expect(got?.data.equals(bytes)).toBe(true)
  })

  it('putBytes interns without a base64 round trip, under the same id as put', () => {
    const store = new BlobStore()
    const bytes = bytesOf(512, 2)
    expect(store.putBytes('image/webp', bytes)).toEqual(
      store.put('image/webp', bytes.toString('base64'))
    )
    expect(store.stats().entries).toBe(1)
  })

  it('dedupes identical bytes to one entry and keeps the FIRST media type', () => {
    const store = new BlobStore()
    const b64 = bytesOf(300, 3).toString('base64')

    const first = store.put('image/png', b64)
    const second = store.put('image/jpeg', b64)

    expect(second).toEqual(first)
    expect(store.stats()).toEqual({ entries: 1, bytes: 300 })
    expect(store.get(first!.blobId)?.mediaType).toBe('image/png')
  })

  it('a get for an unknown id is undefined, not a throw', () => {
    expect(new BlobStore().get('0'.repeat(64))).toBeUndefined()
  })

  it.each([
    ['empty string', ''],
    // `Buffer.from(x, 'base64')` never throws: it skips what it does not know.
    // Without the strict gate this interned as whatever bytes survived.
    ['characters outside the alphabet', 'not base64 !!'],
    ['whitespace only', ' \n\t\r\f '],
    ['whitespace around characters outside the alphabet', 'QUJD\n!REVG'],
    // A single sextet holds no whole byte; it decodes to an empty buffer.
    ['a lone sextet', 'A'],
    ['padding in the middle', 'QQ==QQ==']
  ])('refuses %s', (_label, input) => {
    const store = new BlobStore()
    expect(store.put('image/png', input)).toBeNull()
    expect(store.stats()).toEqual({ entries: 0, bytes: 0 })
  })

  it('accepts base64 wrapped at 76 columns: wrapped and unwrapped bytes share one blobId', () => {
    const store = new BlobStore()
    const bytes = bytesOf(1000, 4)
    const flat = bytes.toString('base64')
    // MIME-style: 76-column lines, CRLF-separated, with a stray space and tab.
    const wrapped = (flat.match(/.{1,76}/g) ?? []).join('\r\n') + ' \t\n'

    const a = store.put('image/png', flat)
    const b = store.put('image/png', wrapped)

    expect(wrapped).toContain('\r\n')
    expect(b).toEqual(a)
    expect(b?.blobId).toBe(sha256(bytes))
    expect(store.stats().entries).toBe(1)
    expect(store.get(b!.blobId)?.data.equals(bytes)).toBe(true)
  })

  it('refuses non-string input from an untrusted caller', () => {
    const store = new BlobStore()
    expect(store.put('image/png', undefined as never)).toBeNull()
    expect(store.put('image/png', 42 as never)).toBeNull()
    expect(store.putBytes('image/png', Buffer.alloc(0))).toBeNull()
    expect(store.putBytes('image/png', 'bytes' as never)).toBeNull()
  })
})

describe('BlobStore eviction', () => {
  it('evicts the least-recently-USED blob first: a get is a touch', () => {
    const store = new BlobStore({ maxBytes: 300 })
    const a = store.putBytes('image/png', bytesOf(100, 10))!
    const b = store.putBytes('image/png', bytesOf(100, 11))!
    const c = store.putBytes('image/png', bytesOf(100, 12))!

    // Without the touch `a` (oldest by insertion) would be the one to go.
    expect(store.get(a.blobId)).toBeDefined()
    const d = store.putBytes('image/png', bytesOf(100, 13))!

    expect(store.get(b.blobId)).toBeUndefined()
    expect(store.get(a.blobId)).toBeDefined()
    expect(store.get(c.blobId)).toBeDefined()
    expect(store.get(d.blobId)).toBeDefined()
    expect(store.stats()).toEqual({ entries: 3, bytes: 300 })
  })

  it('a re-put of existing bytes is an LRU touch too', () => {
    const store = new BlobStore({ maxBytes: 200 })
    const a = store.putBytes('image/png', bytesOf(100, 20))!
    const b = store.putBytes('image/png', bytesOf(100, 21))!

    store.putBytes('image/png', bytesOf(100, 20)) // a becomes newest
    store.putBytes('image/png', bytesOf(100, 22))

    expect(store.get(a.blobId)).toBeDefined()
    expect(store.get(b.blobId)).toBeUndefined()
  })

  it('evicts as many old blobs as one large arrival needs, never the arrival itself', () => {
    const store = new BlobStore({ maxBytes: 300 })
    const old = [30, 31, 32].map((s) => store.putBytes('image/png', bytesOf(100, s))!)

    const big = store.putBytes('image/png', bytesOf(250, 33))!

    for (const ref of old) expect(store.get(ref.blobId)).toBeUndefined()
    expect(store.get(big.blobId)).toBeDefined()
    expect(store.stats()).toEqual({ entries: 1, bytes: 250 })
  })

  it('refuses a blob larger than the whole store and leaves the store untouched', () => {
    const store = new BlobStore({ maxBytes: 100 })
    const kept = store.putBytes('image/png', bytesOf(60, 40))!

    expect(store.putBytes('image/png', bytesOf(101, 41))).toBeNull()

    expect(store.get(kept.blobId)).toBeDefined()
    expect(store.stats()).toEqual({ entries: 1, bytes: 60 })
  })

  it('defaults to a 1 GiB cap', () => {
    expect(BLOB_STORE_MAX_BYTES).toBe(1024 * 1024 * 1024)
  })
})

describe('internAttachments', () => {
  it('turns uploads into refs, keeping media type and file name', () => {
    blobStore.clearForTests()
    const bytes = bytesOf(1024, 50)
    const refs = internAttachments([
      { mediaType: 'image/png', base64Data: bytes.toString('base64'), fileName: 'shot.png' },
      { mediaType: 'application/pdf', base64Data: bytesOf(64, 51).toString('base64') }
    ])

    expect(refs).toEqual([
      { mediaType: 'image/png', blobId: sha256(bytes), bytes: 1024, fileName: 'shot.png' },
      {
        mediaType: 'application/pdf',
        blobId: sha256(bytesOf(64, 51)),
        bytes: 64
      }
    ])
    // A ref never carries the upload's bytes.
    expect(JSON.stringify(refs)).not.toContain(bytes.toString('base64').slice(0, 32))
    expect(blobStore.get(sha256(bytes))?.data.equals(bytes)).toBe(true)
  })

  it('drops what the store refuses and returns undefined when nothing survives', () => {
    blobStore.clearForTests()
    expect(internAttachments(undefined)).toBeUndefined()
    expect(internAttachments([])).toBeUndefined()
    expect(
      internAttachments([
        { mediaType: 'image/png', base64Data: '' },
        { mediaType: 'image/png', base64Data: '%%%' }
      ])
    ).toBeUndefined()

    const good = Buffer.from('hello').toString('base64')
    const refs = internAttachments([
      { mediaType: 'image/png', base64Data: '%%%' },
      { mediaType: 'image/png', base64Data: good }
    ])
    expect(refs).toHaveLength(1)
    expect(refs![0].bytes).toBe(5)
  })

  it('tolerates malformed entries from an untrusted invoke argument', () => {
    blobStore.clearForTests()
    const refs = internAttachments([
      null,
      'str',
      { base64Data: 'QQ==' },
      { mediaType: 7, base64Data: 'QQ==' }
    ] as never)
    expect(refs).toBeUndefined()
    expect(internAttachments('not an array' as never)).toBeUndefined()
  })
})
