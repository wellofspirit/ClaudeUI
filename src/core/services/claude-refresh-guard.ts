/**
 * ADR-071 §6's refresh rule for a Claude credentials file: at most one refresh
 * attempt per VERSION of the file, and a refusal marks the account as needing a
 * sign-in.
 *
 * This is the guard `UsageFetcher` has enforced since S2g, lifted out of the
 * class unchanged the day a second caller appeared: the token keeper
 * (`claude-host-token.ts`) refreshes the SAME active-account file the fetcher
 * reads, and two guards over one grant would each let the other re-offer a
 * token the endpoint had already refused. One instance, shared, so a refusal
 * seen by either caller stops both.
 *
 * A version is the file's mtime and size, the pair that changes when anything
 * rewrites it (a refresh, a sign-in). While it has not changed, a second refresh
 * would offer the endpoint the very token it just rejected. The guard turns back
 * on by itself the moment the file changes.
 */

import { stat } from 'node:fs/promises'
import { statSync } from 'node:fs'

/** A credentials file's version. `{ mtimeMs: 0, size: 0 }` when it is absent. */
export interface CredentialVersion {
  mtimeMs: number
  size: number
}

const ABSENT: CredentialVersion = { mtimeMs: 0, size: 0 }

/** The version of the file at `path`, or {@link ABSENT}. */
export async function credentialVersion(path: string): Promise<CredentialVersion> {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    // Not there: a read of it answers `needs-sign-in` without a request, and
    // there is no version to cache or to charge a refresh against.
    return ABSENT
  }
}

/** {@link credentialVersion}, synchronously (the login-state read, which cannot await). */
export function credentialVersionSync(path: string): CredentialVersion {
  try {
    const info = statSync(path)
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return ABSENT
  }
}

export class ClaudeRefreshGuard {
  /** The version each file was REFUSED a refresh on, by path. */
  private readonly refusedOn = new Map<string, CredentialVersion>()

  /**
   * May a read of this credentials file spend a refresh grant?
   *
   * No, while a refresh for THIS version of the file has already been POSTed and
   * refused: the endpoint has seen that token and said no, and nothing has
   * rewritten the file since, so offering it again only spends grants.
   *
   * A MISSING file has no version to latch (round 2, R4). `{0, 0}` is what
   * {@link credentialVersion} answers for one, and latching it would mean that
   * in single-account Keychain mode, where the credential lives in the Keychain
   * and the file legitimately does not exist, one refused refresh disabled every
   * later refresh for the life of the process.
   */
  allowed(path: string, version: CredentialVersion): boolean {
    if (version.mtimeMs <= 0) return true
    const refused = this.refusedOn.get(path)
    return !(refused?.mtimeMs === version.mtimeMs && refused.size === version.size)
  }

  /** Remember a refused refresh, so {@link allowed} stops offering it. */
  note(result: { refreshFailed?: boolean }, path: string, version: CredentialVersion): void {
    if (version.mtimeMs <= 0) return
    if (result.refreshFailed) this.refusedOn.set(path, version)
  }

  /** Forget every refusal (test isolation only). */
  reset(): void {
    this.refusedOn.clear()
  }
}

/** The one guard every Claude refresh in this process goes through. */
export const claudeRefreshGuard = new ClaudeRefreshGuard()
