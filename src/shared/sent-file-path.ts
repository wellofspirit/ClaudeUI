/**
 * Path resolution for files delivered by the `SendUserFile` tool.
 *
 * Extracted from `SentFilesWidget` so the remote server's `/sent-file`
 * allowlist resolves stored entries EXACTLY the way the renderer does — the
 * two must agree byte-for-byte or a legitimate download 404s (ADR-043 §5).
 * Pure string logic, no `node:path`, so it bundles into the web client too.
 */

/** True for `/x`, `\x`, and `C:\x` / `C:/x` — i.e. anything not cwd-relative. */
export function isAbsoluteLike(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
}

/**
 * Resolve a `SendUserFile` path against the session cwd.
 *
 * cli.js accepts cwd-relative paths and resolves them itself, but the tool
 * INPUT we observe on the wire keeps whatever the model wrote. The main process
 * refuses relative paths outright (it would resolve them against its own cwd),
 * so join here against the session cwd, preserving the cwd's separator flavour.
 * Absolute inputs pass through untouched — main is still the validating side.
 */
export function resolveSentFilePath(cwd: string, filePath: string): string {
  if (isAbsoluteLike(filePath)) return filePath
  if (!cwd) return filePath
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
  const base = cwd.replace(/[\\/]+$/, '')
  const rel = filePath.replace(/^\.[\\/]/, '')
  return `${base}${sep}${rel}`
}
