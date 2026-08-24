/**
 * Security decisions for files delivered through the `SendUserFile` tool
 * (ADR-043). Two consumers, one module so the rules cannot drift:
 *
 *  - `file:sent-file-preview` (desktop IPC) — may this path be read and handed
 *    back to the renderer as a `data:` image URL?
 *  - `GET /sent-file` (remote server) — is this path on the renderer's
 *    allowlist, and how must the response be labelled?
 *
 * Everything here is pure or `fs`-only (no Electron), so it unit-tests without
 * booting an app.
 */

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileBasename, isImagePath, mimeForPath } from '../shared/file-mime'
import { resolveSentFilePath } from '../shared/sent-file-path'
import { validateLocalFilePath } from './shell-security'

/**
 * Preview size cap. A `data:` URL is a base64 string that crosses the IPC
 * boundary and then lives in renderer memory ~1.33x inflated, so an unbounded
 * read is a trivial renderer OOM from model-controlled input.
 */
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024

export type PreviewCheck =
  { ok: true; path: string; mime: string; size: number } | { ok: false; error: string }

/**
 * Whether `rawPath` may be read for an inline image preview.
 *
 * Layers, in order: the shared local-file guard (absolute, non-UNC, existing
 * regular file — see {@link validateLocalFilePath}), an image-extension
 * allowlist (never render model-authored HTML/PDF), and a size cap checked by
 * `stat` BEFORE any read.
 */
export function validateImagePreview(rawPath: string): PreviewCheck {
  const base = validateLocalFilePath(rawPath)
  if (!base.ok) return base
  if (!isImagePath(base.path)) {
    return { ok: false, error: 'Preview is only available for image files' }
  }
  let size: number
  try {
    size = statSync(base.path).size
  } catch {
    return { ok: false, error: 'File does not exist' }
  }
  if (size > MAX_PREVIEW_BYTES) {
    return {
      ok: false,
      error: `Image is too large to preview (max ${Math.round(MAX_PREVIEW_BYTES / (1024 * 1024))} MB)`
    }
  }
  return { ok: true, path: base.path, mime: mimeForPath(base.path), size }
}

/** Read + encode an image preview, or explain why not. Never throws. */
export function readImagePreview(rawPath: string): { src: string } | { error: string } {
  const check = validateImagePreview(rawPath)
  if (!check.ok) return { error: check.error }
  try {
    const buf = readFileSync(check.path)
    return { src: `data:${check.mime};base64,${buf.toString('base64')}` }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Remote `/sent-file` route
// ---------------------------------------------------------------------------

/**
 * Canonical form for comparing two paths that describe the same file.
 *
 * Collapses `.`/`..`/duplicate separators, unifies separator flavour and drops
 * case on Windows. `platform` is a parameter (not a `process.platform` read) so
 * the comparison is testable deterministically on any CI host.
 */
export function normalizePathForCompare(
  p: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (!p) return ''
  if (platform === 'win32') {
    return path.win32.normalize(p.replace(/\//g, '\\')).replace(/\\+$/, '').toLowerCase()
  }
  return path.posix.normalize(p).replace(/\/+$/, '')
}

/**
 * Renderer-authoritative allowlist: return the resolved path of the `sentFiles`
 * entry that `requested` refers to, or `null`.
 *
 * The RETURNED value is the path derived from the snapshot (cwd + stored
 * entry), never the caller's string — so even an exotic-but-equivalent request
 * spelling can only ever open a file the renderer explicitly listed.
 */
export function matchSentFilePath(
  cwd: string,
  entries: ReadonlyArray<{ path: string }>,
  requested: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const want = normalizePathForCompare(requested, platform)
  if (!want) return null
  for (const entry of entries) {
    if (!entry?.path) continue
    const abs = resolveSentFilePath(cwd, entry.path)
    if (normalizePathForCompare(abs, platform) === want) return abs
  }
  return null
}

/** Drop every C0 control char and DEL (loop, not regex — see `no-control-regex`). */
function stripControlChars(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) continue
    out += s[i]
  }
  return out
}

/**
 * Header-safe filename. Strips control characters (header injection via CR/LF),
 * quotes and backslashes (they would terminate/escape the quoted-string).
 */
export function sanitizeHeaderFilename(name: string): string {
  const cleaned = stripControlChars(name).replace(/["\\]/g, '').trim()
  return cleaned || 'download'
}

export interface SentFileDisposition {
  contentType: string
  contentDisposition: string
  /** True when the response renders in place rather than downloading. */
  inline: boolean
}

/**
 * Content-Type + Content-Disposition for a `/sent-file` response.
 *
 * `inline` is honoured ONLY for image types. Everything else — HTML above all —
 * is forced to `attachment`: serving model-authored HTML inline from the remote
 * origin would be same-origin script execution next to the WS token.
 */
export function sentFileDisposition(
  filePath: string,
  inlineRequested: boolean
): SentFileDisposition {
  const contentType = mimeForPath(filePath)
  const inline = inlineRequested && isImagePath(filePath)
  const raw = fileBasename(filePath)
  const ascii = sanitizeHeaderFilename(raw.replace(/[^\x20-\x7e]/g, '_'))
  // RFC 6266: quoted ASCII fallback + a UTF-8 `filename*` for the real name.
  const star = encodeURIComponent(stripControlChars(raw))
  return {
    contentType,
    contentDisposition: `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${star}`,
    inline
  }
}
