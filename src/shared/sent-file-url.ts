/**
 * Pure URL builder/parser for the remote server's delivered-file route
 * (ADR-043 §5). Shared between the web client (builds the URL) and the main
 * process (parses it), mirroring `mockup-url.ts`.
 *
 * Layout:
 *   <origin>/sent-file?session=<routingId>&path=<base64url(absPath)>&token=<t>[&inline=1]
 *
 * The path is base64url-encoded rather than percent-encoded: it is arbitrary
 * user-OS text (backslashes, `#`, `?`, `%`, unicode), and keeping it out of the
 * raw query grammar removes every "who decodes what, when" question between
 * `URLSearchParams`, proxies and the server.
 *
 * `token` is the low-privilege, file-scoped token (NOT the WS token) — see
 * `RemoteServer.fileToken`.
 */

/** Pathname of the route (no trailing slash). */
export const SENT_FILE_ROUTE = '/sent-file'

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(input: string): string | null {
  if (!BASE64URL_RE.test(input)) return null
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  // `atob` tolerates missing padding per spec, but be explicit rather than
  // depending on every runtime agreeing about it.
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    // `fatal` so malformed UTF-8 is rejected rather than silently turned into
    // U+FFFD (which would never match an allowlisted path anyway, but failing
    // loudly keeps the error path honest).
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export interface BuildSentFileUrlOpts {
  /** File-scoped token delivered over the authenticated WS in `sync-full`. */
  token: string
  /**
   * Ask for `Content-Disposition: inline` instead of `attachment`. Honoured
   * only for image types — the server forces attachment for anything else so
   * model-authored HTML can never render in the app's origin.
   */
  inline?: boolean
}

/**
 * Build the same-origin URL a remote client uses to download (or `<img>`-
 * preview) a delivered file.
 *
 * @param sessionId the session's routingId — the key the server looks up in
 *   the renderer snapshot to find the allowlisted `sentFiles`.
 * @param filePath the ALREADY cwd-resolved absolute path (see
 *   `resolveSentFilePath`); the server re-derives the same value from its own
 *   snapshot and refuses anything that does not match.
 */
export function buildSentFileUrl(
  baseOrigin: string,
  sessionId: string,
  filePath: string,
  opts: BuildSentFileUrlOpts
): string {
  const params = new URLSearchParams()
  params.set('session', sessionId)
  params.set('path', toBase64Url(filePath))
  params.set('token', opts.token)
  if (opts.inline) params.set('inline', '1')
  return `${baseOrigin.replace(/\/$/, '')}${SENT_FILE_ROUTE}?${params.toString()}`
}

export interface SentFileQuery {
  /** routingId of the session that delivered the file. */
  session: string
  /** Decoded absolute file path. */
  path: string
  /** Raw token as supplied (the caller compares it in constant time). */
  token: string
  /** `inline=1` was requested. */
  inline: boolean
}

/**
 * Parse the query of a `/sent-file` request. Returns `null` when the request is
 * structurally unusable (missing session/path, or an undecodable path) — the
 * caller answers 404 so a malformed request is indistinguishable from a miss.
 *
 * NOTE: this does NOT authenticate. The token is returned verbatim for the
 * caller's constant-time compare.
 */
export function parseSentFileQuery(params: URLSearchParams): SentFileQuery | null {
  const session = params.get('session') ?? ''
  const encodedPath = params.get('path') ?? ''
  if (!session || !encodedPath) return null
  const path = fromBase64Url(encodedPath)
  if (!path) return null
  return {
    session,
    path,
    token: params.get('token') ?? '',
    inline: params.get('inline') === '1'
  }
}
