/**
 * The proposal card in the proposing session's transcript (session tools, slice
 * 1c-b), through a real `MessageBubble` so the selection point is pinned too.
 * The block carries everything the card shows; the live inputs are the clock, the
 * two commands, and the row of the session it started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { EMPTY_SESSION_STATE, useSessionStore } from '../../../stores/session-store'
import { MessageBubble } from '../MessageBubble'
import {
  ProposalCardView,
  dismissalText,
  expiryText,
  placementParts,
  sameDirectory
} from '../ProposalCard'
import type { ChatMessage, ContentBlock } from '../../../../../shared/types'
import type { ProposalPlacement } from '../../../../../shared/session-proposals'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const PLACEMENT: ProposalPlacement = {
  engine: 'pi',
  model: 'gpt-5',
  effort: 'high',
  permission_mode: 'acceptEdits',
  cwd: '/work/demo/sub'
}
const DAY = 24 * 60 * 60 * 1000

type Block = Extract<ContentBlock, { type: 'proposal_card' }>
const block = (over: Partial<Block> = {}): Block => ({
  type: 'proposal_card',
  proposalId: 'p-0a1b2c3d',
  title: 'Fix the flaky test',
  prompt: 'Find why tests/queue.spec.ts is flaky.',
  background: 'The repository is a Node service; the flaky test only fails on CI.',
  placement: PLACEMENT,
  parentCwd: '/work/demo',
  state: 'pending',
  expiresAt: Date.now() + 6 * DAY,
  ...over
})
const message = (b: Block): ChatMessage => ({
  id: `proposal-card-${b.proposalId}`,
  role: 'system',
  content: [b],
  timestamp: 1
})

const api = {
  startSessionProposal: vi.fn(),
  dismissSessionProposal: vi.fn()
}

let initial: ReturnType<typeof useSessionStore.getState>
beforeEach(() => {
  initial = useSessionStore.getState()
  api.startSessionProposal.mockReset().mockResolvedValue({ success: true, startedRef: 's-kid111' })
  api.dismissSessionProposal.mockReset().mockResolvedValue({ success: true })
  ;(window as unknown as { api: typeof api }).api = {
    ...(window as unknown as { api?: object }).api,
    ...api
  } as never
})
afterEach(() => {
  cleanup()
  useSessionStore.setState(initial, true)
  vi.useRealTimers()
})

const mount = (b: Block): ReturnType<typeof render> =>
  render(<MessageBubble message={message(b)} pendingApprovals={[]} />)
const state = (): string | null => screen.getByTestId('ProposalCard').getAttribute('data-state')

describe('ProposalCard states', () => {
  it('pending: title, placement summary with the directory only when it differs, expiry, two starts and Dismiss', () => {
    mount(block())
    expect(state()).toBe('pending')
    expect(screen.getByTestId('ProposalCard.title').textContent).toBe('Fix the flaky test')
    expect(screen.getByTestId('ProposalCard.state').textContent).toBe('Proposed')
    expect(screen.getByTestId('ProposalCard.placement').textContent).toBe(
      'pi · model gpt-5 · effort high · acceptEdits mode · /work/demo/sub'
    )
    expect(screen.getByTestId('ProposalCard.expiry').textContent).toBe('Expires in 6 days')
    expect(screen.getByTestId('ProposalCard.startGrouped')).not.toBeDisabled()
    expect(screen.getByTestId('ProposalCard.startStandalone')).not.toBeDisabled()
    expect(screen.getByTestId('ProposalCard.dismiss')).not.toBeDisabled()
    expect(screen.queryByTestId('ProposalCard.open')).toBeNull()
  })

  it('offers "Start in this group" and "Start as standalone work", the proposal’s own relation being the primary one and first', () => {
    // No relation (a proposal from before relations existed) and `standalone` read the same.
    for (const placement of [PLACEMENT, { ...PLACEMENT, relation: 'standalone' as const }]) {
      mount(block({ placement }))
      const grouped = screen.getByTestId('ProposalCard.startGrouped')
      const standalone = screen.getByTestId('ProposalCard.startStandalone')
      expect(grouped.textContent).toBe('Start in this group')
      expect(standalone.textContent).toBe('Start as standalone work')
      expect(standalone.getAttribute('data-primary')).toBe('true')
      expect(grouped.getAttribute('data-primary')).toBe('false')
      expect(
        standalone.compareDocumentPosition(grouped) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      cleanup()
    }
    mount(block({ placement: { ...PLACEMENT, relation: 'same_work' } }))
    const grouped = screen.getByTestId('ProposalCard.startGrouped')
    const standalone = screen.getByTestId('ProposalCard.startStandalone')
    expect(grouped.getAttribute('data-primary')).toBe('true')
    expect(standalone.getAttribute('data-primary')).toBe('false')
    expect(
      grouped.compareDocumentPosition(standalone) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('the brief is collapsed until asked for', () => {
    mount(block())
    expect(screen.queryByTestId('ProposalCard.details')).toBeNull()
    fireEvent.click(screen.getByTestId('ProposalCard.toggleDetails'))
    expect(screen.getByTestId('ProposalCard.prompt').textContent).toContain('queue.spec.ts')
    expect(screen.getByTestId('ProposalCard.background').textContent).toContain('only fails on CI')
    fireEvent.click(screen.getByTestId('ProposalCard.toggleDetails'))
    expect(screen.queryByTestId('ProposalCard.details')).toBeNull()
  })

  it('a placement in the proposer’s own directory does not repeat it', () => {
    expect(placementParts({ ...PLACEMENT, cwd: '/work/demo' }, '/work/demo')).toEqual([
      'pi',
      'model gpt-5',
      'effort high',
      'acceptEdits mode'
    ])
    expect(
      placementParts(
        { engine: 'claude', permission_mode: 'default', cwd: '/w', worktree: 'wt' },
        '/w'
      )
    ).toEqual(['claude', 'default mode', 'new worktree wt'])
  })

  it('says in plain text when the directory is outside the proposing session’s folder, and not otherwise', () => {
    mount(block({ placement: { ...PLACEMENT, cwd: '/elsewhere/other-repo', outside: true } }))
    const outside = screen.getByTestId('ProposalCard.outside')
    expect(outside.textContent).toBe(
      "Outside the proposing session's folder: /elsewhere/other-repo"
    )
    // Normal text colour, not the muted placement line, and not repeated in that line.
    expect(outside.className).toContain('text-text-primary')
    expect(outside.className).not.toContain('text-text-muted')
    expect(screen.getByTestId('ProposalCard.placement').textContent).not.toContain('/elsewhere')
    cleanup()
    mount(block())
    expect(screen.queryByTestId('ProposalCard.outside')).toBeNull()
  })

  it('compares directories whichever slashes they were written with', () => {
    expect(sameDirectory('D:\\work\\demo', 'D:/work/demo')).toBe(true)
    expect(sameDirectory('D:/work/demo/', 'd:\\Work\\Demo')).toBe(true)
    expect(sameDirectory('/work/demo', '/work/Demo')).toBe(false)
    expect(sameDirectory('D:/work/demo', 'D:/work/other')).toBe(false)
    // A same-folder placement written in the other style is not shown as a different directory.
    expect(
      placementParts(
        { engine: 'claude', permission_mode: 'default', cwd: 'D:/work/demo' },
        'D:\\work\\demo'
      )
    ).toEqual(['claude', 'default mode'])
  })

  it('started: no buttons, says so, and Open is there when the session has a row', () => {
    useSessionStore.setState({
      sessionRefs: { kid: 's-kid111' },
      sessions: { ...useSessionStore.getState().sessions, kid: { ...EMPTY_SESSION_STATE } }
    })
    mount(block({ state: 'started', startedRef: 's-kid111' }))
    expect(state()).toBe('started')
    expect(screen.getByTestId('ProposalCard.state').textContent).toBe('Started')
    expect(screen.queryByTestId('ProposalCard.startGrouped')).toBeNull()
    expect(screen.queryByTestId('ProposalCard.startStandalone')).toBeNull()
    expect(screen.queryByTestId('ProposalCard.dismiss')).toBeNull()
    expect(screen.queryByTestId('ProposalCard.expiry')).toBeNull()
    expect(screen.getByTestId('ProposalCard.open')).not.toBeDisabled()
  })

  it('started with no row to open: Open is disabled and says why', () => {
    mount(block({ state: 'started', startedRef: 's-kid111' }))
    expect(screen.getByTestId('ProposalCard.open')).toBeDisabled()
    expect(screen.getByTestId('ProposalCard.open').getAttribute('title')).toMatch(
      /not in the sidebar/
    )
  })

  it.each([
    [undefined, 'Dismissed'],
    ['user', 'Dismissed'],
    ['evicted', 'Replaced by newer proposals'],
    ['agent', 'Withdrawn by the agent'],
    ['agent: not needed', 'Withdrawn by the agent: not needed']
  ])('dismissed (%s): %s, and no buttons', (reason, text) => {
    mount(block({ state: 'dismissed', reason }))
    expect(state()).toBe('dismissed')
    expect(screen.getByTestId('ProposalCard.state').textContent).toBe(text)
    expect(screen.queryByTestId('ProposalCard.startGrouped')).toBeNull()
    expect(screen.queryByTestId('ProposalCard.startStandalone')).toBeNull()
    expect(dismissalText(reason)).toBe(text)
  })

  it('expired, as the host wrote it: no buttons', () => {
    mount(block({ state: 'dismissed', reason: 'expired' }))
    expect(state()).toBe('expired')
    expect(screen.getByTestId('ProposalCard.state').textContent).toBe('Expired')
    expect(screen.queryByTestId('ProposalCard.startGrouped')).toBeNull()
    expect(screen.queryByTestId('ProposalCard.startStandalone')).toBeNull()
  })

  it('a pending card past its expiry shows expired at once, and one that expires while open flips by itself', () => {
    mount(block({ expiresAt: Date.now() - 1000 }))
    expect(state()).toBe('expired')
    expect(screen.queryByTestId('ProposalCard.startGrouped')).toBeNull()
    expect(screen.queryByTestId('ProposalCard.startStandalone')).toBeNull()
    cleanup()

    vi.useFakeTimers()
    mount(block({ expiresAt: Date.now() + 5000 }))
    expect(state()).toBe('pending')
    act(() => {
      vi.advanceTimersByTime(5200)
    })
    expect(state()).toBe('expired')
    expect(screen.queryByTestId('ProposalCard.startGrouped')).toBeNull()
    expect(screen.queryByTestId('ProposalCard.startStandalone')).toBeNull()
  })

  it('says how long is left in the unit that fits', () => {
    const now = 1_000_000
    expect(expiryText(now + 30_000, now)).toBe('Expires soon')
    expect(expiryText(now + 12 * 60_000, now)).toBe('Expires in 12 min')
    expect(expiryText(now + 5 * 3_600_000, now)).toBe('Expires in 5 h')
    expect(expiryText(now + 6 * DAY, now)).toBe('Expires in 6 days')
  })
})

describe('ProposalCard commands', () => {
  it('each start button sends the proposal id and its own choice, whichever one is primary, and shows no error on success', async () => {
    mount(block())
    await act(async () => {
      fireEvent.click(screen.getByTestId('ProposalCard.startGrouped'))
    })
    expect(api.startSessionProposal).toHaveBeenLastCalledWith('p-0a1b2c3d', true)
    await act(async () => {
      fireEvent.click(screen.getByTestId('ProposalCard.startStandalone'))
    })
    expect(api.startSessionProposal).toHaveBeenLastCalledWith('p-0a1b2c3d', false)
    expect(api.startSessionProposal).toHaveBeenCalledTimes(2)
    expect(api.dismissSessionProposal).not.toHaveBeenCalled()
    expect(screen.queryByTestId('ProposalCard.error')).toBeNull()
    cleanup()

    // The primary button follows the proposal, the choice follows the button.
    mount(block({ placement: { ...PLACEMENT, relation: 'same_work' } }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('ProposalCard.startStandalone'))
    })
    expect(api.startSessionProposal).toHaveBeenLastCalledWith('p-0a1b2c3d', false)
  })

  it('both buttons wait while a command is in flight, so a double tap sends one', async () => {
    let finish!: (v: { success: boolean }) => void
    api.startSessionProposal.mockReturnValue(new Promise((r) => (finish = r)))
    mount(block())
    fireEvent.click(screen.getByTestId('ProposalCard.startStandalone'))
    // Only the button that was clicked says it is starting; every button waits.
    expect(screen.getByTestId('ProposalCard.startStandalone').textContent).toBe('Starting…')
    expect(screen.getByTestId('ProposalCard.startGrouped').textContent).toBe('Start in this group')
    expect(screen.getByTestId('ProposalCard.startStandalone')).toBeDisabled()
    expect(screen.getByTestId('ProposalCard.startGrouped')).toBeDisabled()
    expect(screen.getByTestId('ProposalCard.dismiss')).toBeDisabled()
    fireEvent.click(screen.getByTestId('ProposalCard.startStandalone'))
    fireEvent.click(screen.getByTestId('ProposalCard.startGrouped'))
    expect(api.startSessionProposal).toHaveBeenCalledTimes(1)
    await act(async () => finish({ success: true }))
    expect(screen.getByTestId('ProposalCard.startStandalone')).not.toBeDisabled()
  })

  it('Dismiss sends the proposal id', async () => {
    mount(block())
    await act(async () => {
      fireEvent.click(screen.getByTestId('ProposalCard.dismiss'))
    })
    expect(api.dismissSessionProposal).toHaveBeenCalledWith('p-0a1b2c3d')
    expect(api.startSessionProposal).not.toHaveBeenCalled()
  })

  it('shows what the host said when a click did not work, and what a thrown error says', async () => {
    api.startSessionProposal.mockResolvedValue({
      success: false,
      error: 'That proposal has expired.'
    })
    mount(block())
    await act(async () => {
      fireEvent.click(screen.getByTestId('ProposalCard.startStandalone'))
    })
    expect(screen.getByTestId('ProposalCard.error').textContent).toBe('That proposal has expired.')
    api.dismissSessionProposal.mockRejectedValue(new Error('offline'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('ProposalCard.dismiss'))
    })
    expect(screen.getByTestId('ProposalCard.error').textContent).toBe('offline')
  })

  it('the view alone offers no button it has no handler for', () => {
    render(
      <ProposalCardView
        proposalId="p-1"
        title="t"
        prompt="p"
        background="b"
        placement={PLACEMENT}
        parentCwd="/x"
        state="pending"
        expiresAt={Date.now() + DAY}
        now={Date.now()}
      />
    )
    expect(screen.getByTestId('ProposalCard.startGrouped')).toBeDisabled()
    expect(screen.getByTestId('ProposalCard.startStandalone')).toBeDisabled()
    expect(screen.getByTestId('ProposalCard.dismiss')).toBeDisabled()
  })
})

describe('ProposalCard — an engine this build no longer has', () => {
  it('renders a stored `codex` placement with a generic mark instead of throwing', () => {
    const historic = block({ placement: { ...PLACEMENT, engine: 'codex' as never } })
    expect(() => mount(historic)).not.toThrow()
    const mark = within(screen.getByTestId('ProposalCard')).getByTestId('EngineLogo')
    expect(mark.getAttribute('data-engine')).toBe('codex')
    expect(mark.getAttribute('aria-label')).toBe('Codex (removed)')
    expect(screen.getByTestId('ProposalCard.placement').textContent).toContain('codex')
  })
})
