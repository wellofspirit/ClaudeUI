/**
 * Layer 2: Component tests for the workspace-trust row in PermissionsDialogView
 * and PermissionsMobileView (same props, same testids).
 *
 * cli.js drops every project/local ALLOW rule while a workspace is untrusted
 * and suppresses its own warning in non-interactive mode, so this row is the
 * user's ONLY signal (and the only fix) for rules on those tabs being inert.
 * It must be absent on the Global tab (whose allows always apply) and while
 * trust is unknown, or it would train people to ignore it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PermissionsDialogView, type PermissionsDialogViewProps } from '../View'
import { PermissionsMobileView } from '../MobileView'
import type {
  ClaudePermissions,
  PermissionScope,
  WorkspaceTrust
} from '../../../../../shared/types'

afterEach(cleanup)

const EMPTY_PERMS: ClaudePermissions = {
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined
}

const UNTRUSTED: WorkspaceTrust = { root: '/d/repo', trusted: false, worktree: false }
const TRUSTED: WorkspaceTrust = { root: '/d/repo', trusted: true, worktree: false }

describe.each([
  ['desktop', PermissionsDialogView],
  ['mobile', PermissionsMobileView]
])('%s view — workspace trust row', (_name, View) => {
  function renderView(over: Partial<PermissionsDialogViewProps> = {}): PermissionsDialogViewProps {
    const props: PermissionsDialogViewProps = {
      loading: false,
      saving: false,
      activeTab: 'local' as PermissionScope,
      tabs: ['local', 'project', 'user'],
      perms: EMPTY_PERMS,
      dirty: { local: false, project: false, user: false },
      hasDirty: false,
      cwd: '/d/repo',
      trust: UNTRUSTED,
      trustSaving: false,
      trustError: null,
      onToggleTrust: vi.fn(),
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
    render(<View {...props} />)
    return props
  }

  const row = (): HTMLElement | null => screen.queryByTestId('PermissionsDialog.trust')
  const toggle = (): HTMLElement => screen.getByTestId('PermissionsDialog.trustToggle')

  it.each(['local', 'project'] as PermissionScope[])('shows on the %s tab', (activeTab) => {
    renderView({ activeTab })
    expect(row()).toBeTruthy()
  })

  it('is hidden on the Global tab', () => {
    renderView({ activeTab: 'user' })
    expect(row()).toBeNull()
  })

  it('is hidden while trust is unknown (null)', () => {
    renderView({ trust: null })
    expect(row()).toBeNull()
  })

  it('off: warning row with the root chip, an off switch and the consequence copy', () => {
    renderView({ trust: UNTRUSTED })
    expect(row()!.dataset.state).toBe('untrusted')
    expect(row()!.className).toContain('bg-warning/10')
    expect(row()!.className).toContain('border-warning/30')
    expect(screen.getByTestId('PermissionsDialog.trustRoot')).toHaveTextContent('/d/repo')
    expect(toggle()).toHaveAttribute('role', 'switch')
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
    expect(toggle()).toHaveAccessibleName('Trust this workspace')
    const text = row()!.textContent ?? ''
    expect(text).toContain('Trust this workspace')
    expect(text).toContain('Not trusted, so Claude Code ignores every Allow rule')
    expect(text).toContain('from the Project scope, and from Local too if settings.local.json')
    expect(text).toContain('Deny and Ask rules still apply, as do Global allows.')
    expect(text).not.toContain('run claude')
  })

  it('on: neutral row, on switch, applies-rules copy', () => {
    renderView({ trust: TRUSTED })
    expect(row()!.dataset.state).toBe('trusted')
    expect(row()!.className).toContain('bg-bg-secondary/30')
    expect(row()!.className).not.toContain('bg-warning/10')
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
    expect(row()!.textContent).toContain(
      'Claude Code applies Allow rules and added directories from the Project and Local scopes.'
    )
    expect(row()!.textContent).not.toContain('Not trusted')
  })

  it('clicking the switch calls onToggleTrust', () => {
    const props = renderView()
    fireEvent.click(toggle())
    expect(props.onToggleTrust).toHaveBeenCalledTimes(1)
  })

  it('worktree: shows the muted line with the cwd relative to the root', () => {
    renderView({
      trust: { ...TRUSTED, worktree: true },
      cwd: '/d/repo/.claude/worktrees/fix-login'
    })
    expect(screen.getByTestId('PermissionsDialog.trustWorktree')).toHaveTextContent(
      'This session runs in the worktree .claude/worktrees/fix-login. Trust is recorded on the main checkout and covers all of its worktrees.'
    )
  })

  it('worktree: full cwd when outside the root; either separator inside it', () => {
    renderView({ trust: { ...TRUSTED, worktree: true }, cwd: '/elsewhere/wt' })
    expect(screen.getByTestId('PermissionsDialog.trustWorktree')).toHaveTextContent(
      'worktree /elsewhere/wt.'
    )
    cleanup()
    renderView({
      trust: { root: 'C:\\repo', trusted: true, worktree: true },
      cwd: 'C:\\repo\\.claude\\worktrees\\a'
    })
    expect(screen.getByTestId('PermissionsDialog.trustWorktree')).toHaveTextContent(
      'worktree .claude/worktrees/a.'
    )
  })

  it('no worktree line for a plain checkout', () => {
    renderView()
    expect(screen.queryByTestId('PermissionsDialog.trustWorktree')).toBeNull()
  })

  it('saving: switch disabled, Saving label shown, switch reflects the target state', () => {
    renderView({ trust: TRUSTED, trustSaving: true })
    expect(toggle()).toBeDisabled()
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('PermissionsDialog.trustSaving')).toHaveTextContent('Saving')
  })

  it('not saving: no Saving label', () => {
    renderView()
    expect(screen.queryByTestId('PermissionsDialog.trustSaving')).toBeNull()
  })

  it('error: replaces the description in danger colour; switch keeps the reverted state', () => {
    renderView({ trust: UNTRUSTED, trustError: 'the file stayed locked' })
    const err = screen.getByTestId('PermissionsDialog.trustError')
    expect(err).toHaveTextContent('Could not update the Claude Code config: the file stayed locked')
    expect(err.className).toContain('text-danger')
    expect(row()!.textContent).not.toContain('Not trusted, so')
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
  })
})
