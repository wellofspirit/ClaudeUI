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
  return `${MOCKUP_ASSET_SCHEME}://${id}.m`
}

/**
 * Path prefix for the remote server's HTTP mockup route. The web client can't
 * use the privileged `mockup-asset://` scheme (it only exists in Electron), so
 * the remote server serves the same HTML + sibling assets over HTTP at
 * `/{MOCKUP_HTTP_PREFIX}/<id>/<b64cwd>/[<subpath>]`.
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
 *   <origin>/mockup/<id>/<b64cwd>/?token=<t>&parent=<origin>&dark=1&v=<n>
 *
 * `b64cwd` stays in the path (mirrors the protocol scheme) so the server can
 * reuse the same routing/validation logic for both transports.
 */
export function buildMockupHttpUrl(
  baseOrigin: string,
  cwd: string,
  id: string,
  opts: BuildMockupHttpUrlOpts
): string {
  const b64 = toBase64Url(cwd)
  const params = new URLSearchParams()
  params.set('token', opts.token)
  if (opts.dark) params.set('dark', '1')
  if (opts.version !== undefined) params.set('v', String(opts.version))
  if (opts.parentOrigin) params.set('parent', opts.parentOrigin)
  return `${baseOrigin.replace(/\/$/, '')}/${MOCKUP_HTTP_PREFIX}/${id}/${b64}/?${params.toString()}`
}
