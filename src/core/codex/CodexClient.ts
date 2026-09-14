import {
  CodexAppServerClient,
  CodexTransportError,
  type CodexClientOptions
} from './CodexAppServerClient'
import type { CodexAuthHook, CodexInjectionToken } from './codex-auth-hook'
import type { CodexMethods } from './protocol/methods'
import type { InitializeParams } from './protocol/InitializeParams'

/**
 * Codex refused the ChatGPT identity the vault handed it (ADR-068 §1).
 *
 * Carries the NATIVE message verbatim — this is where a
 * `forced_chatgpt_workspace_id` in the user's `config.toml` surfaces ("External
 * auth must use one of workspace(s) …"), and a numeric code would leave the
 * user with nothing to act on. There is no retry and no fallback to native auth:
 * a process that cannot run as the account the user chose must not quietly run
 * as some other one (ADR-059 applied to accounts).
 */
export class CodexInjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexInjectionError'
  }
}

/** Typed host-only API. The generic transport remains available for protocol probes. */
export class CodexClient {
  private readonly transport: CodexAppServerClient

  constructor(options: CodexClientOptions) {
    this.transport = new CodexAppServerClient(options)
  }

  /**
   * Handshake, then — when `auth` is supplied — hand this process the vault's
   * ChatGPT token before any other request can run (ADR-068 §1).
   *
   * `auth` absent, or `inject()` answering null, leaves the process on whatever
   * Codex's own store holds: a user who never signed in through ClaudeUI keeps
   * working exactly as before, and the caller records no account.
   *
   * The login response is AWAITED, so `start` resolving means the identity is in
   * place — nothing can send a turn under the previous one. A refusal disposes
   * the process and throws {@link CodexInjectionError}.
   */
  async start(params: InitializeParams, auth?: CodexAuthHook | null) {
    const result = await this.transport.start(params)
    if (!auth) return result
    let token: Awaited<ReturnType<CodexAuthHook['inject']>>
    try {
      token = await auth.inject()
    } catch (error) {
      this.transport.dispose()
      throw new CodexInjectionError(
        error instanceof Error
          ? `The ChatGPT account for this Codex session could not be read: ${error.message}`
          : 'The ChatGPT account for this Codex session could not be read'
      )
    }
    if (!token) return result
    try {
      await this.sendLogin(token)
    } catch (error) {
      this.transport.dispose()
      throw error
    }
    return result
  }

  /**
   * Re-point a LIVE process at another vault account (ADR-068 §2's per-session
   * pin). Legal while external auth is active — `account/login/start
   * {chatgptAuthTokens}` is the one login `account_processor.rs` still accepts
   * then, precisely so a multi-account client can update the identity in place.
   *
   * Unlike {@link start} a refusal does NOT dispose: the process is already
   * running under a perfectly valid identity, so the honest outcome is to reject
   * the pin and leave the session on the account it has. The caller surfaces the
   * native message.
   */
  async injectAccount(auth: CodexAuthHook): Promise<CodexInjectionToken | null> {
    const token = await auth.inject()
    if (!token) return null
    await this.sendLogin(token)
    return token
  }

  /** The one place the injected triple reaches the wire. Never logged. */
  private async sendLogin(token: CodexInjectionToken): Promise<void> {
    try {
      await this.transport.request('account/login/start', {
        type: 'chatgptAuthTokens',
        accessToken: token.accessToken,
        chatgptAccountId: token.chatgptAccountId,
        chatgptPlanType: token.chatgptPlanType
      })
    } catch (error) {
      throw new CodexInjectionError(
        (error instanceof CodexTransportError ? error.nativeMessage : undefined) ??
          'Codex refused the ChatGPT credential from ClaudeUI'
      )
    }
  }

  request<M extends keyof CodexMethods>(
    method: M,
    params: CodexMethods[M]['params']
  ): Promise<CodexMethods[M]['result']> {
    return this.transport.request(method, params)
  }

  abortServerRequests(threadId: string, turnId: string): void {
    this.transport.abortServerRequests(threadId, turnId)
  }

  dispose(): void {
    this.transport.dispose()
  }
}
