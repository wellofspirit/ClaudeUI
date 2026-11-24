/**
 * The Updates button and panel, pure (auto-update design §8; mockup
 * `updates-panel-mockup.html`, tabs A–E). Props in, DOM out: the container
 * (`UpdatesButton.tsx`) reads the stores and hands the models from `utils.ts`.
 *
 * The panel is 344 px wide, anchored above the sidebar footer and allowed to
 * overlap the chat area; in the phone drawer (`narrow`) it spans the drawer
 * less its gutter. Every row carries its own choice: ClaudeUI (release or
 * local build, a running or finished rebuild, the inline restart confirm),
 * then one row per harness update, then installs outside the update flow.
 * A read-only connection sees the same rows with no action buttons.
 */
import { useState } from 'react'
import type { AppUpdateTree } from '../../../../shared/types/app-update'
import type { HarnessUpdatesView } from '../../../../shared/harness-types'
import { EngineLogo } from '../shared/EngineLogo'
import { ProgressBar } from '../shared/ProgressBar'
import { SelectMenu } from '../shared/SelectMenu'
import {
  HARNESS_LABEL,
  installKey,
  progressPercent,
  progressText,
  type InstallPanelRow
} from '../SettingsDialog/harness-view'
import type { RestartConfirm, UpdatesBusy } from './app-update-store'
import {
  buildingFrom,
  bytesText,
  checkedAgo,
  defaultTree,
  formatElapsed,
  impactLines,
  stageName,
  treeLabel,
  type AppRelease,
  type AppSection,
  type HarnessUpdateRow,
  type UpdatesButtonModel
} from './utils'

// ── Icons (the footer's 14px, stroke 1.8) ─────────────────────────────

const ICON = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

function DownloadIcon(): React.JSX.Element {
  return (
    <svg {...ICON} aria-hidden="true">
      <path d="M12 4v11m0 0-4-4m4 4 4-4" />
      <path d="M5 20h14" />
    </svg>
  )
}

function RestartIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg {...ICON} width={size} height={size} strokeWidth={1.9} aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  )
}

function CheckIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg {...ICON} width={size} height={size} strokeWidth={2.2} aria-hidden="true">
      <path d="M5 12l5 5 9-10" />
    </svg>
  )
}

function WarnIcon(): React.JSX.Element {
  return (
    <svg {...ICON} aria-hidden="true">
      <path d="M12 3 2 20h20L12 3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r=".6" />
    </svg>
  )
}

function ExternalIcon(): React.JSX.Element {
  return (
    <svg {...ICON} width={10} height={10} strokeWidth={2} aria-hidden="true">
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  )
}

function CrossIcon(): React.JSX.Element {
  return (
    <svg {...ICON} width={10} height={10} strokeWidth={2.5} aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function Spinner({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="animate-spin motion-reduce:animate-none"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="14 40"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ── The button (tab E) ────────────────────────────────────────────────

const TONE: Record<Exclude<UpdatesButtonModel['state'], 'hidden'>, string> = {
  available: 'text-accent',
  restart: 'text-accent',
  running: 'text-accent',
  done: 'text-success',
  failed: 'text-warning'
}

export function UpdatesButtonView({
  model,
  open,
  fading,
  onClick
}: {
  /** `hidden` only reaches here while the panel is open: the button then shows the check. */
  model: UpdatesButtonModel
  open: boolean
  fading: boolean
  onClick: () => void
}): React.JSX.Element {
  const shown = model.state === 'hidden' ? 'done' : model.state
  const title = model.title || 'Updates'
  return (
    <button
      type="button"
      data-testid="UpdatesButton"
      data-state={shown}
      aria-label={title}
      title={title}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onClick}
      className={`relative flex items-center justify-center w-6 h-6 rounded-md hover:bg-bg-hover transition-[opacity,background-color] duration-300 cursor-default ${TONE[shown]} ${
        open ? 'bg-bg-hover' : ''
      } ${fading ? 'opacity-0' : ''}`}
    >
      {shown === 'available' && <DownloadIcon />}
      {shown === 'restart' && <RestartIcon />}
      {shown === 'running' && <Spinner />}
      {shown === 'done' && <CheckIcon />}
      {shown === 'failed' && <WarnIcon />}
      {(shown === 'available' || shown === 'restart') && model.count > 0 && (
        <span
          data-testid="UpdatesButton.badge"
          className="absolute -top-px -right-0.5 min-w-3 h-3 px-0.5 rounded-full bg-accent text-bg-secondary text-[8.5px] font-bold leading-3 text-center tabular-nums"
        >
          {model.count}
        </span>
      )}
    </button>
  )
}

// ── Small parts ───────────────────────────────────────────────────────

type Tone = 'primary' | 'secondary' | 'warning' | 'link'

const BUTTON_TONE: Record<Tone, string> = {
  primary: 'px-2.5 bg-accent text-bg-secondary hover:bg-accent-hover',
  secondary: 'px-2.5 bg-bg-hover text-text-primary hover:bg-bg-hover/70',
  warning: 'px-2.5 bg-warning text-bg-secondary hover:bg-warning/90',
  link: 'px-1.5 text-text-muted hover:text-text-primary'
}

function Btn({
  tone,
  testid,
  dataId,
  disabled,
  title,
  onClick,
  children
}: {
  tone: Tone
  testid: string
  dataId?: string
  disabled?: boolean
  title?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testid}
      data-id={dataId}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`h-6 shrink-0 inline-flex items-center gap-1.5 rounded-md text-[11.5px] font-medium whitespace-nowrap transition-colors cursor-default disabled:opacity-40 ${BUTTON_TONE[tone]}`}
    >
      {children}
    </button>
  )
}

function NotesLink({
  href,
  label = "What's new"
}: {
  href: string
  label?: string
}): React.JSX.Element {
  return (
    <a
      data-testid="UpdatesPanel.notes"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-accent hover:underline cursor-default"
    >
      {label} <ExternalIcon />
    </a>
  )
}

function AppLogo(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="w-4 h-4 rounded-[4px] shrink-0 inline-flex items-center justify-center text-[9px] font-bold bg-accent text-bg-secondary"
    >
      C
    </span>
  )
}

function Chip({
  tone,
  children
}: {
  tone: 'accent' | 'warning'
  children: string
}): React.JSX.Element {
  return (
    <span
      data-testid="UpdatesPanel.chip"
      className={`shrink-0 whitespace-nowrap text-[9.5px] font-semibold tracking-[0.02em] uppercase px-[5px] py-px rounded ${
        tone === 'accent' ? 'bg-accent/10 text-accent' : 'bg-warning/10 text-warning'
      }`}
    >
      {children}
    </span>
  )
}

/** The row's first line: logo, name, chip, and what sits on the right. */
function RowHead({
  logo,
  name,
  chip,
  right
}: {
  logo: React.ReactNode
  name: string
  chip?: React.ReactNode
  right?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 min-w-0">
      {logo}
      <span className="text-text-primary font-medium truncate">{name}</span>
      {chip}
      {right !== undefined && (
        <span className="ml-auto shrink-0 text-[11px] whitespace-nowrap">{right}</span>
      )}
    </div>
  )
}

/** `from → to` on its own line: never truncated (the browser test pins it at 344 px). */
function Versions({
  from,
  to,
  dataId
}: {
  from: string
  to?: string
  dataId?: string
}): React.JSX.Element {
  return (
    <div
      data-testid="UpdatesPanel.versions"
      data-id={dataId}
      className="mt-1 pl-6 font-mono text-[11px] text-text-secondary whitespace-nowrap tabular-nums"
    >
      {from}
      {to !== undefined && (
        <>
          {' '}
          <span className="text-text-muted px-0.5">→</span>{' '}
          <span className="text-text-primary">{to}</span>
        </>
      )}
    </div>
  )
}

function Sub({
  testid,
  tone = 'normal',
  children
}: {
  testid?: string
  tone?: 'normal' | 'muted' | 'danger'
  children: React.ReactNode
}): React.JSX.Element {
  const color =
    tone === 'danger' ? 'text-danger' : tone === 'muted' ? 'text-text-muted' : 'text-text-secondary'
  return (
    <div
      data-testid={testid}
      className={`mt-1.5 pl-6 text-[11px] leading-[17px] break-words ${color}`}
    >
      {children}
    </div>
  )
}

function Actions({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mt-2.5 pl-6 flex items-center gap-1.5 flex-wrap">{children}</div>
}

function SectionLabel({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="px-3 pt-2.5 pb-0.5 text-[10px] font-semibold tracking-[0.06em] uppercase text-text-muted">
      {children}
    </div>
  )
}

// ── The restart confirm (tab B) ───────────────────────────────────────

function RestartConfirmBox({
  confirm,
  busy,
  indent,
  onConfirm,
  onCancel
}: {
  confirm: RestartConfirm
  busy: boolean
  /** Under a row's name (the row hosts it), or flush (above the footer). */
  indent: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const lines = confirm.impact
    ? impactLines(confirm.impact)
    : ['What is running could not be read.']
  const relaunch = confirm.action !== 'update'
  return (
    <div
      data-testid="UpdatesPanel.restartConfirm"
      data-id={confirm.action}
      className={`mt-2.5 ${indent ? 'ml-6' : ''} rounded-md border border-warning/25 bg-warning/5 px-2.5 py-2`}
    >
      <div className="text-text-primary font-medium mb-1">
        {relaunch ? 'Relaunch ClaudeUI now?' : 'Restart ClaudeUI now?'}
      </div>
      <ul className="text-[11px] text-text-secondary leading-[17px] list-disc pl-4">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="flex gap-1.5 mt-2">
        <Btn tone="warning" testid="UpdatesPanel.restartNow" disabled={busy} onClick={onConfirm}>
          {busy ? 'Restarting…' : relaunch ? 'Relaunch now' : 'Restart now'}
        </Btn>
        <Btn tone="link" testid="UpdatesPanel.cancelRestart" disabled={busy} onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  )
}

// ── The ClaudeUI row ──────────────────────────────────────────────────

export interface AppRowActions {
  onDownload: () => void
  onRestartUpdate: () => void
  onUpdateAndRestart: () => void
  onRebuild: (treeId: string) => void
  onCancelRebuild: () => void
  onRelaunchBuilt: () => void
  onLater: (key: string) => void
  onSkip: (version: string) => void
}

/** The release's status line (tab A and the local row's release choice). */
function ReleaseStatus({ release }: { release: AppRelease }): React.JSX.Element | null {
  const s = release.status
  const ships = release.claudeCodeVersion ? (
    <>
      Ships Claude Code{' '}
      <span className="font-mono text-text-primary">{release.claudeCodeVersion}</span>.
    </>
  ) : null
  switch (s.kind) {
    case 'staged':
      return <Sub testid="UpdatesPanel.status">Downloaded.{ships ? <> {ships}</> : null}</Sub>
    case 'downloading': {
      const pct = s.total ? Math.round((s.received / s.total) * 100) : null
      return (
        <>
          <div className="mt-2 pl-6">
            <ProgressBar testid="UpdatesPanel.progress" dataId="claudeui" percent={pct} smooth />
          </div>
          <Sub testid="UpdatesPanel.status">
            <span className="font-mono tabular-nums">
              Downloading · {bytesText(s.received, s.total)}
            </span>
          </Sub>
        </>
      )
    }
    case 'verifying':
      return <Sub testid="UpdatesPanel.status">Verifying the download…</Sub>
    case 'staging':
      return <Sub testid="UpdatesPanel.status">Preparing the update…</Sub>
    case 'failed':
      return (
        <Sub testid="UpdatesPanel.status" tone="danger">
          {s.reason}
        </Sub>
      )
    case 'ineligible':
      return (
        <Sub testid="UpdatesPanel.status">
          <span className="text-warning">{s.reason}.</span>{' '}
          <NotesLink href={release.notesUrl} label="Download manually" />
        </Sub>
      )
    default:
      return ships ? <Sub testid="UpdatesPanel.status">{ships}</Sub> : null
  }
}

function ReleaseRow({
  app,
  writable,
  busy,
  confirm,
  actions,
  confirmBox
}: {
  app: Extract<AppSection, { kind: 'release' }>
  writable: boolean
  busy: UpdatesBusy | null
  confirm: RestartConfirm | null
  actions: AppRowActions
  confirmBox: React.ReactNode
}): React.JSX.Element {
  const r = app.release
  const kind = r.status.kind
  return (
    <div
      data-testid="UpdatesPanel.appRow"
      data-id="release"
      data-state={kind}
      className="px-3 py-3"
    >
      <RowHead
        logo={<AppLogo />}
        name="ClaudeUI"
        chip={r.pre ? <Chip tone="accent">Pre-release</Chip> : undefined}
        right={kind === 'ineligible' ? undefined : <NotesLink href={r.notesUrl} />}
      />
      <Versions from={app.from} to={r.version} dataId="claudeui" />
      <ReleaseStatus release={r} />
      {confirm && confirm.action === 'update'
        ? confirmBox
        : writable && (
            <Actions>
              {kind === 'staged' && (
                <Btn
                  tone="primary"
                  testid="UpdatesPanel.primary"
                  dataId="restart"
                  disabled={busy === 'restart'}
                  onClick={actions.onRestartUpdate}
                >
                  <RestartIcon size={12} />
                  {busy === 'restart' ? 'Restarting…' : 'Restart to update'}
                </Btn>
              )}
              {kind === 'ready' && (
                <Btn
                  tone="primary"
                  testid="UpdatesPanel.primary"
                  dataId="download"
                  disabled={busy === 'download'}
                  onClick={actions.onDownload}
                >
                  <DownloadIcon />
                  Download
                </Btn>
              )}
              {kind === 'failed' && (
                <Btn
                  tone="secondary"
                  testid="UpdatesPanel.primary"
                  dataId="retry"
                  disabled={busy === 'download'}
                  onClick={actions.onDownload}
                >
                  Retry
                </Btn>
              )}
              <Btn
                tone="link"
                testid="UpdatesPanel.later"
                dataId="claudeui"
                onClick={() => actions.onLater(app.laterKey)}
              >
                Later
              </Btn>
              <Btn
                tone="link"
                testid="UpdatesPanel.skip"
                dataId="claudeui"
                disabled={busy === 'skip'}
                onClick={() => actions.onSkip(r.version)}
              >
                Skip {app.skipLabel}
              </Btn>
            </Actions>
          )}
    </div>
  )
}

function Radio({
  id,
  on,
  disabled,
  title,
  onPick,
  children
}: {
  id: 'rebuild' | 'release'
  on: boolean
  disabled?: boolean
  title?: string
  onPick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="radio"
      aria-checked={on}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-testid="UpdatesPanel.choice"
      data-id={id}
      data-on={on}
      title={title}
      onClick={() => {
        if (!disabled) onPick()
      }}
      onKeyDown={(e) => {
        // Keys meant for the tree select inside it stay the select's.
        if (e.target !== e.currentTarget) return
        if (!disabled && (e.key === ' ' || e.key === 'Enter')) {
          e.preventDefault()
          onPick()
        }
      }}
      className={`flex gap-2 rounded-lg border px-2.5 py-2 cursor-default outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
        on ? 'border-accent/35 bg-accent/5' : 'border-border'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        aria-hidden="true"
        className={`w-3 h-3 mt-px rounded-full shrink-0 border-[1.5px] ${
          on
            ? 'border-accent bg-accent shadow-[inset_0_0_0_2.5px_var(--color-bg-tertiary)]'
            : 'border-text-muted'
        }`}
      />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

function LocalRow({
  app,
  writable,
  busy,
  confirm,
  trees,
  rebuildIntent,
  actions,
  confirmBox
}: {
  app: Extract<AppSection, { kind: 'local' }>
  writable: boolean
  busy: UpdatesBusy | null
  confirm: RestartConfirm | null
  trees: AppUpdateTree[] | null
  rebuildIntent: boolean
  actions: AppRowActions
  confirmBox: React.ReactNode
}): React.JSX.Element {
  const release = app.release
  const rebuildable = app.canRebuild && writable
  const [choice, setChoice] = useState<'rebuild' | 'release'>(
    rebuildIntent || !release ? 'rebuild' : app.canRebuild ? 'rebuild' : 'release'
  )
  const picked: 'rebuild' | 'release' = choice === 'release' && release ? 'release' : 'rebuild'
  const preferred = defaultTree(trees, app.commit)
  const [treeId, setTreeId] = useState<string | null>(null)
  const tree = trees?.find((t) => t.id === treeId) ?? preferred ?? null
  const versionWord = release ? (app.skipLabel ?? release.version) : null
  const sizeText = release?.size ? ` (${Math.round(release.size / 1e6)} MB)` : ''

  return (
    <div
      data-testid="UpdatesPanel.appRow"
      data-id="local"
      data-state={picked}
      className="px-3 py-3"
    >
      <RowHead
        logo={<AppLogo />}
        name="ClaudeUI"
        chip={app.localBuild ? <Chip tone="warning">Local build</Chip> : undefined}
        right={release ? <NotesLink href={release.notesUrl} /> : undefined}
      />
      <Versions from={app.from} to={release?.version} dataId="claudeui" />
      {app.localBuild && (
        <Sub testid="UpdatesPanel.built">
          {app.commit ? (
            <>
              Built from{' '}
              <span className="font-mono text-text-primary">{app.commit.slice(0, 7)}</span>
              {app.dirty ? ', with uncommitted changes.' : '.'}
            </>
          ) : (
            'Built from a source checkout.'
          )}
        </Sub>
      )}
      {app.rebuildError && (
        <Sub testid="UpdatesPanel.buildError" tone="danger">
          The build failed: {app.rebuildError}
        </Sub>
      )}
      <div role="radiogroup" aria-label="How to update" className="mt-2.5 pl-6 space-y-2">
        <Radio
          id="rebuild"
          on={picked === 'rebuild'}
          disabled={!app.canRebuild}
          title={
            app.canRebuild ? undefined : 'No source checkout is known: set one in Update settings'
          }
          onPick={() => setChoice('rebuild')}
        >
          <span className="text-text-primary font-medium block">Rebuild from source</span>
          {app.canRebuild && writable && (
            <div className="mt-1.5 min-w-0">
              <SelectMenu
                testid="UpdatesPanel.tree"
                ariaLabel="Source tree"
                value={tree?.id ?? ''}
                disabled={!trees || trees.length === 0}
                options={
                  trees && trees.length > 0
                    ? trees.map((t) => ({ value: t.id, label: treeLabel(t) }))
                    : [{ value: '', label: trees ? 'No checkout found' : 'Loading…' }]
                }
                onChange={setTreeId}
                fitTrigger
                triggerClassName="w-full min-w-0 min-h-6 py-[3px] bg-bg-secondary border border-border rounded-md text-text-primary text-[11px] leading-4 px-1.5 outline-none focus:border-accent/50 transition-colors"
              />
            </div>
          )}
          <span className="block mt-1.5 text-[11px] text-text-secondary leading-[17px]">
            {app.canRebuild
              ? `Builds the tree as it is.${versionWord ? ` Pull first to get ${versionWord}.` : ''}`
              : 'No source checkout is known here. Set one in Update settings.'}
          </span>
        </Radio>
        {release && (
          <Radio id="release" on={picked === 'release'} onPick={() => setChoice('release')}>
            <span className="text-text-primary font-medium block">Install the release</span>
            <span className="block mt-1 text-[11px] text-text-secondary leading-[17px]">
              Replaces this build with {versionWord}
              {sizeText}. Your source is untouched.
            </span>
          </Radio>
        )}
      </div>
      {release && picked === 'release' && release.status.kind !== 'ready' && (
        <ReleaseStatus release={release} />
      )}
      {confirm && confirm.action === 'update'
        ? confirmBox
        : writable && (
            <Actions>
              {picked === 'rebuild' ? (
                <Btn
                  tone="primary"
                  testid="UpdatesPanel.primary"
                  dataId="rebuild"
                  disabled={!rebuildable || !tree || busy === 'rebuild'}
                  onClick={() => tree && actions.onRebuild(tree.id)}
                >
                  <RestartIcon size={12} />
                  Rebuild &amp; relaunch
                </Btn>
              ) : (
                <Btn
                  tone="primary"
                  testid="UpdatesPanel.primary"
                  dataId="update"
                  disabled={
                    busy === 'download' ||
                    busy === 'restart' ||
                    release?.status.kind === 'downloading' ||
                    release?.status.kind === 'verifying' ||
                    release?.status.kind === 'staging' ||
                    release?.status.kind === 'ineligible'
                  }
                  onClick={actions.onUpdateAndRestart}
                >
                  <RestartIcon size={12} />
                  {busy === 'restart' ? 'Restarting…' : 'Update & restart'}
                </Btn>
              )}
              <Btn
                tone="link"
                testid="UpdatesPanel.later"
                dataId="claudeui"
                onClick={() => actions.onLater(app.laterKey)}
              >
                Later
              </Btn>
              {release && (
                <Btn
                  tone="link"
                  testid="UpdatesPanel.skip"
                  dataId="claudeui"
                  disabled={busy === 'skip'}
                  onClick={() => actions.onSkip(release.version)}
                >
                  Skip {app.skipLabel}
                </Btn>
              )}
            </Actions>
          )}
    </div>
  )
}

function BuildingRow({
  app,
  now,
  writable,
  busy,
  actions
}: {
  app: Extract<AppSection, { kind: 'building' }>
  now: number
  writable: boolean
  busy: UpdatesBusy | null
  actions: AppRowActions
}): React.JSX.Element {
  const started = app.startedAt ? Date.parse(app.startedAt) : NaN
  return (
    <div
      data-testid="UpdatesPanel.appRow"
      data-id="building"
      data-state="building"
      className="px-3 py-3"
    >
      <RowHead
        logo={<AppLogo />}
        name="ClaudeUI"
        chip={<Chip tone="warning">Local build</Chip>}
        right={
          Number.isNaN(started) ? undefined : (
            <span
              data-testid="UpdatesPanel.elapsed"
              className="text-text-secondary font-mono tabular-nums"
            >
              {formatElapsed(now - started)}
            </span>
          )
        }
      />
      <Sub>{buildingFrom(app.tree)}</Sub>
      {(app.stages.length > 0 || app.lastLine) && (
        <div className="mt-2 pl-6 text-[11px] leading-5">
          {app.stages.map((st) => (
            <div
              key={st.label}
              title={st.label}
              data-testid="UpdatesPanel.stage"
              data-state={st.state}
              className="flex items-center gap-1.5 min-w-0"
            >
              <span
                className={`shrink-0 inline-flex w-3 justify-center ${
                  st.state === 'done'
                    ? 'text-success'
                    : st.state === 'running'
                      ? 'text-accent'
                      : 'text-text-muted'
                }`}
              >
                {st.state === 'done' ? (
                  <CheckIcon size={12} />
                ) : st.state === 'running' ? (
                  <Spinner size={12} />
                ) : (
                  <span className="w-1 h-1 rounded-full bg-current" />
                )}
              </span>
              <span
                className={`min-w-0 truncate ${st.state === 'running' ? 'text-text-primary' : 'text-text-secondary'}`}
              >
                {stageName(st.label)}
              </span>
              {st.elapsedMs !== undefined && (
                <span className="ml-auto shrink-0 font-mono text-text-muted tabular-nums">
                  {formatElapsed(st.elapsedMs)}
                </span>
              )}
            </div>
          ))}
          {app.lastLine && (
            <div
              data-testid="UpdatesPanel.lastLine"
              title={app.lastLine}
              className="mt-1 font-mono text-[10.5px] text-text-muted truncate bg-bg-secondary rounded px-1.5 py-0.5"
            >
              {app.lastLine}
            </div>
          )}
        </div>
      )}
      {writable && (
        <Actions>
          <Btn
            tone="secondary"
            testid="UpdatesPanel.cancelBuild"
            disabled={busy === 'cancel-rebuild'}
            onClick={actions.onCancelRebuild}
          >
            Cancel build
          </Btn>
        </Actions>
      )}
      <Sub tone="muted">Nothing changes until you relaunch.</Sub>
    </div>
  )
}

function BuiltRow({
  app,
  writable,
  busy,
  confirm,
  actions,
  confirmBox
}: {
  app: Extract<AppSection, { kind: 'built' }>
  writable: boolean
  busy: UpdatesBusy | null
  confirm: RestartConfirm | null
  actions: AppRowActions
  confirmBox: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid="UpdatesPanel.appRow" data-id="built" data-state="built" className="px-3 py-3">
      <RowHead
        logo={<AppLogo />}
        name="ClaudeUI"
        chip={<Chip tone="warning">Local build</Chip>}
        right={
          <span className="text-success inline-flex items-center gap-1">
            <CheckIcon size={12} /> Built
          </span>
        }
      />
      {app.version && <Versions from={app.version} dataId="claudeui" />}
      <Sub testid="UpdatesPanel.status">
        Build ready
        {app.commit ? (
          <>
            {' · '}
            <span className="font-mono text-text-primary">{app.commit.slice(0, 7)}</span>
          </>
        ) : null}
      </Sub>
      {confirm && confirm.action === 'rebuild'
        ? confirmBox
        : writable && (
            <Actions>
              <Btn
                tone="primary"
                testid="UpdatesPanel.primary"
                dataId="relaunch-built"
                disabled={busy === 'restart'}
                onClick={actions.onRelaunchBuilt}
              >
                <RestartIcon size={12} />
                {busy === 'restart' ? 'Relaunching…' : 'Relaunch now'}
              </Btn>
              <Btn
                tone="link"
                testid="UpdatesPanel.later"
                dataId="claudeui"
                onClick={() => actions.onLater(app.laterKey)}
              >
                Later
              </Btn>
            </Actions>
          )}
    </div>
  )
}

// ── The harness rows ──────────────────────────────────────────────────

export interface HarnessRowActions {
  onUpdate: (row: HarnessUpdateRow) => void
  onLater: (row: HarnessUpdateRow) => void
  onSkip: (row: HarnessUpdateRow) => void
  onCancel: (row: HarnessUpdateRow) => void
  onDismiss: (row: HarnessUpdateRow) => void
  onInstallCancel: (row: InstallPanelRow) => void
  onInstallDismiss: (row: InstallPanelRow) => void
}

function IconButton({
  testid,
  dataId,
  label,
  disabled,
  onClick
}: {
  testid: string
  dataId: string
  label: string
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testid}
      data-id={dataId}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="w-5 h-5 shrink-0 inline-flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default disabled:opacity-40"
    >
      <CrossIcon />
    </button>
  )
}

function HarnessRow({
  row,
  writable,
  actions
}: {
  row: HarnessUpdateRow
  writable: boolean
  actions: HarnessRowActions
}): React.JSX.Element {
  const right =
    row.state === 'installed' ? (
      <span className="text-success inline-flex items-center gap-1">
        <CheckIcon size={12} /> Installed
      </span>
    ) : row.state === 'failed' ? (
      <span className="text-danger">Failed</span>
    ) : row.state === 'waiting' ? (
      <span className="text-text-muted">Waiting</span>
    ) : undefined
  return (
    <div
      data-testid="UpdatesPanel.harnessRow"
      data-id={row.id}
      data-state={row.state}
      className="px-3 py-3"
    >
      <RowHead
        logo={<EngineLogo engineId={row.id} size={14} className="shrink-0 w-4" />}
        name={HARNESS_LABEL[row.id]}
        right={right}
      />
      <Versions from={row.from} to={row.to} dataId={row.id} />
      {row.state === 'installing' && row.progress && (
        <>
          <div className="mt-2 pl-6 flex items-center gap-2">
            <ProgressBar
              testid="UpdatesPanel.harnessProgress"
              dataId={row.id}
              percent={progressPercent(row.progress)}
              className="flex-1"
            />
            {writable && (
              <IconButton
                testid="UpdatesPanel.harnessCancel"
                dataId={row.id}
                label="Cancel"
                onClick={() => actions.onCancel(row)}
              />
            )}
          </div>
          <Sub>
            <span className="font-mono tabular-nums">{progressText(row.progress)}</span>
          </Sub>
        </>
      )}
      {row.state === 'installed' && <Sub>New sessions use {row.to}.</Sub>}
      {row.state === 'failed' && (
        <Sub testid="UpdatesPanel.harnessReason" tone="danger">
          {row.reason}
        </Sub>
      )}
      {row.state === 'available' && writable && (
        <Actions>
          <Btn
            tone="secondary"
            testid="UpdatesPanel.harnessUpdate"
            dataId={row.id}
            onClick={() => actions.onUpdate(row)}
          >
            Update
          </Btn>
          <Btn
            tone="link"
            testid="UpdatesPanel.harnessLater"
            dataId={row.id}
            onClick={() => actions.onLater(row)}
          >
            Later
          </Btn>
          <Btn
            tone="link"
            testid="UpdatesPanel.harnessSkip"
            dataId={row.id}
            onClick={() => actions.onSkip(row)}
          >
            Skip {row.to}
          </Btn>
        </Actions>
      )}
      {row.state === 'failed' && (
        <Actions>
          {writable && (
            <Btn
              tone="secondary"
              testid="UpdatesPanel.harnessRetry"
              dataId={row.id}
              onClick={() => actions.onUpdate(row)}
            >
              Retry
            </Btn>
          )}
          <Btn
            tone="link"
            testid="UpdatesPanel.harnessDismiss"
            dataId={row.id}
            onClick={() => actions.onDismiss(row)}
          >
            Dismiss
          </Btn>
        </Actions>
      )}
    </div>
  )
}

/** An install outside the update flow (the upgrade sheet's): progress and Cancel, done, or the failure. */
function InstallRow({
  row,
  writable,
  actions
}: {
  row: InstallPanelRow
  writable: boolean
  actions: HarnessRowActions
}): React.JSX.Element {
  const key = installKey(row)
  return (
    <div
      data-testid="UpdatesPanel.install"
      data-id={key}
      data-state={row.state}
      className="px-3 py-3"
    >
      <RowHead
        logo={<EngineLogo engineId={row.id} size={14} className="shrink-0 w-4" />}
        name={HARNESS_LABEL[row.id]}
        right={
          row.state === 'installed' ? (
            <span className="text-success inline-flex items-center gap-1">
              <CheckIcon size={12} /> Installed
            </span>
          ) : row.state === 'failed' ? (
            <IconButton
              testid="UpdatesPanel.installDismiss"
              dataId={key}
              label="Dismiss"
              onClick={() => actions.onInstallDismiss(row)}
            />
          ) : writable ? (
            <IconButton
              testid="UpdatesPanel.installCancel"
              dataId={key}
              label="Cancel install"
              onClick={() => actions.onInstallCancel(row)}
            />
          ) : undefined
        }
      />
      <Versions from={row.version} dataId={row.id} />
      {row.state === 'installing' && row.progress && (
        <>
          <div className="mt-2 pl-6">
            <ProgressBar percent={progressPercent(row.progress)} />
          </div>
          <Sub testid="UpdatesPanel.installProgress">
            <span className="font-mono tabular-nums">{progressText(row.progress)}</span>
          </Sub>
        </>
      )}
      {row.state === 'failed' && (
        <Sub testid="UpdatesPanel.installReason" tone="danger">
          {row.reason}
        </Sub>
      )}
    </div>
  )
}

// ── The panel ─────────────────────────────────────────────────────────

export interface UpdatesPanelViewProps {
  /** The phone drawer: span the container less its gutter instead of 344 px. */
  narrow: boolean
  writable: boolean
  now: number
  checking: boolean
  /** Something runs (a download, a build, an install): the header says so. */
  working: boolean
  checkedAt: string | null
  app: AppSection | null
  trees: AppUpdateTree[] | null
  rebuildIntent: boolean
  busy: UpdatesBusy | null
  confirm: RestartConfirm | null
  harnessRows: HarnessUpdateRow[]
  installRows: InstallPanelRow[]
  harnessMode: HarnessUpdatesView['mode'] | undefined
  version: string | null
  canRelaunch: boolean
  errors: string[]
  onCheck: () => void
  onSettings: () => void
  onRelaunch: () => void
  onConfirm: () => void
  onCancelConfirm: () => void
  appActions: AppRowActions
  harnessActions: HarnessRowActions
}

export function UpdatesPanelView(props: UpdatesPanelViewProps): React.JSX.Element {
  const { app, writable, confirm, busy } = props
  const restarting = busy === 'restart'
  const confirmBox = (indent: boolean): React.ReactNode =>
    confirm ? (
      <RestartConfirmBox
        confirm={confirm}
        busy={restarting}
        indent={indent}
        onConfirm={props.onConfirm}
        onCancel={props.onCancelConfirm}
      />
    ) : null
  // A confirm the ClaudeUI row cannot host (Relaunch, or the row went) sits above the footer.
  const rowHostsConfirm =
    confirm !== null &&
    ((confirm.action === 'update' && (app?.kind === 'release' || app?.kind === 'local')) ||
      (confirm.action === 'rebuild' && app?.kind === 'built'))
  const empty = !app && props.harnessRows.length === 0 && props.installRows.length === 0

  return (
    <div
      data-testid="UpdatesPanel"
      role="dialog"
      aria-label="Updates"
      data-narrow={props.narrow}
      className={`absolute bottom-full mb-1.5 z-30 left-3 ${
        props.narrow ? 'right-3' : 'w-[344px]'
      } bg-bg-tertiary border border-border rounded-lg shadow-2xl shadow-black/40 text-[12px] leading-4 text-text-secondary cursor-default`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
        <span className="text-text-primary font-semibold text-[12.5px]">Updates</span>
        <span
          data-testid="UpdatesPanel.checked"
          className="ml-auto text-[11px] text-text-muted truncate"
        >
          {props.checking
            ? 'Checking…'
            : props.working
              ? 'Working…'
              : checkedAgo(props.checkedAt, props.now)}
        </span>
        {writable && (
          <Btn
            tone="link"
            testid="UpdatesPanel.check"
            disabled={props.checking}
            onClick={props.onCheck}
          >
            Check now
          </Btn>
        )}
      </div>
      <div className="max-h-[430px] overflow-y-auto overflow-x-hidden">
        {app && (
          <>
            <SectionLabel>ClaudeUI</SectionLabel>
            {app.kind === 'release' && (
              <ReleaseRow
                app={app}
                writable={writable}
                busy={busy}
                confirm={confirm}
                actions={props.appActions}
                confirmBox={confirmBox(true)}
              />
            )}
            {app.kind === 'local' && (
              <LocalRow
                key={String(props.rebuildIntent)}
                app={app}
                writable={writable}
                busy={busy}
                confirm={confirm}
                trees={props.trees}
                rebuildIntent={props.rebuildIntent}
                actions={props.appActions}
                confirmBox={confirmBox(true)}
              />
            )}
            {app.kind === 'building' && (
              <BuildingRow
                app={app}
                now={props.now}
                writable={writable}
                busy={busy}
                actions={props.appActions}
              />
            )}
            {app.kind === 'built' && (
              <BuiltRow
                app={app}
                writable={writable}
                busy={busy}
                confirm={confirm}
                actions={props.appActions}
                confirmBox={confirmBox(true)}
              />
            )}
            {(props.harnessRows.length > 0 || props.installRows.length > 0) && (
              <div className="mx-3 border-t border-border" />
            )}
          </>
        )}
        {(props.harnessRows.length > 0 || props.installRows.length > 0) && (
          <>
            <SectionLabel>Harnesses</SectionLabel>
            {props.harnessRows.map((row) => (
              <HarnessRow
                key={row.id}
                row={row}
                writable={writable}
                actions={props.harnessActions}
              />
            ))}
            {props.installRows.map((row) => (
              <InstallRow
                key={installKey(row)}
                row={row}
                writable={writable}
                actions={props.harnessActions}
              />
            ))}
            {props.harnessRows.length > 0 && (
              <div
                data-testid="UpdatesPanel.footnote"
                className="px-3 pb-3 text-[11px] text-text-muted leading-[17px]"
              >
                {props.harnessMode === 'auto'
                  ? 'Harness updates install automatically. Running sessions keep their version.'
                  : 'Running sessions keep their version.'}
              </div>
            )}
          </>
        )}
        {empty && (
          <div data-testid="UpdatesPanel.empty" className="px-3 py-3">
            ClaudeUI and its harnesses are up to date.
          </div>
        )}
        {confirm && !rowHostsConfirm && <div className="px-3 pb-3">{confirmBox(false)}</div>}
        {!writable && (
          <div
            data-testid="UpdatesPanel.readOnly"
            className="px-3 pb-3 text-[11px] text-text-muted"
          >
            Read only: updating needs an admin connection.
          </div>
        )}
        {props.errors.map((error) => (
          <div
            key={error}
            data-testid="UpdatesPanel.error"
            className="px-3 pb-3 text-[11px] leading-[17px] text-danger break-words"
          >
            {error}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border text-[11px] min-w-0">
        <Btn tone="link" testid="UpdatesPanel.settings" onClick={props.onSettings}>
          Update settings…
        </Btn>
        {props.version && (
          <span
            data-testid="UpdatesPanel.version"
            className="ml-auto min-w-0 truncate text-text-muted font-mono text-[10.5px]"
          >
            {props.version}
          </span>
        )}
        {props.canRelaunch && writable && (
          <Btn
            tone="link"
            testid="UpdatesPanel.relaunch"
            title="Restart ClaudeUI without updating"
            disabled={restarting}
            onClick={props.onRelaunch}
          >
            <RestartIcon />
            Relaunch
          </Btn>
        )}
      </div>
    </div>
  )
}
