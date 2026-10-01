/**
 * The one-time upgrade sheet (ADR-082 §8; mockup `b51cb3df` A): on the first
 * launch without the bundled engines, offer to install the harnesses this
 * profile used. Main decides what to offer and whether the sheet is pending
 * (`harness:state`'s `upgradePrompt`); this renders it.
 *
 * - Mounted once, at app level (`SessionView`), above the chat.
 * - Only a connection that may write sees it: the desktop always, the web
 *   only with `admin` (`useConnectionHoldsAdmin`). A refusal hides it for this
 *   client without answering.
 * - Rows start unchecked (owner ruling): Install stays disabled until one is
 *   checked, then reads "Install N". No download sizes: the manifests do not
 *   record them, and the install pill shows the bytes as they arrive.
 * - "Not now" and "Install N" answer (it never comes back). Escape only puts
 *   it away for this run; it returns on the next launch.
 */
import { useState } from 'react'
import type { HarnessId } from '../../../../shared/harness-types'
import { useConnectionHoldsAdmin } from '../SettingsDialog/connection-admin'
import { harnessStore, useHarnessStore } from '../SettingsDialog/harness-store'
import {
  HARNESS_LABEL,
  sessionCountLabel,
  upgradeSheetRows,
  type UpgradeSheetRow
} from '../SettingsDialog/harness-view'
import { Button } from '../SettingsDialog/settings-controls'
import { EngineLogo } from '../shared/EngineLogo'
import { useEscapeLayer } from '../shared/use-escape-layer'

export function HarnessUpgradeSheet(): React.JSX.Element | null {
  const state = useHarnessStore()
  const holdsAdmin = useConnectionHoldsAdmin()
  const rows = upgradeSheetRows(state.snapshot)
  if (rows.length === 0 || !holdsAdmin || state.upgradeClosed) return null
  return <Sheet rows={rows} />
}

function Sheet({ rows }: { rows: UpgradeSheetRow[] }): React.JSX.Element {
  const [checked, setChecked] = useState<ReadonlySet<HarnessId>>(() => new Set())
  useEscapeLayer(() => harnessStore.closeUpgradeSheet())
  // A row can leave while the sheet is up (installed from elsewhere): only
  // what is still listed counts.
  const picked = rows.filter((row) => checked.has(row.id)).map((row) => row.id)

  const toggle = (id: HarnessId): void => {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div
      data-testid="HarnessUpgradeSheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="HarnessUpgradeSheet-title"
      className="fixed inset-0 z-[100] flex items-center justify-center px-4"
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative w-[440px] max-w-full bg-bg-primary border border-border rounded-xl shadow-2xl p-5 animate-fade-in">
        <h3 id="HarnessUpgradeSheet-title" className="text-[14px] font-semibold text-text-primary">
          Install the harnesses you use
        </h3>
        <p className="mt-1 text-[12.5px] leading-5 text-text-secondary">
          ClaudeUI no longer ships opencode, pi and Codex. It downloads ClaudeUI&apos;s tested
          copies from their official releases and checks each one against a reviewed digest.
        </p>
        <div className="mt-4 space-y-1">
          {rows.map((row) => (
            <label
              key={row.id}
              data-testid="HarnessUpgradeSheet.row"
              data-id={row.id}
              className="flex items-center gap-3 px-2 h-10 rounded-md hover:bg-bg-hover text-[13px] cursor-default"
            >
              <input
                type="checkbox"
                data-testid="HarnessUpgradeSheet.checkbox"
                data-id={row.id}
                checked={checked.has(row.id)}
                onChange={() => toggle(row.id)}
                className="w-3.5 h-3.5 shrink-0 accent-accent"
              />
              <EngineLogo engineId={row.id} size={14} className="shrink-0" />
              <span className="flex-1 min-w-0 truncate text-text-primary">
                {HARNESS_LABEL[row.id]}{' '}
                <span
                  data-testid="HarnessUpgradeSheet.version"
                  className="text-text-muted tabular-nums"
                >
                  {row.version}
                </span>
              </span>
              <span
                data-testid="HarnessUpgradeSheet.sessions"
                className="shrink-0 text-[11px] text-text-muted tabular-nums"
              >
                {sessionCountLabel(row.sessions)}
              </span>
            </label>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-4 text-text-muted">
          Change versions or use your own installs later in Settings › Harnesses › Installed.
          Skipped ones are offered again when you open a session on them.
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <Button
            testid="HarnessUpgradeSheet.notNow"
            variant="tinted"
            onClick={() => void harnessStore.answerUpgradePrompt([])}
          >
            Not now
          </Button>
          <Button
            testid="HarnessUpgradeSheet.install"
            dataId={String(picked.length)}
            variant="primary"
            disabled={picked.length === 0}
            onClick={() => void harnessStore.answerUpgradePrompt(picked)}
          >
            {picked.length === 0 ? 'Install' : `Install ${picked.length}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
