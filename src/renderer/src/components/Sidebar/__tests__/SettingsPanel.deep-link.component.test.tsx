import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { SettingsScope } from '../../SettingsDialog/settings-sections'

let dialogProps: { initialScope?: SettingsScope; initialSection?: string } | undefined
vi.mock('../../SettingsDialog', () => ({
  SettingsDialog: (props: typeof dialogProps) => {
    dialogProps = props
    return <div data-testid="SettingsDialog" />
  },
  SettingsToggle: () => null
}))
vi.mock('../UsagePanel', () => ({ UsageRing: () => null }))
vi.mock('../../RemoteAccessModal', () => ({ RemoteAccessModal: () => null }))

import { SettingsPanel } from '../SettingsPanel'

describe('SettingsPanel deep links', () => {
  beforeEach(() => {
    dialogProps = undefined
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      platform: 'web',
      getRemoteStatus: vi.fn(),
      onRemoteStatus: vi.fn(() => () => {})
    }
  })
  it('opens the Common shared providers section from an explicit target', async () => {
    render(<SettingsPanel />)
    window.dispatchEvent(
      new CustomEvent('open-settings', {
        detail: { scope: 'common', section: 'shared-providers' }
      })
    )
    await waitFor(() =>
      expect(dialogProps).toMatchObject({
        initialScope: 'common',
        initialSection: 'shared-providers'
      })
    )
  })
  it('infers the owning Claude scope for existing section-only links', async () => {
    render(<SettingsPanel />)
    window.dispatchEvent(new CustomEvent('open-settings', { detail: { section: 'sandbox' } }))
    await waitFor(() =>
      expect(dialogProps).toMatchObject({ initialScope: 'claude', initialSection: 'sandbox' })
    )
  })
})
