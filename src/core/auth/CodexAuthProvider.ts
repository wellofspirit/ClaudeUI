import { homedir } from 'node:os'
import type { EngineAuthProvider } from './EngineAuthProvider'
import type { VendorAuthMap } from '../../shared/types'
import type { CodexAuthStatus } from '../../shared/codex-types'
import { CodexService } from '../codex/CodexService'
import { codexBinaryAvailable } from '../codex/codex-locate'
import { credentialSync } from './vault/CredentialSync'

/**
 * The Codex half of the engine-auth registry (ADR-021).
 *
 * ADR-068 §1 moved the IDENTITY out of here: Codex no longer owns a login the
 * product can start. The vault owns the ChatGPT account, every Codex process is
 * injected with it, and this provider only REPORTS — first from the vault, and
 * only when the vault holds nothing from the native store, which is what a user
 * who signed in with `codex login` themselves still has. The device-code flow it
 * used to drive survives in `CodexService.startLogin` as tested code with no
 * product entry point.
 */
export class CodexAuthProvider implements EngineAuthProvider {
  constructor(
    private readonly service = new CodexService({
      cwd: homedir(),
      // The ACTIVE vault account: the probe has to describe the identity every
      // Codex process actually runs as. Under ADR-069 that is a lease on the
      // active account's host, not a process of its own.
      identity: { accountId: null },
      label: 'auth-probe'
    }),
    private readonly vault: Pick<typeof credentialSync, 'getStatus'> = credentialSync
  ) {}

  async status(): Promise<CodexAuthStatus> {
    if (!codexBinaryAvailable())
      return {
        available: false,
        authenticated: false,
        authKind: null,
        error: 'Codex is not installed for this platform'
      }
    const [status, catalog] = await Promise.all([
      this.service.accountStatus(),
      this.service
        .modelOptions()
        .then(({ catalog }) => ({ modelCount: catalog.filter((model) => !model.hidden).length }))
        .catch(() => ({
          catalogError:
            'The native default model/provider could not be resolved. Only native OpenAI is supported; choose an available model or check native configuration.'
        }))
    ])
    return status.available
      ? {
          available: true,
          authenticated: status.authenticated,
          authKind: status.authKind,
          ...catalog
        }
      : {
          available: status.failure !== 'unavailable',
          authenticated: false,
          authKind: null,
          error: 'Native Codex account status failed; retry or sign in explicitly'
        }
  }

  async probe(): Promise<VendorAuthMap> {
    // The vault first: an account here IS what every Codex process runs as, so
    // reporting the native store instead would describe an identity nothing uses.
    const vault = await this.vault.getStatus().catch(() => null)
    const active = vault?.accounts.find((account) => account.id === vault.activeId)
    if (active) {
      // Two ways one stored account is already dead, and BOTH have to read as
      // "sign in again" rather than as a healthy subscription (ADR-030):
      //
      //  · the vault's own refresh was revoked — `needsReauth`;
      //  · the backend REFUSES the token the vault still holds. Nothing expired,
      //    so no refresh was ever attempted and the vault looks fine; what the
      //    user sees is the catalog coming back empty, which slice 2a's live run
      //    surfaced as the generic "No Codex models were discovered" banner.
      //    `models()` is the narrowest probe of that — a bare `model/list`, with
      //    none of `modelOptions`'s provider assertions — so a misconfigured
      //    `model_provider` cannot be mistaken for a refused credential.
      const rejected = active.needsReauth || !(await this.catalogReadable())
      return {
        openai: {
          authState: rejected ? 'unauthenticated' : 'authenticated',
          billingType: 'subscription',
          requiresLogin: rejected,
          label: active.email ?? 'ChatGPT'
        }
      }
    }
    const status = await this.status()
    return {
      openai: {
        authState:
          !status.available || status.error || status.authKind === 'amazonBedrock'
            ? 'unknown'
            : status.authenticated
              ? 'authenticated'
              : 'unauthenticated',
        billingType:
          status.authKind === 'chatgpt'
            ? 'subscription'
            : status.authKind === 'apiKey'
              ? 'apiKey'
              : 'unknown',
        requiresLogin: status.available && !status.error && !status.authenticated,
        error: status.error ?? status.catalogError,
        label: status.authKind === 'chatgpt' ? 'Native ChatGPT' : 'Native Codex'
      }
    }
  }

  /**
   * Can the injected identity read the model catalog? Any failure — transport,
   * refusal, an empty catalog — answers no; this runs only on the error path of
   * a session that already has nothing to show.
   */
  private async catalogReadable(): Promise<boolean> {
    try {
      return (await this.service.models()).length > 0
    } catch {
      return false
    }
  }

  dispose(): void {
    this.service.dispose()
  }
}

export const codexAuthProvider = new CodexAuthProvider()
