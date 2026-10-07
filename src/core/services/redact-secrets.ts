/**
 * Make an error text safe for a log line when it may echo a secret — an
 * opencode API error body (`OpencodeApiError` embeds up to 500 characters of
 * it) or a token endpoint's answer. Pattern-based, so it needs no list of the
 * secrets in play: anything shaped like a bearer, a JWT, an API key or a long
 * opaque token is replaced, and the text is capped.
 *
 * Words such as `invalid_grant` and status codes survive (classify BEFORE
 * redacting anyway).
 */
export const LOG_TEXT_CAP = 300

const PATTERNS: readonly RegExp[] = [
  // `Bearer <anything>` / `Basic <anything>`
  /\b(?:Bearer|Basic)\s+[^\s"',;]+/gi,
  // JWTs (three base64url segments), with or without the `eyJ` header
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
  // Provider keys: sk-…, sk-ant-…, sk-or-…, rk-…, ghp_…, gho_…, xox…
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{6,}/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat|xox[abpr])_[A-Za-z0-9_-]{6,}/g,
  // JSON fields that carry secrets, whatever their value looks like
  /("(?:access|refresh|key|token|access_token|refresh_token|id_token|apiKey|api_key|password)"\s*:\s*)"[^"]*"/gi,
  // Any other long opaque run (base64/hex) — a token by its shape
  /\b[A-Za-z0-9+/_=-]{32,}\b/g
]

export function redactSecrets(text: string, cap = LOG_TEXT_CAP): string {
  let out = text
  for (const pattern of PATTERNS)
    out = out.replace(pattern, (_match, prefix?: unknown) =>
      typeof prefix === 'string' && pattern.source.startsWith('("')
        ? `${prefix}"[redacted]"`
        : '[redacted]'
    )
  return out.length > cap ? `${out.slice(0, cap)}…` : out
}

/** An error's message, redacted and capped, for a log line. */
export function logSafeError(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err))
}
