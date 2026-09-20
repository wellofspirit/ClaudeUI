/**
 * account-key.ts — the one statement of ADR-071 §3.
 *
 * An account key names a SUBSCRIPTION, not a person: one email can hold a
 * personal and a business ChatGPT plan, and the same happens on Anthropic. Each
 * has its own limits and its own bill, so each is its own account here — which
 * is why the subscription's id comes FIRST in both subscription keys.
 *
 * The key must be derivable on any machine from what the provider says, never
 * from a locally-minted vault id, because ADR-072's hub consolidates ledgers
 * from several machines and a re-keying later would mean rewriting history.
 *
 * shared/ — pure string composition, renderer-safe. The API-key rule needs a
 * SHA-256 and therefore `node:crypto`, so it lives in
 * `core/services/account-key-hash.ts`; the shape of the key it produces is
 * pinned here ({@link apiKeyAccountKeyFromDigest}) so both halves of the rule
 * are stated in one file.
 */

/** What a provider can tell us about the account a turn ran under. Display half is optional. */
export interface AccountIdentity {
  /** The machine-independent key (ADR-071 §3). Never empty — falls back to a native key. */
  accountKey: string
  /** What a person calls the account. Display only; null when we have nothing better. */
  accountLabel: string | null
}

/**
 * Rows that predate ADR-071, and rows whose account we could not establish.
 * Included in totals under an `unknown` account (owner ruling, 2026-09-20).
 */
export const UNKNOWN_ACCOUNT_KEY = 'unknown'

/**
 * The digest's domain-separation prefix. Part of the wire format: changing it
 * re-keys every stored API-key account, so it is pinned by a test vector.
 */
export const API_KEY_DIGEST_PREFIX = 'claudeui-account-key-v1:'

/** How many hex characters of the digest the key carries — 64 bits. */
export const API_KEY_DIGEST_LENGTH = 16

/**
 * A Claude subscription: `anthropic:<organizationUuid>:<accountUuid>`.
 *
 * `organizationUuid` leads because it is what separates two subscriptions held
 * by the same person; `accountUuid` stays in the key because ADR-068 records
 * the reverse case too, two people's accounts inside one organization.
 */
export function anthropicAccountKey(organizationUuid: string, accountUuid: string): string {
  return `anthropic:${organizationUuid}:${accountUuid}`
}

/**
 * A ChatGPT subscription: `chatgpt:<chatgpt_account_id>:<user>`.
 *
 * `user` is the id token's stable user claim, or the lowercased email when the
 * token carries none. With neither, the workspace half still identifies the
 * subscription, so the user half degrades to `unknown` rather than throwing the
 * whole attribution away.
 */
export function chatgptAccountKey(chatgptAccountId: string, user: string | undefined): string {
  return `chatgpt:${chatgptAccountId}:${user || UNKNOWN_ACCOUNT_KEY}`
}

/**
 * Credentials an engine holds and we cannot identify: `<engine>:<vendor>:native`.
 *
 * An opencode Anthropic oauth entry is the standing example — it carries no
 * account id, and resolving one would cost a profile call with a token that
 * belongs to opencode (ADR-071 §3).
 */
export function nativeAccountKey(engineId: string, vendorId: string): string {
  return `${engineId}:${vendorId}:native`
}

/**
 * The API-key key's shape, given a digest someone else computed:
 * `<vendor>:key:<hex16>`. {@link API_KEY_DIGEST_PREFIX} says what was hashed.
 */
export function apiKeyAccountKeyFromDigest(vendorId: string, hex16: string): string {
  return `${vendorId}:key:${hex16}`
}

/**
 * The display half of an API-key account: `<vendor> key …abcd`, the last four
 * characters of the key, as provider consoles show them.
 *
 * The suffix is shown only for a key LONGER than eight characters. This label
 * is stored on every row and travels to ADR-072's hub, so on a short key —
 * which no real provider issues, but nothing stops someone pasting — four of
 * its characters would be a meaningful fraction of the secret rather than a
 * disambiguator. Those get `<vendor> key` and nothing more; the digest still
 * tells the accounts apart.
 */
export function apiKeyAccountLabel(vendorId: string, apiKey: string): string {
  return apiKey.length > 8 ? `${vendorId} key …${apiKey.slice(-4)}` : `${vendorId} key`
}
