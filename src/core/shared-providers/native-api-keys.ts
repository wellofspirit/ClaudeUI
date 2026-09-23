/**
 * native-api-keys.ts — reading the API keys an engine already holds, for
 * adoption into a catalog definition (ADR-074 §6).
 *
 * CREDENTIAL BOUNDARY. This is the one place a raw key is read out of an
 * engine's own `auth.json`, and it runs in the MAIN process only: the caller is
 * `SharedProviderService.adoptNativeKey`, which puts the key in the vault and
 * nowhere else. Nothing here logs, throws with, or returns anything read from the
 * file except through {@link NativeApiKeyReader.readApiKey}; a parse failure is
 * reported as "no keys", never as the content that failed to parse.
 *
 * Only a PLAIN api-key entry counts — `{type:'api', key}` on opencode,
 * `{type:'api_key', key}` on pi. opencode's `wellknown` entry also carries a
 * `key`, but that is a client id, not the secret; and every OAuth entry is an
 * engine-owned sign-in that is never shared (ADR-074 §6).
 */
import * as fs from 'node:fs'

export interface NativeApiKeyReader {
  /** Vendor ids holding a plain API-key entry. [] when the file is absent or unreadable. */
  listApiKeyVendorIds(): string[]
  /** That vendor's raw key, or null when it has no plain API-key entry. MAIN PROCESS ONLY. */
  readApiKey(vendorId: string): string | null
}

/** A reader over one engine's `auth.json`, re-read on every call (a cheap local file). */
export function authJsonApiKeyReader(
  filePath: () => string,
  apiType: 'api' | 'api_key'
): NativeApiKeyReader {
  const entries = (): Record<string, string> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(filePath(), 'utf-8'))
    } catch {
      return {}
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [vendorId, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') continue
      const { type, key } = entry as { type?: unknown; key?: unknown }
      if (type === apiType && typeof key === 'string' && key.length > 0) out[vendorId] = key
    }
    return out
  }
  return {
    listApiKeyVendorIds: () => Object.keys(entries()),
    readApiKey: (vendorId) => entries()[vendorId] ?? null
  }
}

/**
 * The only part of a key that may leave the main process: its last four
 * characters, as a provider console shows them. A key of eight characters or
 * fewer shows nothing — four of eight is half the secret.
 */
export function keyHint(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : '…'
}
