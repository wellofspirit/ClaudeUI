/**
 * Layer 2: Component tests for GitCommitBox's post-commit selection contract.
 *
 * Not a full suite — the box's commit/push/toast plumbing is exercised through
 * the GitPanel flows. What needs its own lock is the `autoSelectNext` fork:
 *
 *   • default (desktop): after a partial commit the first remaining file is
 *     selected, keeping the side-by-side diff pane populated;
 *   • autoSelectNext={false} (mobile): selection stays null. On mobile
 *     selection IS navigation (MobileGitView derives its screen from it), so
 *     the desktop behavior would yank the list screen into the diff of a
 *     leftover file the user never tapped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { GitFileStatus, GitStatusData } from '../../../../../../shared/types'
import { GitCommitBox } from '../GitCommitBox'

const ROUTE = 'route-commitbox'
const CWD = '/d/repo-commitbox'

const stagedFile: GitFileStatus = { path: 'src/staged.ts', index: 'M', working: ' ' }
const leftoverFile: GitFileStatus = { path: 'src/leftover.ts', index: ' ', working: 'M' }

function makeGitStatus(files: GitFileStatus[]): GitStatusData {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/main',
    files,
    staged: files.filter((f) => f.index !== ' ' && f.index !== '?').map((f) => f.path),
    unstaged: files.filter((f) => f.index === ' ').map((f) => f.path),
    untracked: [],
    linesAdded: 1,
    linesRemoved: 1
  }
}

describe('GitCommitBox — post-commit selection', () => {
  let app: TestApp
  let status: GitStatusData

  beforeEach(async () => {
    // Before the commit: one staged file + one unstaged leftover.
    status = makeGitStatus([stagedFile, leftoverFile])

    app = await bootTestApp()
    app.bridge.ipcMain.handle('git:commit', () => ({ ok: true, data: 'abc1234def' }))
    app.bridge.ipcMain.handle('git:status', () => ({ ok: true, data: status }))

    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().setIsGitRepo(ROUTE, true)
    useSessionStore.getState().setGitStatus(ROUTE, status)
    useSessionStore.getState().setGitCommitMessage(ROUTE, 'test: partial commit')
  })

  afterEach(() => {
    cleanup()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  const selected = (): string | null => useSessionStore.getState().sessions[ROUTE].gitSelectedFile

  async function commit(autoSelectNext?: boolean): Promise<void> {
    await act(async () => {
      render(
        autoSelectNext === undefined ? (
          <GitCommitBox />
        ) : (
          <GitCommitBox autoSelectNext={autoSelectNext} />
        )
      )
    })
    // The commit's status refresh reports only the leftover file remaining.
    status = makeGitStatus([leftoverFile])
    await act(async () => {
      screen.getByTestId('GitCommitBox.commit').click()
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  it('selects the first remaining file after a commit by default (desktop)', async () => {
    await commit()
    expect(selected()).toBe('src/leftover.ts')
  })

  it('leaves the selection untouched with autoSelectNext={false} (mobile)', async () => {
    await commit(false)
    expect(selected()).toBeNull()
  })
})
