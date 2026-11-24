/**
 * Saved media files by job id (Critical: the remote file route and `blob:get`'s re-intern read the disk).
 *
 * Neither takes a path from a client: a job id names a ledger row, the row names the file, and the file
 * is served only while it is still a regular file inside the roots of the session that made it
 * (`media-path.ts`, the check the write made). An unknown id, a job that did not complete, a file that
 * moved, shrank into a link or left the roots all answer "nothing".
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import type http from 'node:http'
import { resolveAdditionalDirectories } from './additional-directories'
import { blobStore } from './blob-store'
import { logger } from './logger'
import { mediaJobLedger, type MediaJobLedgerStore } from './media-job-ledger'
import { isInsideMediaRoots, mimeForExt } from './media-path'
import { mergedClaudeRulesFor } from '../pi/permission-engine'

/** Largest media file a lazy re-intern puts back into the blob store. */
export const MEDIA_REINTERN_MAX_BYTES = 64 * 1024 * 1024

export interface MediaFileDeps {
  ledger: Pick<MediaJobLedgerStore, 'get' | 'getByBlobHash'>
  additionalDirectories(cwd: string): string[]
}

const defaultDeps: MediaFileDeps = {
  ledger: mediaJobLedger,
  additionalDirectories: (cwd) =>
    resolveAdditionalDirectories(mergedClaudeRulesFor(cwd).additionalDirectories, cwd)
}

export interface MediaFileInfo {
  path: string
  mime: string
  size: number
}

/** The file of a completed job, or null when the id is unknown or the file is no longer servable. */
export function resolveMediaFile(
  jobId: string,
  deps: MediaFileDeps = defaultDeps
): MediaFileInfo | null {
  try {
    const row = deps.ledger.get(jobId)
    if (!row || row.status !== 'completed') return null
    const ctx = { cwd: row.cwd, additionalDirectories: deps.additionalDirectories(row.cwd) }
    if (!isInsideMediaRoots(ctx, row.path)) return null
    const real = fs.realpathSync.native(row.path)
    if (!isInsideMediaRoots(ctx, real)) return null
    const stat = fs.statSync(real)
    if (!stat.isFile()) return null
    const mime = mimeForExt(real) ?? row.mime
    if (!mime) return null
    return { path: real, mime, size: stat.size }
  } catch {
    return null
  }
}

/**
 * A `blob:get` miss for a media blob: the blob store is memory-only, so a result from a previous run
 * (or one evicted) is read back from its saved file. The file must still hash to the blob id; the store
 * then holds it again. False when nothing was put back (the card keeps its "unavailable" state).
 */
export function reinternMediaBlob(blobId: string, deps: MediaFileDeps = defaultDeps): boolean {
  try {
    const row = deps.ledger.getByBlobHash(blobId)
    if (!row) return false
    const file = resolveMediaFile(row.id, deps)
    if (!file || file.size > MEDIA_REINTERN_MAX_BYTES) return false
    const bytes = fs.readFileSync(file.path)
    if (bytes.length > MEDIA_REINTERN_MAX_BYTES) return false
    if (createHash('sha256').update(bytes).digest('hex') !== blobId) return false
    return blobStore.putBytes(file.mime, bytes) !== null
  } catch (err) {
    logger.warn('MediaFiles', `re-interning blob ${blobId.slice(0, 8)} failed: ${String(err)}`)
    return false
  }
}

/** A single byte range of `size` bytes: `null` = no usable header (serve all), `'invalid'` = 416. */
export function parseByteRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  // Multiple ranges and other units are ignored: the whole file is a valid answer.
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (size === 0 || start >= size || start > end) return 'invalid'
  return { start, end }
}

/**
 * Answer a GET/HEAD for `file` with content type, `Accept-Ranges` and a single HTTP Range. `extra` are
 * the caller's security headers.
 */
export function serveMediaFile(
  req: Pick<http.IncomingMessage, 'method' | 'headers'>,
  res: http.ServerResponse,
  file: MediaFileInfo,
  extra: Record<string, string> = {}
): void {
  const headers = {
    'Content-Type': file.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ...extra
  }
  const range = parseByteRange(req.headers.range, file.size)
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}` })
    res.end()
    return
  }
  const [status, start, end] = range ? [206, range.start, range.end] : [200, 0, file.size - 1]
  res.writeHead(status, {
    ...headers,
    'Content-Length': String(file.size === 0 ? 0 : end - start + 1),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {})
  })
  if (req.method === 'HEAD' || file.size === 0) {
    res.end()
    return
  }
  const stream = fs.createReadStream(file.path, { start, end })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
