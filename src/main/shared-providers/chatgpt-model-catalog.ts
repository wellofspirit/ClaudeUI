import type { EngineModelGroup } from '../../shared/types'
import type { SharedProviderModel } from '../../shared/shared-provider'

/** Merge route-native ChatGPT catalogs without importing or starting either harness. */
export function aggregateChatgptModels(
  piGroups: EngineModelGroup[],
  opencodeGroups: EngineModelGroup[]
): SharedProviderModel[] {
  const models = new Map<string, SharedProviderModel>()
  const add = (route: 'pi' | 'opencode', groups: EngineModelGroup[], vendorId: string) => {
    for (const group of groups) {
      if (group.vendorId !== vendorId) continue
      for (const native of group.models) {
        const separator = native.value.indexOf('/')
        if (separator < 1) continue
        const id = native.value.slice(separator + 1)
        const current = models.get(id) ?? {
          id,
          name: native.displayName,
          reasoning: false,
          vision: false,
          harnessOverrides: { pi: { available: false }, opencode: { available: false } }
        }
        current.reasoning ||= native.supportsEffort === true
        current.vision ||= native.vision === true
        current.harnessOverrides![route] = { id, available: true }
        models.set(id, current)
      }
    }
  }
  add('pi', piGroups, 'openai-codex')
  add('opencode', opencodeGroups, 'openai')
  return [...models.values()]
}
