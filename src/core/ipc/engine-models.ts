/**
 * The cross-engine model catalog `session:get-engine-models` answers — one
 * implementation for both transports (desktop `session.ipc.ts`, remote
 * `remote-handlers.ts`), which differ only in how they ask Claude Code for its
 * models (the desktop's read also reports login status; ADR-014).
 *
 * Asked for ONE engine, only that engine's lookup runs and only its groups come
 * back. That is how the composer reads: one request per engine, so each
 * engine's models land as soon as its own probe answers. Each lookup is an
 * independent process probe (cli.js init, an opencode server, `pi --mode rpc`,
 * the Codex app-server) with timeouts up to 15s, and a single reply for all four
 * held every engine's models back until the slowest probe — a pi probe running
 * to its timeout hid Claude's models with it.
 *
 * Asked for no engine, all four run CONCURRENTLY into one reply (claude,
 * opencode, pi, codex), which waits for the slowest. Kept for callers that want
 * every engine at once and can afford that wait (Settings' curation blocks).
 *
 * Each engine degrades to [] on its own: every engine but Claude is optional,
 * and none may break the picker for the others.
 */
import { HARNESS_IDS, isHarnessId } from '../../shared/harness-types'
import type { EngineId, EngineModelGroup, ModelInfo } from '../../shared/types'
import { discoverCodexModels } from '../codex/model-discovery'
import { discoverOpencodeModels } from '../opencode/model-discovery'
import { discoverPiModels } from '../pi/model-discovery'

/**
 * `engineId` is UNTRUSTED (a remote client's argument): absent (`undefined`,
 * or `null` — a JSON wire turns an `undefined` argument into it) asks for every
 * engine; anything that is not an engine id rejects. Never `[]`: an empty
 * answer reads as "this engine has no models", which would hide a client bug
 * behind a quietly empty picker.
 */
export async function listEngineModels(
  claudeModels: () => Promise<ModelInfo[]>,
  engineId?: unknown
): Promise<EngineModelGroup[]> {
  if (engineId === undefined || engineId === null) {
    const all = await Promise.all(HARNESS_IDS.map((id) => engineGroups(id, claudeModels)))
    return all.flat()
  }
  if (!isHarnessId(engineId)) {
    throw new Error(`get-engine-models: unknown engine ${JSON.stringify(engineId)}`)
  }
  return engineGroups(engineId, claudeModels)
}

function engineGroups(
  engineId: EngineId,
  claudeModels: () => Promise<ModelInfo[]>
): Promise<EngineModelGroup[]> {
  // opencode and pi already answer [] when the binary is missing, no auth is
  // configured or discovery fails; the catches only keep an unexpected throw
  // from failing the whole catalog.
  const none = (): EngineModelGroup[] => []
  switch (engineId) {
    case 'claude':
      return claudeModels()
        .catch((): ModelInfo[] => [])
        .then((models) => [claudeGroup(models)])
    case 'opencode':
      return discoverOpencodeModels().catch(none)
    case 'pi':
      return discoverPiModels().catch(none)
    case 'codex':
      return discoverCodexModels().catch(none)
  }
}

/**
 * Claude models as a flat group. supportedModels() returns bare ModelInfo (no
 * engineId/vendorId) — stamp them so the renderer can attribute a Claude pick to
 * the 'claude' engine. Without this, picking a Claude model while on an opencode
 * session leaves engineId undefined and the pick is mis-recorded under the
 * session's current engine (e.g. "opencode/default").
 */
function claudeGroup(models: ModelInfo[]): EngineModelGroup {
  return {
    engineId: 'claude',
    vendorId: 'anthropic',
    vendorName: 'Anthropic',
    models: models.map((m) => ({ ...m, engineId: 'claude' as const, vendorId: 'anthropic' }))
  }
}
