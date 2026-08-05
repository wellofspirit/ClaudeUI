/**
 * Layer 2: Component test for GitChangesPill.
 *
 * Tests the openGitPanel / closeGitPanel toggle via store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
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

/**
 * The pill bails on a null gitStatus, and nothing else populates it — the ONLY
 * source is the `git:status-update` push. On the remote web client that push
 * never arrived (gitStartWatching was a no-op in api-adapter and the channel was
 * unregistered on the dispatcher), so the pill was permanently invisible there.
 * This asserts the arrival path end-to-end from the transport event.
 */
describe('GitChangesPill — populated by git:status-update', () => {
  const WATCH_ROUTE = 'route-gcp-watch'
  let app: TestApp
  // The store keeps a module-level gitStatusCache keyed by cwd, so a cwd used by
  // an earlier test would pre-seed gitStatus and make the "renders nothing yet"
  // leg vacuous. Every test gets its own.
  let seq = 0
  let cwd: string

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    cwd = `/d/repo-watch-${++seq}`
    useSessionStore.getState().createNewSession(WATCH_ROUTE, cwd)
    useSessionStore.setState({ activeSessionId: WATCH_ROUTE })
    useSessionStore.getState().setIsGitRepo(WATCH_ROUTE, true)

    // Same wiring useClaudeEvents installs for this channel.
    app.api.onGitStatusUpdate(({ cwd: eventCwd, status }) => {
      const s = useSessionStore.getState()
      for (const [routingId, session] of Object.entries(s.sessions)) {
        if (session.cwd === eventCwd) s.setGitStatus(routingId, status)
      }
    })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('renders nothing until a status arrives, then renders the counts', () => {
    const { container, rerender } = render(<GitChangesPill />)
    expect(container.firstChild).toBeNull()

    act(() => {
      app.emit('git:status-update', {
        cwd,
        status: makeStatus({ linesAdded: 12, linesRemoved: 4 })
      })
    })
    rerender(<GitChangesPill />)

    const pill = container.querySelector('[data-testid="GitChangesPill"]')
    expect(pill).not.toBeNull()
    expect(pill!.textContent).toContain('+12')
    expect(pill!.textContent).toContain('-4')
  })

  it('ignores a status for a different cwd', () => {
    const { container, rerender } = render(<GitChangesPill />)
    expect(container.firstChild).toBeNull()

    act(() => {
      app.emit('git:status-update', { cwd: '/d/somewhere-else', status: makeStatus() })
    })
    rerender(<GitChangesPill />)
    expect(container.querySelector('[data-testid="GitChangesPill"]')).toBeNull()
  })
})
