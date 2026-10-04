/**
 * The cross-engine model catalog `session:get-engine-models` answers — one
 * implementation for both transports (desktop `session.ipc.ts`, remote
 * `remote-handlers.ts`), which differ only in how they ask Claude Code for its
 * models (the desktop's read also reports login status; ADR-014).
 *
 * The four lookups run CONCURRENTLY. Each is an independent process probe
 * (cli.js init, an opencode server, `pi --mode rpc`, the Codex app-server) with
 * timeouts up to 15s; awaited in turn, their latencies added up. Concurrent, the
 * reply waits for the SLOWEST one only — still one reply, so a probe that runs
 * to its timeout holds back every engine's models until then. Each degrades to
 * [] on its own: every engine but Claude is optional, and none may break the
 * picker for the others.
 */
import type { EngineModelGroup, ModelInfo } from '../../shared/types'
import { discoverCodexModels } from '../codex/model-discovery'
import { discoverOpencodeModels } from '../opencode/model-discovery'
import { discoverPiModels } from '../pi/model-discovery'

export async function listEngineModels(
  claudeModels: () => Promise<ModelInfo[]>
): Promise<EngineModelGroup[]> {
  const none = (): EngineModelGroup[] => []
  const [claude, opencodeGroups, piGroups, codexGroups] = await Promise.all([
    claudeModels().catch((): ModelInfo[] => []),
    // opencode and pi already answer [] when the binary is missing, no auth is
    // configured or discovery fails; the catches only keep an unexpected throw
    // from failing the whole catalog.
    discoverOpencodeModels().catch(none),
    discoverPiModels().catch(none),
    discoverCodexModels().catch(none)
  ])
  // Claude models as a flat group. supportedModels() returns bare ModelInfo
  // (no engineId/vendorId) — stamp them so the renderer can attribute a Claude
  // pick to the 'claude' engine. Without this, picking a Claude model while on
  // an opencode session leaves engineId undefined and the pick is mis-recorded
  // under the session's current engine (e.g. "opencode/default").
  const claudeGroup: EngineModelGroup = {
    engineId: 'claude',
    vendorId: 'anthropic',
    vendorName: 'Anthropic',
    models: claude.map((m) => ({ ...m, engineId: 'claude' as const, vendorId: 'anthropic' }))
  }
  return [claudeGroup, ...opencodeGroups, ...piGroups, ...codexGroups]
}
