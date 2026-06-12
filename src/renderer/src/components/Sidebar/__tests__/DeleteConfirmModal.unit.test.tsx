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
