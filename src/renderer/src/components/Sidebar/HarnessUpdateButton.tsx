/**
 * The sidebar footer's harness update button (ADR-082 §6; mockup `04c3853c`,
 * tabs B-D). It sits left of Remote Access and takes the footer's `ml-auto`
 * while it shows, so Remote and Settings stay right-aligned.
 *
 * States (`updateButtonState`): a count badge when Ask me has updates, a
 * spinner while an update run installs, a check that fades five seconds after
 * a run that installed everything, amber while a failure is not dismissed,
 * and nothing otherwise. In Ask me mode one click installs every update and
 * opens the panel; any other click opens the panel: each harness, its versions
 * (from → to), progress while it installs and a failure with its reason.
 *
 * It also carries every other harness install (ADR-082 §8, S7b): the upgrade
 * sheet's, the composer banner's, a Settings link's. A spinner while one runs
 * (the tooltip names it and its progress), the same fading check when it
 * finishes, amber on a failure; the panel lists them under the updates with
 * their progress, a Cancel, or the failure's reason with a dismiss. Without
 * this a sheet install ran with no sign outside Settings.
 *
 * It reads the shared harness store (`SettingsDialog/harness-store.ts`), so it
 * and the Installed page show one snapshot. Remote devices see the state read
 * only: Update all, Retry, Check now and Cancel need `admin` (§7).
 */
import { useEffect, useRef, useState } from 'react'
import type { HarnessUpdatesView } from '../../../../shared/harness-types'
import { useConnectionHoldsAdmin } from '../SettingsDialog/connection-admin'
import { ProgressBar } from '../SettingsDialog/HarnessesInstalled'
import {
  harnessStore,
  useHarnessStore,
  type HarnessStoreState
} from '../SettingsDialog/harness-store'
import {
  HARNESS_LABEL,
  installKey,
  installPanelRows,
  openUpdateFailures,
  otherInstalls,
  progressPercent,
  progressText,
  updateButtonState,
  updatePanelRows,
  updateSummary,
  type InstallPanelRow,
  type UpdateButtonState,
  type UpdatePanelRow
} from '../SettingsDialog/harness-view'
import { Button } from '../SettingsDialog/settings-controls'
import { EngineLogo } from '../shared/EngineLogo'
import { useEscapeLayer } from '../shared/use-escape-layer'

/** How long the check shows after a run that installed everything. */
export const DONE_VISIBLE_MS = 5000
/** Then it fades out over this long. */
export const DONE_FADE_MS = 400

export interface HarnessUpdateIndicator {
  state: UpdateButtonState
  /** The button is on screen: it has a state, or its panel is open. */
  visible: boolean
  /** The check is fading out. */
  fading: boolean
  open: boolean
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void
  store: HarnessStoreState
  updates: HarnessUpdatesView | undefined
  writable: boolean
}

/**
 * The button's state, including the five-second check. `SettingsPanel` calls
 * it once and hands it to the button, because the footer's `ml-auto` moves
 * onto the button while it is visible.
 */
export function useHarnessUpdateIndicator(): HarnessUpdateIndicator {
  const store = useHarnessStore()
  const holdsAdmin = useConnectionHoldsAdmin()
  const [open, setOpen] = useState(false)
  const [doneToken, setDoneToken] = useState(0)
  const [donePhase, setDonePhase] = useState<'none' | 'shown' | 'fading'>('none')
  const updates = store.snapshot?.updates
  const running = updates?.status.running ?? false
  const runAt = updates?.status.lastRunAt
  const results = updates?.status.results
  const allInstalled =
    results !== undefined && results.length > 0 && results.every((r) => r.status === 'installed')

  // A run this client did not already know as finished has just ended. The
  // first snapshot sets the baseline: a run that ended before this client
  // looked is not news.
  const settled = useRef<{ known: boolean; runAt?: string }>({ known: false })
  const loaded = updates !== undefined
  useEffect(() => {
    if (!loaded) return
    const seen = settled.current
    if (!seen.known) {
      settled.current = { known: true, runAt: running ? undefined : runAt }
      return
    }
    if (running || runAt === seen.runAt) return
    settled.current = { known: true, runAt }
    if (allInstalled) setDoneToken((n) => n + 1)
  }, [loaded, running, runAt, allInstalled])

  // An install outside the update flow finished (S7b): the same check.
  const installsDone = otherInstalls(updates, store.completedInstalls).length
  const seenDone = useRef(installsDone)
  useEffect(() => {
    if (installsDone > seenDone.current) setDoneToken((n) => n + 1)
    seenDone.current = installsDone
  }, [installsDone])
  // Once the check has faded and the panel is shut, what finished is not news.
  useEffect(() => {
    if (donePhase === 'none' && !open) harnessStore.clearCompletedInstalls()
  }, [donePhase, open])

  useEffect(() => {
    if (doneToken === 0) return
    setDonePhase('shown')
    const fade = setTimeout(() => setDonePhase('fading'), DONE_VISIBLE_MS)
    const hide = setTimeout(() => setDonePhase('none'), DONE_VISIBLE_MS + DONE_FADE_MS)
    return () => {
      clearTimeout(fade)
      clearTimeout(hide)
    }
  }, [doneToken])

  const dismissed = new Set(store.dismissedUpdates)
  const state = updateButtonState({
    updates,
    installs: store.installs,
    pending: store.updatePending,
    dismissed,
    justFinished: donePhase !== 'none'
  })
  return {
    state,
    visible: state !== 'hidden' || open,
    fading: state === 'done' && donePhase === 'fading' && !open,
    open,
    setOpen,
    store,
    updates,
    writable: holdsAdmin && !store.denied
  }
}

// ── Icons (14px, stroke 1.8: the footer's size) ──────────────────────

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
    <svg {...ICON}>
      <path d="M12 4v11m0 0-4-4m4 4 4-4" />
      <path d="M5 20h14" />
    </svg>
  )
}

function CheckIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg {...ICON} width={size} height={size} strokeWidth={2}>
      <path d="M5 12l5 5 9-10" />
    </svg>
  )
}

function WarnIcon(): React.JSX.Element {
  return (
    <svg {...ICON}>
      <path d="M12 3 2 20h20L12 3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r=".6" />
    </svg>
  )
}

function Spinner(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
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

// ── The panel ────────────────────────────────────────────────────────

function PanelRow({ row }: { row: UpdatePanelRow }): React.JSX.Element {
  return (
    <div data-testid="HarnessUpdatePanel.row" data-id={row.id} data-state={row.state}>
      <div className="flex items-center gap-2 min-w-0">
        <EngineLogo engineId={row.id} size={12} className="shrink-0" />
        <span className="shrink-0 text-text-primary">{HARNESS_LABEL[row.id]}</span>
        <span className="min-w-0 truncate font-mono text-[11px] tabular-nums text-text-muted">
          {row.from} → {row.to}
        </span>
        <span className="ml-auto shrink-0 flex items-center text-[11px]">
          {row.state === 'installed' && (
            <span className="text-success" aria-label="Installed">
              <CheckIcon size={12} />
            </span>
          )}
          {row.state === 'waiting' && <span className="text-text-muted">waiting</span>}
          {row.state === 'failed' && row.key && (
            <button
              type="button"
              data-testid="HarnessUpdatePanel.dismiss"
              data-id={row.id}
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => harnessStore.dismissUpdate(row.key!)}
              className="w-5 h-5 inline-flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            >
              <CrossIcon />
            </button>
          )}
        </span>
      </div>
      {row.state === 'installing' && row.progress && (
        <>
          {/* Its own line, so the version pair above is never truncated by it. */}
          <div className="mt-1 text-[11px] text-text-muted tabular-nums">
            {progressText(row.progress)}
          </div>
          <ProgressBar
            testid="HarnessUpdatePanel.progress"
            dataId={row.id}
            percent={progressPercent(row.progress)}
            className="mt-1"
          />
        </>
      )}
      {row.state === 'failed' && (
        <div data-testid="HarnessUpdatePanel.reason" className="mt-1 leading-4 text-danger">
          {row.reason}
        </div>
      )}
    </div>
  )
}

/** An install outside the update flow (S7b): progress and Cancel, done, or the failure. */
function InstallRow({
  row,
  writable
}: {
  row: InstallPanelRow
  writable: boolean
}): React.JSX.Element {
  const key = installKey(row)
  return (
    <div data-testid="HarnessUpdatePanel.install" data-id={key} data-state={row.state}>
      <div className="flex items-center gap-2 min-w-0">
        <EngineLogo engineId={row.id} size={12} className="shrink-0" />
        <span className="shrink-0 text-text-primary">{HARNESS_LABEL[row.id]}</span>
        <span className="min-w-0 truncate font-mono text-[11px] tabular-nums text-text-muted">
          {row.version}
        </span>
        <span className="ml-auto shrink-0 flex items-center text-[11px]">
          {row.state === 'installed' && (
            <span className="text-success" aria-label="Installed">
              <CheckIcon size={12} />
            </span>
          )}
          {row.state === 'installing' && (
            <button
              type="button"
              data-testid="HarnessUpdatePanel.cancel"
              data-id={key}
              aria-label="Cancel install"
              title="Cancel install"
              disabled={!writable}
              onClick={() => void harnessStore.cancel(row.id, row.version)}
              className="w-5 h-5 inline-flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default disabled:opacity-40"
            >
              <CrossIcon />
            </button>
          )}
          {row.state === 'failed' && (
            <button
              type="button"
              data-testid="HarnessUpdatePanel.dismissInstall"
              data-id={key}
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => harnessStore.dismiss(row.id, row.version)}
              className="w-5 h-5 inline-flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            >
              <CrossIcon />
            </button>
          )}
        </span>
      </div>
      {row.state === 'installing' && row.progress && (
        <>
          <div
            data-testid="HarnessUpdatePanel.installProgress"
            className="mt-1 text-[11px] text-text-muted tabular-nums"
          >
            {progressText(row.progress)}
          </div>
          <ProgressBar percent={progressPercent(row.progress)} className="mt-1" />
        </>
      )}
      {row.state === 'failed' && (
        <div data-testid="HarnessUpdatePanel.installReason" className="mt-1 leading-4 text-danger">
          {row.reason}
        </div>
      )}
    </div>
  )
}

function UpdatePanel({ indicator }: { indicator: HarnessUpdateIndicator }): React.JSX.Element {
  const { updates, store, writable } = indicator
  const dismissed = new Set(store.dismissedUpdates)
  const rows = updates ? updatePanelRows(updates, store.installs, dismissed) : []
  const installRows = installPanelRows(updates, store.installs, store.completedInstalls)
  // Installs only (the upgrade sheet's): the panel is about them, not updates.
  const installsOnly = rows.length === 0 && installRows.length > 0
  const running = indicator.state === 'running'
  const failures = updates ? openUpdateFailures(updates, dismissed) : []
  const settledCount = rows.filter((r) => r.state === 'installed' || r.state === 'failed').length
  const canUpdate = !!updates && updates.available.length > 0 && !running
  const retry = canUpdate && failures.length > 0
  const offerUpdate = retry || (canUpdate && updates?.mode === 'ask')

  const openSettings = (): void => {
    indicator.setOpen(false)
    window.dispatchEvent(new CustomEvent('open-settings', { detail: { page: 'harnesses' } }))
  }

  const heading = installsOnly
    ? running
      ? 'Installing harnesses'
      : 'Harness installs'
    : running
      ? 'Updating harnesses'
      : 'Harness updates'

  return (
    <div
      data-testid="HarnessUpdatePanel"
      role="dialog"
      aria-label={heading}
      className="absolute left-3 right-3 bottom-full mb-1.5 z-30 p-3 bg-bg-tertiary border border-border rounded-lg shadow-lg shadow-black/30 text-[12px] leading-4 text-text-secondary cursor-default"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="font-medium text-text-primary">{heading}</span>
        {running && rows.length > 0 && (
          <span className="ml-auto text-[11px] text-text-muted tabular-nums">
            {settledCount} of {rows.length}
          </span>
        )}
      </div>
      {rows.length > 0 || installRows.length > 0 ? (
        <div className="space-y-2.5">
          {rows.map((row) => (
            <PanelRow key={row.id} row={row} />
          ))}
          {installRows.map((row) => (
            <InstallRow key={installKey(row)} row={row} writable={writable} />
          ))}
        </div>
      ) : (
        <div data-testid="HarnessUpdatePanel.empty">
          Every harness ClaudeUI manages is up to date.
        </div>
      )}
      {/* About updates only: a panel of first installs has no running sessions to keep. */}
      {!installsOnly && (
        <div data-testid="HarnessUpdatePanel.note" className="mt-3 text-[11px] text-text-muted">
          {updates?.mode === 'auto'
            ? 'Updates install automatically. Running sessions keep their version; new sessions use the update.'
            : 'Running sessions keep their version. New sessions use the update.'}
        </div>
      )}
      {!writable && (
        <div data-testid="HarnessUpdatePanel.readOnly" className="mt-2 text-[11px] text-text-muted">
          Read only: updating harnesses needs an admin connection.
        </div>
      )}
      {store.updateError && (
        <div data-testid="HarnessUpdatePanel.error" className="mt-2 text-danger">
          {store.updateError}
        </div>
      )}
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {offerUpdate && (
          <Button
            testid="HarnessUpdatePanel.updateAll"
            dataId={retry ? 'retry' : 'update'}
            variant={retry ? 'tinted' : 'primary'}
            disabled={!writable || store.updatePending}
            onClick={() => void harnessStore.updateAll()}
          >
            {retry ? 'Retry' : 'Update all'}
          </Button>
        )}
        <Button
          testid="HarnessUpdatePanel.check"
          variant="link"
          disabled={!writable || store.checkPending || running}
          onClick={() => void harnessStore.checkUpdates()}
        >
          {store.checkPending ? 'Checking…' : 'Check now'}
        </Button>
        <Button testid="HarnessUpdatePanel.settings" variant="link" onClick={openSettings}>
          Harness settings
        </Button>
      </div>
    </div>
  )
}

// ── The button ───────────────────────────────────────────────────────

const TONE: Record<Exclude<UpdateButtonState, 'hidden'>, string> = {
  available: 'text-accent',
  running: 'text-accent',
  done: 'text-success',
  failed: 'text-warning'
}

function buttonTitle(indicator: HarnessUpdateIndicator, shown: UpdateButtonState): string {
  const updates = indicator.updates
  switch (shown) {
    case 'available': {
      const n = updates?.available.length ?? 0
      const what = `${n} harness ${n === 1 ? 'update' : 'updates'} — ${updateSummary(updates?.available ?? [])}`
      return indicator.writable ? `${what} · click to install` : what
    }
    case 'running': {
      if (indicator.store.updatePending || updates?.status.running) return 'Updating harnesses'
      // An install outside a run (S7b): name it and where it is.
      const active = indicator.store.installs.filter((p) => p.phase !== 'failed')
      const first = active[0]
      if (!first) return 'Updating harnesses'
      const more = active.length > 1 ? ` (+${active.length - 1} more)` : ''
      return `Installing ${HARNESS_LABEL[first.id]} ${first.version} · ${progressText(first)}${more}`
    }
    case 'failed': {
      const n = updates
        ? openUpdateFailures(updates, new Set(indicator.store.dismissedUpdates)).length
        : 0
      const m = otherInstalls(updates, indicator.store.installs).filter(
        (p) => p.phase === 'failed'
      ).length
      const parts = [
        n > 0 ? `${n} harness ${n === 1 ? 'update' : 'updates'} failed` : null,
        m > 0 ? `${m} harness ${m === 1 ? 'install' : 'installs'} failed` : null
      ]
      return parts.filter(Boolean).join(', ')
    }
    default: {
      // The check after an install outside the update flow names what landed.
      const installed = otherInstalls(updates, indicator.store.completedInstalls)
      return installed.length > 0
        ? `${installed.map((c) => `${HARNESS_LABEL[c.id]} ${c.version}`).join(', ')} installed`
        : 'Harnesses updated'
    }
  }
}

export function HarnessUpdateButton({
  indicator
}: {
  indicator: HarnessUpdateIndicator
}): React.JSX.Element | null {
  const { open, setOpen } = indicator
  const ref = useRef<HTMLDivElement | null>(null)
  useEscapeLayer(() => setOpen(false), true, open)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, setOpen])

  if (!indicator.visible) return null
  // With the panel open the button stays, showing the check, so the panel
  // never loses its anchor under the pointer.
  const shown: Exclude<UpdateButtonState, 'hidden'> =
    indicator.state === 'hidden' ? 'done' : indicator.state
  const count = indicator.updates?.available.length ?? 0
  const title = buttonTitle(indicator, shown)

  const onClick = (): void => {
    // Ask me: one click installs every update (and shows the progress).
    if (shown === 'available' && indicator.writable && !open) {
      void harnessStore.updateAll()
      setOpen(true)
      return
    }
    setOpen((v) => !v)
  }

  return (
    <div ref={ref} data-testid="HarnessUpdate" className="ml-auto flex">
      <button
        type="button"
        data-testid="HarnessUpdateButton"
        data-state={shown}
        aria-label={title}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onClick}
        className={`relative flex items-center justify-center w-6 h-6 rounded-md hover:bg-bg-hover transition-[opacity,background-color] duration-300 cursor-default ${TONE[shown]} ${
          indicator.fading ? 'opacity-0' : ''
        }`}
      >
        {shown === 'available' && (
          <>
            <DownloadIcon />
            <span
              data-testid="HarnessUpdateButton.badge"
              className="absolute top-px right-0 min-w-3 h-3 px-0.5 rounded-full bg-accent text-bg-secondary text-[8.5px] font-bold leading-3 text-center tabular-nums"
            >
              {count}
            </span>
          </>
        )}
        {shown === 'running' && <Spinner />}
        {shown === 'done' && <CheckIcon />}
        {shown === 'failed' && <WarnIcon />}
      </button>
      {open && <UpdatePanel indicator={indicator} />}
    </div>
  )
}
