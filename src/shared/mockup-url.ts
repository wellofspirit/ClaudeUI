/**
 * Pure URL-builder for the `mockup-asset://` scheme. Shared between main
 * (protocol handler unit tests) and renderer (iframe src attribute).
 *
 * Scheme layout (per-mockup sub-origin for storage isolation):
 *   mockup-asset://<id>.m/<b64cwd>/[<subpath>][?dark=1&v=<n>&parent=<encoded>]
 *
 * Each mockup id becomes its own browser origin, so localStorage / cookies
 * etc. are scoped per-mockup. `b64cwd` stays in the path (not the hostname)
 * so long POSIX paths don't exceed DNS label limits (63 chars).
 */

export const MOCKUP_ASSET_SCHEME = 'mockup-asset'

/**
 * Canonical mockup-id shape: an 8-char lowercase hex string (4 random bytes).
 * The id is interpolated verbatim into the privileged scheme's HOSTNAME
 * (`<id>.m`), which is what browsers key origin/storage isolation on. A
 * malformed id (containing `/`, `?`, `@`, `.`, uppercase, …) could smuggle
 * extra authority/path/query segments into the URL or collapse two mockups
 * onto one origin, defeating the per-mockup isolation this scheme exists for.
 * The protocol/route side already rejects anything but this shape, so a build
 * that produces a non-conforming id is broken regardless — fail fast here at
 * construction time rather than emitting a URL that silently 404s or leaks.
 */
const MOCKUP_ID_RE = /^[a-f0-9]{8}$/

function assertValidMockupId(id: string): void {
  if (!MOCKUP_ID_RE.test(id)) {
    throw new Error(`Invalid mockup id: ${JSON.stringify(id)} (must match ${MOCKUP_ID_RE})`)
  }
}

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  // btoa is available in renderers and modern Node (>= 16).
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface BuildMockupUrlOpts {
  dark?: boolean
  version?: number
  /**
   * Origin of the parent window (renderer). Embedded so the mockup's
   * bootstrap script can target it with postMessage instead of using '*'.
   */
  parentOrigin?: string
}

export function buildMockupUrl(cwd: string, id: string, opts?: BuildMockupUrlOpts): string {
  assertValidMockupId(id)
  const b64 = toBase64Url(cwd)
  const params = new URLSearchParams()
  if (opts?.dark) params.set('dark', '1')
  if (opts?.version !== undefined) params.set('v', String(opts.version))
  if (opts?.parentOrigin) params.set('parent', opts.parentOrigin)
  const qs = params.toString()
  return `${MOCKUP_ASSET_SCHEME}://${id}.m/${b64}/${qs ? `?${qs}` : ''}`
}

/**
 * Origin string for a given mockup id, per the WHATWG URL spec. Used by the
 * renderer-side message bridge to validate `event.origin`.
 */
export function mockupOriginFor(id: string): string {
  assertValidMockupId(id)
  return `${MOCKUP_ASSET_SCHEME}://${id}.m`
}

/**
 * Path prefix for the remote server's HTTP mockup route. The web client can't
 * use the privileged `mockup-asset://` scheme (it only exists in Electron), so
 * the remote server serves the same HTML + sibling assets over HTTP at
 * `/{MOCKUP_HTTP_PREFIX}/<token>/<id>/<b64cwd>/[<subpath>]`.
 */
export const MOCKUP_HTTP_PREFIX = 'mockup'

export interface BuildMockupHttpUrlOpts extends BuildMockupUrlOpts {
  /**
   * Mockup-scoped auth token (NOT the WebSocket token). It lives in the URL
   * and is therefore readable by the mockup's own scripts, so it must be a
   * dedicated low-privilege token — see the security note on the remote
   * server's mockup route.
   */
  token: string
}

/**
 * Build the HTTP URL the web client points its preview iframe at. Layout:
 *   <origin>/mockup/<token>/<id>/<b64cwd>/?parent=<origin>&dark=1&v=<n>
 *
 * The token is a PATH segment, not a query parameter: the mockup's relative
 * asset URLs (`<img src="./logo.png">`, CSS `url(...)`, `fetch('./data.json')`)
 * resolve against the document's path and drop its query string, so a query
 * token never reached the sibling-asset requests and every one of them was
 * refused. `b64cwd` stays in the path too (mirrors the protocol scheme) so the
 * server reuses the same routing/validation logic for both transports.
 */
export function buildMockupHttpUrl(
  baseOrigin: string,
  cwd: string,
  id: string,
  opts: BuildMockupHttpUrlOpts
): string {
  assertValidMockupId(id)
  const b64 = toBase64Url(cwd)
  const params = new URLSearchParams()
  if (opts.dark) params.set('dark', '1')
  if (opts.version !== undefined) params.set('v', String(opts.version))
  if (opts.parentOrigin) params.set('parent', opts.parentOrigin)
  const qs = params.toString()
  const token = encodeURIComponent(opts.token)
  return `${baseOrigin.replace(/\/$/, '')}/${MOCKUP_HTTP_PREFIX}/${token}/${id}/${b64}/${qs ? `?${qs}` : ''}`
}

/**
 * Split a `/mockup/<token>/<rest>` request path into the token and the
 * token-less path `/mockup/<rest>` that `routeHttpMockup` resolves. `null` when
 * the path is not a mockup route or carries no token segment (an empty token
 * yields `/mockup//…`, which is refused here rather than shifting the segments).
 */
export function splitMockupHttpToken(
  pathname: string
): { token: string; innerPath: string } | null {
  const prefix = `/${MOCKUP_HTTP_PREFIX}/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  return { token: rest.slice(0, slash), innerPath: prefix + rest.slice(slash + 1) }
}
