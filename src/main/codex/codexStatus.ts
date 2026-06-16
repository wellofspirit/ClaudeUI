/**
 * Codex auth status probe.
 *
 * Spawns a short-lived app-server, calls account/read {}, and maps the
 * response to a ClaudeUI-facing CodexStatus object:
 *   - authenticated: true when account is present
 *   - email: the ChatGPT email (only for account.type === 'chatgpt')
 *   - planLabel: human-readable plan description (chatgpt subscriptions)
 *   - requiresLogin: true when unauthenticated AND requiresOpenaiAuth is set
 *
 * Distinguishes three error cases:
 *   1. Spawn error (binary missing / not executable) — notInstalled: true
 *   2. RPC timeout or protocol failure — error message, authenticated: false
 *   3. Unauthenticated but reachable — requiresLogin: true
 *
 * Based on t3code's accountProbeStatus / codexAccountAuthLabel / codexAccountEmail
 * logic, ported to plain TS without Effect.
 */

import { withCodexAppServer, CodexSpawnError } from './codexQuery'
import type { V2Account } from './protocol/schema'
import { logger } from '../services/logger'

// ---------------------------------------------------------------------------
// Plan label mapping (mirrors t3code's codexAccountAuthLabel)
// ---------------------------------------------------------------------------

function planLabel(account: V2Account): string | undefined {
  if (account.type === 'apiKey') return 'OpenAI API Key'
  if (account.type === 'amazonBedrock') return 'Amazon Bedrock'
  if (account.type !== 'chatgpt') return undefined

  switch (account.planType) {
    case 'free': return 'ChatGPT Free'
    case 'go': return 'ChatGPT Go'
    case 'plus': return 'ChatGPT Plus'
    case 'pro': return 'ChatGPT Pro'
    case 'prolite': return 'ChatGPT Pro (5x)'
    case 'team': return 'ChatGPT Team'
    case 'self_serve_business_usage_based':
    case 'business': return 'ChatGPT Business'
    case 'enterprise_cbp_usage_based':
    case 'enterprise': return 'ChatGPT Enterprise'
    case 'edu': return 'ChatGPT Edu'
    case 'unknown': return 'ChatGPT'
    default: return undefined
  }
}

function accountEmail(account: V2Account): string | undefined {
  if (account.type !== 'chatgpt') return undefined
  return account.email
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CodexStatus {
  /** True when account/read returned an account object. */
  authenticated: boolean
  /** ChatGPT email — only present when account.type === 'chatgpt'. */
  email?: string
  /** Human-readable plan description. */
  planLabel?: string
  /**
   * True when unauthenticated AND requiresOpenaiAuth is set — means the user
   * should run `codex login`.
   */
  requiresLogin: boolean
  /**
   * True when the codex binary was not found or could not be executed.
   * In this case authenticated is false and requiresLogin is false.
   */
  notInstalled?: boolean
  /** Error message from an unexpected failure (timeout, RPC error, etc.). */
  error?: string
}

/**
 * Probe the Codex auth state by spawning a short-lived app-server.
 *
 * @param cwd       Working directory (used only for the spawn environment).
 * @param timeoutMs Maximum wait time (default: 10 s — shorter than history since
 *                  account/read is a fast call).
 */
export async function getCodexStatus(
  cwd: string,
  timeoutMs = 10_000
): Promise<CodexStatus> {
  logger.debug('codexStatus', 'probing account/read')

  try {
    const response = await withCodexAppServer(
      cwd,
      (client) => client.request('account/read', {}),
      timeoutMs
    )

    const { account, requiresOpenaiAuth } = response

    if (!account) {
      return {
        authenticated: false,
        requiresLogin: requiresOpenaiAuth,
      }
    }

    return {
      authenticated: true,
      email: accountEmail(account),
      planLabel: planLabel(account),
      requiresLogin: false,
    }
  } catch (err) {
    if (err instanceof CodexSpawnError) {
      logger.warn('codexStatus', 'codex binary not found or not executable', err)
      return { authenticated: false, requiresLogin: false, notInstalled: true }
    }

    const msg = err instanceof Error ? err.message : String(err)
    logger.error('codexStatus', 'account/read probe failed', err)
    return { authenticated: false, requiresLogin: false, error: msg }
  }
}
