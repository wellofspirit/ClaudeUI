/**
 * The host's content-addressed blob store (ADR-087).
 *
 * Image and document bytes must not ride the transcript lanes inline: on
 * `tool_result.images[]`, on `image` / `document` blocks, or on user-message and
 * queue-item attachments they would be ringed, folded into canonical state and
 * shipped in every `sync-full` (one screenshot-heavy session measured ~273 MB).
 * Producers intern the bytes HERE and put a {@link BlobRef} on the wire; a
 * client fetches the bytes on demand through `blob:get`.
 *
 * Memory-only on purpose, and bounded by DECODED bytes with LRU eviction:
 *
 *  - canonical state is memory-only too, and every producer that interns is a
 *    decoder that runs again when a transcript is re-read — so a host restart
 *    (or an eviction followed by a re-read) re-derives the blob under the SAME
 *    id, because the id is the hash of the bytes;
 *  - a `get` miss is therefore a legal outcome, not a fault. A client renders it
 *    as "image unavailable".
 *
 * `Buffer`s live outside the V8 heap, which is the other half of the point: the
 * base64 strings they replace were heap-resident for the life of the session.
 *
 * Electron-free (it lives inside the `src/core` fence) and synchronous, so every
 * decoder can intern inline without growing an `await`.
 */

import { createHash } from 'node:crypto'
import type { AttachmentRef, AttachmentUpload, BlobRef } from '../../shared/types'

/** Default cap on the store's decoded bytes. */
export const BLOB_STORE_MAX_BYTES = 1024 * 1024 * 1024

/**
 * Standard or URL-safe base64, padded or not. `Buffer.from(…, 'base64')` never
 * throws — it silently skips characters it does not know — so without this gate
 * a garbage string would intern as whatever bytes survived.
 *
 * ASCII whitespace is tolerated and stripped first ({@link ASCII_WHITESPACE_RE}):
 * a producer that wraps its output at 76 columns (MIME) was accepted by the
 * browser's forgiving-base64 when this was a `data:` URI, and must not lose the
 * image now. Everything else that is not in the alphabet is still refused.
 */
const BASE64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/
const ASCII_WHITESPACE_RE = /[\t\n\f\r ]+/g

interface Entry {
  mediaType: string
  data: Buffer
}

export class BlobStore {
  private readonly maxBytes: number
  /** Insertion order IS recency order: a touch deletes and re-inserts. */
  private readonly entries = new Map<string, Entry>()
  private totalBytes = 0

  constructor(options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? BLOB_STORE_MAX_BYTES
  }

  /**
   * Decode, hash, keep. `null` for empty or undecodable input, or a blob larger
   * than the whole store. Same bytes → same id; a re-put is an LRU touch.
   */
  put(mediaType: string, base64Data: string): BlobRef | null {
    if (typeof base64Data !== 'string' || !base64Data) return null
    // Fast path first: well-formed input (almost everything) never pays for the strip.
    const compact = BASE64_RE.test(base64Data)
      ? base64Data
      : base64Data.replace(ASCII_WHITESPACE_RE, '')
    if (!compact || !BASE64_RE.test(compact)) return null
    return this.putBytes(mediaType, Buffer.from(compact, 'base64'))
  }

  /** {@link put} for bytes already in hand — no base64 round trip. */
  putBytes(mediaType: string, bytes: Buffer): BlobRef | null {
    if (typeof mediaType !== 'string' || !Buffer.isBuffer(bytes) || bytes.length === 0) return null
    if (bytes.length > this.maxBytes) return null
    const blobId = createHash('sha256').update(bytes).digest('hex')
    const existing = this.entries.get(blobId)
    if (existing) {
      // The first writer's media type wins: the id names the bytes, and two
      // producers labelling identical bytes differently must not flip a ref
      // that is already on the wire.
      this.touch(blobId, existing)
      return { blobId, bytes: existing.data.length }
    }
    this.entries.set(blobId, { mediaType, data: bytes })
    this.totalBytes += bytes.length
    this.evict()
    return { blobId, bytes: bytes.length }
  }

  /** The bytes for an id, or undefined when unknown or evicted. LRU touch on hit. */
  get(blobId: string): { mediaType: string; data: Buffer } | undefined {
    const entry = this.entries.get(blobId)
    if (!entry) return undefined
    this.touch(blobId, entry)
    return { mediaType: entry.mediaType, data: entry.data }
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.totalBytes }
  }

  /** Test seam: drop every blob. */
  clearForTests(): void {
    this.entries.clear()
    this.totalBytes = 0
  }

  private touch(blobId: string, entry: Entry): void {
    this.entries.delete(blobId)
    this.entries.set(blobId, entry)
  }

  private evict(): void {
    for (const [blobId, entry] of this.entries) {
      if (this.totalBytes <= this.maxBytes) return
      this.entries.delete(blobId)
      this.totalBytes -= entry.data.length
    }
  }
}

/** The process-wide store every producer interns into and `blob:get` reads. */
export const blobStore = new BlobStore()

/**
 * The upload → ref step `sendPrompt` runs once per prompt: what the engine needs
 * stays an {@link AttachmentUpload}, what the transcript, the queue broadcast and
 * the ring carry is the {@link AttachmentRef}.
 *
 * The input is an invoke ARGUMENT from any connected client, so malformed
 * entries are skipped rather than thrown on; an entry the store refuses is
 * dropped from the refs (the engine still gets it). `undefined` when nothing
 * survives, preserving the "omit when empty" shape the events always had.
 */
export function internAttachments(
  uploads?: AttachmentUpload[] | null
): AttachmentRef[] | undefined {
  if (!Array.isArray(uploads)) return undefined
  const refs: AttachmentRef[] = []
  for (const upload of uploads) {
    if (!upload || typeof upload !== 'object' || typeof upload.mediaType !== 'string') continue
    const ref = blobStore.put(upload.mediaType, upload.base64Data)
    if (!ref) continue
    refs.push({
      mediaType: upload.mediaType,
      ...ref,
      ...(typeof upload.fileName === 'string' && upload.fileName
        ? { fileName: upload.fileName }
        : {})
    })
  }
  return refs.length > 0 ? refs : undefined
}
