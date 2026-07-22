import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { piAuthProvider } from '../auth/PiAuthProvider'
import { authVault } from '../auth/vault/AuthVault'
import { credentialSync } from '../auth/vault/CredentialSync'
import type { SharedProviderModel } from '../../shared/shared-provider'
import { aggregateChatgptModels } from './chatgpt-model-catalog'
import { OpencodeSharedProviderAdapter } from './OpencodeSharedProviderAdapter'
import { PiSharedProviderAdapter } from './PiSharedProviderAdapter'
import { SharedProviderRepository } from './SharedProviderRepository'
import { SharedProviderService } from './SharedProviderService'

// Discovery imports are deferred: OpenCode acquisition only happens when the catalog is requested.
export async function getChatgptModels(): Promise<SharedProviderModel[]> {
  const [piModule, opencodeModule] = await Promise.all([
    import('../pi/model-discovery').catch(() => null),
    import('../opencode/model-discovery').catch(() => null)
  ])
  const [piGroups, opencodeGroups] = await Promise.all([
    piModule ? piModule.discoverPiModels().catch(() => []) : [],
    opencodeModule ? opencodeModule.discoverOpencodeModels().catch(() => []) : []
  ])
  return aggregateChatgptModels(piGroups, opencodeGroups)
}

// Composition stays outside adapters and CredentialSync to avoid auth-provider import cycles.
export const sharedProviderService = new SharedProviderService({
  repository: new SharedProviderRepository(),
  vault: authVault,
  pi: new PiSharedProviderAdapter({ auth: piAuthProvider }),
  opencode: new OpencodeSharedProviderAdapter({ authTarget: opencodeAuthProvider }),
  credentialSync,
  getChatgptModels
})
