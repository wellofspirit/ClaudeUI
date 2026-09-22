import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageHubState, UsageHubStatus } from '../../../../shared/types'
import { onSyncEvent } from '../../../../core/shared/sync/client-registry'
import { ActionRow, Button, SettingRow, SettingsToggle, TextField } from './settings-controls'
import {
  formatDuration,
  HUB_STATE_SEVERITY,
  SEVERITY_ICON,
  SEVERITY_TEXT_CLASS
} from '../usage/usage-utils'

/**
 * Settings › Remote access › Usage hub — the group body (ADR-072 §7).
 *
 * ## Why this pane talks to its own channels
 *
 * Everything here is stored in the operational database rather than in
 * `settings.json`: the hub's address, this machine's name, and the Cloudflare
 * Access service token it authenticates with. `config:save-settings` is
 * reachable from a remote client, so a credential that round-tripped through
 * `AppSettings` would be remotely readable — which is exactly why
 * `remote_config`'s password lives in SQLite too (ADR-072 §6). So this pane
 * reads and writes the six `usage-hub:*` channels directly and never touches
 * the UISettings store, the shape `RemoteServerSettings` already uses for the
 * remote config.
 *
 * ## Why the status is pushed, not polled
 *
 * The client changes state on its own — a timer fires, a token is revoked, a
 * `426` arrives — and there is no store field to fold that into. The core emits
 * `usage-hub:changed` on every state change (ADR-072 §7), so one subscription
 * re-reads the status and this pane needs no interval of its own.
 *
 * The secret is WRITE-ONLY by design: no query returns it, `hasSecret` is all
 * the UI is told, and the field is never prefilled — so there is nothing to
 * reveal and no reveal button, unlike the vendor API-key fields.
 */

/** Testid namespace (ADR-027). */
const H = 'UsageHubSettings'

/** The state vocabulary in words. The core's seven states, and only those. */
const STATE_WORDS: Record<UsageHubState, string> = {
  off: 'Off',
  idle: 'Idle',
  syncing: 'Syncing',
  // Not "Backoff": the fact a reader needs is that it will try again by itself.
  backoff: 'Retrying',
  'needs-credentials': 'Needs credentials',
  'update-hub': 'Update your hub',
  error: 'Error'
}

/** The four fields `usage-hub:configure` takes, as the form holds them. */
interface Draft {
  url: string
  deviceName: string
  clientId: string
  enabled: boolean
}

function draftOf(status: UsageHubStatus): Draft {
  return {
    url: status.url,
    deviceName: status.deviceName,
    clientId: status.clientId,
    enabled: status.enabled
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.url === b.url &&
    a.deviceName === b.deviceName &&
    a.clientId === b.clientId &&
    a.enabled === b.enabled
  )
}

/**
 * The useful half of a rejected channel call.
 *
 * `ipcRenderer.invoke` wraps a handler's throw as "Error invoking remote method
 * '<channel>': <ClassName>: <message>", and the message is the part the URL
 * sanitiser wrote for the person typing ("the hub must be https, or http on
 * localhost"). Both wrappers are stripped so the row shows the sentence rather
 * than the plumbing.
 */
function channelMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^\w*Error:\s*/, '')
}

/** An instant as how long ago it was, or `—` for one that never happened. */
function ago(ts: number | null, now: number): string {
  if (ts === null) return '—'
  return `${formatDuration(Math.max(0, now - ts))} ago`
}

/** A machine's display name: the one its owner set, else a short id. */
function deviceLabel(deviceName: string, deviceId: string): string {
  return deviceName.trim() === '' ? deviceId.slice(0, 8) : deviceName
}

/** The three facts the machine list shows, for this machine and for a peer alike. */
interface Machine {
  deviceId: string
  deviceName: string
  lastPushAt: number | null
}

/**
 * Every machine to list, this one first.
 *
 * `remote.devices` is the cache of the hub's `GET /v1/devices` and the pull
 * FILTERS this device out of it, so the status alone can never produce a list
 * that includes the machine the reader is looking at. Its row is built from the
 * status's own `deviceId` / `deviceName` / `lastPushAt` instead — a machine
 * list that omits the machine you are on would read as "this one is not
 * syncing". A peer the hub echoes back under our own id is dropped rather than
 * drawn twice.
 *
 * Its own row needs a CONFIGURED hub, not just an id: `forgetHub()` deletes the
 * config row but deliberately leaves `hub.device_id` in `meta` (so a machine
 * re-added to the same hub comes back as the device it was), so keying the row
 * on the id alone left a forgotten card listing itself as a synced machine.
 */
function machinesOf(status: UsageHubStatus): Machine[] {
  const configured = status.enabled || status.url !== ''
  const self: Machine[] =
    status.deviceId === null || !configured
      ? []
      : [
          {
            deviceId: status.deviceId,
            deviceName: status.deviceName,
            lastPushAt: status.lastPushAt
          }
        ]
  const peers = status.remote.devices.filter((device) => device.deviceId !== status.deviceId)
  return [...self, ...peers]
}

export function UsageHubSettings(): React.JSX.Element {
  const [status, setStatus] = useState<UsageHubStatus | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [secret, setSecret] = useState('')
  /** True once the user asked to replace a stored secret, revealing the field. */
  const [replacing, setReplacing] = useState(false)
  /**
   * Three error sinks, not one, because they belong to three different rows.
   *
   * A refused URL has to appear beside the field that caused it, and a failed
   * Sync now has nothing to do with that field — one sink rendered in the URL
   * row would have put "the hub refused the service token" under the address,
   * and the next keystroke (which clears the form's own error) would have
   * silently swallowed it.
   */
  const [configureError, setConfigureError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [secretError, setSecretError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Which of the two destructive actions is armed, if either. */
  const [confirming, setConfirming] = useState<'resync' | 'forget' | null>(null)

  /**
   * Whether the form has unsaved edits, readable from the push subscription.
   *
   * A `usage-hub:changed` can arrive while the user is halfway through typing a
   * URL — the client emits one every time it changes state — and a re-read that
   * replaced the draft would eat the keystrokes. The ref is what lets the
   * subscription see the answer without being re-created on every keystroke.
   */
  const dirtyRef = useRef(false)

  const adopt = useCallback((next: UsageHubStatus, replaceDraft?: boolean): void => {
    setStatus(next)
    if (replaceDraft ?? !dirtyRef.current) {
      dirtyRef.current = false
      setDraft(draftOf(next))
    }
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    adopt(await window.api.usageHubStatus())
  }, [adopt])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(
    () =>
      onSyncEvent('usage-hub:changed', () => {
        void reload()
      }),
    [reload]
  )

  const baseline = status === null ? null : draftOf(status)
  const dirty = draft !== null && baseline !== null && !sameDraft(draft, baseline)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  const edit = useCallback((patch: Partial<Draft>): void => {
    setConfigureError(null)
    setDraft((prev) => (prev === null ? prev : { ...prev, ...patch }))
  }, [])

  /**
   * One wrapper for the five mutating channel calls.
   *
   * Every one of them answers the FRESH status, but only the two that CHANGE
   * the four configured fields may re-seed the form from it (`replaceDraft`):
   * a save the core normalised must show what was stored, and a forget must
   * show the cleared row. Sync now and Resync change no field, so re-seeding
   * from their answer would do nothing but throw away an unsaved edit the user
   * made before pressing them.
   */
  const run = useCallback(
    async (
      call: () => Promise<UsageHubStatus>,
      options: {
        onError: (message: string) => void
        replaceDraft: boolean
        onDone?: () => void
      }
    ): Promise<void> => {
      setBusy(true)
      try {
        adopt(await call(), options.replaceDraft)
        options.onDone?.()
      } catch (error) {
        options.onError(channelMessage(error))
      } finally {
        setBusy(false)
      }
    },
    [adopt]
  )

  const handleSave = useCallback((): void => {
    if (draft === null) return
    setConfigureError(null)
    void run(
      () =>
        window.api.configureUsageHub({
          url: draft.url.trim(),
          deviceName: draft.deviceName.trim(),
          clientId: draft.clientId.trim(),
          enabled: draft.enabled
        }),
      { onError: setConfigureError, replaceDraft: true }
    )
  }, [draft, run])

  const handleSaveSecret = useCallback((): void => {
    setSecretError(null)
    void run(() => window.api.setUsageHubSecret(secret), {
      onError: setSecretError,
      // The secret is not one of the four form fields; a save of it must leave
      // an unsaved URL edit alone.
      replaceDraft: false,
      onDone: () => {
        // Cleared on success, so the typed token does not sit in a DOM node for
        // the rest of the session, and the row goes back to its Stored view.
        setSecret('')
        setReplacing(false)
      }
    })
  }, [run, secret])

  const handleSyncNow = useCallback((): void => {
    setActionError(null)
    void run(() => window.api.syncUsageHubNow(), {
      onError: setActionError,
      replaceDraft: false
    })
  }, [run])

  /**
   * Both destructive actions arm on the first press and run on the second.
   *
   * The arm is sticky — nothing disarms it but the second press or a re-render
   * that unmounts the row — which is the house precedent (`RemoteServerSettings`
   * Clear password, `RemotePasskeySettings`).
   */
  const handleConfirmed = useCallback(
    (which: 'resync' | 'forget'): void => {
      if (confirming !== which) {
        setConfirming(which)
        return
      }
      setConfirming(null)
      setActionError(null)
      void run(
        () => (which === 'resync' ? window.api.resyncUsageHub() : window.api.forgetUsageHub()),
        // Forget clears the URL and the switch, so the form must follow it.
        { onError: setActionError, replaceDraft: which === 'forget' }
      )
    },
    [confirming, run]
  )

  if (status === null || draft === null) {
    return (
      <div data-testid={H} className="divide-y divide-border/55">
        <SettingRow testid={`${H}.loading`} description="Loading…" />
      </div>
    )
  }

  const severity = HUB_STATE_SEVERITY[status.state]
  const machines = machinesOf(status)
  const now = Date.now()
  // `syncing` already has a pass in flight and `off` has nothing armed, so
  // neither has a sync to press — and they are the same two states a resync
  // cannot run in either.
  const passBlocked = busy || status.state === 'syncing' || status.state === 'off'

  return (
    <div data-testid={H} className="divide-y divide-border/55">
      <SettingsToggle
        testid={`${H}.enabled`}
        label="Sync usage to a hub"
        checked={draft.enabled}
        // Like every other control here: a flip while a save is in flight would
        // be dropped when that save's answer re-seeds the form.
        disabled={busy}
        onChange={(value) => edit({ enabled: value })}
        tooltip="Pushes this machine's usage rows to your own hub and pulls the other machines' rows back, so every screen can show the combined figures. Only the metering fields leave this machine — never prompts, paths or session ids."
      />

      <SettingRow
        testid={`${H}.urlRow`}
        label="Hub URL"
        description="Your deployed hub's origin. https, or http on localhost for a local run."
        error={configureError ?? undefined}
        errorTestid={`${H}.urlError`}
      >
        <TextField
          testid={`${H}.url`}
          value={draft.url}
          onChange={(value) => edit({ url: value })}
          placeholder="https://usage-hub.example.com"
        />
      </SettingRow>

      <SettingRow
        testid={`${H}.deviceNameRow`}
        label="Device name"
        description="How this machine is named on the hub and in every machine list. Leave it empty for the hostname."
      >
        {/* No placeholder: `getHubConfig` resolves an empty stored name to the
            hostname before the status leaves core, so the field is never empty
            on arrival and a placeholder could only ever repeat its value. */}
        <TextField
          testid={`${H}.deviceName`}
          value={draft.deviceName}
          onChange={(value) => edit({ deviceName: value })}
          mono={false}
        />
      </SettingRow>

      <SettingRow
        testid={`${H}.clientIdRow`}
        label="Client id"
        description="The Access service token's id. Public by design — the secret has its own field below."
      >
        <TextField
          testid={`${H}.clientId`}
          value={draft.clientId}
          onChange={(value) => edit({ clientId: value })}
          placeholder="0123456789abcdef.access"
        />
      </SettingRow>

      <SettingRow
        testid={`${H}.saveRow`}
        label="Apply"
        description="The switch and the three fields above are written together."
      >
        <Button
          testid={`${H}.save`}
          variant="primary"
          disabled={!dirty || busy}
          onClick={handleSave}
        >
          Save
        </Button>
      </SettingRow>

      <SettingRow
        testid={`${H}.secretRow`}
        label="Client secret"
        description="The Access service token's secret. Kept in the operational database and sent only as a request header; nothing reads it back."
        error={secretError ?? undefined}
        errorTestid={`${H}.secretError`}
        layout="stacked"
      >
        <div className="flex items-center gap-2 w-full min-w-0">
          {status.hasSecret && !replacing ? (
            <>
              <span data-testid={`${H}.secretStored`} className="text-[12px] text-text-secondary">
                Stored
              </span>
              <Button testid={`${H}.secretReplace`} onClick={() => setReplacing(true)}>
                Replace
              </Button>
            </>
          ) : (
            <>
              <TextField
                testid={`${H}.secret`}
                type="password"
                value={secret}
                onChange={setSecret}
                placeholder="Paste the secret"
                className="flex-1 min-w-0"
              />
              <Button
                testid={`${H}.saveSecret`}
                variant="primary"
                // An empty submit CLEARS the stored token (the core reads an
                // empty string as "remove it"), which is not what an empty
                // field means. Forget this device is the route that removes one.
                disabled={secret.trim() === '' || busy}
                onClick={handleSaveSecret}
              >
                Save secret
              </Button>
              {/* A way back. Without it, Replace was a one-way door: the
                  revealed empty field is indistinguishable from "no secret
                  stored", so a user who opened it by accident had no way to see
                  that a token is still there. Only offered when there IS one to
                  go back to. */}
              {status.hasSecret && (
                <Button
                  testid={`${H}.secretCancel`}
                  variant="link"
                  disabled={busy}
                  onClick={() => {
                    setReplacing(false)
                    setSecret('')
                    setSecretError(null)
                  }}
                >
                  Cancel
                </Button>
              )}
            </>
          )}
        </div>
      </SettingRow>

      <SettingRow
        testid={`${H}.statusRow`}
        label="Status"
        description="Pushes follow a turn, debounced to one a minute; pulls run every ten minutes."
        error={status.lastError ?? undefined}
        errorTestid={`${H}.lastError`}
        layout="stacked"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            data-testid={`${H}.status`}
            data-state={status.state}
            data-severity={severity}
            className={`text-[12px] whitespace-nowrap ${SEVERITY_TEXT_CLASS[severity]}`}
          >
            <span aria-hidden="true">{SEVERITY_ICON[severity]}</span> {STATE_WORDS[status.state]}
          </span>
          <span
            data-testid={`${H}.lastPush`}
            className="text-[11px] text-text-muted whitespace-nowrap"
          >
            Last push {ago(status.lastPushAt, now)}
          </span>
          <span
            data-testid={`${H}.lastPull`}
            className="text-[11px] text-text-muted whitespace-nowrap"
          >
            Last pull {ago(status.lastPullAt, now)}
          </span>
          {status.pendingEvents > 0 && (
            <span
              data-testid={`${H}.pending`}
              className="text-[11px] text-text-secondary whitespace-nowrap"
            >
              {status.pendingEvents} events waiting
            </span>
          )}
        </div>
        {/* A failed Sync now / Resync / Forget, under the state it is about —
            not in the URL row, and not in the row's own `error` slot, which
            carries the CORE's last error and must stay readable beside it. */}
        {actionError !== null && (
          <span
            data-testid={`${H}.actionError`}
            className="block text-[12px] leading-4 text-danger mt-1"
          >
            {actionError}
          </span>
        )}
      </SettingRow>

      <SettingRow
        testid={`${H}.devicesRow`}
        label="Machines"
        description="Every machine the hub has heard from, as it reports them."
        layout="stacked"
      >
        <div data-testid={`${H}.devices`} className="flex flex-col gap-1 w-full min-w-0">
          {machines.length === 0 ? (
            // Reached only before this machine has an id of its own — sync has
            // never been enabled here, or it was forgotten (ADR-030: say which,
            // never draw an empty list and leave the reader guessing).
            <span data-testid={`${H}.devices.empty`} className="text-[11px] text-text-muted">
              Machines appear once sync is enabled and the hub has answered.
            </span>
          ) : (
            machines.map((device) => (
              <div
                key={device.deviceId}
                data-testid={`${H}.device`}
                data-id={device.deviceId}
                data-self={device.deviceId === status.deviceId ? 'true' : undefined}
                className="flex flex-wrap items-center gap-x-2 text-[11px] min-w-0"
              >
                <span className="text-text-primary truncate">
                  {deviceLabel(device.deviceName, device.deviceId)}
                </span>
                {device.deviceId === status.deviceId && (
                  <span className="text-text-muted whitespace-nowrap">this machine</span>
                )}
                <span className="text-text-muted whitespace-nowrap">
                  last seen {ago(device.lastPushAt, now)}
                </span>
              </div>
            ))
          )}
        </div>
      </SettingRow>

      {/* The three below are IN-PLACE actions, not rows that open an editor,
          which is what `ActionRow` is otherwise for. It is the row the spec
          named, and it has no prop to suppress its trailing chevron — adding
          one would change the primitive for every caller, so the chevron is
          accepted here rather than a fourth row shape invented for three
          buttons. */}
      <ActionRow
        testid={`${H}.syncNow`}
        label="Sync now"
        description="Push what is waiting and pull the other machines' rows, ignoring the non-essential-traffic setting."
        action={status.state === 'syncing' ? 'Syncing…' : 'Sync now'}
        disabled={passBlocked}
        onAction={handleSyncNow}
      />

      <ActionRow
        testid={`${H}.resync`}
        label="Resync this device"
        description="Repair for a known data fault. The hub deletes this machine's rows from the oldest one still held locally forward, rebuilds what it derived from them and raises its epoch; this machine then sends them all again. Rows older than this machine can re-send are left alone, and an ordinary user should never need it."
        action={confirming === 'resync' ? 'Confirm resync?' : 'Resync'}
        disabled={passBlocked}
        onAction={() => handleConfirmed('resync')}
      />

      <ActionRow
        testid={`${H}.forget`}
        label="Forget this device"
        description="Removes this machine's hub configuration, its service token and its cached copy of the other machines' rows. The hub keeps the rows and the name this machine already sent."
        action={confirming === 'forget' ? 'Confirm forget?' : 'Forget'}
        disabled={busy}
        onAction={() => handleConfirmed('forget')}
      />
    </div>
  )
}
