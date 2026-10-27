/**
 * The row for Claude Code holding a message another Claude session sent
 * (`peer_hold`, slice 1a), through a real `MessageBubble` — the selection point is
 * part of what is pinned. The action is the one thing that reaches the host, and
 * it must act on the TRANSCRIPT's session, not the active one.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MessageBubble, TranscriptSessionProvider } from '../MessageBubble'
import { PeerHoldRow, peerHoldSentence } from '../PeerHoldRow'
import type { ChatMessage, ContentBlock } from '../../../../../shared/types'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

type Hold = Extract<ContentBlock, { type: 'peer_hold' }>
const hold = (over: Partial<Hold> = {}): Hold => ({
  type: 'peer_hold',
  holdId: 'm1',
  state: 'held',
  lane: 'socket',
  fromName: 'probe-A',
  cause: 'mode-mismatch',
  ...over
})
const message = (block: Hold): ChatMessage => ({
  id: 'peer-hold-m1',
  role: 'system',
  content: [block],
  timestamp: 0
})

const allowPeerMessages = vi.fn()
beforeEach(() => {
  allowPeerMessages.mockReset().mockResolvedValue({ success: true })
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    platform: 'web',
    allowPeerMessages
  }
})
afterEach(() => cleanup())

function renderBubble(block: Hold, routingId: string | null = 'r-transcript') {
  return render(
    <TranscriptSessionProvider value={routingId}>
      <MessageBubble message={message(block)} pendingApprovals={[]} isLastAssistant={false} />
    </TranscriptSessionProvider>
  )
}

describe('peerHoldSentence', () => {
  it('says what Claude Code did, why, and that the model has not seen it', () => {
    expect(peerHoldSentence(hold())).toBe(
      'A message from Claude session “probe-A” is held by Claude Code: the two sessions run in different permission modes. The model has not seen it.'
    )
    expect(peerHoldSentence(hold({ fromName: '', cause: 'something-new' }))).toContain(
      'another Claude session is held by Claude Code: something-new'
    )
    expect(peerHoldSentence(hold({ state: 'released' }))).toBe(
      'A message from Claude session “probe-A” was released to the model.'
    )
    expect(peerHoldSentence(hold({ state: 'dropped', outcome: 'discarded' }))).toBe(
      'A message from Claude session “probe-A” was dropped (discarded). The model never saw it.'
    )
  })
})

describe('the held row in the transcript', () => {
  it('offers exactly one action, and runs it on the transcript’s own session', async () => {
    renderBubble(hold())
    expect(screen.getByTestId('PeerHoldRow').getAttribute('data-state')).toBe('held')
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe('Allow messages from other Claude sessions here')

    fireEvent.click(screen.getByTestId('PeerHoldRow.allow'))

    await waitFor(() => expect(allowPeerMessages).toHaveBeenCalledWith('r-transcript'))
    expect(screen.queryByTestId('PeerHoldRow.error')).toBeNull()
  })

  it('shows the refusal when Claude Code does not take the change', async () => {
    allowPeerMessages.mockResolvedValue({ success: false, error: 'settings are managed' })
    renderBubble(hold())
    fireEvent.click(screen.getByTestId('PeerHoldRow.allow'))
    expect((await screen.findByTestId('PeerHoldRow.error')).textContent).toBe(
      'settings are managed'
    )
    // The button is back for another try.
    expect(screen.getByTestId('PeerHoldRow.allow')).not.toBeDisabled()
  })

  it('has no action when the transcript belongs to no live session', () => {
    renderBubble(hold(), null)
    expect(screen.queryByTestId('PeerHoldRow.allow')).toBeNull()
    expect(screen.getByTestId('PeerHoldRow.sentence')).toBeInTheDocument()
  })

  it.each(['released', 'dropped'] as const)(
    'a %s row is history: a sentence and no action',
    (state) => {
      renderBubble(hold({ state, outcome: 'discarded' }))
      expect(screen.getByTestId('PeerHoldRow').getAttribute('data-state')).toBe(state)
      expect(screen.queryByRole('button')).toBeNull()
    }
  )

  it('PeerHoldRow alone: the action is whatever the container wires', () => {
    const onAllow = vi.fn()
    render(<PeerHoldRow block={hold()} onAllow={onAllow} />)
    fireEvent.click(screen.getByTestId('PeerHoldRow.allow'))
    expect(onAllow).toHaveBeenCalledTimes(1)
  })
})
