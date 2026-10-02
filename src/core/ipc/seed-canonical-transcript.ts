import { emitEvent, syncCore } from '../services/sync-host'
import { readSessionHistory as loadSessionHistory } from '../services/engine-history'
import { cwdToProjectKey } from '../../shared/project-key'
import { claudeProjectKeyFor } from '../services/claude-transcript-locator'
import { buildTodosFromMessages, buildSentFilesFromMessages } from '../../shared/derive-session'
import { logger } from '../services/logger'
import type { EngineId } from '../../shared/types'

// ---------------------------------------------------------------------------
// Canonical's transcript seed — shared by session creation (a resume) and
// `sendPrompt` (a session that exited and is respawning in place)
// ---------------------------------------------------------------------------

/**
 * Read a resumed session's on-disk transcript into canonical state.
 *
 * Uses `loadSessionHistory` — the SAME source every client's own resume path
 * uses (`useClaudeEvents`'s `session:created` observer) — so canonical and every
 * replica start from identical content.
 *
 * `resumeSessionAt` is why "identical" needs saying: a FORK resumes from a
 * truncated prefix of its parent's transcript, and a seed that ignored the anchor
 * showed every client the parent's post-anchor turns above an engine that had
 * never seen them. Both seeds pass the anchor, so both truncate at the same line.
 */
export async function seedCanonicalTranscript(
  routingId: string,
  resumeSessionId: string,
  cwd: string,
  resumeSessionAt?: string,
  engineId?: EngineId
): Promise<void> {
  try {
    // Claude's transcript is LOCATED: cli.js relocates it into a worktree's
    // project dir on `EnterWorktree`, a key `cwd` does not derive. The other
    // engines read by their own id and ignore projectKey, so they keep the
    // plain derivation (and skip the lookup's filesystem scan).
    const projectKey =
      (engineId ?? 'claude') === 'claude'
        ? claudeProjectKeyFor(resumeSessionId, cwd)
        : cwdToProjectKey(cwd)
    const { messages, taskNotifications, statusLine } = await loadSessionHistory(
      resumeSessionId,
      projectKey,
      resumeSessionAt,
      engineId
    )
    syncCore.seedSession(routingId, {
      cwd,
      messages,
      taskNotifications,
      ...(statusLine ? { statusLine } : {}),
      // Derived fields follow from the transcript, so derive them here rather
      // than leaving canonical to wait for the next live message.
      todos: buildTodosFromMessages(messages) ?? [],
      sentFiles: buildSentFilesFromMessages(messages) ?? []
    })
  } catch (err) {
    if (engineId === 'codex')
      emitEvent('session:error', [
        routingId,
        'Codex history could not be loaded; native context was not replaced.'
      ])
    logger.warn(
      'create-session',
      `canonical seed failed for ${routingId} (shadow state starts empty): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}
