import type { VaultCredentialRecord } from '../auth/vault/AuthVault'
import type { CredentialSync } from '../auth/vault/CredentialSync'
import { readOpencodeNativeConfig, writeOpencodeNativeConfig } from '../opencode/opencode-config'
import { loadEngineConfig, saveEngineConfig } from '../services/ui-config'
import { logger } from '../services/logger'
import { setProviderModelAllowlist } from '../services/provider-model-allowlist'
import { curationForEngine } from '../../shared/provider-curation'
import {
  deliveredDefinition,
  validateSharedProviderId,
  type ConfigurableHarnessId,
  type SharedProviderCuration,
  type SharedProviderDefinition,
  type SharedProviderModel,
  type SharedProviderRouteDiagnosis,
  type SharedProviderStatus
} from '../../shared/shared-provider'
import { OpencodeSharedProviderAdapter, opencodeProviderId } from './OpencodeSharedProviderAdapter'
import {
  PiSharedProviderAdapter,
  isPiBuiltinCollision,
  nativeProviderId
} from './PiSharedProviderAdapter'
import { SharedProviderRepository } from './SharedProviderRepository'
import { keyHint, type NativeApiKeyReader } from './native-api-keys'
import { memoryDeliveredKeyFingerprints, type DeliveredKeyFingerprints } from './delivered-keys'

type Route = ConfigurableHarnessId
const routes: Route[] = ['pi', 'opencode']

interface Repository {
  list(): SharedProviderDefinition[]
  get(id: string): SharedProviderDefinition | null
  save(definition: SharedProviderDefinition): void
  remove(id: string): void
}
interface Vault {
  loadCredential(id: string): Promise<VaultCredentialRecord | null>
  saveCredential(id: string, credential: VaultCredentialRecord): Promise<void>
  removeCredential(id: string): Promise<void>
}
export interface SharedProviderDefaultTargets {
  getPiDefault(): string | undefined
  setPiDefault(value: string | undefined): void
  getOpencodeDefault(): string | undefined
  setOpencodeDefault(value: string | undefined): void
}
/**
 * What adopting an engine's own API key needs (ADR-074 §6). Absent, adoption
 * finds nothing — the service still works, it just never migrates.
 */
export interface NativeKeyAdoptionDeps {
  pi: NativeApiKeyReader
  opencode: NativeApiKeyReader
  /**
   * The vendor ids each engine's BUILT-IN catalog knows, with opencode's display
   * name. Only called once a vendor holds a key in an engine, because opencode's
   * catalog costs a server spawn.
   */
  loadCatalogs(options?: {
    /** The caller already holds opencode's catalog: do not fetch it. */
    skipOpencode?: boolean
  }): Promise<{ pi: ReadonlySet<string>; opencode: ReadonlyMap<string, string> }>
}

/**
 * A vendor whose API key both engines hold natively and no definition shares.
 * `identical` is adopted at boot without asking; `conflict` waits for the user
 * to pick one, and carries only the last four characters of each key.
 */
export type NativeKeyCandidate =
  | { id: string; state: 'identical' }
  | { id: string; state: 'conflict'; hints: Record<Route, string> }

export interface SharedProviderServiceDeps {
  repository?: Repository
  vault: Vault
  pi: PiSharedProviderAdapter
  opencode: OpencodeSharedProviderAdapter
  credentialSync: Pick<CredentialSync, 'feedAll' | 'disconnectChatgpt'>
  defaults?: SharedProviderDefaultTargets
  getChatgptModels?: () => Promise<SharedProviderModel[]>
  nativeKeys?: NativeKeyAdoptionDeps
  /** The slice-5 allowlist writer (`models:set-provider-allowlist`'s). Injected for tests. */
  writeModelAllowlist?: (engine: Route, providerId: string, models: string[] | null) => void
  /**
   * Whether a harness runs (ADR-082 §8, "As built (S7d)"). No key or provider
   * block is written into one that does not: its routes are only recorded, and
   * {@link SharedProviderService.harnessArrived} delivers them. The composition
   * root passes `harnessWritable`; absent, every harness runs.
   */
  harnessRuns?: (route: Route) => boolean
  /**
   * Fingerprints of the key last delivered into each harness slot, so an
   * automatic delivery tells ClaudeUI's own earlier key from the user's.
   * Production wires `~/.claude/ui/delivered-key-fingerprints.json`; absent,
   * in memory.
   */
  deliveredKeys?: DeliveredKeyFingerprints
}

/** Serializes shared-provider RMW across definitions, vault credentials, and native routes. */
export class SharedProviderService {
  private readonly repository: Repository
  private readonly defaults: SharedProviderDefaultTargets
  private readonly routeErrors = new Map<string, Partial<Record<Route, string>>>()
  /** Routes whose engine kept its own key; their error says so (cleared with it). */
  private readonly keptOwnKeys = new Map<string, Set<Route>>()
  private readonly writeModelAllowlist: NonNullable<
    SharedProviderServiceDeps['writeModelAllowlist']
  >
  private mutation = Promise.resolve()
  private readonly harnessRuns: (route: Route) => boolean
  private readonly deliveredKeys: DeliveredKeyFingerprints

  constructor(private readonly deps: SharedProviderServiceDeps) {
    this.repository = deps.repository ?? new SharedProviderRepository()
    this.defaults = deps.defaults ?? productionDefaultTargets()
    this.writeModelAllowlist = deps.writeModelAllowlist ?? setProviderModelAllowlist
    this.harnessRuns = deps.harnessRuns ?? ((): boolean => true)
    this.deliveredKeys = deps.deliveredKeys ?? memoryDeliveredKeyFingerprints()
  }

  listDefinitions(): SharedProviderDefinition[] {
    return this.repository.list()
  }

  async getStatus(id: string): Promise<SharedProviderStatus> {
    // A provider switched off reaches no engine: its routes report off.
    const definition = deliveredDefinition(this.requireDefinition(id))
    const models = await this.listProviderModels(id)
    const [credential, piCredential, opencodeCredential] = await Promise.all([
      this.deps.vault.loadCredential(id),
      definition.routes.pi.enabled ? this.deps.pi.hasCredential(definition) : false,
      definition.routes.opencode.enabled ? this.deps.opencode.hasCredential(definition) : false
    ])
    const piConfigured = definition.kind !== 'custom' || this.deps.pi.hasDefinition(definition)
    const opencodeConfigured =
      definition.kind !== 'custom' || this.deps.opencode.hasDefinition(definition)
    const errors = this.routeErrors.get(id)
    const [pi, opencode] = await Promise.all([
      this.statusRoute(definition, 'pi', piCredential, piConfigured, models, errors?.pi),
      this.statusRoute(
        definition,
        'opencode',
        opencodeCredential,
        opencodeConfigured,
        models,
        errors?.opencode
      )
    ])
    return {
      id,
      connected: credential !== null,
      modelCount: models.length,
      routes: { pi, opencode }
    }
  }

  async listStatuses(): Promise<SharedProviderStatus[]> {
    return Promise.all(this.listDefinitions().map(({ id }) => this.getStatus(id)))
  }

  async saveDefinition(incoming: SharedProviderDefinition): Promise<void> {
    await this.enqueue(async () => {
      const previous = this.repository.get(incoming.id)
      // On/off moves through `setDisabled` only: a save — an endpoint edit, a
      // refresh — keeps whatever the stored definition says.
      const definition = withDisabled(incoming, previous?.disabled === true)
      this.assertNoNativeIdCollision(definition)
      if (definition.id === 'chatgpt') {
        this.repository.save(definition)
        this.clearCompetingDefaults(definition)
        await this.syncChatgpt(await this.withCatalogModels(definition))
        return
      }
      if (definition.kind === 'subscription')
        throw new Error('Only custom and catalog providers can be saved')
      // A kind change would leave the old kind's native state (a projected
      // provider block, or a native key) owned by nobody.
      if (previous && previous.kind !== definition.kind)
        throw new Error(`Provider "${definition.id}" is already a ${previous.kind} provider`)
      // A catalog definition is only ever CREATED by a save: its routes change
      // through `setRouteEnabled` and its list through `setCuration`. Replacing a
      // stored one wholesale would turn off a route (removing that engine's key)
      // and drop its curation — the Add sheet re-adding it must not do that.
      if (previous && definition.kind === 'catalog')
        throw new Error(
          `${previous.name} is already set up. Change its engines or key in its Manage sheet.`
        )
      // Fail fast (M-AT4): a custom provider whose effective pi providerId
      // collides with a built-in native vendor (e.g. 'anthropic') would vend its
      // key over — and delete on removal — the user's real native pi credential.
      // Reject before applying/vending anything, regardless of route-enabled state.
      if (isPiBuiltinCollision(definition)) {
        throw new Error(
          `Provider id "${definition.routes.pi.providerId ?? definition.id}" collides with a built-in pi vendor; choose a different provider id`
        )
      }
      // What reaches the engines: nothing, while the provider is switched off.
      const live = deliveredDefinition(definition)
      const livePrevious = previous && deliveredDefinition(previous)
      // A second key's id (slice 10) lands in both engines as a provider of its
      // own: one either engine already knows would be merged with it, or shadow it.
      if (!previous && definition.derivedFrom && this.deps.nativeKeys) {
        const catalogs = await this.deps.nativeKeys.loadCatalogs()
        if (catalogs.opencode.has(definition.id) || catalogs.pi.has(definition.id))
          throw new Error(
            `"${definition.id}" is a provider the engines already know. Choose another name.`
          )
      }
      const applied: Route[] = []
      try {
        for (const route of routes) {
          this.applyRoute(live, livePrevious, route)
          applied.push(route)
          this.clearError(definition.id, route)
        }
        this.repository.save(definition)
        this.clearCompetingDefaults(definition)
      } catch (error) {
        const failedRoute = routes[applied.length]
        if (failedRoute) this.recordError(definition.id, failedRoute, error)
        else for (const route of applied) this.recordError(definition.id, route, error)
        this.rollbackDefinition(live, livePrevious, applied)
        throw error
      }
      await this.reconcileCustomCredentials(live, livePrevious)
      for (const route of routes) this.applyDefault(live, route, livePrevious ?? live)
    })
  }

  async removeDefinition(id: string): Promise<void> {
    await this.enqueue(async () => {
      const definition = this.requireDefinition(id)
      if (id === 'chatgpt') throw new Error('ChatGPT cannot be removed')
      // Removals happen at once whether or not a harness runs: they delete
      // ClaudeUI's own entries (ADR-082 §8, S7d).
      this.deps.pi.removeDefinition(definition)
      this.deps.opencode.removeDefinitionRoute(definition)
      // Switched off, a catalog provider already took its key back from every
      // engine: what an engine holds for the vendor now is not ours to delete —
      // unless it IS ours, stranded by an interrupted switch-off.
      const live = deliveredDefinition(definition)
      // The keys before the vault: a catalog route's key goes only while it is
      // ClaudeUI's, which is compared with the vault key (`removeRouteCredential`).
      await this.reclaimStrandedKeys(definition)
      for (const route of this.credentialRoutes(live)) await this.removeRouteCredential(live, route)
      await this.deps.vault.removeCredential(id)
      for (const route of routes) this.clearOwnedDefault(live, route)
      await this.clearModelLists(definition)
      this.repository.remove(id)
      this.routeErrors.delete(id)
      this.keptOwnKeys.delete(id)
    })
  }

  async setRouteEnabled(id: string, route: Route, enabled: boolean): Promise<void> {
    await this.enqueue(async () => {
      const previous = this.requireDefinition(id)
      if (previous.routes[route].enabled === enabled) return
      const definition = withRoute(previous, route, { enabled })
      // Switched off, the route is only recorded: turning the provider back on
      // delivers it (and checks it for a collision then).
      if (previous.disabled) {
        this.repository.save(definition)
        return
      }
      if (enabled) this.assertNoNativeIdCollision(definition, route)
      if (!enabled) {
        this.repository.save(definition) // CredentialSync must observe disabled before native removal.
        try {
          await this.removeRoute(previous, route)
          this.clearError(id, route)
          this.clearOwnedDefault(previous, route)
        } catch (error) {
          this.recordError(id, route, error)
          throw error
        }
        return
      }
      try {
        this.applyRoute(definition, previous, route)
      } catch (error) {
        this.recordError(id, route, error)
        throw error
      }
      try {
        this.repository.save(definition)
        this.clearCompetingDefaults(definition)
      } catch (error) {
        this.rollbackDefinition(definition, previous, [route])
        this.recordError(id, route, error)
        throw error
      }
      try {
        // A delivery failure intentionally leaves the checkbox enabled for retry via syncProvider.
        if (definition.id === 'chatgpt')
          await this.syncChatgpt(await this.withCatalogModels(definition))
        else await this.vendRouteCredential(definition, route)
        // A linked list reaches the engine the moment its route does (ADR-074 §3).
        if (definition.curation?.linked) this.projectCuration(definition, route)
        this.applyDefault(
          definition.id === 'chatgpt' ? await this.withCatalogModels(definition) : definition,
          route,
          previous ?? definition
        )
        if (definition.id !== 'chatgpt') this.clearError(id, route)
      } catch (error) {
        this.recordError(id, route, error)
        throw error
      }
    })
  }

  /**
   * Turn per-session account pinning on or off for a SUBSCRIPTION provider
   * (ADR-068 §2). Enqueued with every other definition write, so it cannot
   * interleave with a route change and lose one of the two.
   */
  async setAccountsPerSession(id: string, enabled: boolean): Promise<void> {
    await this.enqueue(async () => {
      const definition = this.requireDefinition(id)
      if (definition.kind !== 'subscription') {
        throw new Error('Per-session accounts are only supported for subscription providers')
      }
      this.repository.save({ ...definition, accounts: { perSession: enabled } })
    })
  }

  /**
   * Switch a key or endpoint provider off or on (ADR-074 slice 10).
   *
   * Off takes it out of every engine — the projection and the key, from each
   * engine whose route is on, by the same ownership rules as turning that route
   * off — and records `disabled`; the key stays in the vault, and the routes,
   * the model list and the route defaults stay in the definition untouched. On
   * clears the flag and re-delivers exactly that, after the collision guard has
   * checked it against the providers that stayed on meanwhile.
   *
   * While a catalog provider was off, an engine may have been given a key of its
   * own for the vendor: switching on would replace it, so that is refused unless
   * `replaceOwn` says the user confirmed it (the keys are compared here, never
   * sent anywhere).
   */
  async setDisabled(id: string, disabled: boolean, replaceOwn = false): Promise<void> {
    await this.enqueue(async () => {
      const previous = this.requireDefinition(id)
      if (previous.kind === 'subscription')
        throw new Error('A subscription is switched off per engine, not as a whole')
      if ((previous.disabled === true) === disabled) return
      const definition = withDisabled(previous, disabled)
      if (!disabled) {
        this.assertNoNativeIdCollision(definition)
        const own = replaceOwn ? [] : await this.ownCredentialRoutes(definition)
        if (own.length)
          throw new Error(
            `${own.join(' and ')} ${own.length > 1 ? 'have their own keys' : 'has its own key'} for ${
              definition.name
            }; switching it on replaces ${own.length > 1 ? 'them' : 'it'} with the stored one.`
          )
        this.repository.save(definition)
        // The user switched it on, having been asked about any key it replaces.
        await this.syncDefinition(definition, { keepOwnKeys: false })
        // A linked list reaches the engines with their routes (ADR-074 §3).
        if (definition.curation?.linked) this.projectCuration(definition)
        return
      }
      this.repository.save(definition) // Recorded first, as a route switched off is.
      const failures: unknown[] = []
      for (const route of routes) {
        if (!previous.routes[route].enabled) continue
        try {
          await this.removeRoute(previous, route)
          this.clearError(id, route)
          this.clearOwnedDefault(previous, route)
        } catch (error) {
          this.recordError(id, route, error)
          failures.push(error)
        }
      }
      if (failures.length)
        throw new AggregateError(failures, `Failed to switch off shared provider ${id}`)
    })
  }

  /**
   * Persist the provider-level model list and, while it is LINKED, project it
   * into every enabled engine's allowlist under that engine's ids (ADR-074 §3) —
   * through the same writer `models:set-provider-allowlist` uses. Unlinking only
   * records the flag: both engines already hold the list the link projected, and
   * from then on each engine's own list is edited per engine.
   */
  async setCuration(id: string, curation: SharedProviderCuration): Promise<void> {
    await this.enqueue(async () => {
      const previous = this.requireDefinition(id)
      // A wire payload: the repository checks `models`, this checks there is a record.
      if (!curation || typeof curation.linked !== 'boolean') throw new Error('Invalid curation')
      const record: SharedProviderCuration = curation.linked
        ? { linked: true, ...(curation.models ? { models: curation.models } : {}) }
        : { linked: false }
      const definition = { ...previous, curation: record }
      this.repository.save(definition)
      // Switched off, no engine takes the list now; switching on projects it.
      if (record.linked) this.projectCuration(deliveredDefinition(definition))
    })
  }

  async setApiKey(id: string, key: string): Promise<void> {
    await this.enqueue(async () => {
      const definition = this.requireDefinition(id)
      if (definition.kind === 'subscription')
        throw new Error('API keys are only supported for custom and catalog providers')
      if (!key) throw new Error('API key is required')
      await this.deps.vault.saveCredential(id, { type: 'api_key', key })
      // Switched off, the key is only stored: switching on delivers it.
      const live = deliveredDefinition(definition)
      await this.reconcileCustomCredentials(live, live)
    })
  }

  async syncProvider(id: string): Promise<void> {
    await this.enqueue(() => this.syncDefinition(this.requireDefinition(id)))
  }
  async syncAll(): Promise<void> {
    await this.enqueue(async () => {
      const failures: unknown[] = []
      for (const definition of this.listDefinitions()) {
        try {
          await this.syncDefinition(definition)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Failed to sync one or more shared providers')
    })
  }

  /**
   * `route`'s harness runs now, after a time it did not (ADR-082 §8, "As built
   * (S7d)"): deliver every definition's current state to that route alone — the other harness is not touched, so a
   * running opencode is not recycled by pi arriving. An automatic delivery: a
   * key the harness holds of its own is kept and the route says so. The
   * ChatGPT credential is CredentialSync's to feed (`harnessArrived` there).
   */
  async harnessArrived(route: Route): Promise<void> {
    await this.enqueue(async () => {
      if (!this.harnessRuns(route)) return
      const failures: unknown[] = []
      for (const definition of this.listDefinitions()) {
        try {
          await this.syncDefinition(definition, { only: route })
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length)
        throw new AggregateError(failures, `Failed to deliver shared providers to ${route}`)
    })
  }

  /**
   * Replace the credential `route`'s engine holds of its own with the stored key
   * — the user's answer to a route that kept its own key (ADR-082 §8, S7d),
   * after the same confirm as switching on.
   */
  async useStoredKey(id: string, route: Route): Promise<void> {
    await this.enqueue(async () => {
      if (route !== 'pi' && route !== 'opencode')
        throw new Error(`Unknown engine: ${String(route)}`)
      const definition = this.requireDefinition(id)
      if (!deliveredDefinition(definition).routes[route].enabled)
        throw new Error(`${definition.name} is not delivered to ${route}`)
      if (!this.harnessRuns(route)) throw new Error(`${route} is not installed`)
      await this.syncDefinition(definition, { only: route, keepOwnKeys: false })
    })
  }

  async disconnectProvider(id: string): Promise<void> {
    await this.enqueue(async () => {
      const definition = this.requireDefinition(id)
      if (id === 'chatgpt') {
        try {
          await this.deps.credentialSync.disconnectChatgpt()
          for (const route of routes) this.clearError(id, route)
        } catch (error) {
          for (const route of routes) this.recordError(id, route, error)
          throw error
        }
        return
      }
      const owned = new Set(this.credentialRoutes(deliveredDefinition(definition)))
      // The engines' keys first: a catalog route's key goes only while it is
      // ClaudeUI's, which is compared with the vault key (`removeRouteCredential`).
      const results = await Promise.allSettled([
        owned.has('pi') ? this.removeRouteCredential(definition, 'pi') : Promise.resolve(),
        owned.has('opencode')
          ? this.removeRouteCredential(definition, 'opencode')
          : Promise.resolve()
      ])
      const central = await Promise.allSettled([this.deps.vault.removeCredential(id)])
      const failures: unknown[] = []
      const centralFailure = central[0].status === 'rejected' ? central[0].reason : undefined
      if (centralFailure) failures.push(centralFailure)
      for (const [route, result] of [
        ['pi', results[0]],
        ['opencode', results[1]]
      ] as const) {
        if (result.status === 'fulfilled' && !centralFailure) this.clearError(id, route)
        else {
          const error = result.status === 'rejected' ? result.reason : centralFailure
          this.recordError(id, route, error)
          if (result.status === 'rejected') failures.push(error)
        }
      }
      if (failures.length)
        throw new AggregateError(failures, `Failed to disconnect shared provider ${id}`)
    })
  }

  async setRouteDefaultModel(id: string, route: Route, modelId: string | undefined): Promise<void> {
    await this.enqueue(async () => {
      const previous = this.requireDefinition(id)
      // A catalog definition lists no models — the engines' own catalogs do —
      // so there is nothing here to name as a route default.
      if (previous.kind === 'catalog' && modelId)
        throw new Error('Catalog providers take their default model from each engine')
      const models = await this.listProviderModels(id)
      const model = modelId ? models.find((candidate) => candidate.id === modelId) : undefined
      if (
        modelId &&
        (!model ||
          model.harnessOverrides?.[route]?.available === false ||
          model.harnessOverrides?.[route]?.enabled === false)
      ) {
        throw new Error(`Model is unavailable for ${route}: ${modelId}`)
      }
      const definition = withRoute(previous, route, { defaultModel: modelId })
      this.repository.save(definition)
      if (modelId) this.clearOtherRouteDefaults(id, route)
      // Recorded either way; an engine's default names it only while it is on.
      this.applyDefault(
        deliveredDefinition({ ...definition, models }),
        route,
        deliveredDefinition({ ...previous, models })
      )
    })
  }

  async listProviderModels(id: string): Promise<SharedProviderModel[]> {
    const definition = this.requireDefinition(id)
    return id === 'chatgpt' && this.deps.getChatgptModels
      ? this.deps.getChatgptModels()
      : definition.models
  }

  /**
   * Bring the engines in line with `definition`: every route, or `only` one.
   *
   * `keepOwnKeys` (the default) is an AUTOMATIC delivery — the boot sync, Retry,
   * a harness arriving: a catalog route whose engine holds a credential of its
   * own for the vendor, not the vault key, keeps it and reports why, because
   * nobody asked the user (a route switched on while its harness did not run
   * never had the switch's own-key check). An explicit action that already
   * asked, or needs no asking (switching on, adopting), passes false.
   */
  private async syncDefinition(
    definition: SharedProviderDefinition,
    { only, keepOwnKeys = true }: { only?: Route; keepOwnKeys?: boolean } = {}
  ): Promise<void> {
    const targets = only ? [only] : routes
    if (definition.id === 'chatgpt') {
      // An arrival feeds its one harness through CredentialSync; feeding both
      // here would rewrite the other harness's store for nothing.
      if (!only) await this.syncChatgpt(definition)
      if (!targets.some((route) => definition.routes[route].defaultModel)) return
      const withModels = await this.withCatalogModels(definition)
      for (const route of targets) {
        this.applyDefault(
          withModels,
          route,
          withModels.routes[route].enabled
            ? withModels
            : withRoute(withModels, route, { enabled: true })
        )
      }
      return
    }
    // Switched off, every route is off for delivery: a sync keeps it out of the
    // engines, as it does a single route that is off.
    const live = deliveredDefinition(definition)
    const failures: unknown[] = []
    for (const route of targets) {
      let failed = false
      /** An own key kept: reported on the route, not thrown — nothing failed. */
      let kept = false
      try {
        // Writes skip a harness that does not run (`applyRoute`, the vend);
        // removals of ClaudeUI's own entries do not.
        this.applyRoute(live, live, route)
        if (live.routes[route].enabled) {
          // A harness that does not run gets it on arrival.
          if (this.runs(route, `delivering ${definition.id}`)) {
            if (keepOwnKeys && (await this.keepsOwnKey(live, route))) {
              kept = true
              this.recordError(definition.id, route, ownKeyKept(live, route))
              this.keptOwnKeys.set(
                definition.id,
                new Set([...(this.keptOwnKeys.get(definition.id) ?? []), route])
              )
              logger.info(
                'SharedProviders',
                `${route} holds its own key for ${definition.id} — kept, not replaced`
              )
            } else await this.vendRouteCredential(live, route)
          }
        } else if (live.kind !== 'catalog') {
          // A provider switched off is synced at every boot, and removing from
          // opencode starts its server: remove only a credential that is there.
          if (!definition.disabled || (await this.routeHasCredential(live, route)))
            await this.removeRouteCredential(live, route)
        } else if (definition.disabled && definition.routes[route].enabled)
          await this.reclaimStrandedKey(definition, route)
      } catch (error) {
        failed = true
        this.recordError(definition.id, route, error)
        failures.push(error)
      }
      try {
        this.applyDefault(
          live,
          route,
          live.routes[route].enabled ? live : withRoute(live, route, { enabled: true })
        )
      } catch (error) {
        failed = true
        this.recordError(definition.id, route, error)
        failures.push(error)
      }
      if (!failed && !kept) this.clearError(definition.id, route)
    }
    if (failures.length)
      throw new AggregateError(failures, `Failed to sync shared provider ${definition.id}`)
  }

  private async reconcileCustomCredentials(
    definition: SharedProviderDefinition,
    previous: SharedProviderDefinition | null
  ): Promise<void> {
    const failures: unknown[] = []
    for (const route of routes) {
      try {
        if (definition.routes[route].enabled) await this.vendRouteCredential(definition, route)
        else if (definition.kind !== 'catalog' || previous?.routes[route].enabled)
          await this.removeRouteCredential(definition, route)
        this.clearError(definition.id, route)
      } catch (error) {
        this.recordError(definition.id, route, error)
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, `Failed to reconcile credentials for ${definition.id}`)
  }

  private async syncChatgpt(definition: SharedProviderDefinition): Promise<void> {
    const credential = await this.deps.vault.loadCredential(definition.id)
    if (credential?.type !== 'oauth') {
      for (const route of routes) this.clearError(definition.id, route)
      return
    }
    try {
      const delivered = await this.deps.credentialSync.feedAll(credential)
      for (const route of routes) {
        if (!definition.routes[route].enabled) continue
        // CredentialSync skipped it: nothing failed, it is fed on arrival.
        if (delivered[route] || !this.harnessRuns(route)) this.clearError(definition.id, route)
        else this.recordError(definition.id, route, 'Credential delivery failed')
      }
    } catch (error) {
      for (const route of routes)
        if (definition.routes[route].enabled) this.recordError(definition.id, route, error)
      throw error
    }
  }

  private applyRoute(
    definition: SharedProviderDefinition,
    previous: SharedProviderDefinition | null,
    route: Route
  ): void {
    if (definition.id === 'chatgpt') return
    // A route that is off REMOVES the block (a file edit, done at once); one
    // that is on writes it, which waits for the harness.
    if (definition.routes[route].enabled && !this.runs(route, `the ${definition.id} definition`))
      return
    const previouslyManaged = previous?.routes[route].enabled === true
    if (route === 'pi')
      this.deps.pi.applyDefinition(definition, previouslyManaged, previous ?? definition)
    else
      this.deps.opencode.applyDefinitionRoute({
        definition,
        previouslyManaged,
        previousDefinition: previous ?? definition
      })
  }
  private rollbackDefinition(
    definition: SharedProviderDefinition,
    previous: SharedProviderDefinition | null,
    applied: Route[]
  ): void {
    for (const route of applied.reverse()) {
      // Nothing was applied to a harness that does not run.
      if (!this.harnessRuns(route)) continue
      try {
        if (previous?.routes[route].enabled) this.applyRoute(previous, previous, route)
        else if (route === 'pi') this.deps.pi.removeDefinition(definition)
        else this.deps.opencode.removeDefinitionRoute(definition)
      } catch {
        /* Preserve the original apply failure; status will discover any stale config. */
      }
    }
  }
  /** Take `definition` out of `route`'s engine — at once, whether or not it runs. */
  private async removeRoute(definition: SharedProviderDefinition, route: Route): Promise<void> {
    if (route === 'pi') this.deps.pi.removeDefinition(definition)
    else this.deps.opencode.removeDefinitionRoute(definition)
    await this.removeRouteCredential(definition, route)
  }
  /**
   * Take a route's key out of its engine — at once, whether or not the harness
   * runs (ADR-082 §8, S7d): pi's is a file edit either way; opencode's goes
   * through its server while it runs and is a direct file edit while it does
   * not.
   *
   * A catalog route's slot is a vendor the engine knows, so it may hold the
   * user's own key or sign-in: only ClaudeUI's key — the vault key, or the one
   * last delivered there ({@link holdsOurKey}) — is taken out. Any other is
   * left where it is, and the slot's fingerprint forgotten. Callers remove the
   * vault key AFTER this, since the comparison reads it. A custom definition's
   * native id is ClaudeUI's own: its entry always goes.
   */
  private async removeRouteCredential(
    definition: SharedProviderDefinition,
    route: Route
  ): Promise<void> {
    const vendorId = routeNativeId(definition, route)
    if (definition.kind === 'catalog' && !(await this.holdsOurKey(definition, route))) {
      this.deliveredKeys.forget(route, vendorId)
      if (await this.routeHasCredential(definition, route))
        logger.info(
          'SharedProviders',
          `${route}: the ${vendorId} credential there is not ClaudeUI's — left in place`
        )
      return
    }
    if (route === 'pi') await this.deps.pi.removeCredential(definition)
    else await this.deps.opencode.removeCredential(definition, this.harnessRuns('opencode'))
    this.deliveredKeys.forget(route, vendorId)
  }
  private async vendRouteCredential(
    definition: SharedProviderDefinition,
    route: Route
  ): Promise<void> {
    const credential = await this.deps.vault.loadCredential(definition.id)
    if (!credential || !definition.routes[route].enabled) return
    if (credential.type !== 'api_key') return
    if (!this.runs(route, `the ${definition.id} key`)) return
    if (route === 'pi') await this.deps.pi.vendApiKey(definition, credential.key)
    else await this.deps.opencode.vendApiKey(definition, credential.key)
    this.deliveredKeys.record(route, routeNativeId(definition, route), credential.key)
  }

  private applyDefault(
    definition: SharedProviderDefinition,
    route: Route,
    previous = definition
  ): void {
    const resolved =
      route === 'pi'
        ? this.deps.pi.resolveDefaultModel(definition)
        : this.deps.opencode.resolveDefaultModel(definition)
    if (!resolved) return this.clearOwnedDefault(previous, route)
    if (!this.defaultWritable(route)) return
    const value =
      typeof resolved === 'string' ? resolved : `${resolved.providerId}/${resolved.modelId}`
    if (route === 'pi') this.defaults.setPiDefault(value)
    else this.defaults.setOpencodeDefault(value)
  }
  /** Clear a default this definition set — ClaudeUI's own value, cleared at once. */
  private clearOwnedDefault(definition: SharedProviderDefinition, route: Route): void {
    const resolved =
      route === 'pi'
        ? this.deps.pi.resolveDefaultModel(definition)
        : this.deps.opencode.resolveDefaultModel(definition)
    if (!resolved) return
    const value =
      typeof resolved === 'string' ? resolved : `${resolved.providerId}/${resolved.modelId}`
    const current =
      route === 'pi' ? this.defaults.getPiDefault() : this.defaults.getOpencodeDefault()
    if (current !== value) return
    if (route === 'pi') this.defaults.setPiDefault(undefined)
    else this.defaults.setOpencodeDefault(undefined)
  }
  private async withCatalogModels(
    definition: SharedProviderDefinition
  ): Promise<SharedProviderDefinition> {
    return definition.id === 'chatgpt'
      ? { ...definition, models: await this.listProviderModels(definition.id) }
      : definition
  }
  private async statusRoute(
    definition: SharedProviderDefinition,
    route: Route,
    credential: boolean,
    configured: boolean,
    models: SharedProviderModel[],
    error?: string
  ): Promise<SharedProviderStatus['routes'][Route]> {
    const enabled = definition.routes[route].enabled
    const kept = enabled && this.keptOwnKeys.get(definition.id)?.has(route) === true
    // A catalog definition lists no models — each engine's own catalog does — so
    // `definition.models` has nothing to count, and a zero there would diagnose
    // every enabled catalog route as empty. The registry counts it from the
    // engine's catalog instead.
    if (definition.kind === 'catalog') {
      return {
        enabled,
        delivered: enabled && configured && credential,
        ...(error ? { error } : {}),
        ...(kept ? { ownKeyKept: true as const } : {})
      }
    }
    const modelCount = models.filter(
      (model) =>
        model.harnessOverrides?.[route]?.available !== false &&
        model.harnessOverrides?.[route]?.enabled !== false
    ).length
    return {
      enabled,
      delivered: enabled && configured && credential,
      modelCount,
      ...(error ? { error } : {}),
      ...(kept ? { ownKeyKept: true as const } : {}),
      // Only diagnose a route that is switched on and empty. A disabled route is
      // empty by intent, and an errored one already says what went wrong — adding
      // a cause there would compete with the actual failure.
      ...(enabled && !error && modelCount === 0
        ? { diagnosis: await this.diagnoseRoute(definition, route) }
        : {})
    }
  }

  /**
   * Ask the route's adapter why it is empty: opencode tells its native provider
   * veto from a model allowlist; pi tells a missing credential from its
   * per-provider allowlist (ADR-074 §5). An adapter that cannot answer falls
   * back to the generic cause.
   */
  private async diagnoseRoute(
    definition: SharedProviderDefinition,
    route: Route
  ): Promise<SharedProviderRouteDiagnosis> {
    try {
      return route === 'pi'
        ? await this.deps.pi.diagnoseZeroModels(definition)
        : this.deps.opencode.diagnoseZeroModels(definition)
    } catch {
      return 'no-models-discovered'
    }
  }
  /**
   * The engines whose native credential for this definition is OURS to delete.
   *
   * A custom definition's native id is one ClaudeUI made up, so both engines'
   * entries are its own. A catalog definition's native id is a vendor the engine
   * already knows (`openrouter`): a disabled route's entry is whatever the user
   * keeps there natively, and ClaudeUI never delivered it — only an ENABLED
   * route's entry is the one we wrote. Enabling or disabling a route is what
   * moves the line (`setRouteEnabled`), never a sync.
   */
  private credentialRoutes(definition: SharedProviderDefinition): Route[] {
    return definition.kind === 'catalog'
      ? routes.filter((route) => definition.routes[route].enabled)
      : routes
  }

  private routeHasCredential(definition: SharedProviderDefinition, route: Route): Promise<boolean> {
    return route === 'pi'
      ? this.deps.pi.hasCredential(definition)
      : this.deps.opencode.hasCredential(definition)
  }

  /**
   * The engine's plain API key for this route's vendor is the one in the vault —
   * compared here, in the main process. False when either is missing or no
   * reader is wired.
   */
  private async holdsVaultKey(
    definition: SharedProviderDefinition,
    route: Route
  ): Promise<boolean> {
    const reader = this.deps.nativeKeys?.[route]
    if (!reader) return false
    const stored = await this.deps.vault.loadCredential(definition.id)
    if (stored?.type !== 'api_key') return false
    return reader.readApiKey(routeNativeId(definition, route)) === stored.key
  }

  /**
   * The engine's plain API key for this route's vendor is ClaudeUI's: the vault
   * key, or the key ClaudeUI last delivered into that slot (its fingerprint). A
   * slot with no fingerprint — an install from before them — has only the
   * vault key as ClaudeUI's. False for an OAuth sign-in, or no reader wired.
   */
  private async holdsOurKey(definition: SharedProviderDefinition, route: Route): Promise<boolean> {
    const vendorId = routeNativeId(definition, route)
    const held = this.deps.nativeKeys?.[route].readApiKey(vendorId)
    if (!held) return false
    if (this.deliveredKeys.matches(route, vendorId, held)) return true
    return this.holdsVaultKey(definition, route)
  }

  /**
   * A catalog provider that is OFF, on a route that is on in its settings: the
   * engine still holding ClaudeUI's key means a switch-off was interrupted
   * before it took the key back. Take it now; any other key there is the
   * user's own and stays (`removeRouteCredential` checks).
   */
  private async reclaimStrandedKey(
    definition: SharedProviderDefinition,
    route: Route
  ): Promise<void> {
    await this.removeRouteCredential(definition, route)
  }

  private async reclaimStrandedKeys(definition: SharedProviderDefinition): Promise<void> {
    if (!definition.disabled || definition.kind !== 'catalog') return
    for (const route of routes)
      if (definition.routes[route].enabled) await this.reclaimStrandedKey(definition, route)
  }

  /**
   * The engines, among a catalog provider's routes that are on in its settings,
   * that hold a credential for the vendor OTHER than the vault key — a key the
   * user gave them while the provider was off, or a sign-in. Switching the
   * provider on would replace it.
   */
  private async ownCredentialRoutes(definition: SharedProviderDefinition): Promise<Route[]> {
    if (definition.kind !== 'catalog') return []
    const own: Route[] = []
    for (const route of routes) {
      if (!definition.routes[route].enabled) continue
      // A harness that does not run is not written into, so switching on
      // replaces nothing there; its arrival keeps an own key (`keepsOwnKey`).
      if (!this.harnessRuns(route)) continue
      if (await this.holdsOwnKey(definition, route)) own.push(route)
    }
    return own
  }

  /**
   * The engine holds a credential for this route's vendor that is neither the
   * vault key nor the key ClaudeUI last delivered there (a key replaced while
   * the harness was away is still ClaudeUI's). A slot with no fingerprint yet —
   * an install from before them — has only the vault key as ClaudeUI's.
   */
  private async holdsOwnKey(definition: SharedProviderDefinition, route: Route): Promise<boolean> {
    return (
      (await this.routeHasCredential(definition, route)) &&
      !(await this.holdsOurKey(definition, route))
    )
  }

  /**
   * An automatic delivery of this catalog route would replace a credential the
   * engine holds of its own: there is a vault key to deliver, and the engine
   * holds something else for the vendor. A custom definition's native id is
   * ClaudeUI's own, so it has no such key.
   */
  private async keepsOwnKey(definition: SharedProviderDefinition, route: Route): Promise<boolean> {
    if (definition.kind !== 'catalog') return false
    const stored = await this.deps.vault.loadCredential(definition.id)
    if (stored?.type !== 'api_key') return false
    return this.holdsOwnKey(definition, route)
  }

  /**
   * Whether `route`'s harness runs, so its own files may be written. One that
   * does not is skipped with one line; nothing failed, so no route error.
   */
  private runs(route: Route, what: string): boolean {
    if (this.harnessRuns(route)) return true
    logger.info('SharedProviders', `${route} not installed — skipping ${what}`)
    return false
  }

  /**
   * pi's default model is ClaudeUI's own record (`engines/pi.json`), written
   * whether or not pi runs; opencode's is its own config file.
   */
  private defaultWritable(route: Route): boolean {
    return route === 'pi' || this.harnessRuns(route)
  }

  /**
   * Refuse a definition whose ENABLED route lands on a native id another
   * definition's enabled route already delivers to, on the same engine
   * (ADR-074 §6). Without it a catalog `openai` with its opencode route on would
   * vend an API key over ChatGPT's OAuth entry for opencode's `openai`, and
   * removing either would delete the other's credential.
   */
  private assertNoNativeIdCollision(definition: SharedProviderDefinition, only?: Route): void {
    // A provider switched off delivers nothing, so it neither collides nor is
    // collided with: a catalog `openai` that is off must not block ChatGPT.
    const live = deliveredDefinition(definition)
    for (const route of only ? [only] : routes) {
      if (!live.routes[route].enabled) continue
      const nativeId = routeNativeId(definition, route)
      const other = this.repository
        .list()
        .find(
          (candidate) =>
            candidate.id !== definition.id &&
            deliveredDefinition(candidate).routes[route].enabled &&
            routeNativeId(candidate, route) === nativeId
        )
      if (other) {
        throw new Error(
          `${other.name} already uses ${route}'s "${nativeId}". Leave ${route} unticked here, or turn ${route} off for ${other.name}.`
        )
      }
    }
  }

  /**
   * A removed provider's model list in each engine's allowlist (ClaudeUI's own
   * `engines/<engine>.json`, harness installed or not) goes with it. A catalog
   * vendor the engine still holds a credential for — the user's own, which a
   * removal leaves — keeps its list: it curates that engine's own provider now.
   */
  private async clearModelLists(definition: SharedProviderDefinition): Promise<void> {
    for (const route of routes) {
      if (definition.kind === 'catalog' && (await this.routeHasCredential(definition, route)))
        continue
      this.writeModelAllowlist(route, routeNativeId(definition, route), null)
    }
  }

  /** Write a linked list into `only`, or every enabled route, in each engine's own ids. */
  private projectCuration(definition: SharedProviderDefinition, only?: Route): void {
    const curation = definition.curation
    if (!curation?.linked) return
    for (const route of only ? [only] : routes) {
      if (!definition.routes[route].enabled) continue
      this.writeModelAllowlist(
        route,
        routeNativeId(definition, route),
        curationForEngine(definition, curation, route)
      )
    }
  }

  /** A vendor id some definition already claims: by its own id, or by an enabled route. */
  private claimsVendor(vendorId: string): boolean {
    return this.repository
      .list()
      .some(
        (definition) =>
          definition.id === vendorId ||
          routes.some(
            (route) =>
              definition.routes[route].enabled && routeNativeId(definition, route) === vendorId
          )
      )
  }

  /**
   * Vendors whose API key BOTH engines hold natively, that no definition claims
   * and both engines' catalogs know. The keys are compared here, in the main
   * process; what comes back is a verdict and, for a conflict, last-four hints.
   */
  async scanNativeKeys(
    /**
     * opencode's catalog as the caller already read it (the registry has), so a
     * cold catalog is not fetched twice. pi's catalog is a constant list.
     */
    preloaded?: { opencode: ReadonlyMap<string, string> }
  ): Promise<NativeKeyCandidate[]> {
    const native = this.deps.nativeKeys
    if (!native) return []
    const plain = this.listPlainApiKeyVendorIds()
    const inPi = new Set(plain.pi)
    const shared = plain.opencode.filter(
      (id) => inPi.has(id) && isProviderId(id) && !this.claimsVendor(id)
    )
    if (shared.length === 0) return []
    const loaded = await native.loadCatalogs(preloaded ? { skipOpencode: true } : undefined)
    const catalogs = preloaded ? { ...loaded, opencode: preloaded.opencode } : loaded
    const out: NativeKeyCandidate[] = []
    for (const id of shared) {
      if (!catalogs.pi.has(id) || !catalogs.opencode.has(id)) continue
      const pi = native.pi.readApiKey(id)
      const opencode = native.opencode.readApiKey(id)
      if (!pi || !opencode) continue
      out.push(
        pi === opencode
          ? { id, state: 'identical' }
          : { id, state: 'conflict', hints: { pi: keyHint(pi), opencode: keyHint(opencode) } }
      )
    }
    return out
  }

  /**
   * The vendor ids each engine holds a PLAIN API key for — exactly what
   * {@link adoptNativeKey} can adopt from that engine. Ids only; no key leaves.
   */
  listPlainApiKeyVendorIds(): Record<Route, string[]> {
    const native = this.deps.nativeKeys
    if (!native) return { pi: [], opencode: [] }
    return {
      pi: native.pi.listApiKeyVendorIds(),
      opencode: native.opencode.listApiKeyVendorIds()
    }
  }

  /**
   * Boot migration (ADR-074 §6): adopt every vendor both engines hold the SAME
   * key for. A differing pair is left alone for the user; single-engine keys and
   * OAuth are never candidates. Safe to repeat — an adopted vendor is claimed —
   * and never throws: every failure is logged by vendor id and skipped.
   */
  async adoptNativeKeys(): Promise<void> {
    let candidates: NativeKeyCandidate[]
    try {
      candidates = await this.scanNativeKeys()
    } catch (error) {
      logger.warn('SharedProviders', `native key scan failed: ${errorMessage(error)}`)
      return
    }
    for (const candidate of candidates) {
      if (candidate.state !== 'identical') continue
      try {
        await this.adoptNativeKey(candidate.id)
      } catch (error) {
        logger.warn(
          'SharedProviders',
          `adopting the ${candidate.id} key failed: ${errorMessage(error)}`
        )
      }
    }
  }

  /**
   * Turn a vendor's native API key into a catalog definition: the key moves to
   * the vault and is delivered to every engine that held one. With `keep`, that
   * engine's key wins (a conflict, or a key only one engine holds); without it,
   * both engines must hold the same key.
   *
   * With `keep`, an engine that holds NO key of its own for the vendor is turned
   * on too, when its catalog knows the vendor — "use it for both engines". One
   * that holds any other credential for it (an OAuth sign-in) is left off: its
   * credential is never replaced without being asked.
   *
   * The key is read and compared HERE, in the main process, and goes to the
   * vault and the engines' own stores only. Nothing about it is logged or
   * returned.
   */
  async adoptNativeKey(id: string, keep?: Route): Promise<void> {
    await this.enqueue(async () => {
      validateSharedProviderId(id)
      const native = this.deps.nativeKeys
      if (!native) throw new Error('Native key adoption is unavailable')
      if (this.claimsVendor(id)) throw new Error(`Provider "${id}" is already shared`)
      const keys: Record<Route, string | null> = {
        pi: native.pi.readApiKey(id),
        opencode: native.opencode.readApiKey(id)
      }
      let key: string
      if (keep) {
        const kept = keys[keep]
        if (!kept) throw new Error(`${keep} holds no API key for ${id}`)
        key = kept
      } else {
        if (!keys.pi || !keys.opencode)
          throw new Error(`Only one engine holds a key for ${id}; choose it to adopt`)
        if (keys.pi !== keys.opencode)
          throw new Error(`The engines hold different keys for ${id}; choose which to keep`)
        key = keys.pi
      }
      const catalogs = await native.loadCatalogs()
      const knows = (route: Route): boolean =>
        (route === 'pi' ? catalogs.pi : catalogs.opencode).has(id)
      if (keep && !(keys[keep] !== null && knows(keep)))
        throw new Error(`${keep} does not know a provider "${id}"`)
      const draft: SharedProviderDefinition = {
        id,
        name: catalogs.opencode.get(id) || id,
        kind: 'catalog',
        models: [],
        managed: true,
        routes: { pi: { enabled: true }, opencode: { enabled: true } }
      }
      // An engine that holds a plain key takes the kept one (a conflict is
      // resolved by replacing it). One with nothing at all for the vendor gets
      // it too, but only with `keep`: without it, adoption is the boot pass,
      // which never touches an engine the user did not set up.
      const enabled = async (route: Route): Promise<boolean> => {
        if (!knows(route)) return false
        if (keys[route] !== null) return true
        if (!keep) return false
        const other = route === 'pi' ? this.deps.pi : this.deps.opencode
        return !(await other.hasCredential(draft))
      }
      const definition: SharedProviderDefinition = {
        ...draft,
        routes: {
          pi: { enabled: await enabled('pi') },
          opencode: { enabled: await enabled('opencode') }
        }
      }
      this.assertNoNativeIdCollision(definition)
      await this.deps.vault.saveCredential(id, { type: 'api_key', key })
      try {
        this.repository.save(definition)
      } catch (error) {
        await this.deps.vault.removeCredential(id).catch(() => undefined)
        throw error
      }
      logger.info(
        'SharedProviders',
        `adopted the ${id} API key into the vault (${keep ? `kept ${keep}'s` : 'identical in both engines'})`
      )
      // Adopting is the user's (or, at boot, an identical key): the key the
      // engines are given is the one they already hold, or the one chosen.
      await this.syncDefinition(definition, { keepOwnKeys: false })
    })
  }

  private requireDefinition(id: string): SharedProviderDefinition {
    const definition = this.repository.get(id)
    if (!definition) throw new Error(`Unknown shared provider: ${id}`)
    return definition
  }
  private clearCompetingDefaults(definition: SharedProviderDefinition): void {
    for (const route of routes) {
      if (definition.routes[route].defaultModel) {
        this.clearOtherRouteDefaults(definition.id, route)
      }
    }
  }
  private clearOtherRouteDefaults(id: string, route: Route): void {
    for (const other of this.repository.list()) {
      if (other.id === id || !other.routes[route].defaultModel) continue
      this.repository.save(withRoute(other, route, { defaultModel: undefined }))
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation)
    this.mutation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  private recordError(id: string, route: Route, error: unknown): void {
    this.keptOwnKeys.get(id)?.delete(route)
    this.routeErrors.set(id, {
      ...this.routeErrors.get(id),
      [route]: error instanceof Error ? error.message : String(error)
    })
  }
  private clearError(id: string, route: Route): void {
    const errors = { ...this.routeErrors.get(id) }
    delete errors[route]
    this.routeErrors.set(id, errors)
    this.keptOwnKeys.get(id)?.delete(route)
  }
}
/**
 * The route's reason when an automatic delivery kept an engine's own key
 * (ADR-082 §8, S7d): the sheet shows it beside "Use the stored key", and the
 * list reads "Not delivered to". Exported for the renderer's match.
 */
export function ownKeyKept(definition: SharedProviderDefinition, route: Route): string {
  return `${route} has its own key for ${definition.name}; it was kept.`
}
/** The native provider id a definition's route delivers to on that engine. */
function routeNativeId(definition: SharedProviderDefinition, route: Route): string {
  return route === 'pi' ? nativeProviderId(definition) : opencodeProviderId(definition)
}
function isProviderId(id: string): boolean {
  try {
    validateSharedProviderId(id)
    return true
  } catch {
    return false
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/** `definition` switched off (`disabled: true`) or on (no `disabled` key at all). */
function withDisabled(
  definition: SharedProviderDefinition,
  disabled: boolean
): SharedProviderDefinition {
  const { disabled: _, ...rest } = definition
  return disabled ? { ...rest, disabled: true } : rest
}
function withRoute(
  definition: SharedProviderDefinition,
  route: Route,
  update: Partial<SharedProviderDefinition['routes'][Route]>
): SharedProviderDefinition {
  return {
    ...definition,
    routes: { ...definition.routes, [route]: { ...definition.routes[route], ...update } }
  }
}
function productionDefaultTargets(): SharedProviderDefaultTargets {
  return {
    getPiDefault: () => loadEngineConfig('pi').piConfig?.defaultModel,
    setPiDefault: (defaultModel) => {
      const config = loadEngineConfig('pi')
      saveEngineConfig('pi', { ...config, piConfig: { ...config.piConfig, defaultModel } })
    },
    getOpencodeDefault: () => readOpencodeNativeConfig().model,
    setOpencodeDefault: (model) =>
      writeOpencodeNativeConfig({ ...readOpencodeNativeConfig(), model })
  }
}
