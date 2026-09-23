/**
 * Models & providers › Default models › "New sessions start on" (providers-v3
 * slice 9, owner ruling 2026-09-23).
 *
 * One engine-neutral row — the SAME item at the top of every engine segment —
 * choosing whether a new session starts on the model last picked on that engine
 * (today's behaviour, and the default) or on the configured default below it.
 * The store's `seedingModelPicks` is what honours it.
 *
 * `LastPickNote` is the other half: while the last pick wins, each engine's
 * default-model row says so, or a changed default that new sessions ignore
 * would look broken.
 */

import { useSessionStore, type AppSettings, type NewSessionModel } from '../../stores/session-store'
import { Segmented, SettingRow } from './settings-controls'

export const NEW_SESSION_MODEL_TESTID = 'NewSessionModelSetting'

export function NewSessionModelSetting({
  settings,
  update
}: {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  const value: NewSessionModel = settings.newSessionModel ?? 'last-picked'
  return (
    <SettingRow
      testid={NEW_SESSION_MODEL_TESTID}
      dataId="newSessionModel"
      label="New sessions start on"
      description="Per engine. The composer's model picker always changes the session you are in."
    >
      <Segmented
        testid={`${NEW_SESSION_MODEL_TESTID}.choice`}
        value={value}
        options={[
          { value: 'last-picked', label: 'The last model I picked' },
          { value: 'configured-default', label: 'The default below' }
        ]}
        onChange={(next) => update({ newSessionModel: next })}
      />
    </SettingRow>
  )
}

/**
 * " Used until you pick a model in the composer." — appended to a default-model
 * row's description while the last pick wins; nothing otherwise.
 */
export function LastPickNote(): React.JSX.Element | null {
  const lastPickWins = useSessionStore(
    (s) => (s.settings.newSessionModel ?? 'last-picked') === 'last-picked'
  )
  if (!lastPickWins) return null
  return (
    <span data-testid={`${NEW_SESSION_MODEL_TESTID}.lastPickNote`} className="text-text-muted">
      {' '}
      Used until you pick a model in the composer.
    </span>
  )
}
