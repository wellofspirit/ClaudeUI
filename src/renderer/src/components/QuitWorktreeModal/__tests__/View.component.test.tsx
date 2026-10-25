/**
 * The quit modal through its REAL View: the C-S1 copy (removal happens after sessions close, so quitting
 * may take a moment) and the busy state once "Remove all" was chosen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QuitWorktreeModalView, type QuitWorktreeModalViewProps } from '../View'
import type { WorktreeInfo } from '../../../../../shared/types'

function entry(name: string): QuitWorktreeModalViewProps['quitWorktrees'][number] {
  return {
    routingId: `r-${name}`,
    worktreeInfo: {
      worktreeName: name,
      worktreePath: `/d/repo/.claude/worktrees/${name}`,
      worktreeBranch: name,
      gitRoot: '/d/repo',
      originalCwd: '/d/repo',
      originalHeadCommit: 'abc',
      createdAt: 1
    } as WorktreeInfo
  }
}

function view(over: Partial<QuitWorktreeModalViewProps> = {}): QuitWorktreeModalViewProps {
  const p: QuitWorktreeModalViewProps = {
    quitWorktrees: [entry('a'), entry('b')],
    removing: false,
    onCancel: vi.fn(),
    onKeepAll: vi.fn(),
    onRemoveAll: vi.fn(),
    ...over
  }
  render(<QuitWorktreeModalView {...p} />)
  return p
}

const t = (id: string): HTMLElement => screen.getByTestId(`QuitWorktreeModal.${id}`)

afterEach(cleanup)

describe('QuitWorktreeModalView', () => {
  it('says removal happens after the sessions close and may take a moment', () => {
    view()
    expect(t('note').textContent).toContain('after your sessions close')
    expect(t('note').textContent).toContain('quitting may take a moment')
  })

  it('lists each worktree and passes the clicks upstream', () => {
    const p = view()
    expect(screen.getAllByTestId('QuitWorktreeModal.worktreeRow')).toHaveLength(2)
    fireEvent.click(t('removeAll'))
    expect(p.onRemoveAll).toHaveBeenCalled()
  })

  it('once removing: the notice changes, Cancel and Keep all are disabled', () => {
    view({ removing: true })
    expect(t('note').textContent).toContain('ClaudeUI quits when this is done')
    expect((t('cancel') as HTMLButtonElement).disabled).toBe(true)
    expect((t('keepAll') as HTMLButtonElement).disabled).toBe(true)
    expect((t('removeAll') as HTMLButtonElement).disabled).toBe(true)
  })

  it('two sessions in one worktree show it once, counted once (N6)', () => {
    view({ quitWorktrees: [entry('a'), { ...entry('a'), routingId: 'r-other' }, entry('b')] })
    const rows = screen.getAllByTestId('QuitWorktreeModal.worktreeRow')
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['a', 'b'])
    expect(screen.getByText(/You have 2 active worktrees/)).toBeTruthy()
  })

  it('two different worktrees that share a folder name stay separate rows (N6)', () => {
    const other = entry('a')
    other.worktreeInfo = { ...other.worktreeInfo, worktreePath: '/e/other/.claude/worktrees/a' }
    view({ quitWorktrees: [entry('a'), other] })
    expect(screen.getAllByTestId('QuitWorktreeModal.worktreeRow')).toHaveLength(2)
  })

  it('the button row wraps on a narrow screen (N8)', () => {
    view()
    expect(t('cancel').parentElement?.className).toContain('flex-wrap')
  })
})
