/**
 * Expected blob refs for tests (ADR-087).
 *
 * Every producer interns image bytes into the host's blob store and puts
 * `{ blobId, bytes }` on the transcript instead of the base64. A test that feeds
 * a decoder some base64 asserts the ref it must come back with; computing it here
 * (the SHA-256 of the decoded bytes, the decoded length) keeps those assertions
 * independent of the store they are checking.
 */
import { createHash } from 'node:crypto'
import { blobStore } from '../../core/services/blob-store'

/** The ref the store hands out for these base64 bytes. */
export function blobRefOf(base64Data: string): { blobId: string; bytes: number } {
  const bytes = Buffer.from(base64Data, 'base64')
  return { blobId: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}

/** The base64 the store currently holds for a ref, or undefined when it holds nothing. */
export function storedBase64(blobId: string): string | undefined {
  return blobStore.get(blobId)?.data.toString('base64')
}
