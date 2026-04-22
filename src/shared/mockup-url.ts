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
