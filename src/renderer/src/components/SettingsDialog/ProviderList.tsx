/**
 * ProviderList — Models & providers › PROVIDERS, the one list (ADR-065
 * § "Providers: one list", settings-v2 phase 6b, board `board2-Main.png`).
 *
 * One row per provider IDENTITY, whatever store backs it: the shared vault, the
 * Claude account, opencode's catalog + auth.json, pi's auth.json + models.json.
 * The rows come from `provider-registry:list` (phase 6a) and this component
 * renders them and nothing else — it derives no state, reads no store directly,
 * and every edit happens in the Manage sheet.
 *
 * IT RE-READS AFTER EVERY WRITE. The registry publishes no change event, so a
 * write is only visible once `listProviderRegistry()` is called again; that is
 * also the moment a row can DISAPPEAR (turning a native pi provider off removes
 * it), which is why the sheet is closed here rather than by itself.
 *
 * ANTHROPIC IS NOT MANAGED HERE. Its row's action navigates to Models &
 * providers › Accounts: sign-in, account switching and the endpoint override
 * are already whole surfaces of their own, and a sheet with a link in it would
 * be a detour, not a home.
 *
 * ONE DEGRADED CASE (owner ruling 2, 2026-09-08): the opencode BINARY is
 * missing. A stopped server is not degraded — catalog discovery starts one — so
 * there is no "start a session" note and no retry; there is one dimmed row
 * saying opencode is not installed, and no opencode chips on any row.
 *
 * The group header's "+ Add provider" is declared by the page model
 * (`settings-pages.tsx`) and dispatches the `settings:add-provider` window
 * event; phase 6c adds the listener here along with the Add sheet.
 */

import { useCallback, useEffect, useState } from 'react'
import type { EngineId } from '../../../../shared/types'
import type { ProviderEntry, ProviderRegistrySnapshot } from '../../../../shared/provider-registry'
import type { SharedProviderRouteDiagnosis } from '../../../../shared/shared-provider'
import { Button, SettingRow } from './settings-controls'
import { CredentialChip, EngineChip, ProviderSheet } from './ProviderSheet'
import type { SettingsTarget } from './settings-target'

/** Testid namespace (ADR-027 tier 1/2). */
const LIST = 'ProviderList'

/** Chip order, and the order the ENABLED FOR group reads in. */
const ENGINE_ORDER: readonly EngineId[] = ['claude', 'opencode', 'pi']

/**
 * Why an enabled, credentialed route still surfaces nothing — appended to the
 * row's own line. The wording is `SharedProviders`': each string names the CAUSE
 * first, so it stays legible truncated, and says where the fix is. A bare
 * "0 models" is what made this class of failure opaque.
 */
function diagnosisText(diagnosis: SharedProviderRouteDiagnosis): string {
  switch (diagnosis) {
    case 'provider-disabled':
      return 'Disabled in the engine — turn it back on below.'
    case 'models-restricted':
      return 'Every model is filtered out — adjust the model list below.'
    case 'no-models-discovered':
      return 'The engine reported no models — check it is installed and reachable.'
  }
}

/** The row's one line: what the registry says, plus the diagnosis when there is one. */
function describe(entry: ProviderEntry): string | undefined {
  const parts = [entry.detail, entry.diagnosis ? diagnosisText(entry.diagnosis) : undefined]
  const text = parts.filter((part): part is string => !!part).join(' · ')
  return text || undefined
}

export function ProviderList({
  navigate
}: {
  /** The render context's navigator — the Anthropic row's Manage uses it. */
  navigate?: (target: SettingsTarget) => void
}): React.JSX.Element {
  /** null until the first read resolves — the card shows one loading row. */
  const [snapshot, setSnapshot] = useState<ProviderRegistrySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The provider whose Manage sheet is open. */
  const [openId, setOpenId] = useState<string | null>(null)

  /**
   * Read the registry. Returns the snapshot so a write can close the sheet on an
   * entry that no longer exists, and keeps the previous rows on failure rather
   * than blanking a list the user is looking at.
   */
  const reload = useCallback(async (): Promise<ProviderRegistrySnapshot | null> => {
    try {
      const next = await window.api.listProviderRegistry()
      setSnapshot(next)
      setError(null)
      return next
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSnapshot((current) => current ?? { entries: [], opencodeInstalled: true })
      return null
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /** After a sheet write: re-read, and close the sheet if its provider is gone. */
  const handleWrote = useCallback(async (): Promise<void> => {
    const next = await reload()
    if (next && !next.entries.some((entry) => entry.id === openId)) setOpenId(null)
  }, [reload, openId])

  if (snapshot === null) {
    return (
      <div data-testid={LIST}>
        <SettingRow testid={`${LIST}.loading`} description="Loading providers…" />
      </div>
    )
  }

  const { entries, opencodeInstalled } = snapshot
  const open = entries.find((entry) => entry.id === openId) ?? null

  return (
    <div data-testid={LIST} className="divide-y divide-border/55">
      {error && (
        <SettingRow testid={`${LIST}.error`} label="Could not read the provider list">
          <span className="text-[12px] text-danger truncate">{error}</span>
        </SettingRow>
      )}

      {entries.map((entry) => (
        <SettingRow
          key={entry.id}
          testid={`${LIST}.row`}
          dataId={entry.id}
          label={entry.name}
          labelBadge={
            <CredentialChip credential={entry.credential} testid={`${LIST}.credential`} />
          }
          description={describe(entry)}
        >
          {ENGINE_ORDER.filter(
            (engine) =>
              entry.engines[engine] !== undefined &&
              // The degraded case: with no opencode binary there is no opencode
              // picker for anything to reach, whatever the route says.
              (engine !== 'opencode' || opencodeInstalled)
          ).map((engine) => (
            <EngineChip
              key={engine}
              engine={engine}
              enabled={entry.engines[engine]!.enabled}
              testid={`${LIST}.engine`}
            />
          ))}
          <Button
            variant="link"
            testid={`${LIST}.manage`}
            dataId={entry.id}
            onClick={() =>
              entry.origin === 'anthropic'
                ? navigate?.({ page: 'models', group: 'accounts' })
                : setOpenId(entry.id)
            }
          >
            Manage
          </Button>
        </SettingRow>
      ))}

      {!opencodeInstalled && (
        <SettingRow
          testid={`${LIST}.notInstalled`}
          dimmed
          label="opencode"
          description="opencode is not installed."
        />
      )}

      {open && (
        <ProviderSheet
          entry={open}
          opencodeInstalled={opencodeInstalled}
          navigate={navigate}
          onWrote={handleWrote}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}
