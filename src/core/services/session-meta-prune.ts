import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { claudeUnmeteredSessionIds, deleteSessionMeta, hasCodexSessionOverrides } from './db'
import { logger } from './logger'
import { loadSessionConfig, sessionConfigIsReadable } from './ui-config'

const LOG_SOURCE = 'SessionMetaPrune'

/** Claude's transcripts are `<projectsDir>/<projectKey>/<sessionId>.jsonl`. */
function claudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/**
 * Every Claude session id that has a transcript file, across all project dirs, or
 * null when the store cannot be read completely.
 *
 * Names only (one readdir per project): the prune asks "is there a record at all",
 * not whether it parses or holds a conversation — an empty or unparseable transcript
 * is still a record, and keeping its row is the safe answer.
 */
function listClaudeTranscriptIds(projectsDir: string): Set<string> | null {
  try {
    const ids = new Set<string>()
    for (const name of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, name)
      // statSync (not Dirent) so a junction/symlinked project dir is followed, as
      // the sidebar listing follows it.
      if (!fs.statSync(dir).isDirectory()) continue
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.jsonl')) ids.add(file.slice(0, -'.jsonl'.length))
      }
    }
    return ids
  } catch (err) {
    logger.warn(LOG_SOURCE, 'Claude transcript store unreadable; pruning nothing', err)
    return null
  }
}

/**
 * Drop `session_meta` rows of Claude sessions that never produced a transcript.
 *
 * An abandoned "New session" used to leave its engine/model row behind (the store's
 * empty-session cleanup dropped only the recents slot), and those rows accumulate.
 * The criterion is deliberately narrow — a row is removed only when ALL hold:
 *
 *  1. its `engine_id` is exactly `claude` (the other engines keep their sessions in
 *     stores this cannot read without a running server — opencode, Codex — or whose
 *     location is user-configurable — pi — so "no record" is not provable for them);
 *  2. it carries no context reading and no Codex override row (a belt: only
 *     CodexSession writes a context reading, so today this filters nothing for a
 *     Claude row — it only keeps the prune from ever touching one that gains one);
 *  3. no `<id>.jsonl` exists in ANY project dir under `~/.claude/projects` (a real
 *     historical session always has one — it is what the sidebar lists);
 *  4. nothing in `sessions.json` still mentions the id (recents, pins, hidden, a
 *     custom title, worktree info): a session the user touched stays;
 *  5. the transcript store was read completely and holds at least one transcript — an
 *     unreadable, unmounted or freshly wiped store proves nothing, and must not be
 *     read as "every session is an orphan";
 *  6. `sessions.json` is readable (a missing file is an empty registry; one that
 *     exists but does not parse would make everything look unreferenced), and
 *     `CLAUDE_CONFIG_DIR` is not set — the user's own config dir moves Claude's
 *     transcripts out of `~/.claude/projects`, so that store proves nothing either.
 *
 * Idempotent; run once at boot before the registry is seeded, never from the
 * renderer. What it removes is only the engine/model pick of a session that never
 * ran; a live session re-writes its row from the renderer's map on its next save.
 */
export function pruneOrphanClaudeSessionMeta(projectsDir: string = claudeProjectsDir()): string[] {
  if (process.env.CLAUDE_CONFIG_DIR) {
    logger.info(
      LOG_SOURCE,
      'CLAUDE_CONFIG_DIR is set; transcripts may live elsewhere, pruning nothing'
    )
    return []
  }
  const candidates = claudeUnmeteredSessionIds().filter((id) => !hasCodexSessionOverrides(id))
  if (candidates.length === 0) return []

  const transcripts = listClaudeTranscriptIds(projectsDir)
  if (!transcripts || transcripts.size === 0) return []

  if (!sessionConfigIsReadable()) {
    logger.warn(
      LOG_SOURCE,
      'sessions.json does not parse; cannot tell what is referenced, pruning nothing'
    )
    return []
  }
  const config = loadSessionConfig()
  const referenced = new Set<string>([
    ...(config.recentSessions ?? []),
    ...(config.pinnedSessions ?? []),
    ...(config.hiddenSessions ?? []),
    ...Object.keys(config.customTitles ?? {}),
    ...Object.keys(config.worktreeInfoMap ?? {})
  ])

  const orphans = candidates.filter((id) => !transcripts.has(id) && !referenced.has(id))
  for (const id of orphans) deleteSessionMeta(id)
  if (orphans.length > 0) {
    // `warn`, not `info`: this deletes user data, and it runs at boot before the
    // saved log filter is applied (the default keeps warnings), so an `info` line
    // never reached the log file.
    logger.warn(LOG_SOURCE, `Pruned ${orphans.length} session-registry row(s) with no transcript`)
  }
  return orphans
}
