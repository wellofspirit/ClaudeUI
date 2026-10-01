/**
 * "Use ClaudeUI’s OpenRouter here instead" — on a harness's OWN row (owner
 * ruling 2026-10-01, ADR-082 §8 "As built (S7f)").
 *
 * The observed "duplicate": a ClaudeUI catalog provider for a vendor, switched
 * off (or with its route to this harness off), and the harness's own key for
 * the same vendor listed as a row of its own. That row is where the user looks,
 * so it offers the ClaudeUI provider for this harness — after the one own-key
 * question (`own-key-question.ts`), since its stored key replaces the
 * harness's own. Confirmed, it runs the existing writers: the route on, then
 * the provider switched on with `replaceOwn` naming exactly the harnesses the
 * question named — the service refuses to replace any other's own key.
 * The native row is then claimed by the provider, and the sheet follows it.
 */

import { useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import type { ProviderEntry } from '../../../../shared/provider-registry'
import type {
  ConfigurableHarnessId,
  SharedProviderDefinition
} from '../../../../shared/shared-provider'
import { Button, SettingRow } from './settings-controls'
import { useEngineRuns } from './harness-store'
import {
  OVERWRITE_OWN_LABEL,
  ownKeyQuestion,
  ownKeysReplacedOnSwitchOn,
  readOwnKeyHolders
} from './own-key-question'

/** Testid namespace — rows of the Manage sheet (ADR-027). */
const SHEET = 'ProviderSheet'

/**
 * The ClaudeUI catalog provider that would deliver to `engine`'s `vendorId`
 * slot, while it does not: switched off, or its route to `engine` off. Its
 * native id is the route's `providerId`, else its own id — the adapters' rule.
 */
export function claudeUiCounterpart(
  definitions: readonly SharedProviderDefinition[],
  engine: ConfigurableHarnessId,
  vendorId: string
): SharedProviderDefinition | null {
  return (
    definitions.find(
      (definition) =>
        definition.kind === 'catalog' &&
        (definition.routes[engine].providerId ?? definition.id) === vendorId &&
        (definition.disabled === true || !definition.routes[engine].enabled)
    ) ?? null
  )
}

export function UseClaudeUiInstead({
  entry,
  busy,
  run
}: {
  /** A NATIVE row. */
  entry: ProviderEntry
  busy: boolean
  /** The sheet's write runner: re-reads, and opens `follow` once it is a row. */
  run: (action: () => Promise<void>, follow?: string) => Promise<void>
}): React.JSX.Element | null {
  const runs = useEngineRuns()
  const registry = useSessionStore((s) => s.providerRegistry)
  const [definitions, setDefinitions] = useState<SharedProviderDefinition[]>([])
  /** The harnesses the question names, read from the host when it opens; null while not asking. */
  const [asking, setAsking] = useState<ConfigurableHarnessId[] | null>(null)
  const [checking, setChecking] = useState(false)
  const engine = entry.ownedBy

  useEffect(() => {
    if (!engine) return
    let cancelled = false
    window.api
      .listSharedProviders()
      .then((list) => {
        if (!cancelled) setDefinitions(list)
      })
      .catch(() => {
        if (!cancelled) setDefinitions([])
      })
    return () => {
      cancelled = true
    }
  }, [engine, entry])

  if (!engine || !runs(engine)) return null
  const vendorId = entry.id.slice(entry.id.indexOf(':') + 1)
  const counterpart = claudeUiCounterpart(definitions, engine, vendorId)
  const shared = counterpart && registry?.entries.find((row) => row.id === counterpart.id)
  // Only a provider with a stored key has one to deliver instead.
  if (!counterpart || shared?.credential !== 'api-key') return null

  const name = counterpart.name
  /**
   * Who the question names, as of now (S7f round 3): this harness, and — when
   * the provider is switched on — every other harness whose route is on and
   * that holds an own key, read from the harnesses' files by the host.
   */
  const ask = async (): Promise<void> => {
    setChecking(true)
    const holders = await readOwnKeyHolders(
      counterpart.id,
      counterpart.disabled ? ownKeysReplacedOnSwitchOn(shared, runs) : []
    )
    setChecking(false)
    setAsking([
      engine,
      ...(counterpart.disabled
        ? holders.filter((other) => other !== engine && counterpart.routes[other].enabled)
        : [])
    ])
  }
  const use = async (replaced: ConfigurableHarnessId[]): Promise<void> => {
    if (!counterpart.routes[engine].enabled)
      await window.api.setSharedProviderRoute(counterpart.id, engine, true)
    // Only the harnesses the question named: one whose own key the snapshot
    // did not show is refused by the service rather than replaced.
    if (counterpart.disabled)
      await window.api.setSharedProviderDisabled(counterpart.id, false, replaced)
  }

  return asking ? (
    <SettingRow
      testid={`${SHEET}.useClaudeUiConfirm`}
      dataId={asking.join(',')}
      description={<span className="text-warning">{ownKeyQuestion(asking, name)}</span>}
    >
      <Button
        variant="primary"
        testid={`${SHEET}.useClaudeUiOverwrite`}
        disabled={busy}
        onClick={() => {
          setAsking(null)
          void run(() => use(asking), counterpart.id)
        }}
      >
        {OVERWRITE_OWN_LABEL}
      </Button>
      <Button variant="link" testid={`${SHEET}.useClaudeUiCancel`} onClick={() => setAsking(null)}>
        Cancel
      </Button>
    </SettingRow>
  ) : (
    <SettingRow
      testid={`${SHEET}.useClaudeUi`}
      dataId={counterpart.id}
      label={`ClaudeUI’s ${name} is ${counterpart.disabled ? 'off' : `off for ${engine}`}`}
      description={`This is ${engine}’s own key. ClaudeUI’s ${name} can be used here instead — its stored key replaces this one.`}
    >
      <Button
        variant="link"
        testid={`${SHEET}.useClaudeUiStart`}
        disabled={busy || checking}
        onClick={() => void ask()}
      >
        {`Use ClaudeUI’s ${name} here instead`}
      </Button>
    </SettingRow>
  )
}
