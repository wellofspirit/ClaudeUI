import type { VaultCredentialRecord } from '../auth/vault/AuthVault'
import type { CredentialSync } from '../auth/vault/CredentialSync'
import { readOpencodeNativeConfig, writeOpencodeNativeConfig } from '../opencode/opencode-config'
import { loadEngineConfig, saveEngineConfig } from '../services/ui-config'
import type {
  ConfigurableHarnessId,
  SharedProviderDefinition,
  SharedProviderModel,
  SharedProviderRouteDiagnosis,
  SharedProviderStatus
} from '../../shared/shared-provider'
import { OpencodeSharedProviderAdapter } from './OpencodeSharedProviderAdapter'
import { PiSharedProviderAdapter, isPiBuiltinCollision } from './PiSharedProviderAdapter'
import { SharedProviderRepository } from './SharedProviderRepository'

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
export interface SharedProviderServiceDeps {
  repository?: Repository
  vault: Vault
  pi: PiSharedProviderAdapter
  opencode: OpencodeSharedProviderAdapter
  credentialSync: Pick<CredentialSync, 'feedAll' | 'disconnectChatgpt'>
  defaults?: SharedProviderDefaultTargets
  getChatgptModels?: () => Promise<SharedProviderModel[]>
}

/** Serializes shared-provider RMW across definitions, vault credentials, and native routes. */
export class SharedProviderService {
  private readonly repository: Repository
  private readonly defaults: SharedProviderDefaultTargets
  private readonly routeErrors = new Map<string, Partial<Record<Route, string>>>()
  private mutation = Promise.resolve()

  constructor(private readonly deps: SharedProviderServiceDeps) {
    this.repository = deps.repository ?? new SharedProviderRepository()
    this.defaults = deps.defaults ?? productionDefaultTargets()
  }

  listDefinitions(): SharedProviderDefinition[] {
    return this.repository.list()
  }

  async getStatus(id: string): Promise<SharedProviderStatus> {
    const definition = this.requireDefinition(id)
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
    return {
      id,
      connected: credential !== null,
      modelCount: models.length,
      routes: {
        pi: this.statusRoute(definition, 'pi', piCredential, piConfigured, models, errors?.pi),
        opencode: this.statusRoute(
          definition,
          'opencode',
          opencodeCredential,
          opencodeConfigured,
          models,
          errors?.opencode
        )
      }
    }
  }

  async listStatuses(): Promise<SharedProviderStatus[]> {
    return Promise.all(this.listDefinitions().map(({ id }) => this.getStatus(id)))
  }

  async saveDefinition(definition: SharedProviderDefinition): Promise<void> {
    await this.enqueue(async () => {
      const previous = this.repository.get(definition.id)
      if (definition.id === 'chatgpt') {
        this.repository.save(definition)
        this.clearCompetingDefaults(definition)
        await this.syncChatgpt(await this.withCatalogModels(definition))
        return
      }
      if (definition.kind !== 'custom') throw new Error('Only custom providers can be saved')
      // Fail fast (M-AT4): a custom provider whose effective pi providerId
      // collides with a built-in native vendor (e.g. 'anthropic') would vend its
      // key over — and delete on removal — the user's real native pi credential.
      // Reject before applying/vending anything, regardless of route-enabled state.
      if (isPiBuiltinCollision(definition)) {
        throw new Error(
          `Provider id "${definition.routes.pi.providerId ?? definition.id}" collides with a built-in pi vendor; choose a different provider id`
        )
      }
      const applied: Route[] = []
      try {
        for (const route of routes) {
          this.applyRoute(definition, previous, route)
          applied.push(route)
          this.clearError(definition.id, route)
        }
        this.repository.save(definition)
        this.clearCompetingDefaults(definition)
      } catch (error) {
        const failedRoute = routes[applied.length]
        if (failedRoute) this.recordError(definition.id, failedRoute, error)
        else for (const route of applied) this.recordError(definition.id, route, error)
        this.rollbackDefinition(definition, previous, applied)
        throw error
      }
      await this.reconcileCustomCredentials(definition)
      for (const route of routes) this.applyDefault(definition, route, previous ?? definition)
    })
  }

  async removeDefinition(id: string): Promise<void> {
    await this.enqueue(async () => {
      const definition = this.requireDefinition(id)
      if (id === 'chatgpt') throw new Error('ChatGPT cannot be removed')
      this.deps.pi.removeDefinition(definition)
      this.deps.opencode.removeDefinitionRoute(definition)
      await Promise.all([
        this.deps.pi.removeCredential(definition),
        this.deps.opencode.removeCredential(definition),
        this.deps.vault.removeCredential(id)
      ])
      for (const route of routes) this.clearOwnedDefault(definition, route)
      this.repository.remove(id)
      this.routeErrors.delete(id)
    })
  }

  async setRouteEnabled(id: string, route: Route, enabled: boolean): Promise<void> {
    await this.enqueue(async () => {
      const previous = this.requireDefinition(id)
      if (previous.routes[route].enabled === enabled) return
      const definition = withRoute(previous, route, { enabled })
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

  async setApiKey(id: string, key: string): Promise<void> {
    await this.enqueue(async () => {
      const definition = this.requireDefinition(id)
      if (definition.kind !== 'custom')
        throw new Error('API keys are only supported for custom providers')
      if (!key) throw new Error('API key is required')
      await this.deps.vault.saveCredential(id, { type: 'api_key', key })
      await this.reconcileCustomCredentials(definition)
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
      const results = await Promise.allSettled([
        this.deps.vault.removeCredential(id),
        this.deps.pi.removeCredential(definition),
        this.deps.opencode.removeCredential(definition)
      ])
      const failures: unknown[] = []
      const centralFailure = results[0].status === 'rejected' ? results[0].reason : undefined
      if (centralFailure) failures.push(centralFailure)
      for (const [route, result] of [
        ['pi', results[1]],
        ['opencode', results[2]]
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
      this.applyDefault({ ...definition, models }, route, { ...previous, models })
    })
  }

  async listProviderModels(id: string): Promise<SharedProviderModel[]> {
    const definition = this.requireDefinition(id)
    return id === 'chatgpt' && this.deps.getChatgptModels
      ? this.deps.getChatgptModels()
      : definition.models
  }

  private async syncDefinition(definition: SharedProviderDefinition): Promise<void> {
    if (definition.id === 'chatgpt') {
      await this.syncChatgpt(definition)
      if (!routes.some((route) => definition.routes[route].defaultModel)) return
      const withModels = await this.withCatalogModels(definition)
      for (const route of routes) {
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
    const failures: unknown[] = []
    for (const route of routes) {
      let failed = false
      try {
        this.applyRoute(definition, definition, route)
        if (definition.routes[route].enabled) await this.vendRouteCredential(definition, route)
        else await this.removeRouteCredential(definition, route)
      } catch (error) {
        failed = true
        this.recordError(definition.id, route, error)
        failures.push(error)
      }
      try {
        this.applyDefault(
          definition,
          route,
          definition.routes[route].enabled
            ? definition
            : withRoute(definition, route, { enabled: true })
        )
      } catch (error) {
        failed = true
        this.recordError(definition.id, route, error)
        failures.push(error)
      }
      if (!failed) this.clearError(definition.id, route)
    }
    if (failures.length)
      throw new AggregateError(failures, `Failed to sync shared provider ${definition.id}`)
  }

  private async reconcileCustomCredentials(definition: SharedProviderDefinition): Promise<void> {
    const failures: unknown[] = []
    for (const route of routes) {
      try {
        if (definition.routes[route].enabled) await this.vendRouteCredential(definition, route)
        else await this.removeRouteCredential(definition, route)
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
        if (delivered[route]) this.clearError(definition.id, route)
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
      try {
        if (previous?.routes[route].enabled) this.applyRoute(previous, previous, route)
        else if (route === 'pi') this.deps.pi.removeDefinition(definition)
        else this.deps.opencode.removeDefinitionRoute(definition)
      } catch {
        /* Preserve the original apply failure; status will discover any stale config. */
      }
    }
  }
  private async removeRoute(definition: SharedProviderDefinition, route: Route): Promise<void> {
    if (route === 'pi') this.deps.pi.removeDefinition(definition)
    else this.deps.opencode.removeDefinitionRoute(definition)
    await this.removeRouteCredential(definition, route)
  }
  private async removeRouteCredential(
    definition: SharedProviderDefinition,
    route: Route
  ): Promise<void> {
    if (route === 'pi') await this.deps.pi.removeCredential(definition)
    else await this.deps.opencode.removeCredential(definition)
  }
  private async vendRouteCredential(
    definition: SharedProviderDefinition,
    route: Route
  ): Promise<void> {
    const credential = await this.deps.vault.loadCredential(definition.id)
    if (!credential || !definition.routes[route].enabled) return
    if (credential.type !== 'api_key') return
    if (route === 'pi') await this.deps.pi.vendApiKey(definition, credential.key)
    else await this.deps.opencode.vendApiKey(definition, credential.key)
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
    const value =
      typeof resolved === 'string' ? resolved : `${resolved.providerId}/${resolved.modelId}`
    if (route === 'pi') this.defaults.setPiDefault(value)
    else this.defaults.setOpencodeDefault(value)
  }
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
  private statusRoute(
    definition: SharedProviderDefinition,
    route: Route,
    credential: boolean,
    configured: boolean,
    models: SharedProviderModel[],
    error?: string
  ): SharedProviderStatus['routes'][Route] {
    const enabled = definition.routes[route].enabled
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
      // Only diagnose a route that is switched on and empty. A disabled route is
      // empty by intent, and an errored one already says what went wrong — adding
      // a cause there would compete with the actual failure.
      ...(enabled && !error && modelCount === 0
        ? { diagnosis: this.diagnoseRoute(definition, route) }
        : {})
    }
  }

  /**
   * Ask the route's adapter why it is empty. Only opencode can distinguish causes
   * (its native provider veto vs a model allowlist); pi has neither concept, so
   * an empty pi route can only mean nothing was discovered.
   */
  private diagnoseRoute(
    definition: SharedProviderDefinition,
    route: Route
  ): SharedProviderRouteDiagnosis {
    if (route === 'pi') return 'no-models-discovered'
    try {
      return this.deps.opencode.diagnoseZeroModels(definition)
    } catch {
      return 'no-models-discovered'
    }
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
    this.routeErrors.set(id, {
      ...this.routeErrors.get(id),
      [route]: error instanceof Error ? error.message : String(error)
    })
  }
  private clearError(id: string, route: Route): void {
    const errors = { ...this.routeErrors.get(id) }
    delete errors[route]
    this.routeErrors.set(id, errors)
  }
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
