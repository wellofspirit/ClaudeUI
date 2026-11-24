import { protocol } from 'electron'
import * as fs from 'fs'
import { Readable } from 'stream'
import { MEDIA_PROTOCOL_SCHEME } from '../../shared/media-protocol-url'
import { MEDIA_JOB_ID_RE } from '../../shared/sent-file-url'
import {
  parseByteRange,
  resolveMediaFile,
  type MediaFileInfo
} from '../../core/services/media-files'

/** `claudeui-media://job/<id>` → the job id, or null for anything else (other host, extra path, bad id). */
export function parseMediaProtocolUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== `${MEDIA_PROTOCOL_SCHEME}:` || url.hostname !== 'job') return null
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
    return MEDIA_JOB_ID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
}

/** Response twin of `serveMediaFile` (media-files.ts): single Range, HEAD, 416. */
export function mediaFileResponse(
  method: string,
  rangeHeader: string | null,
  file: MediaFileInfo
): Response {
  const headers: Record<string, string> = {
    'Content-Type': file.mime,
    'Accept-Ranges': 'bytes',
    ...SECURITY_HEADERS
  }
  const range = parseByteRange(rangeHeader ?? undefined, file.size)
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${file.size}` }
    })
  }
  const [status, start, end] = range ? [206, range.start, range.end] : [200, 0, file.size - 1]
  headers['Content-Length'] = String(file.size === 0 ? 0 : end - start + 1)
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`
  if (method === 'HEAD' || file.size === 0) return new Response(null, { status, headers })
  const body = Readable.toWeb(fs.createReadStream(file.path, { start, end })) as ReadableStream
  return new Response(body, { status, headers })
}

export function handleMediaRequest(
  request: Pick<Request, 'url' | 'method' | 'headers'>,
  resolve: typeof resolveMediaFile = resolveMediaFile
): Response {
  const id = parseMediaProtocolUrl(request.url)
  const file = id ? resolve(id) : null
  if (!file) return new Response(null, { status: 404, headers: SECURITY_HEADERS })
  return mediaFileResponse(request.method, request.headers.get('range'), file)
}

/**
 * The scheme's privileges. `registerSchemesAsPrivileged` replaces its previous call, so this is
 * listed in the one call in `registerMockupAssetScheme`. `stream` is what lets `<video>` play.
 */
export const MEDIA_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: MEDIA_PROTOCOL_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}

export function registerMediaHandler(): void {
  protocol.handle(MEDIA_PROTOCOL_SCHEME, (request) => handleMediaRequest(request))
}
