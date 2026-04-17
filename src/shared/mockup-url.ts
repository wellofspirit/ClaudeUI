/**
 * Pure URL-builder for the `mockup-asset://` scheme. Shared between main
 * (protocol handler unit tests) and renderer (iframe src attribute).
 *
 * Scheme layout:
 *   mockup-asset://tailwind.css/
 *   mockup-asset://m/<b64cwd>/<id>/[?dark=1][&v=<n>]
 */

export const MOCKUP_ASSET_SCHEME = 'mockup-asset'

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  // btoa is available in renderers and modern Node (>= 16).
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function buildMockupUrl(
  cwd: string,
  id: string,
  opts?: { dark?: boolean; version?: number }
): string {
  const b64 = toBase64Url(cwd)
  const params = new URLSearchParams()
  if (opts?.dark) params.set('dark', '1')
  if (opts?.version !== undefined) params.set('v', String(opts.version))
  const qs = params.toString()
  return `${MOCKUP_ASSET_SCHEME}://m/${b64}/${id}/${qs ? `?${qs}` : ''}`
}
