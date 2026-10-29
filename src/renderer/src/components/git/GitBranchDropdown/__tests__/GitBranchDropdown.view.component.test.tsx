/**
 * Layer 2: the branch dropdown as the user sees it - the real View, in the DOM.
 *
 * Part 1 drives the View with props (header states, rows, popups). Part 2 mounts
 * the whole dropdown (FC + View + the IPC bridge) for the flows whose point is the
 * wiring: a click inside a portalled popup must not read as click-outside, a dirty
 * switch goes stash-then-checkout, Enter on a highlighted row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, within, cleanup } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type {
  GitBranchData,
  GitBranchDetail,
  GitStatusData,
  WorktreeInfo
} from '../../../../../../shared/types'
import { GitBranchDropdownView, type GitBranchDropdownViewProps } from '../View'
import { GitBranchDropdown } from '../GitBranchDropdown'
import { buildBranchList } from '../branch-model'

const NOW = 1_700_000_000_000

function detail(name: string, o: Partial<GitBranchDetail> = {}): GitBranchDetail {
  return {
    name,
    kind: 'local',
    commitTime: NOW / 1000 - 4 * 60,
    ahead: 0,
    behind: 0,
    gone: false,
    current: false,
    ...o
  }
}

function branchData(details: GitBranchDetail[], o: Partial<GitBranchData> = {}): GitBranchData {
  return {
    current: details.find((x) => x.current)?.name ?? '',
    local: details.filter((x) => x.kind === 'local').map((x) => x.name),
    remote: details.filter((x) => x.kind === 'remote').map((x) => x.name),
    tracking: {},
    details,
    autostashes: [],
    pullConfig: { rebase: null, ff: null },
    unpublished: 0,
    ...o
  }
}

const noop = (): void => {}

function viewProps(
  branches: GitBranchData,
  o: Partial<GitBranchDropdownViewProps> = {}
): GitBranchDropdownViewProps {
  const search = o.search ?? ''
  return {
    dropdownRef: { current: null },
    inputRef: { current: null },
    current: branches.current,
    detached: false,
    upstream: 'origin/' + branches.current,
    upstreamGone: false,
    hasRemote: true,
    ahead: 0,
    behind: 0,
    unpublished: 0,
    fetchedLabel: null,
    worktree: null,
    autostashCount: 0,
    isSyncing: false,
    syncOp: 'idle',
    search,
    onSearchChange: noop,
    onSearchKeyDown: noop,
    loaded: true,
    list: buildBranchList(branches, search, false),
    highlightKey: null,
    now: NOW,
    uiFontScale: 1,
    onToggleRemote: noop,
    createBase: branches.current,
    baseOptions: branches.local,
    baseMenuOpen: false,
    onToggleBaseMenu: noop,
    onPickBase: noop,
    loading: false,
    error: null,
    successMsg: null,
    onDismissError: noop,
    pullPrompt: null,
    stashPrompt: null,
    onCheckout: noop,
    onCreate: noop,
    onNewBranch: noop,
    onFetch: noop,
    onPull: noop,
    onPush: noop,
    onPublish: noop,
    onRestore: noop,
    onCopyWorktreePath: noop,
    onPullConfirm: async () => {},
    onPullCancel: noop,
    onStashAndSwitch: async () => {},
    onSwitchAnyway: async () => {},
    onStashCancel: noop,
    ...o
  }
}

const tid = (id: string): HTMLElement => screen.getByTestId(`GitBranchDropdown.${id}`)
const maybe = (id: string): HTMLElement | null => screen.queryByTestId(`GitBranchDropdown.${id}`)

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Part 1 — the View
// ---------------------------------------------------------------------------

describe('GitBranchDropdownView', () => {
  const BASE = branchData([
    detail('feat', { current: true, upstream: 'origin/feat', ahead: 2 }),
    detail('main', { upstream: 'origin/main' }),
    detail('old', { upstream: 'origin/old', gone: true }),
    detail('wip')
  ])

  describe('header states', () => {
    it('ahead of the upstream: names it, counts the push, highlights Push and disables Pull', () => {
      render(
        <GitBranchDropdownView
          {...viewProps(BASE, { ahead: 2, fetchedLabel: 'Fetched 2 min ago' })}
        />
      )
      expect(tid('current')).toHaveTextContent('feat')
      expect(tid('upstream')).toHaveTextContent('origin/feat')
      expect(tid('upstream')).toHaveTextContent('2 to push')
      expect(tid('push')).toHaveTextContent('↑2')
      expect(tid('push')).not.toBeDisabled()
      expect(tid('push').className).toContain('text-accent')
      expect(tid('pull')).toBeDisabled()
      expect(tid('fetched')).toHaveTextContent('Fetched 2 min ago')
      expect(maybe('publish')).toBeNull()
    })

    it('behind the upstream: Pull carries the count and is the highlighted one', () => {
      render(<GitBranchDropdownView {...viewProps(BASE, { behind: 4 })} />)
      expect(tid('pull')).toHaveTextContent('↓4')
      expect(tid('pull')).not.toBeDisabled()
      expect(tid('pull').className).toContain('text-accent')
      expect(tid('push')).toBeDisabled()
      expect(tid('upstream')).toHaveTextContent('4 to pull')
    })

    it('without an upstream the push slot becomes Publish, and the old -u prompt is gone', () => {
      const onPublish = vi.fn()
      render(
        <GitBranchDropdownView
          {...viewProps(BASE, { upstream: null, unpublished: 3, onPublish })}
        />
      )
      expect(tid('upstream')).toHaveTextContent('Not on the remote yet · 3 commits')
      expect(maybe('push')).toBeNull()
      fireEvent.click(tid('publish'))
      expect(onPublish).toHaveBeenCalledTimes(1)
      expect(screen.queryByText(/Push with -u/)).toBeNull()
    })

    it('a deleted upstream is said so and can be re-published', () => {
      render(<GitBranchDropdownView {...viewProps(BASE, { upstreamGone: true })} />)
      expect(tid('upstream')).toHaveTextContent('was deleted on the remote')
      expect(maybe('publish')).not.toBeNull()
    })

    it('up to date says so, with both directions disabled', () => {
      render(<GitBranchDropdownView {...viewProps(BASE)} />)
      expect(tid('upstream')).toHaveTextContent('up to date')
      expect(tid('push')).toBeDisabled()
      expect(tid('pull')).toBeDisabled()
      expect(tid('fetch')).not.toBeDisabled()
    })

    it('has no sync group without a remote', () => {
      render(<GitBranchDropdownView {...viewProps(BASE, { hasRemote: false, upstream: null })} />)
      expect(maybe('sync')).toBeNull()
      expect(tid('upstream')).toHaveTextContent('No remote configured')
    })

    it('in a worktree: the tinted context row names it, the parent repo, and copies the path', () => {
      const onCopyWorktreePath = vi.fn()
      render(
        <GitBranchDropdownView
          {...viewProps(BASE, {
            worktree: { name: 'fix-hooks', parentRepo: 'ClaudeUI', path: '/wt/fix-hooks' },
            onCopyWorktreePath
          })}
        />
      )
      expect(tid('worktree')).toHaveTextContent('fix-hooks')
      expect(tid('worktree')).toHaveTextContent('parent repo')
      expect(tid('worktree')).toHaveTextContent('ClaudeUI')
      fireEvent.click(tid('copyPath'))
      expect(onCopyWorktreePath).toHaveBeenCalledTimes(1)
    })

    it('outside a worktree there is no context row', () => {
      render(<GitBranchDropdownView {...viewProps(BASE)} />)
      expect(maybe('worktree')).toBeNull()
    })

    it('offers Restore when a ClaudeUI autostash of this branch exists', () => {
      const onRestore = vi.fn()
      render(<GitBranchDropdownView {...viewProps(BASE, { autostashCount: 1, onRestore })} />)
      expect(tid('stashRow')).toHaveTextContent('1 stash from this branch')
      fireEvent.click(tid('restore'))
      expect(onRestore).toHaveBeenCalledTimes(1)
    })

    it('has no Restore row without one', () => {
      render(<GitBranchDropdownView {...viewProps(BASE)} />)
      expect(maybe('stashRow')).toBeNull()
    })
  })

  describe('rows', () => {
    it('shows age, ahead/behind, gone and local only; the current row is checked', () => {
      render(<GitBranchDropdownView {...viewProps(BASE)} />)
      const rows = screen.getAllByTestId('GitBranchDropdown.branchRow')
      expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['feat', 'main', 'old', 'wip'])
      const feat = rows[0]
      expect(feat).toHaveAttribute('data-current', 'true')
      expect(feat).toHaveTextContent('✓')
      expect(feat).toHaveTextContent('↑2')
      expect(feat).toHaveTextContent('4m')
      expect(rows[2]).toHaveTextContent('gone')
      expect(rows[3]).toHaveTextContent('local only')
    })

    it('a branch held by another worktree is a chip, not a button, with a tooltip naming it', () => {
      const onCheckout = vi.fn()
      const b = branchData([
        detail('feat', { current: true, upstream: 'origin/feat' }),
        detail('pre-release', {
          upstream: 'origin/pre-release',
          worktree: { path: '/repo', main: true }
        }),
        detail('other', { worktree: { path: '/repo/.claude/worktrees/parity', main: false } })
      ])
      render(<GitBranchDropdownView {...viewProps(b, { onCheckout })} />)
      const rows = screen.getAllByTestId('GitBranchDropdown.branchRow')
      const parent = rows.find((r) => r.getAttribute('data-id') === 'pre-release')!
      const other = rows.find((r) => r.getAttribute('data-id') === 'other')!

      expect(within(parent).getByTestId('GitBranchDropdown.inUse')).toHaveTextContent('⑂ parent')
      expect(within(other).getByTestId('GitBranchDropdown.inUse')).toHaveTextContent('⑂ in use')
      expect(other.getAttribute('title')).toContain('‘parity’')
      for (const row of [parent, other]) {
        expect(row.tagName).not.toBe('BUTTON')
        fireEvent.click(row)
      }
      expect(onCheckout).not.toHaveBeenCalled()
    })

    it('hides remote branches that have a local twin; the rest sit in a collapsed group', () => {
      const onToggleRemote = vi.fn()
      const b = branchData([
        detail('main', { current: true, upstream: 'origin/main' }),
        detail('origin/main', { kind: 'remote' }),
        detail('origin/docs/x', { kind: 'remote' }),
        detail('origin/docs/y', { kind: 'remote' })
      ])
      const { rerender } = render(<GitBranchDropdownView {...viewProps(b, { onToggleRemote })} />)
      expect(tid('remoteToggle')).toHaveTextContent('Remote only')
      expect(tid('remoteToggle')).toHaveTextContent('(2)')
      expect(screen.queryAllByTestId('GitBranchDropdown.remoteRow')).toHaveLength(0)

      fireEvent.click(tid('remoteToggle'))
      expect(onToggleRemote).toHaveBeenCalledTimes(1)

      // Searching looks inside the group even though it was never opened.
      rerender(<GitBranchDropdownView {...viewProps(b, { search: 'docs' })} />)
      const remote = screen.getAllByTestId('GitBranchDropdown.remoteRow')
      expect(remote.map((r) => r.getAttribute('data-id'))).toEqual([
        'origin/docs/x',
        'origin/docs/y'
      ])
    })

    it('clicking a row switches to it', () => {
      const onCheckout = vi.fn()
      render(<GitBranchDropdownView {...viewProps(BASE, { onCheckout })} />)
      fireEvent.click(screen.getAllByTestId('GitBranchDropdown.branchRow')[1])
      expect(onCheckout).toHaveBeenCalledWith('main')
    })
  })

  describe('search doubles as create', () => {
    it('first row is Create <text> from the current branch; the base list swaps it', () => {
      const onCreate = vi.fn()
      const onToggleBaseMenu = vi.fn()
      const onPickBase = vi.fn()
      const { rerender } = render(
        <GitBranchDropdownView
          {...viewProps(BASE, {
            search: 'git-dropdown',
            highlightKey: 'create',
            onCreate,
            onToggleBaseMenu,
            onPickBase
          })}
        />
      )
      expect(tid('createRow')).toHaveTextContent('Create git-dropdown')
      expect(tid('createBase')).toHaveTextContent('feat ▾')
      fireEvent.click(tid('createRow'))
      expect(onCreate).toHaveBeenCalledTimes(1)
      fireEvent.click(tid('createBase'))
      expect(onToggleBaseMenu).toHaveBeenCalledTimes(1)
      expect(maybe('baseMenu')).toBeNull()

      rerender(
        <GitBranchDropdownView
          {...viewProps(BASE, {
            search: 'git-dropdown',
            baseMenuOpen: true,
            onPickBase
          })}
        />
      )
      const options = screen.getAllByTestId('GitBranchDropdown.baseOption')
      expect(options.map((o) => o.getAttribute('data-id'))).toEqual(['feat', 'main', 'old', 'wip'])
      fireEvent.click(options[1])
      expect(onPickBase).toHaveBeenCalledWith('main')
    })

    it('an exact match offers no Create row; the footer is "+ New branch from <current>"', () => {
      const onNewBranch = vi.fn()
      render(<GitBranchDropdownView {...viewProps(BASE, { search: 'main', onNewBranch })} />)
      expect(maybe('createRow')).toBeNull()

      cleanup()
      render(<GitBranchDropdownView {...viewProps(BASE, { onNewBranch })} />)
      expect(tid('newBranch')).toHaveTextContent('+ New branch')
      expect(screen.getByText('from feat')).toBeInTheDocument()
      fireEvent.click(tid('newBranch'))
      expect(onNewBranch).toHaveBeenCalledTimes(1)
    })
  })

  describe('errors', () => {
    it("shows a title and git's whole multi-line message, and dismisses", () => {
      const onDismissError = vi.fn()
      const message = 'error: Your local changes would be overwritten\nPlease commit or stash them.'
      render(
        <GitBranchDropdownView
          {...viewProps(BASE, {
            error: { title: "Couldn't switch to wip", message },
            onDismissError
          })}
        />
      )
      expect(tid('error')).toHaveTextContent("Couldn't switch to wip")
      expect(tid('error').textContent).toContain('Please commit or stash them.')
      expect(tid('error').innerHTML).not.toContain('truncate')
      fireEvent.click(tid('errorDismiss'))
      expect(onDismissError).toHaveBeenCalledTimes(1)
    })
  })

  describe('popups', () => {
    const pullText = (choice: 'rebase' | 'merge' | 'ff-only' | 'ask'): HTMLElement => {
      render(
        <GitBranchDropdownView
          {...viewProps(BASE, { pullPrompt: { ahead: 3, behind: 2, choice } })}
        />
      )
      return screen.getByTestId('GitBranchDropdown.pullConfirm')
    }

    it('pull.rebase: one Rebase button and the rebase sentence', async () => {
      const onPullConfirm = vi.fn(async () => {})
      render(
        <GitBranchDropdownView
          {...viewProps(BASE, {
            pullPrompt: { ahead: 3, behind: 2, choice: 'rebase' },
            onPullConfirm
          })}
        />
      )
      const modal = screen.getByTestId('GitBranchDropdown.pullConfirm')
      expect(modal).toHaveTextContent('Rebase your 3 local commits onto 2 incoming')
      expect(within(modal).getByTestId('GitBranchDropdown.pullConfirm.confirm')).toHaveTextContent(
        'Rebase'
      )
      expect(within(modal).queryByTestId('GitBranchDropdown.pullConfirm.secondary')).toBeNull()
      await act(async () => {
        fireEvent.click(within(modal).getByTestId('GitBranchDropdown.pullConfirm.confirm'))
      })
      expect(onPullConfirm).toHaveBeenCalledWith('rebase')
    })

    it('pull.rebase=false: merge sentence, merge commit', () => {
      const modal = pullText('merge')
      expect(modal).toHaveTextContent('Merge 2 incoming commits (creates a merge commit)')
      expect(within(modal).getByTestId('GitBranchDropdown.pullConfirm.confirm')).toHaveTextContent(
        'Merge'
      )
    })

    it('pull.ff=only: explains the failure and offers Merge and Rebase', () => {
      const modal = pullText('ff-only')
      expect(modal).toHaveTextContent('pull.ff')
      expect(modal).toHaveTextContent('would fail')
      expect(within(modal).getByTestId('GitBranchDropdown.pullConfirm.confirm')).toHaveTextContent(
        'Merge'
      )
      expect(
        within(modal).getByTestId('GitBranchDropdown.pullConfirm.secondary')
      ).toHaveTextContent('Rebase')
    })

    it.each([
      ['confirm', 'merge'],
      ['secondary', 'rebase']
    ])('unset: the %s button passes %s', async (button, mode) => {
      const onPullConfirm = vi.fn(async () => {})
      render(
        <GitBranchDropdownView
          {...viewProps(BASE, {
            pullPrompt: { ahead: 1, behind: 1, choice: 'ask' },
            onPullConfirm
          })}
        />
      )
      await act(async () => {
        fireEvent.click(screen.getByTestId(`GitBranchDropdown.pullConfirm.${button}`))
      })
      expect(onPullConfirm.mock.calls).toEqual([[mode]])
    })

    describe('the dirty-switch popup', () => {
      const mocks = {
        onStashAndSwitch: vi.fn(async () => {}),
        onSwitchAnyway: vi.fn(async () => {}),
        onStashCancel: vi.fn()
      }
      const open = (): HTMLElement => {
        vi.clearAllMocks()
        render(
          <GitBranchDropdownView
            {...viewProps(BASE, { stashPrompt: { branch: 'main', files: 1 }, ...mocks })}
          />
        )
        return screen.getByTestId('GitBranchDropdown.stashConfirm')
      }

      it('counts the files and offers the three choices', () => {
        const modal = open()
        expect(modal).toHaveTextContent('1 uncommitted file')
        expect(within(modal).getByText('Stash and switch')).toBeInTheDocument()
        expect(within(modal).getByText('Switch and bring them along')).toBeInTheDocument()
        expect(within(modal).getByText('Cancel')).toBeInTheDocument()
      })

      it('Stash and switch', async () => {
        const modal = open()
        await act(async () => {
          fireEvent.click(within(modal).getByText('Stash and switch'))
        })
        expect(mocks.onStashAndSwitch).toHaveBeenCalledTimes(1)
        expect(mocks.onSwitchAnyway).not.toHaveBeenCalled()
      })

      it('Switch and bring them along', async () => {
        const modal = open()
        await act(async () => {
          fireEvent.click(within(modal).getByText('Switch and bring them along'))
        })
        expect(mocks.onSwitchAnyway).toHaveBeenCalledTimes(1)
        expect(mocks.onStashAndSwitch).not.toHaveBeenCalled()
      })

      it('Cancel', () => {
        const modal = open()
        fireEvent.click(within(modal).getByTestId('GitBranchDropdown.stashConfirm.cancel'))
        expect(mocks.onStashCancel).toHaveBeenCalledTimes(1)
      })
    })

    it("renders outside the dropdown (a portal), which the top bar's containment would otherwise clip", () => {
      render(
        <GitBranchDropdownView
          {...viewProps(BASE, { stashPrompt: { branch: 'main', files: 2 } })}
        />
      )
      expect(tid('stashConfirm').parentElement).toBe(document.body)
      expect(tid('stashConfirm').closest('[data-testid="GitBranchDropdown"]')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// Part 2 — the whole dropdown over the IPC bridge
// ---------------------------------------------------------------------------

describe('GitBranchDropdown wired to the bridge', () => {
  const ROUTE = 'route-branch-dom'
  const CWD = '/repo/dom'
  let app: TestApp
  let onClose: ReturnType<typeof vi.fn<() => void>>
  let calls: { channel: string; args: unknown[] }[]
  let status: GitStatusData
  let branches: GitBranchData

  const mkStatus = (o: Partial<GitStatusData> = {}): GitStatusData => ({
    branch: 'feat',
    ahead: 0,
    behind: 0,
    trackingBranch: '',
    files: [],
    staged: [],
    unstaged: [],
    untracked: [],
    linesAdded: 0,
    linesRemoved: 0,
    ...o
  })

  const called = (channel: string): unknown[][] =>
    calls.filter((c) => c.channel === channel).map((c) => c.args)

  beforeEach(async () => {
    calls = []
    onClose = vi.fn()
    status = mkStatus()
    branches = branchData([
      detail('feat', { current: true }),
      detail('origin/feat', { kind: 'remote' }),
      detail('main', { upstream: 'origin/main' }),
      detail('busy', { worktree: { path: '/wt/busy', main: false } })
    ])
    app = await bootTestApp()
    const handle = (channel: string, data: () => unknown): void => {
      app.bridge.ipcMain.handle(channel, (_e, ...args: unknown[]) => {
        calls.push({ channel, args })
        return { ok: true, data: data() }
      })
    }
    handle('git:branches', () => branches)
    handle('git:status', () => status)
    handle('git:fetch', () => undefined)
    handle('git:checkout', () => undefined)
    handle('git:stash-push', () => undefined)
    handle('git:pull', () => ({ summary: '1 changes' }))
    handle('git:create-branch', () => undefined)
    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().setGitStatus(ROUTE, status)
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  async function mount(): Promise<void> {
    await act(async () => {
      render(<GitBranchDropdown onClose={onClose} anchorRef={{ current: null }} />)
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  const click = async (el: HTMLElement): Promise<void> => {
    await act(async () => {
      fireEvent.click(el)
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  it('a dirty switch: Stash and switch stashes then checks out, and clicking in the popup does not close the dropdown', async () => {
    status = mkStatus({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] as GitStatusData['files'] })
    useSessionStore.getState().setGitStatus(ROUTE, status)
    await mount()

    await click(
      screen
        .getAllByTestId('GitBranchDropdown.branchRow')
        .find((r) => r.getAttribute('data-id') === 'main')!
    )
    const modal = screen.getByTestId('GitBranchDropdown.stashConfirm')
    expect(modal).toHaveTextContent('2 uncommitted files')

    // A mousedown inside the popup is not "outside" the dropdown.
    fireEvent.mouseDown(modal)
    expect(onClose).not.toHaveBeenCalled()
    expect(called('git:checkout')).toHaveLength(0)

    await click(within(modal).getByText('Stash and switch'))
    const order = calls
      .map((c) => c.channel)
      .filter((c) => c === 'git:stash-push' || c === 'git:checkout')
    expect(order).toEqual(['git:stash-push', 'git:checkout'])
    expect(called('git:checkout')[0]).toEqual([CWD, 'main'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a dirty switch: bring-along checks out without stashing', async () => {
    status = mkStatus({ files: [{ path: 'a.ts' }] as GitStatusData['files'] })
    useSessionStore.getState().setGitStatus(ROUTE, status)
    await mount()
    await click(
      screen
        .getAllByTestId('GitBranchDropdown.branchRow')
        .find((r) => r.getAttribute('data-id') === 'main')!
    )
    await click(screen.getByText('Switch and bring them along'))
    expect(called('git:stash-push')).toHaveLength(0)
    expect(called('git:checkout')[0]).toEqual([CWD, 'main'])
  })

  it('an in-use row never reaches checkout', async () => {
    await mount()
    const busy = screen
      .getAllByTestId('GitBranchDropdown.branchRow')
      .find((r) => r.getAttribute('data-id') === 'busy')!
    await click(busy)
    expect(called('git:checkout')).toHaveLength(0)
  })

  it('a diverged pull asks; the popup text follows git config, and the chosen mode is sent', async () => {
    status = mkStatus({ ahead: 2, behind: 1, trackingBranch: 'origin/feat' })
    useSessionStore.getState().setGitStatus(ROUTE, status)
    branches = { ...branches, pullConfig: { rebase: 'rebase', ff: null } }
    await mount()

    await click(tid('pull'))
    expect(called('git:pull')).toHaveLength(0)
    expect(screen.getByTestId('GitBranchDropdown.pullConfirm')).toHaveTextContent(
      'Rebase your 2 local commits onto 1 incoming'
    )
    await click(screen.getByTestId('GitBranchDropdown.pullConfirm.confirm'))
    expect(called('git:pull')[0]).toEqual([CWD, 'rebase'])
    expect(maybe('pullConfirm')).toBeNull()
  })

  it('a fast-forward pull does not ask', async () => {
    status = mkStatus({ ahead: 0, behind: 3, trackingBranch: 'origin/feat' })
    useSessionStore.getState().setGitStatus(ROUTE, status)
    await mount()
    await click(tid('pull'))
    expect(screen.queryByTestId('GitBranchDropdown.pullConfirm')).toBeNull()
    expect(called('git:pull')).toHaveLength(1)
  })

  it('typing, then Enter on the Create row, creates from the current branch', async () => {
    await mount()
    const input = tid('search')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'brand-new' } })
    })
    expect(tid('createRow')).toHaveTextContent('Create brand-new')
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(called('git:create-branch')[0]).toEqual([CWD, 'brand-new', null])
  })

  it('Enter on an arrow-selected match switches to it', async () => {
    await mount()
    const input = tid('search')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'mai' } }) // Create "mai", then main
    })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(called('git:checkout')[0]).toEqual([CWD, 'main'])
  })

  it('in a worktree session the header carries the context row', async () => {
    const info: WorktreeInfo = {
      worktreePath: '/repo/.claude/worktrees/fix-hooks',
      worktreeBranch: 'worktree-fix-hooks',
      worktreeName: 'fix-hooks',
      originalCwd: '/repo',
      gitRoot: '/repo',
      originalHeadCommit: 'abc',
      createdAt: 1
    }
    useSessionStore.getState().setWorktreeInfo(ROUTE, info)
    await mount()
    expect(tid('worktree')).toHaveTextContent('fix-hooks')
    expect(tid('worktree')).toHaveTextContent('repo')
  })
})
