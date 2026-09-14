/**
 * Layer 1: Unit tests for DeleteConfirmModal.
 *
 * Pure rendering + user-interaction tests — no store, no IPC. The component
 * receives an `onConfirm` Promise; these tests exercise the success, error,
 * and busy states.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { DeleteConfirmModal } from '../DeleteConfirmModal'

function renderModal(overrides: Partial<React.ComponentProps<typeof DeleteConfirmModal>> = {}) {
  const props: React.ComponentProps<typeof DeleteConfirmModal> = {
    kind: 'session',
    name: 'My Session',
    path: '~/.claude/projects/key/abc.jsonl',
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
    ...overrides
  }
  return { ...render(<DeleteConfirmModal {...props} />), props }
}

describe('DeleteConfirmModal (session)', () => {
  it('renders session title and path in the hint', () => {
    renderModal()
    expect(screen.getByText('Delete session?')).toBeInTheDocument()
    expect(screen.getByText(/"My Session"/)).toBeInTheDocument()
    expect(screen.getByText('~/.claude/projects/key/abc.jsonl')).toBeInTheDocument()
  })

  it('calls onConfirm when Delete is clicked', async () => {
    const { props } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledOnce())
  })

  it('calls onCancel when Cancel is clicked', () => {
    const { props } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledOnce()
  })

  it('Escape cancels, but not while the delete is in flight', async () => {
    // Every ConfirmModal in the app is an `useEscapeLayer` layer as of the
    // ADR-065 follow-up: Escape is Cancel, on the same terms as the scrim
    // click. Mid-flight it is swallowed — the dialog must not vanish under the
    // user while the delete is still running.
    let resolve!: () => void
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r
        })
    )
    const { props } = renderModal({ onConfirm })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('button', { name: 'Deleting...' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledOnce()
    await act(async () => {
      resolve()
    })
  })

  it('shows Deleting... state while onConfirm is pending and disables buttons', async () => {
    let resolve!: () => void
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r
        })
    )
    renderModal({ onConfirm })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('button', { name: 'Deleting...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => {
      resolve()
    })
  })

  it('shows an inline error + Retry when onConfirm rejects', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY: resource busy'))
      .mockResolvedValueOnce(undefined)
    renderModal({ onConfirm })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Could not delete')).toBeInTheDocument()
    expect(screen.getByText('EBUSY: resource busy')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('Retry re-invokes onConfirm', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValueOnce(undefined)
    renderModal({ onConfirm })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('button', { name: 'Retry' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2))
  })
})

describe('DeleteConfirmModal (project)', () => {
  it('renders session count in body + confirm button label', () => {
    renderModal({
      kind: 'project',
      name: 'ClaudeUI',
      path: '~/.claude/projects/key/',
      sessionCount: 57
    })
    expect(screen.getByText('Delete project?')).toBeInTheDocument()
    expect(screen.getAllByText(/57 sessions/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Delete all 57 sessions' })).toBeInTheDocument()
  })

  it('pluralises "1 session" correctly', () => {
    renderModal({
      kind: 'project',
      name: 'Solo',
      path: '~/.claude/projects/solo/',
      sessionCount: 1
    })
    expect(screen.getByRole('button', { name: 'Delete all 1 session' })).toBeInTheDocument()
  })

  it('falls back to plain Delete label when sessionCount is 0', () => {
    renderModal({
      kind: 'project',
      name: 'Empty',
      path: '~/.claude/projects/empty/',
      sessionCount: 0
    })
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })
})

/**
 * Codex branches (ADR-066 slice G). The native delete is refused while a fork
 * still references the thread's history, so deleting a branched session takes
 * the whole subtree — and the confirmation has to say so BEFORE the user
 * agrees, which is the only reason this prop exists.
 */
describe('DeleteConfirmModal (codex branches)', () => {
  it('lists the branches the delete will take with it, and marks the running one', () => {
    renderModal({
      name: 'Root thread',
      path: 'thread-root',
      branches: [
        { threadId: 'fork-a', title: 'Try the other fix', live: true, depth: 1 },
        { threadId: 'fork-b', title: null, live: false, depth: 2 }
      ]
    })
    expect(screen.getByTestId('DeleteConfirmModal.branches')).toBeInTheDocument()
    expect(screen.getAllByTestId('DeleteConfirmModal.branch')).toHaveLength(2)
    expect(screen.getByText(/Also deletes 2 branches/)).toBeInTheDocument()
    expect(screen.getByText(/Try the other fix/)).toBeInTheDocument()
    // No sidebar title for a branch nobody has opened: the id is what is left.
    expect(screen.getByText(/fork-b/)).toBeInTheDocument()
    expect(screen.getByText(/running, will be stopped/)).toBeInTheDocument()
    // One button, and it says how many threads it is about to remove.
    expect(screen.getByRole('button', { name: 'Delete all 3' })).toBeInTheDocument()
  })

  it('says nothing extra for an unbranched Codex session', () => {
    renderModal({ name: 'Leaf thread', path: 'thread-leaf', branches: [] })
    expect(screen.queryByTestId('DeleteConfirmModal.branches')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })
})
