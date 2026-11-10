/**
 * Layer 2: Component tests for PermissionsDialog FC.
 *
 * The FC manages permsMap/dirty/loading state, calls
 * loadClaudePermissions(scope, cwd?) on open, and saveClaudePermissions
 * on tab change / close. We mock the View to capture props.
 *
 * Tested flows:
 *   1. Loads all scopes on mount when cwd is set
 *   2. Loads only the user scope when cwd is null
 *   3. onAddRule marks scope dirty
 *   4. onChangeTab saves current scope and switches
 *   5. onSaveAll calls saveClaudePermissions for each dirty scope
 *   6. onClose saves pending dirty scopes before calling onClose
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { PermissionsDialogViewProps } from '../View'
import type {
  ClaudePermissions,
  PermissionScope,
  WorkspaceTrust
} from '../../../../../shared/types'

let viewProps: PermissionsDialogViewProps
vi.mock('../View', () => ({
  PermissionsDialogView: (props: PermissionsDialogViewProps) => {
    viewProps = props
    return null
  }
}))

const CWD = '/d/repo'

function makePerms(overrides: Partial<ClaudePermissions> = {}): ClaudePermissions {
  return {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined,
    ...overrides
  }
}

describe('PermissionsDialog FC', () => {
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn>
  let loadCalls: Array<{ scope: PermissionScope; cwd: string | undefined }>
  let saveCalls: Array<{
    scope: PermissionScope
    perms: ClaudePermissions
    cwd: string | undefined
  }>

  beforeEach(async () => {
    app = await bootTestApp()
    onClose = vi.fn()
    loadCalls = []
    saveCalls = []

    app.bridge.ipcMain.handle(
      'claude:load-permissions',
      async (_e, scope: PermissionScope, cwd?: string) => {
        loadCalls.push({ scope, cwd })
        if (scope === 'user') return makePerms({ allow: ['Bash(git:*)'] })
        if (scope === 'project') return makePerms({ ask: ['WebFetch'] })
        if (scope === 'local') return makePerms({ deny: ['Bash(rm -rf:*)'] })
        return makePerms()
      }
    )

    app.bridge.ipcMain.handle(
      'claude:save-permissions',
      async (_e, scope: PermissionScope, perms: ClaudePermissions, cwd?: string) => {
        saveCalls.push({ scope, perms, cwd })
      }
    )

    // Default: unknown trust (null), so the trust row stays out of the other tests' way.
    app.bridge.ipcMain.handle('claude:workspace-trust' as never, async () => null)
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(props: {
    open: boolean
    cwd: string | null
    initialTab?: PermissionScope
  }): Promise<ReturnType<typeof render>> {
    const { PermissionsDialog } = await import('../PermissionsDialog')
    return render(
      React.createElement(PermissionsDialog, {
        open: props.open,
        cwd: props.cwd,
        initialTab: props.initialTab,
        onClose: onClose as () => void
      })
    )
  }

  it('loads all three scopes on mount when cwd is set', async () => {
    await act(async () => {
      await renderFC({ open: true, cwd: CWD })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Should request user, project, local in parallel
    const scopes = loadCalls.map((c) => c.scope).sort()
    expect(scopes).toEqual(['local', 'project', 'user'])
    expect(viewProps.loading).toBe(false)
    expect(viewProps.tabs).toEqual(['local', 'project', 'user'])
  })

  it('loads only user scope when cwd is null', async () => {
    await act(async () => {
      await renderFC({ open: true, cwd: null })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(loadCalls).toHaveLength(1)
    expect(loadCalls[0].scope).toBe('user')
    expect(viewProps.tabs).toEqual(['user'])
  })

  it('returns to the local tab when cwd arrives after a null-cwd mount (boot order)', async () => {
    // TopBar mounts the dialog from app boot, before the restored session's
    // cwd hydrates. The null-cwd window forces the user tab; once cwd lands
    // the default must come back to local — the old one-way reset left every
    // post-boot open stranded on Global.
    const { PermissionsDialog } = await import('../PermissionsDialog')
    let result!: ReturnType<typeof render>
    await act(async () => {
      result = await renderFC({ open: true, cwd: null })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(viewProps.activeTab).toBe('user')

    await act(async () => {
      result.rerender(
        React.createElement(PermissionsDialog, {
          open: true,
          cwd: CWD,
          onClose: onClose as () => void
        })
      )
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(viewProps.activeTab).toBe('local')
    expect(viewProps.tabs).toEqual(['local', 'project', 'user'])
  })

  it('onAddRule marks active scope as dirty and updates perms', async () => {
    await act(async () => {
      await renderFC({ open: true, cwd: CWD, initialTab: 'user' })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    act(() => {
      viewProps.onAddRule('allow', 'Edit(src/**)')
    })

    expect(viewProps.perms.allow).toContain('Edit(src/**)')
    expect(viewProps.dirty.user).toBe(true)
    expect(viewProps.hasDirty).toBe(true)
  })

  it('onChangeTab saves current dirty scope before switching', async () => {
    await act(async () => {
      await renderFC({ open: true, cwd: CWD, initialTab: 'user' })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Make user scope dirty
    act(() => {
      viewProps.onAddRule('allow', 'NewRule')
    })
    expect(viewProps.dirty.user).toBe(true)

    // Switch to project tab — should trigger save on user
    await act(async () => {
      await viewProps.onChangeTab('project')
    })

    expect(saveCalls).toHaveLength(1)
    expect(saveCalls[0].scope).toBe('user')
    expect(viewProps.activeTab).toBe('project')
    expect(viewProps.dirty.user).toBe(false)
  })

  it('onSaveAll persists every dirty scope', async () => {
    await act(async () => {
      await renderFC({ open: true, cwd: CWD, initialTab: 'user' })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Dirty user and project
    act(() => {
      viewProps.onAddRule('allow', 'UserRule')
    })
    await act(async () => {
      await viewProps.onChangeTab('project')
    })
    // saveScope was triggered by the tab change above — saveCalls contains user
    saveCalls.length = 0
    act(() => {
      viewProps.onAddRule('ask', 'ProjectRule')
    })

    await act(async () => {
      await viewProps.onSaveAll()
    })

    expect(saveCalls.map((c) => c.scope)).toContain('project')
  })

  it('onClose saves dirty scopes before closing', async () => {
    await act(async () => {
      await renderFC({ open: true, cwd: CWD, initialTab: 'user' })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    act(() => {
      viewProps.onAddRule('allow', 'Dirty')
    })

    await act(async () => {
      await viewProps.onClose()
    })

    expect(saveCalls.some((c) => c.scope === 'user')).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('onUpdateRule replaces a rule at the given index and marks dirty', async () => {
    app.bridge.ipcMain.handle('claude:load-permissions', async (_e, scope: PermissionScope) => {
      if (scope === 'user') return makePerms({ allow: ['rule-a', 'rule-b'] })
      return makePerms()
    })

    await act(async () => {
      await renderFC({ open: true, cwd: CWD, initialTab: 'user' })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    act(() => {
      viewProps.onUpdateRule('allow', 0, 'rule-a-new')
    })

    expect(viewProps.perms.allow).toEqual(['rule-a-new', 'rule-b'])
    expect(viewProps.dirty.user).toBe(true)
  })

  it('onDeleteRule removes the rule at the given index', async () => {
    app.bridge.ipcMain.handle('claude:load-permissions', async (_e, scope: PermissionScope) => {
      if (scope === 'user') return makePerms({ allow: ['a', 'b', 'c'] })
      return makePerms()
    })

    await act(async () => {
      await renderFC({ open: true, cwd: CWD, initialTab: 'user' })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    act(() => {
      viewProps.onDeleteRule('allow', 1)
    })

    expect(viewProps.perms.allow).toEqual(['a', 'c'])
    expect(viewProps.dirty.user).toBe(true)
  })

  it('loads empty defaults when loadClaudePermissions rejects', async () => {
    app.bridge.ipcMain.handle('claude:load-permissions', async () => {
      throw new Error('IPC failed')
    })

    await act(async () => {
      await renderFC({ open: true, cwd: CWD, initialTab: 'user' })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(viewProps.loading).toBe(false)
    expect(viewProps.perms.allow).toEqual([])
    expect(viewProps.perms.deny).toEqual([])
  })

  it('forces activeTab=user when cwd transitions from set to null', async () => {
    // Rerender-based test: start with cwd set + initialTab=project, then
    // transition cwd to null and verify the FC resets activeTab to 'user'.
    const { PermissionsDialog } = await import('../PermissionsDialog')
    const render1 = await act(async () =>
      render(
        React.createElement(PermissionsDialog, {
          open: true,
          cwd: CWD,
          initialTab: undefined,
          onClose: onClose as () => void
        })
      )
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Switch to project tab
    await act(async () => {
      await viewProps.onChangeTab('project')
    })
    expect(viewProps.activeTab).toBe('project')

    // Transition cwd → null (only 'user' tab is available)
    await act(async () =>
      render1.rerender(
        React.createElement(PermissionsDialog, {
          open: true,
          cwd: null,
          initialTab: undefined,
          onClose: onClose as () => void
        })
      )
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(viewProps.activeTab).toBe('user')
    expect(viewProps.tabs).toEqual(['user'])
  })

  // Workspace trust gates whether cli.js honors project/local ALLOW rules; the
  // container probes it, and toggles it optimistically (revert on failure).
  describe('workspace trust', () => {
    const ROOT = '/d/repo'
    let setCalls: Array<{ cwd: string; trusted: boolean }>
    let setImpl: (trusted: boolean) => Promise<WorkspaceTrust>

    function stubTrust(result: WorkspaceTrust | null | Error): void {
      app.bridge.ipcMain.handle('claude:workspace-trust' as never, async () => {
        if (result instanceof Error) throw result
        return result
      })
    }

    beforeEach(() => {
      setCalls = []
      setImpl = async (trusted) => ({ root: ROOT, trusted, worktree: false })
      app.bridge.ipcMain.handle(
        'claude:set-workspace-trust' as never,
        async (_e: unknown, cwd: string, trusted: boolean) => {
          setCalls.push({ cwd, trusted })
          return setImpl(trusted)
        }
      )
    })

    async function renderAndSettle(
      cwd: string | null,
      initialTab?: PermissionScope
    ): Promise<void> {
      await act(async () => {
        await renderFC({ open: true, cwd, initialTab })
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
    }

    it('passes the probed trust state to the View', async () => {
      stubTrust({ root: ROOT, trusted: false, worktree: true })
      await renderAndSettle(CWD, 'project')
      expect(viewProps.trust).toEqual({ root: ROOT, trusted: false, worktree: true })
    })

    it('leaves trust null when there is no cwd to probe', async () => {
      stubTrust({ root: ROOT, trusted: false, worktree: false })
      await renderAndSettle(null)
      expect(viewProps.trust).toBeNull()
    })

    it('leaves trust null when the probe returns null or fails — no false alarm', async () => {
      stubTrust(null)
      await renderAndSettle(CWD, 'project')
      expect(viewProps.trust).toBeNull()
      cleanup()
      stubTrust(new Error('IPC failed'))
      await renderAndSettle(CWD, 'project')
      expect(viewProps.trust).toBeNull()
    })

    it('toggle is optimistic, calls the API, and adopts the response', async () => {
      stubTrust({ root: ROOT, trusted: false, worktree: false })
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      setImpl = async (trusted) => {
        await gate
        return { root: ROOT, trusted, worktree: false }
      }
      await renderAndSettle(CWD, 'project')

      let pending!: void
      await act(async () => {
        pending = viewProps.onToggleTrust()
      })
      expect(setCalls).toEqual([{ cwd: CWD, trusted: true }])
      expect(viewProps.trustSaving).toBe(true)
      expect(viewProps.trust?.trusted).toBe(true)

      // A second click while saving is ignored.
      await act(async () => {
        viewProps.onToggleTrust()
      })
      expect(setCalls).toHaveLength(1)

      await act(async () => {
        release()
        await pending
      })
      expect(viewProps.trustSaving).toBe(false)
      expect(viewProps.trust?.trusted).toBe(true)
      expect(viewProps.trustError).toBeNull()
    })

    it('reverts and reports a stripped error when the write fails', async () => {
      stubTrust({ root: ROOT, trusted: true, worktree: false })
      setImpl = async () => {
        throw new Error('the file stayed locked by another Claude Code process')
      }
      await renderAndSettle(CWD, 'project')

      await act(async () => {
        await viewProps.onToggleTrust()
      })
      expect(setCalls).toEqual([{ cwd: CWD, trusted: false }])
      expect(viewProps.trust?.trusted).toBe(true)
      expect(viewProps.trustSaving).toBe(false)
      expect(viewProps.trustError).toContain(
        'the file stayed locked by another Claude Code process'
      )
      expect(viewProps.trustError).not.toContain('Error invoking remote method')
    })

    it('after a failed write, shows what is on disk (the host may have written before the call failed)', async () => {
      let onDisk: WorkspaceTrust = { root: ROOT, trusted: false, worktree: false }
      app.bridge.ipcMain.handle('claude:workspace-trust' as never, async () => onDisk)
      setImpl = async (trusted) => {
        onDisk = { root: ROOT, trusted, worktree: false } // the host wrote...
        throw new Error('connection lost') // ...but the reply never arrived
      }
      await renderAndSettle(CWD, 'project')
      expect(viewProps.trust?.trusted).toBe(false)

      await act(async () => {
        await viewProps.onToggleTrust()
      })
      expect(viewProps.trust?.trusted).toBe(true)
      expect(viewProps.trustError).toContain('connection lost')
      expect(viewProps.trustSaving).toBe(false)
    })

    it('after a failed write and a failed re-probe, falls back to the previous state', async () => {
      stubTrust({ root: ROOT, trusted: false, worktree: false })
      await renderAndSettle(CWD, 'project')
      app.bridge.ipcMain.handle('claude:workspace-trust' as never, async () => {
        throw new Error('probe down')
      })
      setImpl = async () => {
        throw new Error('write down')
      }
      await act(async () => {
        await viewProps.onToggleTrust()
      })
      expect(viewProps.trust?.trusted).toBe(false)
      expect(viewProps.trustError).toContain('write down')
    })

    it('drops a save that lands after the cwd changed', async () => {
      const OTHER = '/d/other'
      app.bridge.ipcMain.handle(
        'claude:workspace-trust' as never,
        async (_e: unknown, cwd: string) => ({
          root: cwd,
          trusted: false,
          worktree: false
        })
      )
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      setImpl = async (trusted) => {
        await gate
        return { root: ROOT, trusted, worktree: false }
      }
      const { PermissionsDialog } = await import('../PermissionsDialog')
      let result!: ReturnType<typeof render>
      await act(async () => {
        result = await renderFC({ open: true, cwd: CWD, initialTab: 'project' })
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      let pending!: void
      await act(async () => {
        pending = viewProps.onToggleTrust()
      })
      expect(viewProps.trust?.trusted).toBe(true)

      await act(async () => {
        result.rerender(
          React.createElement(PermissionsDialog, {
            open: true,
            cwd: OTHER,
            initialTab: 'project',
            onClose: onClose as () => void
          })
        )
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(viewProps.trust).toEqual({ root: OTHER, trusted: false, worktree: false })

      await act(async () => {
        release()
        await pending
      })
      expect(viewProps.trust).toEqual({ root: OTHER, trusted: false, worktree: false })
      expect(viewProps.trustSaving).toBe(false)
    })

    it('does not touch the dialog dirty/save state', async () => {
      stubTrust({ root: ROOT, trusted: false, worktree: false })
      await renderAndSettle(CWD, 'project')
      await act(async () => {
        await viewProps.onToggleTrust()
      })
      expect(viewProps.hasDirty).toBe(false)
      expect(saveCalls).toEqual([])
    })
  })

  it('onListDir prop delegates to listDir IPC', async () => {
    let listDirCalls = 0
    app.bridge.ipcMain.handle('file:list-dir' as any, async (_e, path: string) => {
      listDirCalls++
      return { path, entries: [{ name: 'src', isDirectory: true }], isRoot: false }
    })

    await act(async () => {
      await renderFC({ open: true, cwd: CWD, initialTab: 'user' })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const result = await viewProps.onListDir('/d/repo')
    expect(listDirCalls).toBe(1)
    expect(result.entries).toHaveLength(1)
  })
})
