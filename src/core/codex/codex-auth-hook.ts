/**
 * The ONE place a Codex process is told which ChatGPT identity it runs as
 * (ADR-068 §1).
 *
 * Codex is the third route of the shared `chatgpt` provider and the only one fed
 * by INJECTION rather than by file: after `initialize`, the host sends
 * `account/login/start {type:'chatgptAuthTokens'}` with an access token off the
 * vault, and Codex holds it IN MEMORY ONLY (`AuthDotJson::storage_mode` forces
 * `Ephemeral` for that mode). The refresh token never leaves ClaudeUI, nothing
 * is written under `$CODEX_HOME`, and `CredentialSync` stays the single refresh
 * owner — which is exactly the rotating-refresh-token hazard ADR-036 exists to
 * prevent, absent by construction here.
 *
 * Codex never refreshes an injected token. On a 401 it asks the host, ONCE per
 * recovery, through the `account/chatgptAuthTokens/refresh` server request and
 * waits ten seconds (`app-server/src/external_auth.rs`). {@link CodexAuthHook}
 * answers it, which is why this module exists as a shared factory rather than
 * four copies: `CodexSession`, `CodexService`, model discovery and the
 * cross-engine dispatch target all start app-servers, and an inject path that
 * drifted between them would silently bill turns to the wrong subscription.
 *
 * OPT-IN BY CONSTRUCTION. Nothing here is a default: every caller receives its
 * hook from its own composition root (`register-engines.ts`, the
 * `crossEngineDispatcher` singleton, `CodexAuthProvider`, `model-discovery.ts`).
 * A test that builds a session, service or dispatcher without one injects
 * nothing and never touches the vault — which is what keeps the real-binary
 * integration suite from feeding a developer's real ChatGPT token to a sandboxed
 * process.
 *
 * TOKEN HYGIENE: `CredentialSync.injectionTokenFor` is the single source of
 * token material and nothing in this module logs, stores or returns it anywhere
 * except into the two protocol payloads Codex requires.
 */
import { CHATGPT_PROVIDER_ID } from '../auth/vault/AuthVault'
import { credentialSync, type CodexInjectionToken } from '../auth/vault/CredentialSync'
import type { ChatgptAuthTokensRefreshResponse } from './protocol/v2/ChatgptAuthTokensRefreshResponse'

export type { CodexInjectionToken }

/** The provider whose accounts Codex runs under. Only ChatGPT has a Codex route. */
export const CODEX_AUTH_PROVIDER_ID = CHATGPT_PROVIDER_ID

/**
 * The slice of `CredentialSync` a hook needs. Structural (the singleton
 * satisfies it) so a test can hand in a fake without a vault, a timer or a
 * filesystem.
 */
export interface CodexAuthSource {
  injectionTokenFor(
    accountId: string | null,
    refreshMarginMs?: number
  ): Promise<CodexInjectionToken | null>
  /** Token-free; used only to map a WORKSPACE id back onto a vault account id. */
  getStatus(): Promise<{ accounts: Array<{ id: string; accountId?: string }> }>
}

export interface CodexAuthHook {
  /**
   * The token to inject after `initialize`, or null to leave the process on
   * whatever Codex's own store holds (a user who never signed in through
   * ClaudeUI keeps working).
   */
  inject(): Promise<CodexInjectionToken | null>
  /** Answers `account/chatgptAuthTokens/refresh`. Rejects when no account can. */
  onRefreshRequest(params: unknown): Promise<ChatgptAuthTokensRefreshResponse>
  /**
   * Re-point this hook at another vault account before the NEXT {@link inject}
   * (ADR-068 §2's per-session pin). `null` means the ACTIVE account.
   *
   * A setter rather than an argument on `inject()` because the choice is sticky:
   * the refresh answer's second fallback is "the account this process was
   * injected with", and a re-injection that did not also move the requested
   * account would leave a later 401 recovering onto the previous identity.
   */
  requestAccount(accountId: string | null): void
  /**
   * Is `accountId` a vault account that still exists? Token-free — it reads the
   * same `getStatus()` the account commands do. `setAccount` validates through
   * it so an unknown id is refused before anything is persisted (ADR-059's rule
   * applied to accounts: never silently substitute another identity).
   */
  hasAccount(accountId: string): Promise<boolean>
  /** The vault account id this process currently runs as, or null. */
  readonly injectedAccountId: string | null
  /**
   * Rung when a refresh cannot be answered, with the account that was being
   * used. Assigned by the ONE process that owns this hook (a session sends
   * `session:auth-required`); a hook is never shared between processes.
   */
  onAuthRequired?: (accountId: string | null) => void
}

export interface CodexAuthHookDeps {
  /** Which vault account to run as. null/absent = the ACTIVE account. */
  accountId?: string | null
  source?: CodexAuthSource
  onAuthRequired?: (accountId: string | null) => void
}

/** `previousAccountId` off the native params — a WORKSPACE id, or null. */
function previousWorkspaceId(params: unknown): string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const value = (params as { previousAccountId?: unknown }).previousAccountId
  return typeof value === 'string' && value ? value : null
}

/**
 * Build the hook for ONE Codex process.
 *
 * The refresh answer resolves an account in this order, taking the first that
 * yields a token:
 *
 *  1. the vault account whose WORKSPACE id equals the native `previousAccountId`
 *     hint — the app-server sends the workspace, not our account id, and its own
 *     doc comment says the hint exists for "clients that manage multiple
 *     accounts/workspaces";
 *  2. the account this process was injected with;
 *  3. the active account.
 *
 * Every step answers from the CACHED credential unless it has actually expired
 * (`refreshMarginMs` 0), because Codex abandons the turn after ten seconds and a
 * still-valid token is the answer it wants.
 */
export function codexAuthHook(deps: CodexAuthHookDeps = {}): CodexAuthHook {
  const source = deps.source ?? credentialSync
  let requested = deps.accountId ?? null
  let injected: string | null = null
  const hook: CodexAuthHook = {
    get injectedAccountId(): string | null {
      return injected
    },
    onAuthRequired: deps.onAuthRequired,
    requestAccount(accountId: string | null): void {
      requested = accountId
    },
    async hasAccount(accountId: string): Promise<boolean> {
      const status = await source.getStatus()
      return status.accounts.some((account) => account.id === accountId)
    },
    async inject(): Promise<CodexInjectionToken | null> {
      const token = await source.injectionTokenFor(requested)
      injected = token?.vaultAccountId ?? null
      return token
    },
    async onRefreshRequest(params: unknown): Promise<ChatgptAuthTokensRefreshResponse> {
      const candidates: Array<string | null> = []
      const workspace = previousWorkspaceId(params)
      if (workspace) {
        try {
          const status = await source.getStatus()
          const match = status.accounts.find((account) => account.accountId === workspace)
          if (match) candidates.push(match.id)
        } catch {
          // A status read that fails is a hint we cannot use, not a refusal:
          // the injected and active fallbacks below still apply.
        }
      }
      if (injected !== null) candidates.push(injected)
      candidates.push(null)
      for (const candidate of [...new Set(candidates)]) {
        const token = await source.injectionTokenFor(candidate, 0)
        if (!token) continue
        injected = token.vaultAccountId
        return {
          accessToken: token.accessToken,
          chatgptAccountId: token.chatgptAccountId,
          chatgptPlanType: token.chatgptPlanType
        }
      }
      hook.onAuthRequired?.(injected)
      // Deliberately message-free: the transport answers a handler rejection
      // with a fixed JSON-RPC error, and Codex refuses to log our message
      // anyway ("may contain a token").
      throw new Error('No ChatGPT account can answer the Codex token refresh')
    }
  }
  return hook
}
