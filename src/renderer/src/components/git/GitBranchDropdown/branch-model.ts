/**
 * What the branch dropdown lists, derived from one `GitBranchData`: the rows, the
 * "Create <text>" row, and the keyboard order. Pure, so the View stays a layout
 * and the FC stays the state - and so these rules are testable without a DOM.
 */
import type {
  GitAutostash,
  GitBranchData,
  GitBranchDetail,
  GitPullConfig
} from '../../../../../shared/types'

export interface BranchRow {
  /** Stable key and keyboard-order id: `local:<name>` / `remote:<name>`. */
  key: string
  detail: GitBranchDetail
  /** `origin/` for a remote-only row, '' for a local one. */
  prefix: string
  /** The name shown after `prefix`, and what `git checkout` is given. */
  name: string
  /** False for a branch checked out in another worktree: git refuses to check it out twice. */
  activatable: boolean
  /** No upstream configured. */
  localOnly: boolean
}

export interface BranchListModel {
  local: BranchRow[]
  remoteOnly: BranchRow[]
  /** The remote-only group is open: toggled open, or a search is looking in it. */
  remoteExpanded: boolean
  /** The name the "Create <text>" row would make, or null when the text names a branch already. */
  createName: string | null
  /** Keys of the rows an arrow key can land on, top to bottom (`create` first). */
  navKeys: string[]
}

export const CREATE_KEY = 'create'

/** Remote-tracking `origin/feat/x` without its remote: `feat/x` (what `git checkout` DWIMs). */
function stripRemote(name: string): string {
  const i = name.indexOf('/')
  return i >= 0 ? name.slice(i + 1) : name
}

export function buildBranchList(
  branches: GitBranchData,
  search: string,
  remoteOpen: boolean
): BranchListModel {
  const text = search.trim()
  const filter = text.toLowerCase()
  const matches = (name: string): boolean => !filter || name.toLowerCase().includes(filter)

  const localNames = new Set(branches.local)
  // A remote branch some local branch already tracks (or shares a name with) is that
  // local row, not a second one.
  const trackedRemotes = new Set(
    branches.details.filter((d) => d.kind === 'local' && d.upstream).map((d) => d.upstream)
  )

  const local: BranchRow[] = []
  const remoteOnly: BranchRow[] = []
  for (const detail of branches.details) {
    if (detail.kind === 'local') {
      if (!matches(detail.name)) continue
      local.push({
        key: `local:${detail.name}`,
        detail,
        prefix: '',
        name: detail.name,
        activatable: !detail.worktree,
        localOnly: !detail.upstream
      })
      continue
    }
    const short = stripRemote(detail.name)
    if (localNames.has(short) || trackedRemotes.has(detail.name)) continue
    if (!matches(detail.name)) continue
    remoteOnly.push({
      key: `remote:${detail.name}`,
      detail,
      prefix: detail.name.slice(0, detail.name.length - short.length),
      name: short,
      activatable: true,
      localOnly: false
    })
  }

  const exists =
    localNames.has(text) ||
    branches.remote.includes(text) ||
    branches.remote.some((r) => stripRemote(r) === text)
  // Whitespace and a leading '-' can never name a branch: offering to create one
  // would only produce git's refusal.
  const createName = text && !exists && !/\s/.test(text) && !text.startsWith('-') ? text : null

  const remoteExpanded = remoteOpen || filter !== ''
  const navKeys = [
    ...(createName ? [CREATE_KEY] : []),
    ...local.filter((r) => r.activatable).map((r) => r.key),
    ...(remoteExpanded ? remoteOnly.map((r) => r.key) : [])
  ]
  return { local, remoteOnly, remoteExpanded, createName, navKeys }
}

/** `4m`, `3h`, `2d`, `3w`, `5mo`, `2y` since a unix-seconds commit time. */
export function formatAge(commitTimeSec: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor(nowMs / 1000 - commitTimeSec))
  if (sec < 60) return 'now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  if (day < 60) return `${Math.floor(day / 7)}w`
  if (day < 365) return `${Math.floor(day / 30)}mo`
  return `${Math.floor(day / 365)}y`
}

/** "Fetched 2 min ago". */
export function formatFetched(fetchedAtMs: number, nowMs: number): string {
  const min = Math.floor(Math.max(0, nowMs - fetchedAtMs) / 60_000)
  if (min < 1) return 'Fetched just now'
  if (min < 60) return `Fetched ${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `Fetched ${hr} h ago`
  return `Fetched ${Math.floor(hr / 24)} d ago`
}

/**
 * How a diverged pull will reconcile, from the settings git would apply:
 * `rebase` / `merge` are decided; `ff-only` would fail on divergence; `ask` is
 * git >= 2.33's refusal to pull a diverged branch without being told.
 */
export type PullChoice = 'rebase' | 'merge' | 'ff-only' | 'ask'

export function pullChoice(config: GitPullConfig): PullChoice {
  if (config.rebase) return config.rebase
  if (config.ff === 'only') return 'ff-only'
  if (config.ff === 'false') return 'merge'
  return 'ask'
}

/** The newest ClaudeUI autostash made from this branch, and how many there are. */
export function autostashFor(
  branches: GitBranchData | null,
  branch: string
): { latest: GitAutostash; count: number } | null {
  const mine = branches?.autostashes.filter((s) => s.branch === branch) ?? []
  return mine.length > 0 ? { latest: mine[0], count: mine.length } : null
}
