/**
 * The "Install <version>" link on a Settings row that says a harness is not
 * installed (ADR-082 §8; mockup `b51cb3df` D): the dispatch panes and the
 * opencode, pi and Codex configuration panes. It uses the Installed page's
 * install path (`harnessStore.install`), so its progress shows there and in
 * the composer banner too.
 *
 * Offered only when the harness is `missing` (ClaudeUI's copy is selected and
 * installable here) and this connection may write; otherwise the row keeps
 * its plain sentence. While an install runs it says so; after a failure it
 * gives the reason and Retry.
 */
import type { HarnessId } from '../../../../shared/harness-types'
import { useConnectionHoldsAdmin } from './connection-admin'
import { harnessStore, useHarnessStore } from './harness-store'
import { harnessReadiness, installNeeded, progressText } from './harness-view'
import { SettingRow } from './settings-controls'

/**
 * Whether the row offers an install, so it can drop the dimming a dead row
 * has. `undefined` (a row about no one harness) never does.
 */
export function useHarnessInstallOffered(id: HarnessId | undefined): boolean {
  const state = useHarnessStore()
  const holdsAdmin = useConnectionHoldsAdmin()
  return (
    id !== undefined &&
    holdsAdmin &&
    !state.denied &&
    harnessReadiness(state.snapshot, id) === 'missing'
  )
}

export function HarnessInstallLink({ id }: { id: HarnessId }): React.JSX.Element | null {
  const state = useHarnessStore()
  const offered = useHarnessInstallOffered(id)
  if (!offered || !state.snapshot) return null
  const need = installNeeded(state.snapshot.harnesses[id])
  if (!need) return null
  const mine = state.installs.filter((p) => p.id === id)
  const active = mine.find((p) => p.phase !== 'failed')
  if (active) {
    return (
      <span data-testid="HarnessInstallLink" data-id={id} data-state="installing">
        {' '}
        Installing {active.version} · {progressText(active)}
      </span>
    )
  }
  const failed = mine.find((p) => p.phase === 'failed')
  const request = failed?.version ?? need.request
  return (
    <>
      {failed && (
        <span data-testid="HarnessInstallLink.error" className="text-danger">
          {' '}
          Installing {failed.version} failed: {failed.reason ?? 'unknown error'}.
        </span>
      )}{' '}
      <button
        type="button"
        data-testid="HarnessInstallLink"
        data-id={id}
        data-state={failed ? 'failed' : 'offer'}
        onClick={() => void harnessStore.install(id, request)}
        className="text-accent hover:text-accent-hover transition-colors cursor-default"
      >
        {failed ? 'Retry' : `Install ${need.version ?? 'latest'}`}
      </button>
    </>
  )
}

/**
 * A not-installed row's description: "<Label> is not installed. Install
 * <version> · <why it matters>", the link between the two sentences.
 */
export function NotInstalledLine({ harness, lead, rest }: NotInstalledCopy): React.JSX.Element {
  const offered = useHarnessInstallOffered(harness)
  return (
    <>
      <span className={offered ? 'text-warning' : undefined}>{lead}</span>
      {harness && <HarnessInstallLink id={harness} />}
      {rest && <span>{`${offered ? ' · ' : ' '}${rest}`}</span>}
    </>
  )
}

/** What a not-installed row says: its first sentence, and why the harness matters here. */
export interface NotInstalledCopy {
  /** The harness the row is about; absent for a row about several (no install offered). */
  harness?: HarnessId
  lead: string
  rest?: string
}

/**
 * The description-only row a pane shows when its harness is not installed
 * (ADR-065's one row). Dimmed like any dead row, unless it offers the install.
 */
export function NotInstalledRow({
  testid,
  dataId,
  dimmed = true,
  ...copy
}: NotInstalledCopy & {
  testid?: string
  dataId?: string
  /** Rows that were never dimmed keep that. */
  dimmed?: boolean
}): React.JSX.Element {
  const offered = useHarnessInstallOffered(copy.harness)
  return (
    <SettingRow
      testid={testid}
      dataId={dataId}
      dimmed={dimmed && !offered}
      description={<NotInstalledLine {...copy} />}
    />
  )
}
