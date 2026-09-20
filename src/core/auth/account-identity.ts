/**
 * account-identity.ts — naming the account an opencode or pi turn ran under.
 *
 * ADR-071 §3's "opencode and pi accounts need no patch": the identity is
 * already on disk in the engine's own `auth.json`, so a row can be attributed
 * without asking the engine anything. Both engines store the same two shapes
 * per vendor — an oauth entry, or an entry carrying a key — so the rule is one
 * function here, parameterised by the engine id and by which vendor id is that
 * engine's ChatGPT provider (`openai` on opencode, `openai-codex` on pi).
 *
 * CREDENTIAL BOUNDARY. This module is the only place that reads those files for
 * metering, and it returns nothing but `{ accountKey, accountLabel }`. It never
 * logs, never throws with anything it read, and hands key material to exactly
 * one function ({@link apiKeyAccountKey}), which keeps only a digest and the
 * last four characters. An access token is parsed for its identity claims —
 * account id, user, email, plan — and the token itself goes no further: the
 * cache below keeps identities only, never the parsed file.
 */

import fs from 'fs'
import { chatgptAccountKey, nativeAccountKey, type AccountIdentity } from '../../shared/account-key'
import { apiKeyAccountKey } from '../services/account-key-hash'
import { extractAccountId, extractEmail, extractPlanType, extractUserId } from './vault/codex-oauth'

/** One vendor's entry as either engine's auth.json stores it. Untyped JSON, read defensively. */
interface AuthEntryShape {
  type?: unknown
  key?: unknown
  access?: unknown
  accountId?: unknown
}

/**
 * Resolve one vendor's account identity from its auth.json entry.
 *
 * - a ChatGPT oauth entry → `chatgpt:<subscription>:<user>`, the same key the
 *   Codex engine derives for the same subscription, so usage through any of
 *   the three engines lands on one account. The subscription id is the stored
 *   `accountId` when the engine persists one (opencode does) and the token's
 *   own `chatgpt_account_id` claim when it does not (pi);
 * - any entry carrying a key → the API-key digest;
 * - everything else, including an Anthropic oauth entry (which carries no
 *   account id in either place) → `<engine>:<vendor>:native`.
 */
export function accountIdentityFromAuthEntry(params: {
  engineId: string
  vendorId: string
  /** True when this vendor id is the engine's ChatGPT provider. */
  isChatgptVendor: boolean
  entry: unknown
}): AccountIdentity {
  const { engineId, vendorId, isChatgptVendor } = params
  const native: AccountIdentity = {
    accountKey: nativeAccountKey(engineId, vendorId),
    accountLabel: vendorId
  }

  const entry = params.entry
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return native
  const e = entry as AuthEntryShape

  if (e.type === 'oauth') {
    if (!isChatgptVendor) return native
    const accessToken = typeof e.access === 'string' ? e.access : undefined
    // The stored id first (opencode persists it), then the token's own claim
    // (pi does not persist one, but its access token is the same JWT). Only a
    // subscription we cannot name either way falls through to the native key.
    const accountId =
      (typeof e.accountId === 'string' ? e.accountId : '') ||
      (accessToken ? (extractAccountId({ access_token: accessToken }) ?? '') : '')
    if (!accountId) return native
    return chatgptIdentity(accountId, accessToken)
  }

  // A non-oauth entry carrying a `key`: 'api' on opencode, 'api_key' on pi,
  // and whatever a future version calls it. The same "anything non-oauth is a
  // key" idiom both providers' credential-type reads already use.
  //
  // `key` is NOT always the secret. On opencode's `wellknown` shape the secret
  // is `token` and `key` is a client id — a stable per-provider identifier,
  // not a credential. Digesting it still produces a stable account for that
  // provider, which is the right answer for one person's ledger, but it is a
  // different fact from the one an `api` entry states.
  if (typeof e.key === 'string' && e.key.length > 0) return apiKeyAccountKey(vendorId, e.key)

  return native
}

/**
 * The ChatGPT half: the user claim, or the lowercased email when the token
 * carries none. The label is the email with the plan beside it, so two
 * subscriptions under one email can be told apart on screen.
 */
function chatgptIdentity(accountId: string, accessToken: string | undefined): AccountIdentity {
  const tokens = { access_token: accessToken }
  const email = accessToken ? extractEmail(tokens) : undefined
  const plan = accessToken ? extractPlanType(tokens) : undefined
  const user = (accessToken ? extractUserId(tokens) : undefined) ?? email?.toLowerCase()

  const name = email ?? 'ChatGPT'
  return {
    accountKey: chatgptAccountKey(accountId, user),
    accountLabel: plan ? `${name} (${plan})` : name
  }
}

/**
 * One engine's auth.json, read on demand and cached, so a sign-in change
 * between turns attributes each turn to the account that ran it.
 *
 * What is CACHED is the derived identities and nothing else. Every entry in
 * the file is resolved on the read and the parsed object is dropped, so no
 * token or key survives in a long-lived object for the sake of a lookup that
 * only ever wants a key and a label.
 *
 * The read is synchronous because a usage row is written from a synchronous
 * path, and it is one small local file. The cache key is the file's mtime AND
 * its size: mtime alone would miss a rewrite that lands in the same
 * millisecond, and a missed rewrite mis-attributes every later row for the
 * life of the process.
 */
export class AuthFileIdentityCache {
  private cache: {
    path: string
    /** mtime and size together — see the class comment on why not mtime alone. */
    stamp: string
    byVendor: Map<string, AccountIdentity>
  } | null = null

  constructor(
    private readonly engineId: string,
    private readonly resolvePath: () => string,
    private readonly chatgptVendorId: string
  ) {}

  /** This vendor's identity. A missing, unreadable or corrupt file gives the native key. */
  identity(vendorId: string): AccountIdentity {
    const path = this.resolvePath()

    let stamp: string
    try {
      const stat = fs.statSync(path)
      stamp = `${stat.mtimeMs}:${stat.size}`
    } catch {
      // No file to read — every vendor the engine holds is unidentifiable.
      this.cache = null
      return this.native(vendorId)
    }

    if (!this.cache || this.cache.path !== path || this.cache.stamp !== stamp) {
      this.cache = { path, stamp, byVendor: this.readIdentities(path) }
    }

    // A vendor with no entry has no identity to cache — it is native by
    // absence, and stays so until the file changes.
    return this.cache.byVendor.get(vendorId) ?? this.native(vendorId)
  }

  /** Resolve every entry in the file, then let the parsed file go out of scope. */
  private readIdentities(path: string): Map<string, AccountIdentity> {
    const byVendor = new Map<string, AccountIdentity>()
    for (const [vendorId, entry] of Object.entries(readJsonObject(path))) {
      byVendor.set(
        vendorId,
        accountIdentityFromAuthEntry({
          engineId: this.engineId,
          vendorId,
          isChatgptVendor: vendorId === this.chatgptVendorId,
          entry
        })
      )
    }
    return byVendor
  }

  private native(vendorId: string): AccountIdentity {
    return { accountKey: nativeAccountKey(this.engineId, vendorId), accountLabel: vendorId }
  }
}

/**
 * Parse the file, or give back nothing. A corrupt file caches as an EMPTY read
 * against its stamp rather than re-parsing on every row; nothing is logged,
 * because the only thing there is to say would come out of a credential file.
 */
function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Missing, unreadable or malformed — the native key is the honest answer.
  }
  return {}
}
