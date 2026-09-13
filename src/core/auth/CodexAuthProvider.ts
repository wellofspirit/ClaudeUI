import { homedir } from 'node:os'
import type { EngineAuthProvider } from './EngineAuthProvider'
import type { VendorAuthMap } from '../../shared/types'
import type { CodexAuthStatus } from '../../shared/codex-types'
import { CodexService } from '../codex/CodexService'
import { codexAuthHook } from '../codex/codex-auth-hook'
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
    private readonly service = new CodexService({ cwd: homedir(), auth: codexAuthHook() }),
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
      return {
        openai: {
          // A revoked refresh token is reported as such rather than as a healthy
          // subscription (ADR-030): the turn WILL fail, and the sign-in prompt
          // is the only thing that fixes it.
          authState: active.needsReauth ? 'unauthenticated' : 'authenticated',
          billingType: 'subscription',
          requiresLogin: active.needsReauth,
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

  dispose(): void {
    this.service.dispose()
  }
}

export const codexAuthProvider = new CodexAuthProvider()
