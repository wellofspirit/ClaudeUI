/**
 * Which CLAUDE files a project delete removes — one rule, shared by the delete
 * itself (`handlers-core.deleteProject`, main) and the confirmation that has to
 * describe it before the user agrees (the Sidebar's delete dialog, renderer).
 *
 * Pure and dependency-free, so both sides compute the answer from the same
 * directory listing with the same code: a dialog that described a different
 * rule than the one that runs would be worse than one that said nothing.
 */

import type { DirectoryGroup, SessionInfo } from './types'

export interface ClaudeProjectDeletePlan {
  /** Remove `~/.claude/projects/<projectKey>/` wholesale. */
  removeDir: boolean
  /** Session files removed one at a time (`<sid>.jsonl` + its `<sid>/` folder),
   *  each under the project dir it actually lives in. */
  sessionFiles: Array<{ sessionId: string; projectKey: string }>
}

const isClaude = (s: SessionInfo): boolean => !s.engineId || s.engineId === 'claude'

/**
 * The listing groups a Claude session under its HOME project (its first-prompt
 * cwd) even when cli.js's `EnterWorktree` moved its file into a worktree's
 * project dir, so the directory a project's key names and the set of files its
 * members live in are no longer the same thing:
 *
 *  - A member RELOCATED out of this dir: removing the dir would leave it behind
 *    and the next listing would bring it straight back. It goes by its own
 *    `projectKey` — one session, never its whole dir, which can hold sessions
 *    that are not members of this project.
 *  - A dir that HOLDS another project's relocated member (deleting a worktree
 *    project whose dir a home-project session was moved into): removing the dir
 *    wholesale would silently delete a session the sidebar shows under a
 *    different project. Then every member goes one by one and the dir stays.
 *
 * Other engines' sessions are never in the plan: they are deleted through their
 * own engines, not by unlinking anything under `~/.claude/projects`.
 */
export function planClaudeProjectDelete(
  directories: DirectoryGroup[],
  projectKey: string
): ClaudeProjectDeletePlan {
  const group = directories.find((g) => g.projectKey === projectKey)
  const dirShared = directories.some(
    (g) =>
      g.projectKey !== projectKey &&
      g.sessions.some((s) => isClaude(s) && s.projectKey === projectKey)
  )
  const sessionFiles = (group?.sessions ?? [])
    .filter((s) => isClaude(s) && (dirShared || s.projectKey !== projectKey))
    .map((s) => ({ sessionId: s.sessionId, projectKey: s.projectKey }))
  return { removeDir: !dirShared, sessionFiles }
}
