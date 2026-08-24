/**
 * UTF-8 ⇄ base64 for text that travels on the wire, usable from BOTH the main
 * process and the browser bundle.
 *
 * PTY output is the reason this exists (SyncCore phase 2): terminal bytes are
 * base64-framed rather than embedded as raw JSON strings, because a shell can
 * emit anything — including sequences that survive `JSON.stringify` only after
 * lossy escaping, and control characters that would otherwise have to be
 * quoted on every frame.
 *
 * Node gets the `Buffer` fast path; the browser falls back to
 * TextEncoder/TextDecoder + `btoa`/`atob`. The binary-string step is CHUNKED —
 * `String.fromCharCode(...bytes)` on a 200 KB scrollback replay would blow the
 * argument limit (RangeError: too many function arguments).
 */

/** Max bytes handed to one `String.fromCharCode` spread call. */
const BINARY_CHUNK = 0x8000

export function textToBase64(text: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64')
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += BINARY_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BINARY_CHUNK))
  }
  return btoa(binary)
}

export function base64ToText(b64: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
