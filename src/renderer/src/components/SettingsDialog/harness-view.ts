/**
 * The Installed page's reading of a `HarnessStateEntry` (ADR-082 §2): what a
 * row says and offers, as pure functions of the snapshot, so the rules are
 * tested without rendering and the sidebar's update button (S6) can reuse them.
 */
import type {
  DetectedVerdict,
  HarnessId,
  HarnessInstallProgress,
  HarnessSourceChoice,
  HarnessStateEntry,
  HarnessVersionsResult
} from '../../../../shared/harness-types'

export const HARNESS_LABEL: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'opencode',
  pi: 'pi',
  codex: 'Codex'
}

/** The row's left segment: Claude Code ships bundled, the rest come from ClaudeUI's store. */
export function leftSource(id: HarnessId): Exclude<HarnessSourceChoice, 'system'> {
  return id === 'claude' ? 'bundled' : 'managed'
}

export function leftLabel(id: HarnessId): string {
  return id === 'claude' ? 'Bundled' : 'ClaudeUI'
}

/** opencode and pi choose a version; Claude Code's bundled copy and Codex's are locked. */
export function hasVersionChoice(id: HarnessId): boolean {
  return id === 'opencode' || id === 'pi'
}

/** `harness:install-progress` / `installs` key: one install per harness and exact version. */
export function installKey(p: { id: HarnessId; version: string }): string {
  return `${p.id}@${p.version}`
}

/** Upstream's newest release, when `harness:versions` answered. */
export function upstreamLatest(versions: HarnessVersionsResult | undefined): string | null {
  return versions?.status === 'ok' ? versions.latest : null
}

export function isInstalled(entry: HarnessStateEntry, version: string): boolean {
  return entry.managed.some((m) => m.version === version)
}

/** The ClaudeUI choice, kept while System is selected (`tested` when none was saved). */
export function managedChoice(entry: HarnessStateEntry): string {
  return entry.selection.version ?? 'tested'
}

/**
 * The exact version the ClaudeUI choice names: Tested is the manifest's, Latest
 * the newest installed one (what the resolver runs), else upstream's newest.
 */
export function choiceVersion(
  entry: HarnessStateEntry,
  choice: string,
  versions?: HarnessVersionsResult
): string | null {
  if (choice === 'tested') return entry.manifest.tested
  if (choice === 'latest') return entry.managed[0]?.version ?? upstreamLatest(versions)
  return choice
}

/**
 * The selection names a ClaudeUI version that is not in the store: the
 * resolver falls back and the row offers to install it. `request` is what to
 * pass `installHarness` (an exact version when one is known, so its progress
 * matches; `latest` otherwise).
 */
export function missingManagedVersion(
  entry: HarnessStateEntry,
  versions?: HarnessVersionsResult
): { request: string; version: string | null } | null {
  if (entry.selection.source !== 'managed' || entry.id === 'claude') return null
  const choice = managedChoice(entry)
  if (choice === 'latest') {
    if (entry.managed.length > 0) return null
    const latest = upstreamLatest(versions)
    return { request: latest ?? 'latest', version: latest }
  }
  const version = choiceVersion(entry, choice, versions)
  if (!version || isInstalled(entry, version)) return null
  return { request: version, version }
}

/** What the version dropdown's trigger reads for a ClaudeUI choice. */
export function choiceLabel(
  entry: HarnessStateEntry,
  choice: string,
  versions?: HarnessVersionsResult
): string {
  const version = choiceVersion(entry, choice, versions)
  if (choice === 'tested') return `Tested · ${version}`
  if (choice === 'latest') return version ? `Latest · ${version}` : 'Latest'
  return choice
}

/**
 * Every exact version the dropdown offers: upstream's releases and the store's
 * installs (an install can be older than upstream's list reaches), newest first.
 * Versions here are validated `x.y.z[-pre]` strings, which a numeric collation
 * orders correctly.
 */
export function exactVersions(
  entry: HarnessStateEntry,
  versions?: HarnessVersionsResult
): string[] {
  const all = new Set<string>(entry.managed.map((m) => m.version))
  if (versions?.status === 'ok') for (const v of versions.available) all.add(v)
  const choice = managedChoice(entry)
  if (choice !== 'tested' && choice !== 'latest') all.add(choice)
  return [...all].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
}

/**
 * The selected ClaudeUI version is missing AND nothing equivalent runs in its
 * place: the row's one actionable state ("1.18.33 is not installed · Install").
 * Until arc 3 unbundles the engines, a bundled copy of the very version the
 * selection names satisfies it, so that case is not "not installed".
 */
export function installNeeded(
  entry: HarnessStateEntry,
  versions?: HarnessVersionsResult
): { request: string; version: string | null } | null {
  const missing = missingManagedVersion(entry, versions)
  if (!missing) return null
  return bundledSatisfies(entry, missing.version) ? null : missing
}

/** The bundled copy that runs is exactly `version` (arc 2 still ships one). */
export function bundledSatisfies(entry: HarnessStateEntry, version: string | null): boolean {
  const r = entry.resolved
  return r.source === 'bundled' && r.path !== null && version !== null && r.version === version
}

const compareVersions = (a: string, b: string): number =>
  a.localeCompare(b, 'en', { numeric: true })

/** The row's one description line (mockup design 1: `uiNote` or `sysNote`, for the active side only). */
export interface HarnessRowLine {
  /** Which case the line describes; the page's tests and verifiers read it as `data-state`. */
  state: 'running' | 'not-installed' | 'fallback' | 'unavailable'
  text: string
  tone: 'normal' | 'warning' | 'danger'
  /** The running binary's full path (and the resolver's reason), for a tooltip. */
  title?: string
}

function runningTitle(entry: HarnessStateEntry): string | undefined {
  const r = entry.resolved
  const parts: string[] = []
  if (r.path) {
    parts.push(
      r.displayPath && r.displayPath !== r.path
        ? `Runs ${r.displayPath} (${r.path})`
        : `Runs ${r.path}`
    )
  }
  if (r.reason) parts.push(r.reason)
  return parts.length > 0 ? parts.join('\n') : undefined
}

export function rowLine(
  entry: HarnessStateEntry,
  versions?: HarnessVersionsResult
): HarnessRowLine {
  const r = entry.resolved
  const id = entry.id
  const title = runningTitle(entry)
  const unavailable = (): HarnessRowLine => ({
    state: 'unavailable',
    text: r.reason ?? `${HARNESS_LABEL[id]} was not found`,
    tone: 'danger',
    title
  })
  const fellBack = (reason: string): HarnessRowLine => ({
    state: 'fallback',
    text: `${reason}; ${
      r.source === 'bundled'
        ? 'running the bundled copy'
        : r.source === 'env'
          ? 'running the environment override'
          : "running ClaudeUI's copy"
    }`,
    tone: 'warning',
    title
  })
  const withVersion = (prefix: string): string => (r.version ? `${prefix} · ${r.version}` : prefix)

  if (r.path === null) return unavailable()
  if (r.source === 'env')
    return { state: 'running', text: withVersion('Environment override'), tone: 'normal', title }

  if (entry.selection.source === 'system') {
    if (r.source !== 'system') return fellBack(r.reason ?? `No usable System ${HARNESS_LABEL[id]}`)
    const tested = entry.manifest.tested
    const where = r.displayPath ?? r.path
    const how =
      r.version === null
        ? 'version unknown'
        : r.version === tested
          ? `${r.version}, the version ClaudeUI tested`
          : `${r.version}, ${compareVersions(r.version, tested) > 0 ? 'newer' : 'older'} than the ${tested} ClaudeUI tested`
    const note = id === 'claude' ? ' · runs unmodified: voice and live streaming off' : ''
    return { state: 'running', text: `${where} · ${how}${note}`, tone: 'normal', title }
  }

  if (id === 'claude') {
    return {
      state: 'running',
      text: `${withVersion('Bundled with ClaudeUI')} · patched: voice and live streaming`,
      tone: 'normal',
      title
    }
  }
  const need = installNeeded(entry, versions)
  if (need) {
    // Say what runs meanwhile: the line is otherwise the only place a user
    // would learn that the bundled copy is still in use.
    const meanwhile =
      r.source === 'bundled'
        ? `; running the bundled ${r.version ?? 'copy'}`
        : r.source === 'managed'
          ? `; running ClaudeUI's ${r.version ?? 'copy'}`
          : ''
    return {
      state: 'not-installed',
      text: `${need.version ?? 'Latest'} is not installed${meanwhile}`,
      tone: 'warning',
      title
    }
  }
  const missing = missingManagedVersion(entry, versions)
  // Any other fallback (a store version without its executable) says why.
  if (r.reason && !(missing && bundledSatisfies(entry, missing.version))) return fellBack(r.reason)
  const prefix =
    id === 'codex'
      ? 'Exact version this ClaudeUI release speaks'
      : r.source === 'bundled'
        ? 'Bundled with ClaudeUI'
        : "ClaudeUI's copy"
  return { state: 'running', text: withVersion(prefix), tone: 'normal', title }
}

/**
 * Why the System segment is off, for its tooltip: nothing found, or the
 * resolver's reason when installs were found but none is usable. Undefined
 * when System is usable.
 */
export function systemOffReason(entry: HarnessStateEntry): string | undefined {
  if (entry.system.choice.kind === 'ok') return undefined
  if (entry.system.installs.length === 0) {
    return entry.system.detectedAt === null
      ? 'Not looked for yet: Detect again searches this computer'
      : `No ${HARNESS_LABEL[entry.id]} found on this computer`
  }
  return entry.system.choice.reason
}

/** The running System install's label: tested when it is this release's pin. */
export function systemVerdict(entry: HarnessStateEntry): 'tested' | 'untested' | null {
  if (entry.resolved.source !== 'system' || !entry.resolved.version) return null
  return entry.resolved.version === entry.manifest.tested ? 'tested' : 'untested'
}

export const VERDICT_LABEL: Record<DetectedVerdict, string> = {
  tested: 'tested',
  untested: 'untested',
  'too-old': 'too old',
  incompatible: 'incompatible',
  unsupported: 'unsupported',
  failed: 'failed'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const PHASE_LABEL: Record<HarnessInstallProgress['phase'], string> = {
  resolving: 'Preparing',
  downloading: 'Downloading',
  verifying: 'Verifying',
  extracting: 'Extracting',
  checking: 'Checking',
  done: 'Installed',
  failed: 'Failed'
}

/** 0–100 while a download states its size; null otherwise. */
export function progressPercent(p: HarnessInstallProgress): number | null {
  if (p.phase !== 'downloading' || !p.totalBytes || p.receivedBytes === undefined) return null
  return Math.max(0, Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100)))
}

/** "Downloading 12.3 MB of 40.0 MB", "Verifying", "Failed: <reason>". */
export function progressText(p: HarnessInstallProgress): string {
  if (p.phase === 'failed') return p.reason ? `Failed: ${p.reason}` : 'Failed'
  if (p.phase === 'downloading' && p.receivedBytes !== undefined) {
    return p.totalBytes
      ? `Downloading ${formatBytes(p.receivedBytes)} of ${formatBytes(p.totalBytes)}`
      : `Downloading ${formatBytes(p.receivedBytes)}`
  }
  return PHASE_LABEL[p.phase]
}
