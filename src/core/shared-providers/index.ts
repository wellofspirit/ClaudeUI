import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { piAuthProvider } from '../auth/PiAuthProvider'
import { authVault } from '../auth/vault/AuthVault'
import { credentialSync } from '../auth/vault/CredentialSync'
import type { SharedProviderModel } from '../../shared/shared-provider'
import { aggregateChatgptModels } from './chatgpt-model-catalog'
import { discoverOpencodeModels } from '../opencode/model-discovery'
import { discoverPiModels } from '../pi/model-discovery'
import { OpencodeSharedProviderAdapter } from './OpencodeSharedProviderAdapter'
import { PiSharedProviderAdapter } from './PiSharedProviderAdapter'
import { SharedProviderRepository } from './SharedProviderRepository'
import { SharedProviderService } from './SharedProviderService'

// Discovery is deferred to call time: opencode/pi model acquisition only happens
// when the catalog is requested. Static imports here are harmless — both modules
// are already in the main bundle via their auth-provider/session importers, and
// each discovery function returns [] on any failure (opencode/pi are optional).
export async function getChatgptModels(): Promise<SharedProviderModel[]> {
  const [piGroups, opencodeGroups] = await Promise.all([
    discoverPiModels().catch(() => []),
    discoverOpencodeModels().catch(() => [])
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
