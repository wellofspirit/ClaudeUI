import type {
  ConfigurableHarnessId,
  EndpointProbeInput,
  EndpointProbeResult,
  SharedProviderAccountList,
  SharedProviderCuration,
  SharedProviderDefinition,
  SharedProviderModel,
  SharedProviderStatus
} from '../../shared-provider'
import type { ProviderRegistrySnapshot } from '../../provider-registry'

export interface SharedProviderAPI {
  /**
   * The UNIFIED provider list (ADR-065 § "Providers: one list") — the shared
   * definitions, opencode's catalog and pi's vendor entries as one row set, with
   * `opencodeInstalled: false` standing for the single degraded case. A pure
   * read: every row action is one of the write channels below or beside it.
   */
  listProviderRegistry(): Promise<ProviderRegistrySnapshot>
  /**
   * The subscription ACCOUNTS of one shared provider (ADR-068 §2) — the same
   * list the registry row carries, plus each account's expiry and reauth state.
   * Never token material.
   */
  listProviderAccounts(providerId: string): Promise<SharedProviderAccountList>
  /** Make one stored account the active one: both engine stores are re-vended. */
  switchProviderAccount(providerId: string, accountId: string): Promise<void>
  /** Forget one stored account. Removing the active one promotes the newest remaining. */
  removeProviderAccount(providerId: string, accountId: string): Promise<void>
  listSharedProviders(): Promise<SharedProviderDefinition[]>
  getSharedProviderStatuses(): Promise<SharedProviderStatus[]>
  listSharedProviderModels(id: string): Promise<SharedProviderModel[]>
  saveSharedProvider(definition: SharedProviderDefinition): Promise<void>
  /**
   * Detect: what a custom endpoint serves, read host-side. The typed `apiKey`
   * wins; otherwise `providerId` names a saved provider whose stored key the
   * host uses. Never answers the key.
   */
  probeSharedEndpoint(input: EndpointProbeInput): Promise<EndpointProbeResult>
  removeSharedProvider(id: string): Promise<void>
  setSharedProviderRoute(
    id: string,
    harness: ConfigurableHarnessId,
    enabled: boolean
  ): Promise<void>
  /**
   * Store a provider's key and deliver it to each enabled harness. A harness
   * holding a key of its own for the vendor keeps it unless `replaceOwn` names
   * it — the harnesses the user agreed to overwrite (ADR-082 §8, S7f).
   */
  setSharedProviderApiKey(
    id: string,
    key: string,
    replaceOwn?: readonly ConfigurableHarnessId[]
  ): Promise<void>
  /**
   * Adopt a key an engine already holds into a catalog definition (ADR-074 §6).
   * `keep` names the engine whose key wins; omitted, both must hold the same key.
   */
  adoptSharedProviderNativeKey(id: string, keep?: ConfigurableHarnessId): Promise<void>
  /** One model list for every engine, or one each (ADR-074 §3); projected while linked. */
  setSharedProviderCuration(id: string, curation: SharedProviderCuration): Promise<void>
  /**
   * Switch a key or endpoint provider off (delivered to no engine; key, routes
   * and model list kept) or back on (ADR-074 slice 10). Switching on refuses to
   * replace a key a harness holds of its own unless `replaceOwn` names that
   * harness (S7f: per harness).
   */
  setSharedProviderDisabled(
    id: string,
    disabled: boolean,
    replaceOwn?: readonly ConfigurableHarnessId[]
  ): Promise<void>
  syncSharedProvider(id: string): Promise<void>
  /** Replace the key a route's engine kept of its own with the stored one (ADR-082 §8, S7d). */
  useSharedProviderStoredKey(id: string, harness: ConfigurableHarnessId): Promise<void>
  /**
   * The running harnesses that hold a key of their own for a provider (a
   * definition id, or a vendor id with no definition) right now, read from
   * their auth files — what an own-key question names (S7f).
   */
  getSharedProviderOwnKeyHolders(id: string): Promise<ConfigurableHarnessId[]>
  disconnectSharedProvider(id: string): Promise<void>
  setSharedProviderDefaultModel(
    id: string,
    harness: ConfigurableHarnessId,
    modelId?: string
  ): Promise<void>
}
