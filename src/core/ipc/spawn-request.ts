import type { EngineId, SessionConfig, SessionSpawnRequest } from '../../shared/types'
import { opt } from './wire-args'

/**
 * `session:create` takes `(routingId, request)`. A client loaded before the request object
 * existed (a browser tab left open across a host upgrade, a cached phone bundle) still sends
 * the 11 positional arguments `(routingId, cwd, effort, resumeSessionId, permissionMode,
 * model, thinkingMode, resumeSessionAt, forkSession, engineId, announce)`; the second one is
 * then a string. This file is the only place that knows either shape.
 */

/** The old positional list after the routing id, in its old order. Only legacy clients send it. */
export function spawnRequestFromLegacyArgs(
  cwd: string,
  effort?: string | null,
  resumeSessionId?: string | null,
  permissionMode?: string | null,
  model?: string | null,
  thinkingMode?: string | null,
  resumeSessionAt?: string | null,
  forkSession?: boolean | null,
  engineId?: EngineId | null,
  announce?: SessionSpawnRequest['announce'] | null
): SessionSpawnRequest {
  // A WS client's JSON turns an omitted argument into `null`: treated as absent (wire-args.ts).
  const config: SessionConfig = {}
  if (effort != null) config.effort = effort
  if (permissionMode != null) config.permissionMode = permissionMode
  if (model != null) config.model = model
  if (thinkingMode != null) config.thinkingMode = thinkingMode
  const sessionId = opt(resumeSessionId)
  const at = opt(resumeSessionAt)
  const fork = opt(forkSession)
  const engine = opt(engineId)
  const announced = opt(announce)
  return {
    cwd,
    ...(engine !== undefined ? { engineId: engine } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
    ...(sessionId !== undefined
      ? {
          resume: {
            sessionId,
            ...(at !== undefined ? { at } : {}),
            ...(fork !== undefined ? { fork } : {})
          }
        }
      : {}),
    ...(announced !== undefined ? { announce: announced } : {})
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): boolean => typeof v === 'string'
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === 'string'

/**
 * What each config field must be when it arrives as JSON. The config is spread whole into the
 * spawn options, so only these keys, with values of these kinds, come through from a client. A
 * new `SessionConfig` field does not compile until it has a check here.
 */
const CONFIG_WIRE_CHECKS: { [K in keyof Required<SessionConfig>]: (v: unknown) => boolean } = {
  model: isString,
  effort: isString,
  thinkingMode: isString,
  permissionMode: isString,
  reasoningVariant: isStringOrNull
}

function configFromWire(raw: Record<string, unknown>): SessionConfig {
  const config: Record<string, unknown> = {}
  for (const [key, check] of Object.entries(CONFIG_WIRE_CHECKS)) {
    if (check(raw[key])) config[key] = raw[key]
  }
  return config
}

/**
 * The request from the wire arguments after the routing id: `[request]`, or the legacy
 * `[cwd, effort, ...]`. A request object arrives as JSON over the WebSocket, so it is checked
 * for what the handler relies on (a string `cwd`); unknown keys are ignored at every level, a
 * value of the wrong kind is dropped, and a `config`, `resume` or `announce` that is not an
 * object is treated as absent.
 */
export function parseSpawnRequest(args: unknown[]): SessionSpawnRequest {
  const [first, ...rest] = args
  if (typeof first === 'string') {
    const [
      effort,
      resumeSessionId,
      permissionMode,
      model,
      thinkingMode,
      resumeSessionAt,
      forkSession,
      engineId,
      announce
    ] = rest as Parameters<typeof spawnRequestFromLegacyArgs> extends [string, ...infer R]
      ? R
      : never
    return spawnRequestFromLegacyArgs(
      first,
      effort,
      resumeSessionId,
      permissionMode,
      model,
      thinkingMode,
      resumeSessionAt,
      forkSession,
      engineId,
      announce
    )
  }
  if (!isObject(first) || typeof first.cwd !== 'string') {
    throw new Error('session:create needs a request with a string cwd')
  }
  const r = first.resume
  const a = first.announce
  return {
    cwd: first.cwd,
    ...(typeof first.engineId === 'string' ? { engineId: first.engineId as EngineId } : {}),
    ...(isObject(first.config) ? { config: configFromWire(first.config) } : {}),
    ...(isObject(r) && typeof r.sessionId === 'string'
      ? {
          resume: {
            sessionId: r.sessionId,
            ...(typeof r.at === 'string' ? { at: r.at } : {}),
            ...(typeof r.fork === 'boolean' ? { fork: r.fork } : {})
          }
        }
      : {}),
    ...(isObject(a)
      ? {
          announce: {
            ...(isStringOrNull(a.effort) ? { effort: a.effort as string | null } : {}),
            ...(isStringOrNull(a.thinkingMode)
              ? { thinkingMode: a.thinkingMode as string | null }
              : {})
          }
        }
      : {})
  }
}
