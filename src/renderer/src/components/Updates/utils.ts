/**
 * The Updates panel's reading of the host's state (auto-update design §8,
 * mockup `updates-panel-mockup.html` tabs A–E): which ClaudeUI row shows and
 * what it offers, the harness rows, and the footer button's state. Pure
 * functions of the app-update view, the harness snapshot and this client's
 * "Later" choices, so every state is tested without rendering.
 */
import type {
  AppUpdateRebuildStage,
  AppUpdateTree,
  AppUpdateTreeSummary,
  AppUpdateView
} from '../../../../shared/types/app-update'
import type {
  HarnessId,
  HarnessInstallProgress,
  HarnessUpdatesView
} from '../../../../shared/harness-types'
import { HARNESS_IDS } from '../../../../shared/harness-types'
import type { RebuiltInPlace, RestartImpact } from '../../../../shared/relaunch'
import { UPDATE_FEED_REPO } from '../../../../shared/update-manifest'
import {
  HARNESS_LABEL,
  formatBytes,
  installKey,
  installPanelRows,
  progressPercent,
  updateResultKey,
  type InstallPanelRow
} from '../SettingsDialog/harness-view'

// ── "Later" (per client, in memory) ───────────────────────────────────

/**
 * Items this client put off: key → the `lastCheckedAt` (of the app or the
 * harnesses) when it did. A Later holds while that check time is unchanged,
 * so the next check, or a reload, brings the item back.
 */
export type LaterMap = Readonly<Record<string, string | null>>

export function isLater(later: LaterMap, key: string, checkedAt: string | undefined): boolean {
  return Object.prototype.hasOwnProperty.call(later, key) && later[key] === (checkedAt ?? null)
}

export const appLaterKey = (version: string): string => `claudeui@${version}`
export const rebuildLaterKey = (startedAt: string | undefined): string =>
  `rebuild@${startedAt ?? ''}`

// ── Versions ──────────────────────────────────────────────────────────

export const isPreReleaseVersion = (version: string): boolean => version.includes('-pre')

/**
 * `pre.14` for `3.9.1-pre.14` when `relativeTo` shares its `3.9.1` (the
 * mockup's "Skip pre.14", "pre.13 +5"); the whole version otherwise.
 */
export function shortVersion(version: string, relativeTo: string | null | undefined): string {
  const m = /^(\d+\.\d+\.\d+)-(pre\.\d+)$/.exec(version)
  if (!m || !relativeTo) return version
  return relativeTo.startsWith(`${m[1]}-`) || relativeTo === m[1] ? m[2] : version
}

/** A release's notes page, from its version (tags are `v<version>`). */
export function releaseNotesUrl(version: string): string {
  return `https://github.com/${UPDATE_FEED_REPO}/releases/tag/v${version}`
}

/** The running build as one line: `3.9.1-pre.13`, `Local build · e4f1a2c · uncommitted changes`. */
export function buildLine(current: AppUpdateView['current']): string {
  if (current.kind === 'dev') return 'Development run'
  if (current.kind === 'release') return current.version ?? 'Unknown version'
  const parts = ['Local build']
  if (current.commit) parts.push(current.commit.slice(0, 7))
  if (current.dirty) parts.push('uncommitted changes')
  return parts.join(' · ')
}

/**
 * What this build is, as a version: a release's own version; a local build's
 * base tag (without the `v`) and how far past it, `3.9.1-pre.14 +22`, or its
 * package version when it has no tag; null for a dev run (each caller says
 * that its own way). Settings › Updates, the panel's footer and the relaunch
 * notices all read this one.
 */
export function buildVersion(current: AppUpdateView['current']): string | null {
  if (current.kind === 'dev') return null
  if (current.kind === 'release') return current.version
  const base = current.comparisonVersion
  if (!base) return current.version
  return current.ahead ? `${base} +${current.ahead}` : base
}

/**
 * The footer's version: {@link buildVersion}, or `dev`; a local build made from
 * a tree with uncommitted changes says so (its commit alone does not tell).
 */
export function footerVersion(view: AppUpdateView | null): string | null {
  if (!view) return null
  const version = buildVersion(view.current)
  if (!version) return view.current.kind === 'dev' ? 'dev' : null
  return view.current.kind === 'local' && view.current.dirty === true
    ? `${version} · modified`
    : version
}

// ── The ClaudeUI row ──────────────────────────────────────────────────

/** Where a release download stands, for the row's status line and its main action. */
export type AppReleaseStatus =
  | { kind: 'ready' }
  | { kind: 'downloading'; received: number; total: number | null }
  | { kind: 'verifying' }
  | { kind: 'staging' }
  | { kind: 'staged' }
  | { kind: 'failed'; reason: string }
  | { kind: 'ineligible'; reason: string }

export interface AppRelease {
  version: string
  notesUrl: string
  /** Bytes; unknown for a download staged before this run checked. */
  size: number | null
  claudeCodeVersion: string | null
  pre: boolean
  status: AppReleaseStatus
}

export type AppSection =
  | {
      kind: 'release'
      from: string
      release: AppRelease
      skipLabel: string
      laterKey: string
    }
  | {
      /** A local build (or the cog menu's Rebuild entry): rebuild from source or take the release. */
      kind: 'local'
      localBuild: boolean
      from: string
      commit: string | null
      dirty: boolean
      /** The release on offer, when there is one. */
      release: AppRelease | null
      skipLabel: string | null
      /** A source checkout is known (`rebuildAvailable`). */
      canRebuild: boolean
      /** The last rebuild failed: why. */
      rebuildError: string | null
      laterKey: string
    }
  | {
      kind: 'building'
      tree: AppUpdateTreeSummary | null
      stages: AppUpdateRebuildStage[]
      lastLine: string | null
      startedAt: string | null
    }
  | {
      kind: 'built'
      version: string
      commit: string | null
      laterKey: string
    }

function releaseStatus(view: AppUpdateView, version: string): AppReleaseStatus {
  const d = view.download
  if (d.version === version) {
    switch (d.phase) {
      case 'staged':
        return { kind: 'staged' }
      case 'downloading':
        return { kind: 'downloading', received: d.received ?? 0, total: d.total ?? null }
      case 'verifying':
        return { kind: 'verifying' }
      case 'staging':
        return { kind: 'staging' }
      case 'failed':
        return { kind: 'failed', reason: d.error ?? 'The download failed' }
      default:
        break
    }
  }
  if (!view.eligibility.ok) return { kind: 'ineligible', reason: view.eligibility.reason }
  return { kind: 'ready' }
}

/**
 * The release on offer: the checked one, or (after a restart, before the
 * first check) the one still staged from before.
 */
function offeredRelease(view: AppUpdateView): AppRelease | null {
  const a = view.available
  if (a) {
    return {
      version: a.version,
      notesUrl: a.notesUrl,
      size: a.size,
      claudeCodeVersion: a.claudeCodeVersion,
      pre: isPreReleaseVersion(a.version),
      status: releaseStatus(view, a.version)
    }
  }
  const d = view.download
  if (d.phase === 'staged' && d.version && d.version !== view.skippedVersion) {
    return {
      version: d.version,
      notesUrl: releaseNotesUrl(d.version),
      size: null,
      claudeCodeVersion: null,
      pre: isPreReleaseVersion(d.version),
      status: { kind: 'staged' }
    }
  }
  return null
}

/** `pre.13 +5`: the base a local build was cut from, and how far ahead of it. */
function localFrom(current: AppUpdateView['current'], to: string | null): string {
  const base = current.comparisonVersion ?? current.version ?? 'local'
  const shown = to ? shortVersion(base, to) : base
  return current.ahead ? `${shown} +${current.ahead}` : shown
}

/**
 * The ClaudeUI row, or null when there is nothing to show: an update offered,
 * downloading, staged or failed; a rebuild running, built or failed; or the
 * panel opened from the cog menu's Rebuild entry (`rebuildIntent`). A row
 * this client put off (`later`) is hidden until the next check, except when
 * the Rebuild entry asks for it.
 */
export function appSection(
  view: AppUpdateView | null,
  opts: { later: LaterMap; rebuildIntent?: boolean }
): AppSection | null {
  if (!view || !view.supported) return null
  const intent = opts.rebuildIntent === true
  const checkedAt = view.check.lastCheckedAt
  const r = view.rebuild

  if (r?.phase === 'building') {
    return {
      kind: 'building',
      tree: r.tree ?? null,
      stages: r.stages ?? [],
      lastLine: r.lastLine ?? null,
      startedAt: r.startedAt ?? null
    }
  }
  const rebuildKey = rebuildLaterKey(r?.startedAt)
  if (r?.phase === 'built' && (intent || !isLater(opts.later, rebuildKey, checkedAt))) {
    return {
      kind: 'built',
      version: r.built?.version ?? '',
      commit: r.built?.commit ?? null,
      laterKey: rebuildKey
    }
  }

  const offered = offeredRelease(view)
  const appKey = offered ? appLaterKey(offered.version) : rebuildKey
  const release = offered && (intent || !isLater(opts.later, appKey, checkedAt)) ? offered : null
  const rebuildFailed =
    r?.phase === 'failed' && (intent || !isLater(opts.later, rebuildKey, checkedAt))
  const current = view.current
  const localBuild = current.kind === 'local'

  if ((localBuild || intent) && (release || intent || rebuildFailed)) {
    return {
      kind: 'local',
      localBuild,
      from: localBuild ? localFrom(current, release?.version ?? null) : (current.version ?? ''),
      commit: current.commit ?? null,
      dirty: current.dirty === true,
      release,
      skipLabel: release ? shortVersion(release.version, current.comparisonVersion) : null,
      canRebuild: view.rebuildAvailable,
      rebuildError: rebuildFailed ? (r?.error ?? 'The build failed') : null,
      laterKey: release ? appKey : rebuildKey
    }
  }
  if (!release) return null
  return {
    kind: 'release',
    from: current.version ?? '',
    release,
    skipLabel: shortVersion(release.version, current.comparisonVersion ?? current.version),
    laterKey: appKey
  }
}

/** "Worktree: auto-update", "Main checkout: pre-release", with its uncommitted count. */
export function treeLabel(tree: AppUpdateTree): string {
  const head =
    tree.name === 'main checkout'
      ? `Main checkout: ${tree.branch ?? tree.commit ?? 'detached'}`
      : `Worktree: ${tree.name}`
  return tree.dirty > 0 ? `${head} · ${tree.dirty} uncommitted` : head
}

/**
 * Two commits are the same: either is a prefix of the other (a tree's short
 * HEAD against a build's full SHA), case-insensitively, at 7 characters or more.
 */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (Math.min(x.length, y.length) < 7) return false
  return x.startsWith(y) || y.startsWith(x)
}

/**
 * The tree a rebuild picks first: the one whose HEAD is the running build's
 * commit; else the checkout the host says the build came from; else the first.
 */
export function defaultTree(
  trees: readonly AppUpdateTree[] | null | undefined,
  buildCommit: string | null | undefined
): AppUpdateTree | null {
  if (!trees || trees.length === 0) return null
  return (
    trees.find((t) => sameCommit(t.commit, buildCommit)) ??
    trees.find((t) => t.buildSource === true) ??
    trees[0]
  )
}

/**
 * A rebuild stage as the panel names it. `scripts/build.mjs` prints the
 * `build:stage` labels of `scripts/lib/build-targets.mjs` (a parallel group's
 * members joined with ` ‖ `); anything else passes through.
 */
export function stageName(label: string): string {
  if (label.split(' ‖ ').some((member) => member.trim().startsWith('electron-vite')))
    return 'Typecheck and build'
  if (label === 'stamp build-info') return 'Stamp the build'
  if (label.startsWith('electron-builder')) return 'Package'
  if (label === 'stamp install-marker') return 'Mark the install'
  if (label === 'codesign') return 'Sign'
  if (label === 'xattr -cr') return 'Clear quarantine'
  return label
}

/** "Building from worktree auto-update", "Building from the main checkout". */
export function buildingFrom(tree: AppUpdateTreeSummary | null): string {
  if (!tree) return 'Building ClaudeUI'
  return tree.name === 'main checkout'
    ? 'Building from the main checkout'
    : `Building from worktree ${tree.name}`
}

/** `1:42`, `12:05`, `1:02:09`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** "Checked just now", "Checked 2 min ago", "Checked 3 h ago". */
export function checkedAgo(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return 'Not checked yet'
  const min = Math.floor(Math.max(0, now - t) / 60_000)
  if (min < 1) return 'Checked just now'
  if (min < 60) return `Checked ${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 48) return `Checked ${h} h ago`
  return `Checked ${Math.floor(h / 24)} d ago`
}

/** The newer of two ISO times (either may be missing). */
export function newestTime(...times: Array<string | undefined>): string | null {
  let best: string | null = null
  for (const t of times) {
    if (t && (best === null || Date.parse(t) > Date.parse(best))) best = t
  }
  return best
}

// ── The restart confirm (mockup tab B) ────────────────────────────────

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** One line per thing a restart interrupts; empty when nothing would be. */
export function impactLines(impact: RestartImpact): string[] {
  const lines: string[] = []
  const w = impact.workingSessions
  if (w > 0)
    lines.push(
      w === 1
        ? '1 session is working. Its turn stops; it reopens after.'
        : `${w} sessions are working. Their turns stop; they reopen after.`
    )
  if (impact.terminals > 0)
    lines.push(`${plural(impact.terminals, 'terminal', 'terminals')} will close.`)
  if (impact.remoteClients > 0)
    lines.push(`${plural(impact.remoteClients, 'remote device', 'remote devices')} will reconnect.`)
  return lines
}

export const impactIsEmpty = (impact: RestartImpact): boolean =>
  impact.workingSessions === 0 && impact.terminals === 0 && impact.remoteClients === 0

// ── The harness rows ──────────────────────────────────────────────────

/** One harness update in the panel (mockup tabs A, C, D). */
export interface HarnessUpdateRow {
  id: HarnessId
  from: string
  to: string
  state: 'available' | 'waiting' | 'installing' | 'installed' | 'failed'
  /** `installing`: the install's latest progress. */
  progress?: HarnessInstallProgress
  /** `failed`: why. */
  reason?: string
  /** `failed`: an update run's result (dismissed by key), or this panel's own install. */
  dismiss?: { kind: 'result'; key: string } | { kind: 'install' }
}

export interface HarnessRowsInput {
  updates: HarnessUpdatesView | undefined
  installs: readonly HarnessInstallProgress[]
  /** Run failures this client dismissed (`updateResultKey`). */
  dismissed: ReadonlySet<string>
  /** Installs this client saw finish. */
  completed: readonly { id: HarnessId; version: string }[]
  /** Updates this client started from the panel: install key → the version it replaces. */
  started: Readonly<Record<string, string>>
  later: LaterMap
}

/**
 * The harness rows, in harness order: each result of the current or last
 * update run (Automatically; a dismissed failure is gone); then each available
 * update, as installing, failed (this client's install of it), waiting for its
 * turn in a run, or available (unless put off with Later); then each update
 * this client installed from the panel, once it finished.
 */
export function harnessUpdateRows(input: HarnessRowsInput): HarnessUpdateRow[] {
  const u = input.updates
  if (!u) return []
  const rows = new Map<HarnessId, HarnessUpdateRow>()
  const runAt = u.status.lastRunAt
  for (const r of u.status.results) {
    const key = updateResultKey(r, runAt)
    if (r.status === 'failed' && input.dismissed.has(key)) continue
    rows.set(r.id, {
      id: r.id,
      from: r.from,
      to: r.to,
      state: r.status,
      ...(r.status === 'failed'
        ? { reason: r.reason ?? 'unknown error', dismiss: { kind: 'result' as const, key } }
        : {})
    })
  }
  for (const a of u.available) {
    const same = (p: HarnessInstallProgress): boolean => p.id === a.id && p.version === a.to
    const base = { id: a.id, from: a.from, to: a.to }
    const progress = input.installs.find((p) => same(p) && p.phase !== 'failed')
    if (progress) {
      rows.set(a.id, { ...base, state: 'installing', progress })
      continue
    }
    const failed = input.installs.find((p) => same(p) && p.phase === 'failed')
    if (failed) {
      rows.set(a.id, {
        ...base,
        state: 'failed',
        reason: failed.reason ?? 'unknown error',
        dismiss: { kind: 'install' }
      })
      continue
    }
    if (rows.get(a.id)?.to === a.to) continue
    if (u.status.running) {
      rows.set(a.id, { ...base, state: 'waiting' })
      continue
    }
    if (isLater(input.later, installKey({ id: a.id, version: a.to }), u.status.lastCheckedAt)) {
      continue
    }
    rows.set(a.id, { ...base, state: 'available' })
  }
  for (const c of input.completed) {
    const from = input.started[installKey(c)]
    if (from === undefined) continue
    const row = rows.get(c.id)
    if (row && row.to === c.version && row.state === 'installed') continue
    rows.set(c.id, { id: c.id, from, to: c.version, state: 'installed' })
  }
  return HARNESS_IDS.filter((id) => rows.has(id)).map((id) => rows.get(id)!)
}

/** Installs outside the update flow (the upgrade sheet's), minus those the update rows show. */
export function otherInstallRows(
  updates: HarnessUpdatesView | undefined,
  installs: readonly HarnessInstallProgress[],
  completed: readonly { id: HarnessId; version: string }[],
  harnessRows: readonly HarnessUpdateRow[]
): InstallPanelRow[] {
  const shown = new Set(harnessRows.map((r) => installKey({ id: r.id, version: r.to })))
  return installPanelRows(updates, installs, completed).filter((r) => !shown.has(installKey(r)))
}

// ── The footer button (mockup tab E) ──────────────────────────────────

export type UpdatesButtonState = 'hidden' | 'available' | 'restart' | 'running' | 'failed' | 'done'

export interface UpdatesButtonModel {
  state: UpdatesButtonState
  /** Items awaiting a decision: the badge. */
  count: number
  title: string
}

/** What the ClaudeUI row asks of the user, or is doing. */
function appActivity(app: AppSection | null): {
  decision: boolean
  restart: boolean
  running: string | null
  failed: string | null
  label: string | null
} {
  const none = { decision: false, restart: false, running: null, failed: null, label: null }
  if (!app) return none
  if (app.kind === 'building') return { ...none, running: 'Building ClaudeUI' }
  if (app.kind === 'built')
    return { ...none, decision: true, restart: true, label: 'ClaudeUI rebuild ready to relaunch' }
  const release = app.release
  const failedBuild = app.kind === 'local' && app.rebuildError ? 'ClaudeUI build failed' : null
  if (!release) return { ...none, failed: failedBuild }
  const name = `ClaudeUI ${release.version}`
  switch (release.status.kind) {
    case 'downloading': {
      const s = release.status
      const pct = s.total ? Math.round((s.received / s.total) * 100) : null
      return { ...none, running: `Downloading ${name}${pct === null ? '' : ` ${pct}%`}` }
    }
    case 'verifying':
    case 'staging':
      return { ...none, running: `Preparing ${name}` }
    case 'failed':
      return { ...none, failed: `${name} failed to download` }
    case 'staged':
      return { ...none, decision: true, restart: true, label: `${name} ready to restart` }
    default:
      return { ...none, decision: true, failed: failedBuild, label: name }
  }
}

/**
 * The footer button: `running` (spinner) while a download, a build or a
 * harness install runs; `failed` (amber) while a failure is not dismissed;
 * `restart` (the restart arrow, with the count) when the ClaudeUI update is
 * staged or a rebuild is built; `available` (download icon, with the count)
 * while anything awaits a decision; `done` for the moments after installs
 * finished (`justFinished`); else hidden. Harness updates count in Ask me
 * only: Automatically installs them by itself.
 */
export function updatesButtonModel(input: {
  app: AppSection | null
  harnessRows: readonly HarnessUpdateRow[]
  installRows: readonly InstallPanelRow[]
  harnessMode: HarnessUpdatesView['mode'] | undefined
  /** A harness run is in flight (this client's or the host's). */
  harnessRunning: boolean
  justFinished: boolean
  /** What finished, for the check's tooltip. */
  finished: readonly { id: HarnessId; version: string }[]
}): UpdatesButtonModel {
  const app = appActivity(input.app)
  const askMe = input.harnessMode !== 'auto'
  const pending = input.harnessRows.filter((r) => r.state === 'available')
  const counted = askMe ? pending : []
  const count = counted.length + (app.decision ? 1 : 0)

  const running: string[] = []
  if (app.running) running.push(app.running)
  for (const r of input.harnessRows) {
    if (r.state !== 'installing') continue
    const pct = r.progress ? progressPercent(r.progress) : null
    running.push(`installing ${HARNESS_LABEL[r.id]}${pct === null ? '' : ` ${pct}%`}`)
  }
  for (const r of input.installRows) {
    if (r.state !== 'installing') continue
    const pct = r.progress ? progressPercent(r.progress) : null
    running.push(`installing ${HARNESS_LABEL[r.id]}${pct === null ? '' : ` ${pct}%`}`)
  }
  if (
    running.length === 0 &&
    (input.harnessRunning || input.harnessRows.some((r) => r.state === 'waiting'))
  )
    running.push('Updating harnesses')
  if (running.length > 0) return { state: 'running', count: 0, title: running.join(' · ') }

  const failed: string[] = []
  if (app.failed) failed.push(app.failed)
  for (const r of input.harnessRows)
    if (r.state === 'failed') failed.push(`${HARNESS_LABEL[r.id]} ${r.to} failed to install`)
  for (const r of input.installRows)
    if (r.state === 'failed') failed.push(`${HARNESS_LABEL[r.id]} ${r.version} failed to install`)
  if (failed.length > 0) return { state: 'failed', count: 0, title: failed.join(', ') }

  if (app.restart) {
    const more = count - 1
    return {
      state: 'restart',
      count,
      title: `${app.label}${more > 0 ? `, ${more} more` : ''}: click to review`
    }
  }
  if (count > 0) {
    const items = [
      ...(app.label ? [app.label] : []),
      ...counted.map((r) => `${HARNESS_LABEL[r.id]} ${r.to}`)
    ]
    return { state: 'available', count, title: `${items.join(', ')}: click to review` }
  }
  if (input.justFinished) {
    const what = input.finished.map((c) => `${HARNESS_LABEL[c.id]} ${c.version}`)
    return {
      state: 'done',
      count: 0,
      title: what.length > 0 ? `${what.join(', ')} installed` : 'Harnesses updated'
    }
  }
  return { state: 'hidden', count: 0, title: '' }
}

/** Download progress as the row shows it: `14.2 MB / 22.9 MB`. */
export function bytesText(received: number, total: number | null): string {
  return total ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received)
}

/**
 * How a build made in place is named: its commit; else (the running commit
 * rebuilt, or no git) its build time; else its version.
 */
export function newBuildName(build: RebuiltInPlace): string {
  if (build.commit) return build.commit
  const at = build.builtAt ? new Date(build.builtAt) : null
  if (at && Number.isFinite(at.getTime()))
    return `the build from ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  return build.version
}
