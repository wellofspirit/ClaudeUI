import { opencodeAuthProvider } from '../auth/OpencodeAuthProvider'
import { piAuthProvider } from '../auth/PiAuthProvider'
import { authVault } from '../auth/vault/AuthVault'
import { credentialSync } from '../auth/vault/CredentialSync'
import type { SharedProviderModel } from '../../shared/shared-provider'
import { aggregateChatgptModels } from './chatgpt-model-catalog'
import {
  discoverOpencodeModels,
  discoverOpencodeProviderCatalog
} from '../opencode/model-discovery'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { opencodeCredentialStore } from '../opencode/opencode-credentials'
import { PI_API_KEY_VENDOR_IDS } from '../auth/pi-vendor-ids'
import { discoverPiModels } from '../pi/model-discovery'
import { harnessWritable } from '../harness/resolve'
import { deliveredKeyFingerprints } from './delivered-keys'
import { authJsonApiKeyReader, batchedApiKeyReader } from './native-api-keys'
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

// opencode 2.x keys: one credential list per pass (one server), dropped when
// ClaudeUI changes a credential.
const opencodeKeyReader = batchedApiKeyReader(() => opencodeCredentialStore.readActiveKeys())
opencodeCredentialStore.onChange(() => opencodeKeyReader.invalidate())

// Composition stays outside adapters and CredentialSync to avoid auth-provider import cycles.
export const sharedProviderService = new SharedProviderService({
  repository: new SharedProviderRepository(),
  vault: authVault,
  pi: new PiSharedProviderAdapter({ auth: piAuthProvider }),
  opencode: new OpencodeSharedProviderAdapter({ authTarget: opencodeAuthProvider }),
  credentialSync,
  getChatgptModels,
  // No key is written into a harness that does not run; removals happen at once
  // (ADR-082 §8, S7d). The fingerprints tell ClaudeUI's earlier keys from the
  // user's.
  harnessRuns: harnessWritable,
  deliveredKeys: deliveredKeyFingerprints(),
  // ADR-074 §6 adoption: plain API keys each engine holds — pi's `api_key`
  // entries in its auth.json, opencode 2.x's ACTIVE key rows (ADR-093 §5).
  // opencode's catalog costs a server spawn, so the service asks for it only
  // once a vendor holds a key in both.
  nativeKeys: {
    pi: authJsonApiKeyReader(() => piAuthProvider.authFilePath(), 'api_key'),
    opencode: opencodeKeyReader,
    loadCatalogs: async (options) => ({
      pi: new Set(PI_API_KEY_VENDOR_IDS),
      opencode: new Map(
        (!options?.skipOpencode && opencodeServerManager.isBinaryAvailable()
          ? await discoverOpencodeProviderCatalog()
          : []
        ).map((entry) => [entry.id, entry.name] as const)
      )
    })
  }
})
