/**
 * Which engines a session on each engine can dispatch into (ADR-033). A leaf
 * module so a session's own input check reads the same table the dispatcher
 * does — session tests mock the dispatcher module wholesale, and a check that
 * lived there would vanish with it.
 */

import type { EngineId } from '../../shared/types'

/** Every OTHER engine (ADR-033's same-engine guard, `launchRun`). */
export const DISPATCH_TARGETS: Readonly<Record<EngineId, readonly EngineId[]>> = {
  claude: ['opencode', 'pi'],
  opencode: ['claude', 'pi'],
  pi: ['claude', 'opencode']
}

/** Whether a session on `from` may dispatch into `to`. */
export function canDispatchInto(from: EngineId, to: unknown): to is EngineId {
  return typeof to === 'string' && (DISPATCH_TARGETS[from] as readonly string[]).includes(to)
}
