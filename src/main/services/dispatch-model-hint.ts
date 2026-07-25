/**
 * Builds the model-list sentence(s) baked into a `dispatch_agent` tool
 * registration at creation time (ADR-033 follow-up).
 *
 * Problem this closes: the calling agent has no way to learn which model ids
 * are valid for a dispatch target — opencode's "providerID/modelID" strings
 * are unguessable, and even Claude's aliases are unstated. Previously the
 * only feedback was the dispatcher's isError echo AFTER a failed call. This
 * module resolves a concrete hint (allowlist, or a cached-known model list,
 * or a generic per-engine format hint) once at registration time so both
 * `collab-tool.ts` (Claude → opencode) and `opencode-hosted-tools.ts`
 * (opencode → Claude) can append it to the tool description and the `model`
 * param's own `.describe()`.
 *
 * Deliberately a LEAF module — no imports beyond the `EngineId` type — so
 * both call sites (which sit on opposite sides of the require-cycle hazard
 * documented in opencode-hosted-tools.ts's CYCLE NOTE) can import it without
 * risk. Callers are responsible for sourcing `allowedModels`/`defaultModel`
 * (from `loadEngineConfig(targetEngine).dispatch`) and `knownModelIds` (from
 * a synchronous, cache-only, never-blocking/never-spawning source) and
 * passing them in — this module does no I/O of its own.
 */
import type { EngineId } from '../../shared/types'

/** Cap on how many concrete model ids surface from a cached-list peek. */
const MAX_LISTED_MODELS = 15

export interface DispatchModelHintInput {
  /** The engine `dispatch_agent` targets (the OTHER side from the host). */
  targetEngine: EngineId
  /** From `loadEngineConfig(targetEngine).dispatch.allowedModels` — a non-empty
   *  list always wins over `knownModelIds` (it's the authoritative gate the
   *  dispatcher itself enforces). */
  allowedModels?: string[]
  /** From `loadEngineConfig(targetEngine).dispatch.defaultModel`. */
  defaultModel?: string
  /**
   * Model ids known to be available for the target engine, from a
   * synchronous, cache-only source (e.g. `peekOpencodeModels()`). Pass
   * undefined/empty when nothing is cached yet — callers must NEVER derive
   * this from a source that can block or spawn a process (a tool
   * registration path must stay synchronous and side-effect-free).
   */
  knownModelIds?: string[]
}

export interface DispatchModelHint {
  /** Full sentence(s) to append to the tool's top-level description. */
  long: string
  /** Shorter form to append to the `model` parameter's own `.describe()`. */
  short: string
}

function genericHint(targetEngine: EngineId): { long: string; short: string } {
  if (targetEngine === 'opencode') {
    return {
      long: 'Models use the "providerID/modelID" format (e.g. "opencode/nemotron-3-ultra-free").',
      short: 'Use "providerID/modelID" format (e.g. "opencode/nemotron-3-ultra-free").'
    }
  }
  // ADR-033 M4c: pi's picker-value convention mirrors opencode's exactly
  // (engine-meta.ts's PI_META — "<provider>/<modelId>", e.g. its hardcoded
  // fallback PI_DEFAULT_MODEL) — a DISTINCT case from 'claude' below, not the
  // same generic Claude-alias phrasing (pi has no "sonnet"/"haiku" aliases).
  if (targetEngine === 'pi') {
    return {
      long: 'Models use the "provider/modelId" format (e.g. "openai-codex/gpt-5.6-luna").',
      short: 'Use "provider/modelId" format (e.g. "openai-codex/gpt-5.6-luna").'
    }
  }
  return {
    long: 'Claude model aliases, e.g. "sonnet", "haiku", "opus".',
    short: 'A Claude alias, e.g. "sonnet", "haiku", "opus".'
  }
}

/** Join ids, capping the listed count and noting how many were omitted. */
function listWithCap(ids: string[]): string {
  const shown = ids.slice(0, MAX_LISTED_MODELS)
  const omitted = ids.length - shown.length
  return omitted > 0 ? `${shown.join(', ')} (+${omitted} more)` : shown.join(', ')
}

/**
 * Resolve the model-list hint for a `dispatch_agent` registration targeting
 * `targetEngine`. Resolution order: configured allowlist (verbatim, no cap —
 * it's user-authored and expected to be small) > a cached-known model list
 * (capped at 15 ids) > a generic per-engine format hint. Always appends a
 * default-model clause.
 */
export function describeDispatchModels(input: DispatchModelHintInput): DispatchModelHint {
  const { targetEngine, allowedModels, defaultModel, knownModelIds } = input

  let long: string
  let short: string
  if (allowedModels && allowedModels.length > 0) {
    const joined = allowedModels.join(', ')
    long = `Allowed models: ${joined}.`
    short = `Must be one of: ${joined}.`
  } else if (knownModelIds && knownModelIds.length > 0) {
    const capped = listWithCap(knownModelIds)
    long = `Available models include: ${capped}.`
    short = `e.g. ${capped}.`
  } else {
    const hint = genericHint(targetEngine)
    long = hint.long
    short = hint.short
  }

  const defaultClauseLong = defaultModel
    ? `Default: ${defaultModel}.`
    : 'No default is configured — pass model explicitly.'
  const defaultClauseShort = defaultModel ? `Default: ${defaultModel}.` : 'No default configured.'

  return {
    long: `${long} ${defaultClauseLong}`,
    short: `${short} ${defaultClauseShort}`
  }
}
