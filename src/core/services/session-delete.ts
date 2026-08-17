/**
 * session-delete.ts
 *
 * Engine-neutral persisted-session delete dispatcher (ADR-025). Moved out of
 * opencode-session-list.ts by engine-hardening Item 6b — the dispatcher itself
 * is engine-neutral and doesn't belong in an opencode-named module.
 */

import { deleteOpencodeSession } from './opencode-session-list'
import { deletePiSession } from './pi-session-list'
import { deleteSessionFiles } from './delete-session-files'
import type { EngineId } from '../../shared/types'

/**
 * Engine-neutral persisted-session delete. Each engine owns its mechanism:
 *  - opencode → DELETE /session/{id} via the shared server (deleteOpencodeSession)
 *  - pi → unlink the session's .jsonl file (deletePiSession)
 *  - claude / undefined → remove the JSONL + subagent dir (deleteSessionFiles)
 * The lossy projectKey is only used for the Claude filesystem path; opencode
 * and pi delete by their own engine-owned sessionId.
 */
export async function deleteSessionByEngine(
  sessionId: string,
  projectKey: string,
  engineId?: EngineId
): Promise<void> {
  if (engineId === 'opencode') {
    await deleteOpencodeSession(sessionId)
  } else if (engineId === 'pi') {
    await deletePiSession(sessionId)
  } else {
    await deleteSessionFiles(sessionId, projectKey)
  }
}
