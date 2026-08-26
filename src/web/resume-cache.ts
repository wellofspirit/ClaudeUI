/**
 * Browser-side cache for the passkey RESUMPTION TOKEN (ADR-063) — the client
 * half of the token `webauthn-service.ts` mints on every accepted assertion.
 *
 * This is the passkey's analogue of the cached password proof next door
 * (`password-proof.ts`), and it carries the same trust reading: what it holds
 * authenticates the BROWSER, never the human. A terminal act, the settings
 * session and the strong tier's mutation window still demand a live ceremony —
 * only login stickiness changes.
 *
 * `sessionStorage` and deliberately not `localStorage` (owner ruling): it
 * survives the tab discard/restore that causes the pain this exists for — Edge
 * on Android kills backgrounded tabs within minutes, and a frozen sleeping tab
 * gets swept by the server's idle cut — and it never outlives the browser
 * session. There is no "stay signed in".
 *
 * ONE key, unsalted: `sessionStorage` is already origin-scoped by the browser,
 * and the token is origin-bound server-side, so a key derived from anything else
 * would be a second copy of a fact the platform already enforces. Every accessor
 * tolerates storage being unavailable (private mode / disabled), degrading to
 * "run the ceremony every time".
 */

/** sessionStorage key for the cached resumption token. */
const RESUME_CACHE_KEY = 'claudeui-remote-resume'

/** Token shape on the wire: 32 bytes, hex — the same test the server applies. */
const RESUME_TOKEN_RE = /^[0-9a-f]{64}$/i

/**
 * The cached token, or `null` when there is none / storage is unreadable.
 *
 * Anything not shaped like a token is ignored rather than presented: a garbage
 * value would cost a round trip and an audit row to be told what this regex can
 * say for free.
 */
export function readCachedResumeToken(): string | null {
  try {
    const cached = sessionStorage.getItem(RESUME_CACHE_KEY)
    return cached && RESUME_TOKEN_RE.test(cached) ? cached : null
  } catch {
    return null
  }
}

export function writeCachedResumeToken(token: string): void {
  try {
    sessionStorage.setItem(RESUME_CACHE_KEY, token)
  } catch {
    /* non-fatal — this connection still works, the next one just re-ceremonies */
  }
}

export function clearCachedResumeToken(): void {
  try {
    sessionStorage.removeItem(RESUME_CACHE_KEY)
  } catch {
    /* nothing cached / storage disabled */
  }
}
