/**
 * Settings › Harnesses › Installed (ADR-082 §2-§4, §7; mockup `8bf84c23`
 * design 1): one row per harness, each with a source segment (Bundled or
 * ClaudeUI | System) and a version control, plus the page's own actions
 * (Detect again, and the install progress pill at the top right).
 *
 * The rows are the page's one setting item; the actions are its header
 * accessory (`SettingsPage.accessory`). Both read the shared harness store
 * (`harness-store.ts`), so they show one snapshot and one install list.
 */
import { useEffect, useRef, useState } from 'react'
import type {
  DetectedVerdict,
  HarnessInstallProgress,
  HarnessStateEntry,
  HarnessSystemInstallView
} from '../../../../shared/harness-types'
import { HARNESS_IDS } from '../../../../shared/harness-types'
import { useIsMobile } from '../../hooks/useIsMobile'
import { EngineLogo } from '../shared/EngineLogo'
import type { SelectMenuOption } from '../shared/SelectMenu'
import { useEscapeLayer } from '../shared/use-escape-layer'
import { useConnectionHoldsAdmin } from './connection-admin'
import {
  detectionRunning,
  harnessStore,
  useHarnessPageVisit,
  useHarnessStore,
  type HarnessStoreState,
  type HarnessVersionsState
} from './harness-store'
import {
  HARNESS_LABEL,
  VERDICT_LABEL,
  autoLatestWarning,
  choiceLabel,
  exactVersions,
  hasVersionChoice,
  installKey,
  isInstalled,
  leftLabel,
  leftSource,
  managedChoice,
  bundledSatisfies,
  installNeeded,
  missingManagedVersion,
  progressPercent,
  progressText,
  rowLine,
  systemOffReason,
  systemVerdict,
  upstreamLatest
} from './harness-view'
import { Button, LockIcon, Segmented, SelectField, SettingRow } from './settings-controls'

// ── Small pieces ──────────────────────────────────────────────────────

type ChipTone = 'ok' | 'warn' | 'danger' | 'muted'

const CHIP_TONE: Record<ChipTone, string> = {
  ok: 'bg-success/15 text-success',
  warn: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  muted: 'border border-border text-text-secondary'
}

function Chip({
  tone,
  children,
  testid,
  dataId
}: {
  tone: ChipTone
  children: React.ReactNode
  testid?: string
  dataId?: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testid}
      data-id={dataId}
      className={`shrink-0 inline-flex items-center rounded-full px-[7px] text-[10.5px] font-medium leading-4 whitespace-nowrap ${CHIP_TONE[tone]}`}
    >
      {children}
    </span>
  )
}

const VERDICT_TONE: Record<DetectedVerdict, ChipTone> = {
  tested: 'ok',
  untested: 'warn',
  'too-old': 'muted',
  unsupported: 'muted',
  incompatible: 'danger',
  failed: 'danger'
}

/** A thin progress bar: determinate with a percentage, pulsing without. Shared with the sidebar's update panel. */
export function ProgressBar({
  percent,
  className,
  testid,
  dataId
}: {
  percent: number | null
  className?: string
  testid?: string
  dataId?: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testid}
      data-id={dataId}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={`block h-[3px] rounded-full bg-bg-hover overflow-hidden ${className ?? ''}`}
    >
      <span
        className={`block h-full bg-accent ${percent === null ? 'w-1/3 animate-pulse' : ''}`}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </span>
  )
}

function CrossIcon(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function DownloadIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="shrink-0"
    >
      <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
    </svg>
  )
}

/** A small icon button in the progress pill and its list (cancel, dismiss). */
function IconButton({
  label,
  onClick,
  disabled,
  testid,
  dataId
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  testid: string
  dataId: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testid}
      data-id={dataId}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default disabled:opacity-40"
    >
      <CrossIcon />
    </button>
  )
}

const installName = (p: HarnessInstallProgress): string => `${HARNESS_LABEL[p.id]} ${p.version}`

// ── The version control ──────────────────────────────────────────────

const VERSION_WIDTH = 'w-[168px]'

/** A value the user cannot change: Bundled Claude Code, ClaudeUI's Codex. */
function LockedVersion({ text, title }: { text: string; title: string }): React.JSX.Element {
  return (
    <span
      data-testid="HarnessRow.lockedVersion"
      title={title}
      className={`h-7 ${VERSION_WIDTH} max-w-full inline-flex items-center gap-1.5 px-2.5 border border-dashed border-border rounded-md text-[12px] text-text-secondary`}
    >
      <span className="flex-1 min-w-0 truncate tabular-nums">{text}</span>
      <LockIcon />
    </span>
  )
}

function versionOptions(
  entry: HarnessStateEntry,
  versions: HarnessVersionsState | undefined,
  installs: HarnessInstallProgress[]
): SelectMenuOption[] {
  const ok = versions?.status === 'ok' ? versions : undefined
  const latest = upstreamLatest(ok)
  const tested = entry.manifest.tested
  const latestNote = latest
    ? `upstream's newest · ${latest}`
    : versions?.status === 'loading'
      ? "checking upstream's newest…"
      : versions?.status === 'error' || versions?.status === 'unsupported'
        ? "upstream's newest is unavailable"
        : "upstream's newest"
  const installing = new Set(
    installs.filter((p) => p.id === entry.id && p.phase !== 'failed').map((p) => p.version)
  )
  const note = (text: string): React.JSX.Element => (
    <span className="text-[11px] text-text-muted">{text}</span>
  )
  return [
    {
      value: 'latest',
      section: 'Keep up to date',
      label: 'Latest',
      selectedLabel: choiceLabel(entry, 'latest', ok),
      description: latestNote,
      trailing:
        latest === tested ? <Chip tone="ok">tested</Chip> : <Chip tone="warn">untested</Chip>
    },
    {
      value: 'tested',
      label: 'Tested',
      selectedLabel: choiceLabel(entry, 'tested', ok),
      description: `moves with ClaudeUI releases · ${tested}`,
      trailing: <Chip tone="ok">tested</Chip>
    },
    ...exactVersions(entry, ok).map((version, i): SelectMenuOption => ({
      value: version,
      section: i === 0 ? 'Stay on a version' : undefined,
      label: version,
      trailing: installing.has(version)
        ? note('installing')
        : isInstalled(entry, version)
          ? note('installed')
          : undefined
    }))
  ]
}

// ── One harness ──────────────────────────────────────────────────────

function DetectedInstall({ install }: { install: HarnessSystemInstallView }): React.JSX.Element {
  const node = install.node
  const nodeText = node
    ? node.kind === 'electron'
      ? `on ClaudeUI's Node ${node.version}`
      : `on Node ${node.version}`
    : null
  return (
    <span data-testid="HarnessRow.detected" data-id={install.displayPath} className="block py-0.5">
      <span className="flex items-center gap-1.5 min-w-0">
        <Chip tone={VERDICT_TONE[install.verdict]}>{VERDICT_LABEL[install.verdict]}</Chip>
        <span className="shrink-0 tabular-nums text-text-primary">{install.version ?? '—'}</span>
        <span className="min-w-0 truncate text-text-muted">
          {install.installKind}
          {nodeText ? ` · ${nodeText}` : ''}
        </span>
      </span>
      <span className="block truncate font-mono text-[11px]" title={install.displayPath}>
        {install.displayPath}
      </span>
      {install.reason && <span className="block text-text-muted">{install.reason}</span>}
    </span>
  )
}

function HarnessRow({
  entry,
  state,
  writable,
  stacked
}: {
  entry: HarnessStateEntry
  state: HarnessStoreState
  writable: boolean
  stacked: boolean
}): React.JSX.Element {
  const id = entry.id
  const [showDetected, setShowDetected] = useState(false)
  const versionsState = state.versions[id]
  const versions = versionsState?.status === 'ok' ? versionsState : undefined
  const onSystem = entry.selection.source === 'system'
  const systemUsable = entry.system.choice.kind === 'ok'
  const verdict = systemVerdict(entry)
  const missing = missingManagedVersion(entry, versions)
  const need = installNeeded(entry, versions)
  const line = rowLine(entry, versions)
  const rowInstalls = state.installs.filter((p) => p.id === id)
  // An install in flight for this harness replaces the line with its progress
  // (mockup: "Downloading 0.87.4 · …" over a bar); a failure says why.
  const active = rowInstalls.find((p) => p.phase !== 'failed')
  const failed = active ? undefined : rowInstalls.find((p) => p.phase === 'failed')
  const detected = entry.system.installs
  // Latest + Automatically is allowed, with a warning (ADR-082 §6).
  const autoLatest = state.snapshot ? autoLatestWarning(entry, state.snapshot.updates.mode) : false

  const onSource = (source: 'bundled' | 'managed' | 'system'): void => {
    if (!writable || source === entry.selection.source) return
    void harnessStore.setSelection(id, { source })
  }

  /** Pick a ClaudeUI version: save it, then fetch it when the store lacks it. */
  const onVersion = async (choice: string): Promise<void> => {
    if (!writable) return
    // Re-picking the current choice only means something when it is not installed.
    if (choice === managedChoice(entry) && !missing) return
    const saved = await harnessStore.setSelection(id, { source: 'managed', version: choice })
    if (!saved) return
    // Latest means upstream's newest, even when an older version is installed.
    const target =
      choice === 'latest'
        ? (upstreamLatest(versions) ?? (entry.managed.length > 0 ? null : 'latest'))
        : choice === 'tested'
          ? entry.manifest.tested
          : choice
    // The save answers with the resolver's fresh view: a bundled copy of the
    // very version picked satisfies it, and nothing downloads.
    const fresh = harnessStore.getState().snapshot?.harnesses[id] ?? entry
    if (!target || isInstalled(fresh, target) || bundledSatisfies(fresh, target)) return
    const inFlight = state.installs.some(
      (p) => p.id === id && p.version === target && p.phase !== 'failed'
    )
    if (!inFlight) void harnessStore.install(id, target)
  }

  // ── Right-hand controls ──
  const segment = (
    <Segmented
      testid="HarnessRow.source"
      optionTestid="HarnessRow.sourceOption"
      ariaLabel={`${HARNESS_LABEL[id]} source`}
      value={entry.selection.source}
      disabled={!writable}
      onChange={onSource}
      options={[
        { value: leftSource(id), label: leftLabel(id) },
        {
          value: 'system',
          label: 'System',
          disabled: !systemUsable,
          // Why System is off lives here, not as a row line (design 1).
          title: systemOffReason(entry)
        }
      ]}
    />
  )

  let version: React.JSX.Element
  if (id === 'claude') {
    version = (
      <LockedVersion
        text={entry.bundledVersion ? `Bundled · ${entry.bundledVersion}` : 'Bundled'}
        title="Claude Code's bundled copy moves with ClaudeUI releases"
      />
    )
  } else if (!hasVersionChoice(id)) {
    version = (
      <LockedVersion
        text={entry.manifest.tested}
        title="The exact Codex version this ClaudeUI release speaks"
      />
    )
  } else {
    version = (
      <SelectField
        testid="HarnessRow.version"
        dataId={id}
        width={VERSION_WIDTH}
        value={managedChoice(entry)}
        disabled={!writable || onSystem}
        options={versionOptions(entry, versionsState, state.installs)}
        onChange={(v) => void onVersion(v)}
      />
    )
  }

  const controls = (
    <span className="flex items-center gap-2 flex-wrap">
      {segment}
      {/* Switching to System keeps the ClaudeUI choice, greyed, so switching back restores it. */}
      <span
        data-testid="HarnessRow.versionSlot"
        data-kept={onSystem ? 'true' : 'false'}
        title={onSystem ? 'Kept for when you switch back' : undefined}
        className={onSystem ? 'opacity-50' : undefined}
      >
        {version}
      </span>
    </span>
  )

  // ── Description: ONE line for the active side (design 1's uiNote / sysNote) ──
  const lineText = active
    ? `Installing ${active.version} · ${progressText(active)}`
    : failed
      ? `Installing ${failed.version} failed: ${failed.reason ?? 'unknown error'}`
      : line.text
  const lineTone = active ? 'normal' : failed ? 'danger' : line.tone
  const description = (
    <>
      <span
        data-testid="HarnessRow.line"
        data-state={active ? 'installing' : failed ? 'failed' : line.state}
        data-source={entry.resolved.source}
        title={line.title}
        className={`block ${
          lineTone === 'danger' ? 'text-danger' : lineTone === 'warning' ? 'text-warning' : ''
        }`}
      >
        {lineText}
        {need && !active && (
          <>
            {' · '}
            <button
              type="button"
              data-testid="HarnessRow.install"
              data-id={need.request}
              disabled={!writable}
              onClick={() => void harnessStore.install(id, need.request)}
              className="text-accent hover:text-accent-hover transition-colors cursor-default disabled:opacity-40"
            >
              Install
            </button>
          </>
        )}
        {detected.length > 0 && (
          <>
            {' · '}
            <button
              type="button"
              data-testid="HarnessRow.detectedToggle"
              aria-expanded={showDetected}
              onClick={() => setShowDetected((v) => !v)}
              className="text-text-muted hover:text-text-primary transition-colors cursor-default"
            >
              {showDetected ? 'hide what was found' : `${detected.length} found on this computer`}
            </button>
          </>
        )}
      </span>
      {autoLatest && (
        <span
          data-testid="HarnessRow.autoLatest"
          data-id={id}
          title="Install updates is Automatically and this harness follows Latest: new upstream releases install without asking, before ClaudeUI has tested them."
          className="block text-warning"
        >
          Installs untested releases automatically
        </span>
      )}
      {active && (
        <ProgressBar
          testid="HarnessRow.progress"
          dataId={installKey(active)}
          percent={progressPercent(active)}
          className="mt-1.5 w-[200px] max-w-full"
        />
      )}
      {showDetected && (
        <span
          data-testid="HarnessRow.detectedList"
          className="block mt-1 pl-2 border-l border-border"
        >
          {detected.map((install) => (
            <DetectedInstall key={install.displayPath} install={install} />
          ))}
        </span>
      )}
    </>
  )

  return (
    <SettingRow
      testid="HarnessRow"
      dataId={id}
      layout={stacked ? 'stacked' : 'inline'}
      leading={stacked ? undefined : <EngineLogo engineId={id} size={14} className="shrink-0" />}
      label={HARNESS_LABEL[id]}
      labelBadge={
        verdict ? (
          <Chip tone={verdict === 'tested' ? 'ok' : 'warn'} testid="HarnessRow.verdict">
            {verdict}
          </Chip>
        ) : undefined
      }
      description={description}
      error={state.errors[id]}
    >
      {controls}
    </SettingRow>
  )
}

// ── The page's item ──────────────────────────────────────────────────

const READ_ONLY_TEXT =
  'Read only: installing or switching a harness needs an admin connection. Sign in with a passkey or the password to change it.'

export function HarnessesInstalled(): React.JSX.Element {
  useHarnessPageVisit()
  const state = useHarnessStore()
  const holdsAdmin = useConnectionHoldsAdmin()
  const stacked = useIsMobile()
  const writable = holdsAdmin && !state.denied
  const loaded = state.snapshot !== null

  // The version dropdowns' Latest and upstream releases (cached for an hour in main).
  useEffect(() => {
    if (!loaded) return
    for (const id of HARNESS_IDS) if (hasVersionChoice(id)) void harnessStore.loadVersions(id)
  }, [loaded])

  if (!state.snapshot) {
    return (
      <div data-testid="HarnessesInstalled">
        {state.loadError ? (
          <SettingRow
            testid="HarnessesInstalled.status"
            dataId="error"
            description="Could not read the harnesses."
            error={state.loadError}
          />
        ) : (
          <SettingRow testid="HarnessesInstalled.status" dataId="loading" description="Loading…" />
        )}
      </div>
    )
  }
  const snapshot = state.snapshot
  return (
    <div data-testid="HarnessesInstalled" className="divide-y divide-border/55">
      {!writable && (
        <SettingRow testid="HarnessesInstalled.readOnly" dimmed description={READ_ONLY_TEXT} />
      )}
      {state.loadError && (
        <SettingRow
          testid="HarnessesInstalled.status"
          dataId="error"
          description="Showing the last state read."
          error={state.loadError}
        />
      )}
      {HARNESS_IDS.map((id) => (
        <HarnessRow
          key={id}
          entry={snapshot.harnesses[id]}
          state={state}
          writable={writable}
          stacked={stacked}
        />
      ))}
    </div>
  )
}

// ── The page's actions: Detect again, and the install progress pill ──

function InstallListItem({
  install,
  writable
}: {
  install: HarnessInstallProgress
  writable: boolean
}): React.JSX.Element {
  const failed = install.phase === 'failed'
  const key = installKey(install)
  return (
    <div
      data-testid="HarnessInstallPill.item"
      data-id={key}
      data-phase={install.phase}
      className="px-3 py-2 text-[12px]"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-text-primary">{installName(install)}</span>
        {failed ? (
          <IconButton
            label="Dismiss"
            testid="HarnessInstallPill.dismiss"
            dataId={key}
            onClick={() => harnessStore.dismiss(install.id, install.version)}
          />
        ) : (
          <IconButton
            label="Cancel install"
            testid="HarnessInstallPill.cancel"
            dataId={key}
            disabled={!writable}
            onClick={() => void harnessStore.cancel(install.id, install.version)}
          />
        )}
      </div>
      <div className={`mt-0.5 leading-4 ${failed ? 'text-danger' : 'text-text-secondary'}`}>
        {progressText(install)}
      </div>
      {!failed && <ProgressBar percent={progressPercent(install)} className="mt-1.5" />}
    </div>
  )
}

/**
 * The top-right progress pill (ADR-082 §4): one install shows its phase and
 * bytes with a cancel; several show a count that opens the list; a failure
 * shows its reason until dismissed.
 */
export function HarnessInstallPill({
  installs,
  writable
}: {
  installs: HarnessInstallProgress[]
  writable: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const several = installs.length > 1
  useEscapeLayer(() => setOpen(false), true, open && several)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  useEffect(() => {
    if (!several) setOpen(false)
  }, [several])

  if (installs.length === 0) return null
  const shell =
    'h-7 max-w-full inline-flex items-center gap-2 px-2.5 rounded-full border text-[12px]'

  if (!several) {
    const p = installs[0]
    const key = installKey(p)
    if (p.phase === 'failed') {
      return (
        <div
          data-testid="HarnessInstallPill"
          data-state="failed"
          className={`${shell} bg-danger/10 border-danger/25 text-danger`}
        >
          <span className="shrink-0">{installName(p)} failed</span>
          <span
            data-testid="HarnessInstallPill.reason"
            className="min-w-0 truncate"
            title={p.reason}
          >
            {p.reason}
          </span>
          <IconButton
            label="Dismiss"
            testid="HarnessInstallPill.dismiss"
            dataId={key}
            onClick={() => harnessStore.dismiss(p.id, p.version)}
          />
        </div>
      )
    }
    const percent = progressPercent(p)
    return (
      <div
        data-testid="HarnessInstallPill"
        data-state="active"
        data-phase={p.phase}
        className={`${shell} bg-accent/10 border-accent/25 text-text-primary`}
      >
        <span className="text-accent">
          <DownloadIcon />
        </span>
        <span className="shrink-0">{installName(p)}</span>
        {percent !== null && <ProgressBar percent={percent} className="w-16 shrink-0" />}
        <span
          data-testid="HarnessInstallPill.progress"
          className="min-w-0 truncate text-[11px] text-text-muted tabular-nums"
        >
          {progressText(p)}
        </span>
        <IconButton
          label="Cancel install"
          testid="HarnessInstallPill.cancel"
          dataId={key}
          disabled={!writable}
          onClick={() => void harnessStore.cancel(p.id, p.version)}
        />
      </div>
    )
  }

  const failedCount = installs.filter((p) => p.phase === 'failed').length
  const activeCount = installs.length - failedCount
  const summary = [
    activeCount > 0 ? `${activeCount} ${activeCount === 1 ? 'install' : 'installs'}` : null,
    failedCount > 0 ? `${failedCount} failed` : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div ref={ref} data-testid="HarnessInstallPill" data-state="several" className="relative">
      <button
        type="button"
        data-testid="HarnessInstallPill.count"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${shell} cursor-default ${
          failedCount > 0 && activeCount === 0
            ? 'bg-danger/10 border-danger/25 text-danger'
            : 'bg-accent/10 border-accent/25 text-text-primary'
        }`}
      >
        <span className="text-accent">
          <DownloadIcon />
        </span>
        {summary}
      </button>
      {open && (
        <div
          data-testid="HarnessInstallPill.list"
          className="absolute right-0 top-full mt-1 w-[300px] max-w-[calc(100vw-32px)] z-30 bg-bg-tertiary border border-border rounded-lg shadow-lg shadow-black/30 divide-y divide-border/55"
        >
          {installs.map((p) => (
            <InstallListItem key={installKey(p)} install={p} writable={writable} />
          ))}
        </div>
      )}
    </div>
  )
}

function lastRunTitle(lastRunAt: string | undefined): string | undefined {
  if (!lastRunAt) return undefined
  const when = new Date(lastRunAt)
  return Number.isNaN(when.getTime()) ? undefined : `Last checked ${when.toLocaleString()}`
}

/** The Installed page's header accessory. */
export function HarnessesPageActions(): React.JSX.Element {
  useHarnessPageVisit()
  const state = useHarnessStore()
  const holdsAdmin = useConnectionHoldsAdmin()
  const writable = holdsAdmin && !state.denied
  const running = detectionRunning(state)
  return (
    <div
      data-testid="HarnessesPageActions"
      className="flex items-center justify-end gap-2 flex-wrap"
    >
      <HarnessInstallPill installs={state.installs} writable={writable} />
      <Button
        testid="HarnessesPageActions.detect"
        disabled={!writable || running || state.snapshot === null}
        title={
          running
            ? 'Looking for installs on this computer'
            : lastRunTitle(state.snapshot?.detection.lastRunAt)
        }
        onClick={() => void harnessStore.detect()}
      >
        {running ? 'Detecting…' : 'Detect again'}
      </Button>
      {state.detectError && (
        <span
          data-testid="HarnessesPageActions.error"
          className="basis-full text-right text-[12px] text-danger"
        >
          {state.detectError}
        </span>
      )}
    </div>
  )
}
