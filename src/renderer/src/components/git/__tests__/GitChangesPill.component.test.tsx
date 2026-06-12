/**
 * Layer 2: Component test for GitChangesPill.
 *
 * Tests the openGitPanel / closeGitPanel toggle via store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { GitChangesPill } from '../GitChangesPill'
import type { GitStatusData } from '../../../../../shared/types'

const ROUTE = 'route-gcp'

function makeStatus(overrides: Partial<GitStatusData> = {}): GitStatusData {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/main',
    files: [{ path: 'a.ts', index: ' ', working: 'M' }],
    staged: [],
    unstaged: ['a.ts'],
    untracked: [],
    linesAdded: 3,
    linesRemoved: 1,
    ...overrides
  } as GitStatusData
}

describe('GitChangesPill', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().setIsGitRepo(ROUTE, true)
    useSessionStore.getState().setGitStatus(ROUTE, makeStatus())
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('renders nothing when not a git repo', () => {
    useSessionStore.getState().setIsGitRepo(ROUTE, false)
    const { container } = render(<GitChangesPill />)
    expect(container.firstChild).toBeNull()
  })

  it('toggles openGitPanel / closeGitPanel on click', () => {
    const { container } = render(<GitChangesPill />)
    fireEvent.click(container.querySelector('button')!)

    expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('git')

    fireEvent.click(container.querySelector('button')!)
    expect(useSessionStore.getState().sessions[ROUTE].rightPanel).toBe('none')
  })

  it('renders "No Changes" when files are empty', () => {
    useSessionStore.getState().setGitStatus(ROUTE, makeStatus({ files: [] }))
    const { getByText } = render(<GitChangesPill />)
    expect(getByText('No Changes')).toBeInTheDocument()
  })
})
