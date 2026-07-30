/**
 * Extension → MIME mapping shared by every surface that serves or previews a
 * file delivered through the `SendUserFile` tool (ADR-043):
 *
 *  - main's `file:sent-file-preview` IPC (data-URL preview),
 *  - the remote server's `/sent-file` route (Content-Type + inline decision),
 *  - the renderer widget (does this row get a thumbnail?).
 *
 * Deliberately dependency-free (no `node:path`) so it can live in `src/shared`
 * and be bundled into the web client as well as the main process.
 */

/**
 * Extensions we are willing to render as an image. Everything else is treated
 * as opaque data — in particular HTML and PDF are NEVER rendered inline, since
 * doing so would execute model-authored markup inside an app origin (ADR-043
 * §4).
 */
export const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.avif',
  '.ico'
] as const

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon'
}

/** Non-image types worth naming; anything unknown falls back to octet-stream. */
const OTHER_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

export const DEFAULT_MIME = 'application/octet-stream'

/** Last path segment, handling both separator flavours. */
export function fileBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]) return parts[i]
  }
  return filePath
}

/**
 * Lowercased extension including the dot (`".png"`), or `''`. A leading dot
 * (dotfile) is NOT an extension — `.gitignore` has none.
 */
export function fileExtension(filePath: string): string {
  const base = fileBasename(filePath)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

/** True when the path's extension is in {@link IMAGE_EXTENSIONS}. */
export function isImagePath(filePath: string): boolean {
  return fileExtension(filePath) in IMAGE_MIME
}

/** MIME type for a path's extension, or {@link DEFAULT_MIME}. */
export function mimeForPath(filePath: string): string {
  const ext = fileExtension(filePath)
  return IMAGE_MIME[ext] ?? OTHER_MIME[ext] ?? DEFAULT_MIME
}
