/**
 * The sidebar footer's Updates button and panel (auto-update design §8,
 * mockup tabs A–E): one button for ClaudeUI and the harnesses, in the slot the
 * harness update button had, left of Remote Access. While it shows it takes
 * the footer's `ml-auto` (`SettingsPanel` reads `visible`).
 *
 * A click only opens or closes the panel; every item there has its own choice
 * (its main action, Later, Skip <version>), and nothing installs or restarts
 * without one. The cog menu and the macOS app menu open the same panel through
 * the store (`updatesStore.openPanel`).
 *
 * It also carries every other harness install (ADR-082 §8, S7b): the upgrade
 * sheet's and the composer banner's show here with progress and Cancel, and
 * the button shows a check that fades five seconds after installs finish.
 *
 * It reads two stores: `app-update-store.ts` (ClaudeUI, the panel's state, this
 * client's Later choices) and the shared harness store. Remote devices without
 * `admin` see the panel read only.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useConnectionHoldsAdmin } from '../SettingsDialog/connection-admin'
import {
  harnessStore,
  useHarnessStore,
  type HarnessStoreState
} from '../SettingsDialog/harness-store'
import { installKey, otherInstalls, type InstallPanelRow } from '../SettingsDialog/harness-view'
import { useEscapeLayer } from '../shared/use-escape-layer'
import { updatesStore, useUpdatesStore, type UpdatesState } from './app-update-store'
import {
  appSection,
  footerVersion,
  harnessUpdateRows,
  newestTime,
  otherInstallRows,
  updatesButtonModel,
  type AppSection,
  type HarnessUpdateRow,
  type UpdatesButtonModel
} from './utils'
import {
  UpdatesButtonView,
  UpdatesPanelView,
  type AppRowActions,
  type HarnessRowActions
} from './View'

/** How long the check shows after installs finish. */
export const DONE_VISIBLE_MS = 5000
/** Then it fades out over this long. */
export const DONE_FADE_MS = 400

export interface UpdatesIndicator {
  model: UpdatesButtonModel
  /** The button is on screen: it has a state, or its panel is open. */
  visible: boolean
  /** The check is fading out. */
  fading: boolean
  updates: UpdatesState
  harness: HarnessStoreState
  /** The ClaudeUI row the panel shows (the Rebuild entry included). */
  app: AppSection | null
  harnessRows: HarnessUpdateRow[]
  installRows: InstallPanelRow[]
  writable: boolean
}

/**
 * The button's state, the panel's rows, and the five-second check.
 * `SettingsPanel` calls it once and hands it to the button, because the
 * footer's `ml-auto` moves onto the button while it is visible.
 */
export function useUpdatesIndicator(): UpdatesIndicator {
  const u = useUpdatesStore()
  const h = useHarnessStore()
  const holdsAdmin = useConnectionHoldsAdmin()
  const updates = h.snapshot?.updates

  const dismissed = useMemo(() => new Set(h.dismissedUpdates), [h.dismissedUpdates])
  const harnessRows = harnessUpdateRows({
    updates,
    installs: h.installs,
    dismissed,
    completed: h.completedInstalls,
    started: u.started,
    later: u.later
  })
  const installRows = otherInstallRows(updates, h.installs, h.completedInstalls, harnessRows)
  const buttonApp = appSection(u.view, { later: u.later })
  const app = u.rebuildIntent
    ? appSection(u.view, { later: u.later, rebuildIntent: true })
    : buttonApp

  // The check after installs (S7b). A harness run this client did not already
  // know as finished has just ended with everything installed; the first
  // snapshot sets the baseline, so a run that ended before this client looked
  // is not news.
  const [doneToken, setDoneToken] = useState(0)
  const [donePhase, setDonePhase] = useState<'none' | 'shown' | 'fading'>('none')
  const running = updates?.status.running ?? false
  const runAt = updates?.status.lastRunAt
  const results = updates?.status.results
  const allInstalled =
    results !== undefined && results.length > 0 && results.every((r) => r.status === 'installed')
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

  // An install finished (the upgrade sheet's, or an update from the panel).
  const finished = otherInstalls(updates, h.completedInstalls)
  const finishedCount = finished.length
  const seenFinished = useRef(finishedCount)
  useEffect(() => {
    if (finishedCount > seenFinished.current) setDoneToken((n) => n + 1)
    seenFinished.current = finishedCount
  }, [finishedCount])
  // Once the check has faded and the panel is shut, what finished is not news.
  useEffect(() => {
    if (donePhase === 'none' && !u.open) harnessStore.clearCompletedInstalls()
  }, [donePhase, u.open])

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

  const model = updatesButtonModel({
    app: buttonApp,
    harnessRows,
    installRows,
    harnessMode: updates?.mode,
    harnessRunning: running,
    justFinished: donePhase !== 'none',
    finished
  })
  return {
    model,
    visible: model.state !== 'hidden' || u.open,
    fading: model.state === 'done' && donePhase === 'fading' && !u.open,
    updates: u,
    harness: h,
    app,
    harnessRows,
    installRows,
    writable: holdsAdmin && !u.denied && !h.denied
  }
}

/** Re-render every `ms` while `active` (a build's elapsed time, "checked 2 min ago"). */
function useNow(active: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [active, ms])
  return now
}

export function UpdatesButton({
  indicator
}: {
  indicator: UpdatesIndicator
}): React.JSX.Element | null {
  const { updates: u, harness: h, app, writable } = indicator
  const open = u.open
  const narrow = useIsMobile()
  const ref = useRef<HTMLDivElement | null>(null)
  useEscapeLayer(() => updatesStore.closePanel(), true, open)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        updatesStore.closePanel()
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // The rebuild trees, once the local-build row shows to an admin.
  const wantsTrees = open && app?.kind === 'local' && app.canRebuild && writable && u.trees === null
  useEffect(() => {
    if (wantsTrees) void updatesStore.loadTrees()
  }, [wantsTrees])

  const now = useNow(open, app?.kind === 'building' ? 1000 : 30_000)

  if (!indicator.visible) return null

  const harnessUpdates = h.snapshot?.updates
  const harnessCheckedAt = harnessUpdates?.status.lastCheckedAt
  const appCheckedAt = u.view?.check.lastCheckedAt

  const appActions: AppRowActions = {
    onDownload: () => void updatesStore.download(),
    onRestartUpdate: () => void updatesStore.requestRestart('update'),
    onUpdateAndRestart: () => void updatesStore.updateAndRestart(),
    onRebuild: (treeId) => void updatesStore.rebuild(treeId),
    onCancelRebuild: () => void updatesStore.cancelRebuild(),
    onRelaunchBuilt: () => void updatesStore.requestRestart('rebuild'),
    onLater: (key) => updatesStore.later(key, appCheckedAt),
    onSkip: (version) => void updatesStore.skip(version)
  }
  const harnessActions: HarnessRowActions = {
    onUpdate: (row) => updatesStore.updateHarness(row.id, row.from, row.to),
    onLater: (row) =>
      updatesStore.later(installKey({ id: row.id, version: row.to }), harnessCheckedAt),
    onSkip: (row) => void harnessStore.skipUpdate(row.id, row.to),
    onCancel: (row) => void harnessStore.cancel(row.id, row.to),
    onDismiss: (row) => {
      if (row.dismiss?.kind === 'result') harnessStore.dismissUpdate(row.dismiss.key)
      else harnessStore.dismiss(row.id, row.to)
    },
    onInstallCancel: (row) => void harnessStore.cancel(row.id, row.version),
    onInstallDismiss: (row) => harnessStore.dismiss(row.id, row.version)
  }

  const errors = [u.error, u.loadError, h.updateError, ...Object.values(h.errors)].filter(
    (e): e is string => typeof e === 'string' && e !== ''
  )
  const working =
    indicator.model.state === 'running' ||
    u.busy === 'rebuild' ||
    u.busy === 'download' ||
    u.busy === 'restart'

  return (
    <div ref={ref} data-testid="Updates" className="ml-auto flex">
      <UpdatesButtonView
        model={indicator.model}
        open={open}
        fading={indicator.fading}
        onClick={() => updatesStore.togglePanel()}
      />
      {open && (
        <UpdatesPanelView
          narrow={narrow}
          writable={writable}
          now={now}
          checking={u.busy === 'check' || h.checkPending || u.view?.check.running === true}
          working={working}
          checkedAt={newestTime(appCheckedAt, harnessCheckedAt)}
          app={app}
          trees={u.trees}
          rebuildIntent={u.rebuildIntent}
          busy={u.busy}
          confirm={u.confirm}
          harnessRows={indicator.harnessRows}
          installRows={indicator.installRows}
          harnessMode={harnessUpdates?.mode}
          version={footerVersion(u.view)}
          canRelaunch={u.relaunch?.available === true}
          errors={[...new Set(errors)]}
          onCheck={() => void updatesStore.check()}
          onSettings={() => {
            updatesStore.closePanel()
            window.dispatchEvent(new CustomEvent('open-settings', { detail: { page: 'updates' } }))
          }}
          onRelaunch={() => void updatesStore.requestRestart('relaunch')}
          onConfirm={() => void updatesStore.confirmRestart()}
          onCancelConfirm={() => updatesStore.cancelConfirm()}
          appActions={appActions}
          harnessActions={harnessActions}
        />
      )}
    </div>
  )
}
