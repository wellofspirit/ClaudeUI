/**
 * session-delete.ts
 *
 * Engine-neutral persisted-session delete dispatcher (ADR-025). Moved out of
 * opencode-session-list.ts by engine-hardening Item 6b — the dispatcher itself
 * is engine-neutral and doesn't belong in an opencode-named module.
 */

import { historyFor } from './engine-history'
import type { EngineId } from '../../shared/types'

/**
 * Engine-neutral persisted-session delete. Each engine owns its mechanism:
 *  - opencode → DELETE /session/{id} via the shared server (deleteOpencodeSession)
 *  - pi → unlink the session's .jsonl file (deletePiSession)
 *  - claude / undefined → remove the JSONL + subagent dir (deleteSessionFiles)
 * The lossy projectKey is only used for the Claude filesystem path; opencode
 * and pi delete by their own engine-owned sessionId.
 *
 * Resolves `false` when the engine did not delete the session (opencode's server down, pi's
 * file stuck): the session survives, and whoever ends things WITH it must not.
 */
export async function deleteSessionByEngine(
  sessionId: string,
  projectKey: string,
  engineId?: EngineId
): Promise<boolean> {
  // opencode and pi swallow their own failures and say so with `false`; a refusal throws.
  return (await historyFor(engineId).delete(sessionId, projectKey)) !== false
}
