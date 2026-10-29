/**
 * The sidebar's worktree fold (ADR-112 §6): sessions in a linked git worktree show inside their
 * PARENT repository's project group, and Delete / Hide project act on what the group shows.
 *
 * The fold is a VIEW over the canonical listing, which stays one group per directory (the
 * `linkedWorktree` marker, the replica's worktree projection and `session-tools` all read it as it
 * is). Pure and dependency-free: the renderer folds what it draws, and `handlers-core.deleteProject`
 * folds what it deletes, with this one code, so the confirmation describes the rule that runs.
 *
 * Which marked group belongs to which parent is decided once (`resolveFold`) and both entry points
 * read that answer, so the group the sidebar shows and the group a delete empties cannot disagree,
 * not even for a lossy `cwdToProjectKey` collision or two spellings of one repo root.
 */

import { cwdToProjectKey } from './project-key'
import { worktreeCwdKey } from './linked-worktree'
import type { DirectoryGroup, LinkedWorktree, SessionInfo } from './types'

/** A worktree group absorbed into its parent's view group (one per directory, so a worktree's subfolder is another). */
export interface FoldedWorktree {
  cwd: string
  projectKey: string
  linkedWorktree: LinkedWorktree
}

/** A group of the sidebar's view: the listing's group, or a synthesised parent, with its absorbed worktrees. */
export interface ViewDirectoryGroup extends DirectoryGroup {
  /** The listing has no group for this repository: built from the worktrees' `repoRoot`. */
  synthesized?: boolean
  foldedWorktrees?: FoldedWorktree[]
}

interface ParentSlot {
  /** The parent's group in the listing; null for a synthesised one. */
  group: DirectoryGroup | null
  cwd: string
  projectKey: string
  children: DirectoryGroup[]
}

interface Resolution {
  /** Groups that stay at the top level, listing order. */
  kept: DirectoryGroup[]
  /** Every parent that absorbs at least one worktree group, by its `projectKey`. */
  parents: Map<string, ParentSlot>
}

/** A group the fold absorbs: marked, with a repository root to fold into. */
function isFoldable(g: DirectoryGroup): g is DirectoryGroup & { linkedWorktree: LinkedWorktree } {
  return !!g.linkedWorktree && g.linkedWorktree.repoRoot !== ''
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p

function resolveFold(listing: readonly DirectoryGroup[]): Resolution {
  const kept = listing.filter((g) => !isFoldable(g))
  const parents = new Map<string, ParentSlot>()
  if (kept.length === listing.length) return { kept, parents }

  const byCwdKey = new Map<string, DirectoryGroup>()
  const byProjectKey = new Map<string, DirectoryGroup>()
  for (const g of kept) {
    const ck = worktreeCwdKey(g.cwd)
    if (ck && !byCwdKey.has(ck)) byCwdKey.set(ck, g)
    if (g.projectKey && !byProjectKey.has(g.projectKey)) byProjectKey.set(g.projectKey, g)
  }
  const synthByCwdKey = new Map<string, ParentSlot>()

  const slotFor = (group: DirectoryGroup | null, cwd: string, projectKey: string): ParentSlot => {
    let slot = parents.get(projectKey)
    if (!slot) {
      slot = { group, cwd, projectKey, children: [] }
      parents.set(projectKey, slot)
    }
    return slot
  }

  for (const child of listing) {
    if (!isFoldable(child)) continue
    const root = child.linkedWorktree.repoRoot
    const rootKey = worktreeCwdKey(root)
    const rootProjectKey = cwdToProjectKey(root)
    // The repository's own group: by directory first, then by the key Claude keeps its folder under
    // (cwdToProjectKey is lossy, so two directories can share it: they are one project to Claude too).
    const existing = byCwdKey.get(rootKey) ?? byProjectKey.get(rootProjectKey)
    if (existing) {
      slotFor(existing, existing.cwd, existing.projectKey).children.push(child)
      continue
    }
    const synth = synthByCwdKey.get(rootKey) ?? parents.get(rootProjectKey)
    if (synth) {
      synth.children.push(child)
      continue
    }
    const slot = slotFor(null, root, rootProjectKey)
    synthByCwdKey.set(rootKey, slot)
    slot.children.push(child)
  }
  return { kept, parents }
}

/**
 * The worktree groups that fold into the project `parentProjectKey`: the marked groups of the
 * listing whose repository is that project's directory (or shares its Claude project key). The
 * parent need not have a group of its own: a repository whose only sessions ran in its worktrees
 * is a synthesised group keyed by `cwdToProjectKey(repoRoot)`.
 */
export function worktreeChildrenOf(
  listing: readonly DirectoryGroup[],
  parentProjectKey: string
): DirectoryGroup[] {
  return resolveFold(listing).parents.get(parentProjectKey)?.children ?? []
}

const newestFirst = (a: SessionInfo, b: SessionInfo): number => b.lastActivityAt - a.lastActivityAt

/**
 * The sidebar's view of the listing: each worktree group (a linked worktree whose repository root
 * is known) is removed from the top level and its sessions shown in the parent's group. Groups
 * the fold does not understand (a bare repo or submodule has no `repoRoot`, a vanished directory
 * is unmarked) stay as they are. Returns the listing itself when nothing folds.
 */
export function foldForView(listing: readonly DirectoryGroup[]): ViewDirectoryGroup[] {
  const { kept, parents } = resolveFold(listing)
  if (parents.size === 0) return listing as DirectoryGroup[]

  const view: ViewDirectoryGroup[] = kept.map((g) => {
    const slot = parents.get(g.projectKey)
    return slot && slot.group === g ? build(slot, g) : g
  })
  for (const slot of parents.values()) {
    if (!slot.group) view.push(build(slot, null))
  }
  // directory-merge's order: newest session first, groups by their newest session.
  view.sort((a, b) => (b.sessions[0]?.lastActivityAt ?? 0) - (a.sessions[0]?.lastActivityAt ?? 0))
  return view
}

function build(slot: ParentSlot, own: DirectoryGroup | null): ViewDirectoryGroup {
  const seen = new Set<string>()
  const sessions: SessionInfo[] = []
  for (const g of own ? [own, ...slot.children] : slot.children) {
    for (const s of g.sessions) {
      if (seen.has(s.sessionId)) continue
      seen.add(s.sessionId)
      sessions.push(s)
    }
  }
  sessions.sort(newestFirst)
  const foldedWorktrees = slot.children.map((c) => ({
    cwd: c.cwd,
    projectKey: c.projectKey,
    linkedWorktree: c.linkedWorktree as LinkedWorktree
  }))
  if (own) return { ...own, sessions, foldedWorktrees }
  return {
    cwd: slot.cwd,
    projectKey: slot.projectKey,
    folderName: baseName(slot.cwd),
    sessions,
    synthesized: true,
    foldedWorktrees
  }
}

/**
 * What a request for the project `projectKey` means, resolved through the SAME fold the sidebar
 * draws, so a delete covers what the group showed and nothing a lossy key happens to collide with.
 * `deleteProject`, its Claude-file plan and the renderer's clean-up all read it.
 */
export interface ProjectScope {
  /**
   * The canonical group behind the view group: the parent's own group, or (a stale request for a
   * folded worktree's own key) that worktree's group. null for a synthesised parent and for a key
   * the listing has no group for.
   */
  group: DirectoryGroup | null
  /** The view group has no group of its own in the listing. */
  synthesized: boolean
  /** The worktree groups folded into the view group. */
  children: DirectoryGroup[]
  /**
   * May `~/.claude/projects/<projectKey>/` be removed wholesale? Only when a real, unmarked group
   * backs the project: a synthesised parent's folder holds Claude's per-repo memory, an unknown
   * key names nothing the sidebar showed, and a worktree group is never removed wholesale.
   */
  ownDirRemovable: boolean
  /** `worktreeCwdKey` of the view group's cwd and of every folded worktree's: the live-session predicate. */
  cwdKeys: ReadonlySet<string>
}

export function projectScope(listing: readonly DirectoryGroup[], projectKey: string): ProjectScope {
  const { kept, parents } = resolveFold(listing)
  const slot = parents.get(projectKey)
  let group: DirectoryGroup | null
  let children: DirectoryGroup[] = []
  let cwd: string | null
  if (slot) {
    group = slot.group
    children = slot.children
    cwd = slot.cwd
  } else {
    // Not a parent of anything: a plain group of the view, else a folded worktree asked for by its own key.
    group =
      kept.find((g) => g.projectKey === projectKey) ??
      listing.find((g) => isFoldable(g) && g.projectKey === projectKey) ??
      null
    cwd = group?.cwd ?? null
  }
  const cwdKeys = new Set<string>()
  for (const c of [cwd, ...children.map((g) => g.cwd)]) {
    const key = c ? worktreeCwdKey(c) : ''
    if (key) cwdKeys.add(key)
  }
  return {
    group,
    synthesized: !!slot && slot.group === null,
    children,
    ownDirRemovable: group !== null && !group.linkedWorktree,
    cwdKeys
  }
}

/** Does a live session in `cwd` belong to the project? By directory, never by the lossy Claude key. */
export function inProject(scope: ProjectScope, cwd: string | null | undefined): boolean {
  const key = cwd ? worktreeCwdKey(cwd) : ''
  return key !== '' && scope.cwdKeys.has(key)
}

/**
 * The live sessions that belong to the project `projectKey`, for the delete (server) and its
 * clean-up (renderer) alike.
 *
 *  - Normally: those running in the view group's directory or a folded worktree's (`inProject`).
 *  - When the listing knows nothing for the key (no group, nothing folded): a group made only of
 *    live, not-yet-listed sessions, which the sidebar builds under `cwdToProjectKey(cwd)`. Then the
 *    members are the live sessions with that key, except any whose directory a listed group claims
 *    or that some listing group already holds.
 *
 * `unlisted` are the members no listing group holds: the only ones whose persisted history can be
 * named from their own cwd.
 */
export function liveProjectMembers(
  listing: readonly DirectoryGroup[],
  scope: ProjectScope,
  projectKey: string,
  live: Iterable<readonly [string, { cwd?: string | null }]>
): { ids: string[]; unlisted: string[] } {
  const listedIds = new Set<string>()
  const listedCwds = new Set<string>()
  for (const g of listing) {
    for (const x of g.sessions) listedIds.add(x.sessionId)
    const key = g.cwd ? worktreeCwdKey(g.cwd) : ''
    if (key) listedCwds.add(key)
  }
  const unknownKey = scope.group === null && !scope.synthesized && scope.children.length === 0
  const ids: string[] = []
  const unlisted: string[] = []
  for (const [id, session] of live) {
    const cwd = session.cwd ?? ''
    if (unknownKey) {
      if (!cwd || cwdToProjectKey(cwd) !== projectKey) continue
      if (listedIds.has(id) || listedCwds.has(worktreeCwdKey(cwd))) continue
    } else if (!inProject(scope, cwd)) continue
    ids.push(id)
    if (!listedIds.has(id)) unlisted.push(id)
  }
  return { ids, unlisted }
}

export interface FoldedWorktreeSummary {
  /** Sessions in the folded worktree groups. */
  sessionCount: number
  /** One entry per distinct worktree (a worktree and its subfolder are one). */
  names: string[]
}

/** What a delete of `projectKey` also covers beyond the project's own group; null when nothing is folded in. */
export function foldedWorktreeSummary(
  listing: readonly DirectoryGroup[],
  projectKey: string
): FoldedWorktreeSummary | null {
  const children = worktreeChildrenOf(listing, projectKey)
  if (children.length === 0) return null
  const byPath = new Map<string, string>()
  const sessionIds = new Set<string>()
  for (const c of children) {
    for (const x of c.sessions) sessionIds.add(x.sessionId)
    const lw = c.linkedWorktree as LinkedWorktree
    if (!byPath.has(lw.worktreePath)) byPath.set(lw.worktreePath, lw.name)
  }
  return { sessionCount: sessionIds.size, names: [...byPath.values()] }
}
