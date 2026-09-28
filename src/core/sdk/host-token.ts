/**
 * Host-owned OAuth tokens for cli.js spawns (multi-account, ADR-015).
 *
 * In multi-account mode the app owns each account's credentials file
 * (`~/.claude/ui/accounts/<id>/.credentials.json`) and hands cli.js the active
 * account's access token through the environment, the contract Claude Desktop
 * uses: `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1`, and
 * cli.js asks us for a fresh one with `oauth_token_refresh` on a 401
 * (docs/protocol-cc/08 §8.7). cli.js never refreshes or persists an
 * env-supplied token, so keeping it fresh is the host's job: the token keeper,
 * `core/services/claude-host-token.ts`.
 *
 * This module is the seam between the two layers, in the shape of
 * `endpoint-env.ts` / `securestorage-env.ts`: the SDK layer (`buildEnv`,
 * `query()`) reads the token and registers each live process through a
 * {@link HostTokenSource}, which the keeper publishes at boot. The SDK layer
 * never imports the service layer.
 *
 * FAIL CLOSED. With multi-account on, a spawn that cannot be given the active
 * account's token throws {@link HostTokenUnavailableError}. It never falls
 * through to the machine's default Claude login, which belongs to whoever ran
 * `claude` in a terminal, not to the account the user picked.
 */

import { getEndpointEnv } from './endpoint-env'
import { getSecurestorageEnv } from './securestorage-env'
import type { OAuthTokenAnswer } from './types'

/** What a spawn's env carries from the active account's stored credential. */
export interface HostTokenCredential {
  accessToken: string
  /** The credential's granted scopes → `CLAUDE_CODE_OAUTH_SCOPES` (space-separated). */
  scopes: string[]
  subscriptionType: string | null
  rateLimitTier: string | null
}

/**
 * One live cli.js process running on a host token: the account dir it was
 * spawned for, and the token it holds now. `query()` creates it and registers it
 * with the source for the life of the process.
 */
export interface HostTokenSession {
  readonly dir: string
  /** The access token this process holds. Updated on every token handed to it. */
  token: string
  /**
   * Hand the process a new token (`update_environment_variables`). Resolves
   * whether cli.js acknowledged it; never rejects.
   */
  push(token: string): Promise<boolean>
}

/** The token keeper, as the SDK layer sees it. */
export interface HostTokenSource {
  /** The stored credential in `dir`, synchronously; null when none is readable. */
  read(dir: string): HostTokenCredential | null
  /**
   * Make the active account's token good for the next spawn (refreshing it when
   * it expires within the pre-spawn margin). Throws
   * {@link HostTokenUnavailableError} when no usable token can be had.
   */
  ensureFresh(): Promise<void>
  /** Register a live process. Returns the unregister. */
  attach(session: HostTokenSession): () => void
  /** Answer one of the process's `oauth_token_refresh` requests. */
  answerRefresh(session: HostTokenSession): Promise<OAuthTokenAnswer>
}

/** Why no spawn could be given a host token. */
export type HostTokenUnavailableReason = 'signed-out' | 'needs-sign-in' | 'unavailable'

/**
 * A spawn refused because multi-account is on and the active account has no
 * usable token. The message is written for the user: every caller that
 * surfaces spawn errors shows it as it stands.
 */
export class HostTokenUnavailableError extends Error {
  readonly code = 'HOST_TOKEN_UNAVAILABLE'

  constructor(
    readonly reason: HostTokenUnavailableReason,
    message: string = HOST_TOKEN_MESSAGES[reason]
  ) {
    super(message)
    this.name = 'HostTokenUnavailableError'
  }
}

const HOST_TOKEN_MESSAGES: Record<HostTokenUnavailableReason, string> = {
  'signed-out': 'The active Claude account is not signed in. Sign in to it to continue.',
  'needs-sign-in':
    "The active Claude account's sign-in was refused. Sign in to it again to continue.",
  unavailable:
    "The active Claude account's sign-in could not be renewed (network or server error). Try again in a moment."
}

let source: HostTokenSource | null = null

/** Publish the token keeper (or clear it). Wired once, in `startCoreServices`. */
export function setHostTokenSource(next: HostTokenSource | null): void {
  source = next
}

export function getHostTokenSource(): HostTokenSource | null {
  return source
}

/**
 * The account dir whose token a spawn made NOW carries, or null when spawns
 * carry no host token: single-account mode (cli.js uses the user's own Claude
 * Code login), or a custom endpoint profile (`endpoint-env.ts`), whose own
 * credential wins over the account's.
 */
export function hostTokenDir(): string | null {
  const dir = getSecurestorageEnv()?.dir
  if (!dir) return null
  if (getEndpointEnv()) return null
  return dir
}

/**
 * The active account's credential for a spawn, or null when spawns carry no
 * host token (see {@link hostTokenDir}). Throws
 * {@link HostTokenUnavailableError} when one is owed and none can be read.
 */
export function readHostTokenSpawn(): { dir: string; credential: HostTokenCredential } | null {
  const dir = hostTokenDir()
  if (!dir) return null
  // No keeper wired means no way to read the account's file, and a spawn
  // without it would run on the default login: refuse, like a missing file.
  const credential = source?.read(dir) ?? null
  if (!credential) throw new HostTokenUnavailableError('signed-out')
  return { dir, credential }
}

/**
 * Await before every `query()` a caller can await: refreshes the active
 * account's token when it is about to expire, and rejects with
 * {@link HostTokenUnavailableError} when there is no usable one. A no-op
 * whenever spawns carry no host token.
 */
export function ensureHostTokenFresh(): Promise<void> {
  if (!hostTokenDir() || !source) return Promise.resolve()
  return source.ensureFresh()
}
