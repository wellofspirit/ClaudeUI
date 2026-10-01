/**
 * The ONE question asked before a ClaudeUI provider's key replaces a key a
 * harness holds of its own for the same vendor (owner ruling 2026-10-01,
 * ADR-082 §8 "As built (S7f)"): creating a catalog provider in the Add sheet,
 * and "Use ClaudeUI’s <name> here instead" on that harness's own row. Kept in
 * one place so the two never word the same choice differently.
 *
 * Harness ids are named as the rest of the provider surfaces name them —
 * `pi’s own key`, never a display label.
 */

import type { ProviderEntry } from '../../../../shared/provider-registry'
import type { ConfigurableHarnessId } from '../../../../shared/shared-provider'
import type { EngineRuns } from './harness-view'

type Harness = ConfigurableHarnessId

/**
 * The engines whose OWN key for the vendor switching this provider back on
 * would replace (ADR-074 slice 10): a route on in its settings, into an engine
 * that holds a credential of its own. The switch asks first — on the Manage
 * sheet, on the list, and on a harness's own row (`UseClaudeUiInstead`) — and
 * the service checks the keys themselves.
 *
 * A harness that does not run is never named (ADR-082 §8, S7d): nothing is
 * written into it, so switching on replaces nothing there, and when it arrives
 * the delivery keeps a key of its own instead of asking.
 */
export function ownKeysReplacedOnSwitchOn(entry: ProviderEntry, runs: EngineRuns): Harness[] {
  if (!entry.disabled) return []
  return (['opencode', 'pi'] as const).filter(
    (engine) =>
      runs(engine) && entry.engines[engine]?.routeOn && entry.engines[engine]?.ownCredential
  )
}

/**
 * Who holds a key of their OWN for a provider right now (S7f round 3): `id` is
 * a definition's id, or a vendor id with no definition. Read from the
 * harnesses' auth files by the host — never the registry snapshot, which is as
 * old as the screen and whose opencode half comes from a cached catalog. A
 * failed read answers `fallback` (what the screen showed); the service still
 * refuses to replace a key the question did not name.
 */
export async function readOwnKeyHolders(
  id: string,
  fallback: readonly Harness[]
): Promise<Harness[]> {
  try {
    return await window.api.getSharedProviderOwnKeyHolders(id)
  } catch {
    return [...fallback]
  }
}

/**
 * The harnesses switching `entry` on would replace an own key in, as of now:
 * those holding one whose route is on in its settings, among those that run.
 * Nothing to replace when it is on already.
 */
export async function switchOnReplacesNow(
  entry: ProviderEntry,
  runs: EngineRuns
): Promise<Harness[]> {
  if (!entry.disabled) return []
  const holders = await readOwnKeyHolders(entry.id, ownKeysReplacedOnSwitchOn(entry, runs))
  return (['opencode', 'pi'] as const).filter(
    (engine) => holders.includes(engine) && runs(engine) && entry.engines[engine]?.routeOn === true
  )
}

const joinAnd = (engines: readonly Harness[]): string =>
  engines.length > 1 ? `${engines.slice(0, -1).join(', ')} and ${engines.at(-1)}` : engines[0]

/**
 * "pi’s own key for OpenRouter will be replaced by the stored one." — the
 * confirm of an action on a provider that already exists: switching it on,
 * turning a route on, "Use the stored key".
 */
export function ownKeysReplacedText(
  entry: Pick<ProviderEntry, 'name'>,
  engines: readonly string[]
): string {
  const who = engines.map((engine) => `${engine}’s`).join(' and ')
  return `${who} own key${engines.length > 1 ? 's' : ''} for ${entry.name} will be replaced by the stored one.`
}

/** "pi has its own key for OpenRouter" — the note on a harness the Add sheet offers. */
export function ownKeyNote(engine: Harness, name: string): string {
  return `${engine} has its own key for ${name}`
}

/** "pi already has its own OpenRouter key. Overwrite it and manage the key from ClaudeUI?" */
export function ownKeyQuestion(engines: readonly Harness[], name: string): string {
  const many = engines.length > 1
  return `${joinAnd(engines)} already ${many ? 'have their' : 'has its'} own ${name} key${
    many ? 's' : ''
  }. Overwrite ${many ? 'them' : 'it'} and manage the key from ClaudeUI?`
}

/** The yes: the harness's own key is replaced, and ClaudeUI manages that slot from then on. */
export const OVERWRITE_OWN_LABEL = 'Overwrite and manage from ClaudeUI'

/** The no: the harness keeps its own key, and the ClaudeUI provider's route to it is off. */
export function keepOwnLabel(engines: readonly Harness[]): string {
  return engines.length > 1 ? 'Keep their own keys' : `Keep ${engines[0]}’s own key`
}
