import { DispatchRun, DispatchRunRegistry } from '../../core/services/dispatch-runs'

/**
 * Register a running X-Agent run for `parentId` in a registry of its own (what the
 * dispatcher does at a launch) and return the call that ends it. A session's idle timer
 * holds while the run is registered (ADR-105 §3).
 */
export function startRunningDispatch(parentId: string): () => void {
  const registry = new DispatchRunRegistry()
  const run = new DispatchRun({
    parentId,
    toolUseId: `toolu_${parentId}`,
    background: true,
    engine: 'pi',
    name: null,
    description: undefined,
    continuation: false,
    launchMode: 'default',
    startedAt: 1
  })
  registry.add(run)
  return () => registry.remove(run)
}
