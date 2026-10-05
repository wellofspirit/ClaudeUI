/**
 * Read-only access to opencode's own credential store (`<dataDir>/auth.json`).
 *
 * Extracted so both OpencodeAuthProvider (which owns writes) and
 * model-discovery (which needs "does a credential exist?" to decide whether
 * Remove is available) can read it without an import cycle — OpencodeAuthProvider
 * already imports invalidateOpencodeModelCache from model-discovery, so the
 * dependency cannot run the other way.
 *
 * Never returns key or token material — only which vendor ids have an entry and
 * of what kind.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { deepEqual, isPlainObject } from '../../shared/opencode-config-diff'

/**
 * opencode's auth store path. The data dir mirrors opencode's own resolution —
 * `$XDG_DATA_HOME/opencode`, falling back to `~/.local/share/opencode` (opencode
 * uses XDG paths even on Windows; same resolution as resolveOpencodeDbPath in
 * services/opencode-session-list.ts). Env is read at call time so tests can
 * point it at a temp dir.
 */
export function resolveOpencodeAuthJsonPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(dataHome, 'opencode', 'auth.json')
}

/**
 * Which vendor ids currently have stored credentials, and of what kind.
 *
 * Why the file and not an endpoint: opencode exposes no way to READ stored
 * credentials (only PUT/DELETE /auth/{id}), and GET /config/providers reports a
 * custom provider as configured the moment it is declared in opencode.json —
 * with or without a key — so the auth store is the only truthful source.
 *
 * opencode's entry types are 'api' | 'oauth' | 'wellknown'; anything non-oauth
 * is reported as 'api' (a stored secret of some kind). Missing or unparseable
 * file → {} (opencode is optional).
 */
export async function readOpencodeCredentialTypes(): Promise<Record<string, 'api' | 'oauth'>> {
  try {
    const raw = await fs.promises.readFile(resolveOpencodeAuthJsonPath(), 'utf-8')
    return parseCredentialTypes(raw)
  } catch {
    return {}
  }
}

/**
 * Whether `vendorId`'s stored entry is already exactly `entry` — so a writer can
 * skip a write that would change nothing (and the model-cache invalidation and
 * server recycle that come with it). Read at call time, never cached: opencode
 * itself rewrites this file (an OAuth refresh), and an old copy would let a
 * real change be skipped.
 *
 * Answers a boolean, so this module still hands out no key material. A missing
 * or unreadable file, or an absent entry, is `false`: the caller writes as it
 * would have, through whatever corrupt-file discipline its own path has.
 */
export async function opencodeAuthEntryEquals(vendorId: string, entry: unknown): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.promises.readFile(resolveOpencodeAuthJsonPath(), 'utf-8')
    )
    return isPlainObject(parsed) && deepEqual(parsed[vendorId], entry)
  } catch {
    return false
  }
}

/** Synchronous twin of readOpencodeCredentialTypes for sync-only call paths. */
export function readOpencodeCredentialTypesSync(): Record<string, 'api' | 'oauth'> {
  try {
    return parseCredentialTypes(fs.readFileSync(resolveOpencodeAuthJsonPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function parseCredentialTypes(raw: string): Record<string, 'api' | 'oauth'> {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, 'api' | 'oauth'> = {}
  for (const [vendorId, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'object' || entry === null) continue
    out[vendorId] = (entry as { type?: unknown }).type === 'oauth' ? 'oauth' : 'api'
  }
  return out
}
