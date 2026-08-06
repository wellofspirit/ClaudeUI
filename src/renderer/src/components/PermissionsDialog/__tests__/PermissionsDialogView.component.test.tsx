/**
 * Layer 2: Component tests for the untrusted-workspace banner in
 * PermissionsDialogView.
 *
 * cli.js drops every project/local ALLOW rule while a workspace is untrusted
 * and suppresses its own warning in non-interactive mode, so this banner is the
 * user's ONLY signal that the rules they are editing on those tabs are inert.
 * It must appear exactly when that is true — a banner on the Global tab (whose
 * allows always apply) or on an unprobed workspace would train people to ignore
 * it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PermissionsDialogView, type PermissionsDialogViewProps } from '../View'
import type { ClaudePermissions, PermissionScope } from '../../../../../shared/types'

afterEach(cleanup)

const EMPTY_PERMS: ClaudePermissions = {
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined
}

function renderView(over: Partial<PermissionsDialogViewProps> = {}): void {
  const props: PermissionsDialogViewProps = {
    loading: false,
    saving: false,
    activeTab: 'local' as PermissionScope,
    tabs: ['local', 'project', 'user'],
    perms: EMPTY_PERMS,
    dirty: { local: false, project: false, user: false },
    hasDirty: false,
    workspaceTrusted: false,
    onListDir: vi.fn(async () => ({ entries: [], isRoot: false })),
    onChangeTab: vi.fn(async () => {}),
    onUpdateRule: vi.fn(),
    onDeleteRule: vi.fn(),
    onAddRule: vi.fn(),
    onUpdateDir: vi.fn(),
    onDeleteDir: vi.fn(),
    onAddDir: vi.fn(),
    onSaveAll: vi.fn(async () => {}),
    onClose: vi.fn(),
    ...over
  }
  render(<PermissionsDialogView {...props} />)
}

const banner = (): HTMLElement | null => screen.queryByTestId('PermissionsDialog.trustWarning')

describe('PermissionsDialogView — untrusted-workspace banner', () => {
  it.each(['local', 'project'] as PermissionScope[])(
    'warns on the %s tab when the workspace is untrusted',
    (activeTab) => {
      renderView({ activeTab, workspaceTrusted: false })
      expect(banner()).toBeTruthy()
      expect(banner()!.textContent).toContain('not trusted')
    }
  )

  it('does not warn on the Global tab — user-scope allows survive the trust gate', () => {
    renderView({ activeTab: 'user', workspaceTrusted: false })
    expect(banner()).toBeNull()
  })

  it('does not warn on a trusted workspace', () => {
    renderView({ activeTab: 'local', workspaceTrusted: true })
    expect(banner()).toBeNull()
  })

  it('does not warn while trust is unknown', () => {
    renderView({ activeTab: 'local', workspaceTrusted: null })
    expect(banner()).toBeNull()
  })

  it('says deny/ask still apply and how to fix it', () => {
    renderView({ activeTab: 'project', workspaceTrusted: false })
    const text = banner()!.textContent ?? ''
    expect(text).toContain('Deny and Ask rules still apply')
    expect(text).toContain('claude')
  })
})
