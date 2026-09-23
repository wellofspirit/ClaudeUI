/**
 * Settings › Remote access › Usage hub (ADR-072 §7, slice S5b).
 *
 * The rules this file exists to guard:
 *
 *  - the group talks ONLY to the six `usage-hub:*` channels. Nothing here may
 *    reach `saveSettings`, because a remote client can write that surface and
 *    this group holds a service token (ADR-072 §6);
 *  - the secret is write-only. The field is never prefilled from a status, and
 *    the typed value is out of the DOM the moment it is stored;
 *  - the status is PUSHED. A `usage-hub:changed` re-reads it, so the pane needs
 *    no interval and cannot show a stale state after the client moved on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UsageHubSettings } from '../UsageHubSettings'
import type { UsageHubDevice, UsageHubState, UsageHubStatus } from '../../../../../shared/types'

// The pane's one push subscription, captured so a test can fire it. The real
// registry DEFERS a listener while no transport client exists, which would
// swallow the emit in jsdom.
const syncHandlers = new Map<string, (...args: unknown[]) => void>()
vi.mock('../../../../../core/shared/sync/client-registry', () => ({
  onSyncEvent: (channel: string, cb: (...args: unknown[]) => void) => {
    syncHandlers.set(channel, cb)
    return () => syncHandlers.delete(channel)
  }
}))

const THIS_DEVICE = '11111111-1111-4111-8111-111111111111'
const OTHER_DEVICE = '22222222-2222-4222-8222-222222222222'

function makeDevice(overrides: Partial<UsageHubDevice> = {}): UsageHubDevice {
  return {
    deviceId: OTHER_DEVICE,
    deviceName: 'studio',
    os: 'darwin',
    appVersion: '3.3.0',
    lastPushAt: Date.now() - 120_000,
    retired: false,
    ...overrides
  }
}

function makeStatus(overrides: Partial<UsageHubStatus> = {}): UsageHubStatus {
  return {
    enabled: true,
    url: 'https://usage-hub.example.com',
    deviceId: THIS_DEVICE,
    deviceName: 'laptop',
    clientId: '0123456789abcdef.access',
    hasSecret: false,
    state: 'idle',
    lastPushAt: null,
    lastPullAt: null,
    lastError: null,
    pendingEvents: 0,
    remote: { devices: [], epoch: null },
    ...overrides
  }
}

const api = {
  usageHubStatus: vi.fn<() => Promise<UsageHubStatus>>(),
  configureUsageHub: vi.fn<(input: unknown) => Promise<UsageHubStatus>>(),
  setUsageHubSecret: vi.fn<(secret: string) => Promise<UsageHubStatus>>(),
  syncUsageHubNow: vi.fn<() => Promise<UsageHubStatus>>(),
  resyncUsageHub: vi.fn<() => Promise<UsageHubStatus>>(),
  forgetUsageHub: vi.fn<() => Promise<UsageHubStatus>>(),
  // The one channel this group must NEVER use: settings are remotely writable.
  saveSettings: vi.fn()
}

/** Mount and wait for the first status read to land. */
async function mount(status: UsageHubStatus = makeStatus()): Promise<void> {
  api.usageHubStatus.mockResolvedValue(status)
  render(<UsageHubSettings />)
  await screen.findByTestId('UsageHubSettings.status')
}

/** A promise the test resolves by hand, to hold a channel call in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('UsageHubSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncHandlers.clear()
    api.usageHubStatus.mockResolvedValue(makeStatus())
    api.configureUsageHub.mockImplementation(async (input) => {
      const patch = input as Record<string, unknown>
      return makeStatus({
        url: String(patch.url),
        deviceName: String(patch.deviceName),
        clientId: String(patch.clientId),
        enabled: patch.enabled === true
      })
    })
    api.setUsageHubSecret.mockResolvedValue(makeStatus({ hasSecret: true }))
    api.syncUsageHubNow.mockResolvedValue(makeStatus({ state: 'idle', lastPushAt: Date.now() }))
    api.resyncUsageHub.mockResolvedValue(makeStatus())
    // `forgetHub()` deletes the config row but LEAVES `hub.device_id` in `meta`
    // on purpose, so the id survives — which is what makes the machine list's
    // "configured?" gate load-bearing rather than decorative.
    api.forgetUsageHub.mockResolvedValue(
      makeStatus({
        enabled: false,
        url: '',
        clientId: '',
        state: 'off',
        hasSecret: false,
        deviceId: THIS_DEVICE,
        lastPushAt: null,
        remote: { devices: [], epoch: null }
      })
    )
    ;(window as unknown as { api: typeof api }).api = api
  })
  afterEach(cleanup)

  it('reads the status once on mount and renders the state', async () => {
    await mount(makeStatus({ state: 'backoff', lastPushAt: Date.now() - 60_000 }))
    expect(api.usageHubStatus).toHaveBeenCalledTimes(1)
    const chip = screen.getByTestId('UsageHubSettings.status')
    expect(chip).toHaveAttribute('data-state', 'backoff')
    expect(chip).toHaveTextContent('Retrying')
    expect(screen.getByTestId('UsageHubSettings.lastPush')).toHaveTextContent('Last push 1m ago')
    // ADR-030: never read is a dash, not a zero.
    expect(screen.getByTestId('UsageHubSettings.lastPull')).toHaveTextContent('Last pull —')
  })

  it('has a word for each of the seven states', async () => {
    const expected: Array<[UsageHubState, string]> = [
      ['off', 'Off'],
      ['idle', 'Idle'],
      ['syncing', 'Syncing'],
      ['backoff', 'Retrying'],
      ['needs-credentials', 'Needs credentials'],
      ['update-hub', 'Update your hub'],
      ['error', 'Error']
    ]
    for (const [state, words] of expected) {
      await mount(makeStatus({ state }))
      const chip = screen.getByTestId('UsageHubSettings.status')
      expect(chip).toHaveAttribute('data-state', state)
      expect(chip).toHaveTextContent(words)
      cleanup()
    }
  })

  it('shows the pending count and the core-written error, and hides the count at zero', async () => {
    await mount(makeStatus({ state: 'error', pendingEvents: 42, lastError: 'the hub said 500' }))
    expect(screen.getByTestId('UsageHubSettings.pending')).toHaveTextContent('42 events waiting')
    expect(screen.getByTestId('UsageHubSettings.lastError')).toHaveTextContent('the hub said 500')
    cleanup()
    await mount(makeStatus({ pendingEvents: 0 }))
    expect(screen.queryByTestId('UsageHubSettings.pending')).toBeNull()
  })

  it('keeps Save disabled until a field changes, then writes exactly the four fields', async () => {
    await mount()
    expect(screen.getByTestId('UsageHubSettings.save')).toBeDisabled()

    fireEvent.change(screen.getByTestId('UsageHubSettings.url'), {
      target: { value: 'https://hub.example.org' }
    })
    expect(screen.getByTestId('UsageHubSettings.save')).toBeEnabled()

    fireEvent.click(screen.getByTestId('UsageHubSettings.save'))
    await waitFor(() => expect(api.configureUsageHub).toHaveBeenCalledTimes(1))
    const input = api.configureUsageHub.mock.calls[0][0] as Record<string, unknown>
    expect(input).toEqual({
      url: 'https://hub.example.org',
      deviceName: 'laptop',
      clientId: '0123456789abcdef.access',
      enabled: true
    })
    expect(Object.keys(input).sort()).toEqual(['clientId', 'deviceName', 'enabled', 'url'])
    // A save that went through leaves nothing to save.
    await waitFor(() => expect(screen.getByTestId('UsageHubSettings.save')).toBeDisabled())
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('re-disables Save when the field is typed back to the stored value', async () => {
    await mount()
    const url = screen.getByTestId('UsageHubSettings.url')
    fireEvent.change(url, { target: { value: 'https://hub.example.org' } })
    expect(screen.getByTestId('UsageHubSettings.save')).toBeEnabled()
    fireEvent.change(url, { target: { value: 'https://usage-hub.example.com' } })
    expect(screen.getByTestId('UsageHubSettings.save')).toBeDisabled()
  })

  it('locks the whole form, the switch included, while a save is in flight', async () => {
    await mount()
    const pending = deferred<UsageHubStatus>()
    api.configureUsageHub.mockReturnValueOnce(pending.promise)

    fireEvent.change(screen.getByTestId('UsageHubSettings.url'), {
      target: { value: 'https://hub.example.org' }
    })
    fireEvent.click(screen.getByTestId('UsageHubSettings.save'))

    // The switch is a control like any other: a flip accepted here would be
    // thrown away when the save's answer re-seeds the form.
    await waitFor(() => expect(screen.getByTestId('UsageHubSettings.enabled')).toBeDisabled())
    expect(screen.getByTestId('UsageHubSettings.save')).toBeDisabled()
    expect(screen.getByTestId('UsageHubSettings.syncNow.action')).toBeDisabled()

    pending.resolve(makeStatus({ url: 'https://hub.example.org' }))
    await waitFor(() => expect(screen.getByTestId('UsageHubSettings.enabled')).toBeEnabled())
  })

  it('keeps an unsaved edit across Sync now and Resync', async () => {
    await mount()
    fireEvent.change(screen.getByTestId('UsageHubSettings.deviceName'), {
      target: { value: 'workshop' }
    })

    fireEvent.click(screen.getByTestId('UsageHubSettings.syncNow.action'))
    await waitFor(() => expect(api.syncUsageHubNow).toHaveBeenCalledTimes(1))
    // Neither action changes any of the four configured fields, so neither may
    // re-seed the form from its answer.
    expect(screen.getByTestId('UsageHubSettings.deviceName')).toHaveValue('workshop')

    fireEvent.click(screen.getByTestId('UsageHubSettings.resync.action'))
    fireEvent.click(screen.getByTestId('UsageHubSettings.resync.action'))
    await waitFor(() => expect(api.resyncUsageHub).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('UsageHubSettings.deviceName')).toHaveValue('workshop')
    expect(screen.getByTestId('UsageHubSettings.save')).toBeEnabled()
  })

  it('shows a failed action under the status, not under the URL, and a keystroke does not clear it', async () => {
    await mount()
    api.syncUsageHubNow.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'usage-hub:sync-now': Error: the hub refused the service token"
      )
    )
    fireEvent.click(screen.getByTestId('UsageHubSettings.syncNow.action'))

    const error = await screen.findByTestId('UsageHubSettings.actionError')
    expect(error).toHaveTextContent('the hub refused the service token')
    // The URL row said nothing: the address is not what failed.
    expect(screen.queryByTestId('UsageHubSettings.urlError')).toBeNull()

    // Typing clears the FORM's error, and must not swallow this one.
    fireEvent.change(screen.getByTestId('UsageHubSettings.url'), {
      target: { value: 'https://hub.example.org' }
    })
    expect(screen.getByTestId('UsageHubSettings.actionError')).toBeInTheDocument()
  })

  it('surfaces the sanitiser message inline and keeps the typed URL', async () => {
    await mount()
    api.configureUsageHub.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'usage-hub:configure': HubUrlError: the hub must be https, or http on localhost"
      )
    )
    fireEvent.change(screen.getByTestId('UsageHubSettings.url'), {
      target: { value: 'http://hub.example.org' }
    })
    fireEvent.click(screen.getByTestId('UsageHubSettings.save'))
    const error = await screen.findByTestId('UsageHubSettings.urlError')
    // The channel wrapper and the error class are stripped; the sentence is not.
    expect(error).toHaveTextContent('the hub must be https, or http on localhost')
    expect(error.textContent).not.toContain('invoking remote method')
    expect(screen.getByTestId('UsageHubSettings.url')).toHaveValue('http://hub.example.org')
  })

  it('never prefills the secret, and reveals an EMPTY field behind Replace', async () => {
    await mount(makeStatus({ hasSecret: true }))
    expect(screen.queryByTestId('UsageHubSettings.secret')).toBeNull()
    expect(screen.getByTestId('UsageHubSettings.secretStored')).toHaveTextContent('Stored')

    fireEvent.click(screen.getByTestId('UsageHubSettings.secretReplace'))
    const field = screen.getByTestId('UsageHubSettings.secret')
    expect(field).toHaveValue('')
    expect(field).toHaveAttribute('type', 'password')
    // Nothing to reveal, so no reveal button (ADR-072 §6).
    expect(screen.queryByTestId('UsageHubSettings.secretReveal')).toBeNull()
  })

  it('lets Replace be undone, so the revealed field is not a one-way door', async () => {
    await mount(makeStatus({ hasSecret: true }))
    fireEvent.click(screen.getByTestId('UsageHubSettings.secretReplace'))
    fireEvent.change(screen.getByTestId('UsageHubSettings.secret'), { target: { value: 'typed' } })

    fireEvent.click(screen.getByTestId('UsageHubSettings.secretCancel'))
    expect(screen.getByTestId('UsageHubSettings.secretStored')).toHaveTextContent('Stored')
    expect(screen.queryByTestId('UsageHubSettings.secret')).toBeNull()
    expect(api.setUsageHubSecret).not.toHaveBeenCalled()
    // And the typed value is gone, not held for the next reveal.
    fireEvent.click(screen.getByTestId('UsageHubSettings.secretReplace'))
    expect(screen.getByTestId('UsageHubSettings.secret')).toHaveValue('')
  })

  it('offers no Cancel when there is no stored secret to go back to', async () => {
    await mount()
    expect(screen.getByTestId('UsageHubSettings.secret')).toBeInTheDocument()
    expect(screen.queryByTestId('UsageHubSettings.secretCancel')).toBeNull()
  })

  it('stores a typed secret through its own channel and leaves it in no DOM node', async () => {
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    await mount()
    expect(screen.getByTestId('UsageHubSettings.saveSecret')).toBeDisabled()

    fireEvent.change(screen.getByTestId('UsageHubSettings.secret'), { target: { value: token } })
    fireEvent.click(screen.getByTestId('UsageHubSettings.saveSecret'))
    await waitFor(() => expect(api.setUsageHubSecret).toHaveBeenCalledWith(token))
    expect(api.setUsageHubSecret).toHaveBeenCalledTimes(1)

    // `hasSecret` came back true, so the field is gone; re-revealing it shows an
    // empty one, and the token is in no value and no markup.
    const stored = await screen.findByTestId('UsageHubSettings.secretStored')
    expect(stored).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('UsageHubSettings.secretReplace'))
    expect(screen.getByTestId('UsageHubSettings.secret')).toHaveValue('')
    for (const node of document.querySelectorAll('input')) expect(node.value).not.toBe(token)
    expect(document.body.innerHTML).not.toContain(token)
    expect(api.configureUsageHub).not.toHaveBeenCalled()
  })

  it('re-reads the status when the core emits usage-hub:changed', async () => {
    await mount()
    expect(api.usageHubStatus).toHaveBeenCalledTimes(1)
    api.usageHubStatus.mockResolvedValue(makeStatus({ state: 'syncing' }))
    syncHandlers.get('usage-hub:changed')!()
    await waitFor(() =>
      expect(screen.getByTestId('UsageHubSettings.status')).toHaveAttribute('data-state', 'syncing')
    )
    expect(api.usageHubStatus).toHaveBeenCalledTimes(2)
  })

  it('does not overwrite an unsaved edit when a pushed status arrives', async () => {
    await mount()
    fireEvent.change(screen.getByTestId('UsageHubSettings.deviceName'), {
      target: { value: 'workshop' }
    })
    api.usageHubStatus.mockResolvedValue(makeStatus({ state: 'syncing' }))
    syncHandlers.get('usage-hub:changed')!()
    await waitFor(() =>
      expect(screen.getByTestId('UsageHubSettings.status')).toHaveAttribute('data-state', 'syncing')
    )
    expect(screen.getByTestId('UsageHubSettings.deviceName')).toHaveValue('workshop')
  })

  it('has no Sync now to press while syncing or off', async () => {
    await mount(makeStatus({ state: 'syncing' }))
    expect(screen.getByTestId('UsageHubSettings.syncNow.action')).toBeDisabled()
    cleanup()
    await mount(makeStatus({ state: 'off', enabled: false }))
    expect(screen.getByTestId('UsageHubSettings.syncNow.action')).toBeDisabled()
    cleanup()
    await mount(makeStatus({ state: 'idle' }))
    const button = screen.getByTestId('UsageHubSettings.syncNow.action')
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => expect(api.syncUsageHubNow).toHaveBeenCalledTimes(1))
  })

  it('makes Resync a two-press action', async () => {
    await mount()
    const button = screen.getByTestId('UsageHubSettings.resync.action')
    fireEvent.click(button)
    expect(api.resyncUsageHub).not.toHaveBeenCalled()
    expect(screen.getByTestId('UsageHubSettings.resync.action')).toHaveTextContent(
      'Confirm resync?'
    )
    fireEvent.click(screen.getByTestId('UsageHubSettings.resync.action'))
    await waitFor(() => expect(api.resyncUsageHub).toHaveBeenCalledTimes(1))
  })

  it('makes Forget a two-press action', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('UsageHubSettings.forget.action'))
    expect(api.forgetUsageHub).not.toHaveBeenCalled()
    expect(screen.getByTestId('UsageHubSettings.forget.action')).toHaveTextContent(
      'Confirm forget?'
    )
    fireEvent.click(screen.getByTestId('UsageHubSettings.forget.action'))
    await waitFor(() => expect(api.forgetUsageHub).toHaveBeenCalledTimes(1))
    // The answer is adopted, so the group shows the forgotten configuration.
    await waitFor(() => expect(screen.getByTestId('UsageHubSettings.url')).toHaveValue(''))
    expect(screen.getByTestId('UsageHubSettings.status')).toHaveAttribute('data-state', 'off')
    // And it does NOT go on listing itself as a synced machine, even though the
    // device id outlives the configuration.
    expect(screen.getByTestId('UsageHubSettings.devices.empty')).toBeInTheDocument()
    expect(screen.queryByTestId('UsageHubSettings.device')).toBeNull()
  })

  it('lists this machine first and marked, and names an unnamed peer by a short id', async () => {
    // The pull FILTERS this device out of `remote.devices`, so its row can only
    // come from the status's own fields.
    await mount(
      makeStatus({
        lastPushAt: Date.now() - 60_000,
        remote: { epoch: 7, devices: [makeDevice({ deviceId: OTHER_DEVICE, deviceName: '' })] }
      })
    )
    const rows = screen.getAllByTestId('UsageHubSettings.device')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('data-id', THIS_DEVICE)
    expect(rows[0]).toHaveAttribute('data-self', 'true')
    expect(rows[0]).toHaveTextContent('laptop')
    expect(rows[0]).toHaveTextContent('this machine')
    expect(rows[0]).toHaveTextContent('last seen 1m ago')
    expect(rows[1]).not.toHaveAttribute('data-self')
    expect(rows[1]).toHaveTextContent(OTHER_DEVICE.slice(0, 8))
    expect(rows[1]).not.toHaveTextContent('this machine')
    expect(rows[1]).toHaveTextContent('last seen 2m ago')
  })

  it('draws this machine exactly once even if the hub echoes it back', async () => {
    await mount(
      makeStatus({
        remote: { epoch: 7, devices: [makeDevice({ deviceId: THIS_DEVICE, deviceName: 'laptop' })] }
      })
    )
    const rows = screen.getAllByTestId('UsageHubSettings.device')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute('data-self', 'true')
  })

  it('says so rather than showing an empty list on a machine that never synced', async () => {
    await mount(makeStatus({ enabled: false, state: 'off', deviceId: null }))
    expect(screen.getByTestId('UsageHubSettings.devices.empty')).toBeInTheDocument()
    expect(screen.queryByTestId('UsageHubSettings.device')).toBeNull()
    cleanup()
    // An id of its own and nothing heard back from the hub yet: one row, ours.
    await mount(makeStatus())
    expect(screen.getAllByTestId('UsageHubSettings.device')).toHaveLength(1)
    expect(screen.queryByTestId('UsageHubSettings.devices.empty')).toBeNull()
  })
})
