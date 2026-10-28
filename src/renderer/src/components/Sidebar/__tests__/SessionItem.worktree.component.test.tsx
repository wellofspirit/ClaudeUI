/**
 * Worktree session rows (slice 3e / C-S10): every row whose session is in a linked worktree gets
 * the always-visible right-edge tint. A row counts as a worktree session when a `worktreeInfoMap`
 * entry exists (EnterWorktree, session.moved, created here) OR when its cwd is a directory the
 * listing marks `linkedWorktree` (any engine, any layout, found by normalised cwd).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { EMPTY_SESSION_STATE, useSessionStore } from '../../../stores/session-store'
import type { DirectoryGroup, SessionInfo, WorktreeInfo } from '../../../../../shared/types'
import { SessionItem } from '../SessionItem'

const WT = 'C:/Users/me/.local/share/opencode/worktree/ab12/repo'

const info = (cwd: string, sessionId = 's-1'): SessionInfo => ({
  sessionId,
  cwd,
  projectKey: 'k',
  title: 'Session',
  timestamp: 0,
  lastActivityAt: 0
})

const marked = (cwd: string): DirectoryGroup => ({
  cwd,
  projectKey: 'k',
  folderName: 'repo',
  sessions: [],
  linkedWorktree: { worktreePath: WT, repoRoot: 'C:/Users/me/repo', name: 'ab12/repo', branch: '' }
})

const recorded: WorktreeInfo = {
  worktreePath: '/repo/.claude/worktrees/foo',
  worktreeBranch: 'worktree-foo',
  worktreeName: 'foo',
  originalCwd: '/repo',
  gitRoot: '/repo',
  originalHeadCommit: '',
  createdAt: 1,
  origin: 'detected'
}

let initial: ReturnType<typeof useSessionStore.getState>
beforeEach(() => {
  initial = useSessionStore.getState()
})
afterEach(() => {
  cleanup()
  useSessionStore.setState(initial, true)
})

const renderRow = (cwd: string, extra: Partial<React.ComponentProps<typeof SessionItem>> = {}) =>
  render(<SessionItem info={info(cwd)} active={false} onClick={() => {}} {...extra} />)

describe('SessionItem worktree tint', () => {
  it('a plain session has no tint and no worktree icon', () => {
    useSessionStore.setState({ directories: [marked(WT)] })
    renderRow('/some/other/dir', { onPin: () => {} })
    expect(screen.queryByTestId('SessionItem.worktreeTint')).toBeNull()
    expect(screen.queryByTitle('Worktree session')).toBeNull()
    // No stacking context for a row that has no tint layer to keep behind its content.
    expect(screen.getByTestId('SessionItem').className).not.toContain('isolate')
  })

  it('a recorded worktreeInfoMap entry tints the row', () => {
    useSessionStore.setState({ worktreeInfoMap: { 's-1': recorded } })
    renderRow('/repo')
    expect(screen.getByTestId('SessionItem.worktreeTint')).toBeInTheDocument()
  })

  it('a cwd the listing marks as a linked worktree tints the row, matched across separators and case', () => {
    useSessionStore.setState({ directories: [marked(WT)] })
    renderRow('c:\\users\\ME\\.local\\share\\opencode\\worktree\\ab12\\repo\\')
    expect(screen.getByTestId('SessionItem.worktreeTint')).toBeInTheDocument()
    expect(screen.getByTitle('Worktree session')).toBeInTheDocument()
  })

  it("the live session's cwd wins over the listing's", () => {
    useSessionStore.setState({
      directories: [marked(WT)],
      sessions: { 's-1': { ...EMPTY_SESSION_STATE, cwd: WT } }
    })
    renderRow('/stale/listing/cwd')
    expect(screen.getByTestId('SessionItem.worktreeTint')).toBeInTheDocument()
  })

  it('is a faint purple gradient: the token at the right edge, transparent 30% in, never clickable', () => {
    useSessionStore.setState({ worktreeInfoMap: { 's-1': recorded } })
    renderRow('/repo', { onPin: () => {} })
    const tint = screen.getByTestId('SessionItem.worktreeTint')
    expect(tint.style.backgroundImage).toBe(
      'linear-gradient(to left, var(--color-worktree-tint) 0%, transparent 30%)'
    )
    expect(tint.className).toContain('pointer-events-none')
    expect(tint.className).toContain('rounded-md')
    expect(tint.className).toContain('-z-10')

    // It sits inside the row's own stacking context, before the content and the hover backdrop
    // (the backdrop paints later, so its blur reads the tint too).
    const row = screen.getByTestId('SessionItem')
    expect(row.className).toContain('isolate')
    expect(row.firstElementChild).toBe(tint)
    const backdrop = row.querySelector('.session-icon-backdrop')
    expect(backdrop).not.toBeNull()
    expect(
      tint.compareDocumentPosition(backdrop as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('tints active and renaming rows too', () => {
    useSessionStore.setState({ worktreeInfoMap: { 's-1': recorded } })
    renderRow('/repo', { active: true, isRenaming: true })
    expect(screen.getByTestId('SessionItem.worktreeTint')).toBeInTheDocument()
  })
})
