import type { EngineId } from './engine'

/**
 * What a session runs with: the fields a spawn sets and a live change patches. One type for
 * both paths, so a field cannot exist on one of them only. Every member is optional; an engine
 * ignores the fields it does not take (noted per member).
 *
 * A new field: `src/core/providers/CLAUDE.md` has the recipe. The engines' `liveConfig` tables
 * do not compile until each says how it takes a live change of it.
 */
export interface SessionConfig {
  /** Model value in the engine's convention (Claude alias, opencode "vendorId/modelId", pi model id). All three engines. */
  model?: string
  /** Reasoning-effort tier. Claude and pi; opencode uses per-model reasoning variants instead. */
  effort?: string
  /** Thinking mode ('adaptive' | 'enabled' | 'disabled'). Claude only. */
  thinkingMode?: string
  /** Permission mode. All three engines. */
  permissionMode?: string
  /** The model's reasoning variant. opencode only; `null` is the model's default. */
  reasoningVariant?: string | null
}

/**
 * What a client asks for when it starts a session (`window.api.createSession`): where, on which
 * engine, with which config, and what it continues from.
 */
export interface SessionSpawnRequest {
  routingId: string
  cwd: string
  /** Absent means Claude: the default at the wire boundary for a client that predates engines. */
  engineId?: EngineId
  config?: SessionConfig
  /**
   * The engine session to continue. `at` is a fork anchor in the engine's own convention (a
   * JSONL line uuid for Claude, an entry id for pi); with `fork`, the session branches off
   * there into a new one instead of continuing in place.
   */
  resume?: { sessionId: string; at?: string; fork?: boolean }
  /**
   * The values every replica adopts as this session's own on the birth event. `effort`: a
   * string announces the spawn effort, `null` says the model takes none, absent says the
   * client does not know the model. `thinkingMode`: the raw pick, `null` for none.
   */
  announce?: { effort?: string | null; thinkingMode?: string | null }
}
