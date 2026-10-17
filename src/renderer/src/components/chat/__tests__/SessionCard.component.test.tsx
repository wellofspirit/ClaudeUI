/**
 * The session card in the parent's transcript, and the "continued in / from" bar
 * (session tools, slice 1b), through a real `MessageBubble` so the selection
 * point is pinned too. Everything the card shows beyond the block's fixed part
 * comes from the replicated links and the child's live session: those are the
 * states pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EMPTY_SESSION_STATE, useSessionStore } from '../../../stores/session-store'
import { MessageBubble } from '../MessageBubble'
import { SessionCardView } from '../SessionCard'
import { SessionLinkBar } from '../ChatPanel/SessionLinkBar'
import type { SessionLinkInfo } from '../../../../../shared/session-links'
import type { ChatMessage, PendingApproval, SessionStatus } from '../../../../../shared/types'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const BLOCK = {
  type: 'session_card' as const,
  childRef: 's-kid111',
  kind: 'started' as const,
  title: 'Fix the flaky test',
  engineId: 'codex' as const
}
const card: ChatMessage = {
  id: 'session-card-s-kid111',
  role: 'system',
  content: [BLOCK],
  timestamp: 1
}

const link = (over: Partial<SessionLinkInfo> = {}): SessionLinkInfo => ({
  parentRef: 's-par111',
  kind: 'started',
  state: 'live',
  createdBy: 'agent',
  wakeParent: false,
  createdAt: 1,
  ...over
})

let initial: ReturnType<typeof useSessionStore.getState>
beforeEach(() => {
  initial = useSessionStore.getState()
})
afterEach(() => {
  cleanup()
  useSessionStore.setState(initial, true)
})

function child(over: Partial<typeof EMPTY_SESSION_STATE> = {}): typeof EMPTY_SESSION_STATE {
  return { ...EMPTY_SESSION_STATE, sdkActive: true, ...over }
}

function setWorld(opts: {
  link?: SessionLinkInfo | null
  session?: typeof EMPTY_SESSION_STATE | null
  title?: string
  refs?: boolean
}): void {
  useSessionStore.setState({
    sessionLinks: opts.link === null ? {} : { 's-kid111': opts.link ?? link() },
    sessionRefs: opts.refs === false ? {} : { 'kid-1': 's-kid111' },
    sessions: opts.session === null ? {} : { 'kid-1': opts.session ?? child() },
    customTitles: opts.title ? { 'kid-1': opts.title } : {},
    directories: []
  })
}

function renderCard(): void {
  render(<MessageBubble message={card} pendingApprovals={[]} isLastAssistant={false} />)
}
const state = (): string => screen.getByTestId('SessionCard').getAttribute('data-state') ?? ''

describe('SessionCard', () => {
  it('shows the child as working while its turn runs, idle after, and the engine and kind', () => {
    setWorld({ session: child({ status: { state: 'running' } as SessionStatus }) })
    renderCard()
    expect(state()).toBe('working')
    expect(screen.getByTestId('SessionCard.dot').getAttribute('data-state')).toBe('running')
    expect(screen.getByTestId('SessionCard.kind').textContent).toContain('Started a session')
    expect(screen.getByTestId('SessionCard').getAttribute('data-kind')).toBe('started')

    cleanup()
    setWorld({ session: child({ status: { state: 'idle' } as SessionStatus }) })
    renderCard()
    expect(state()).toBe('idle')
    expect(screen.getByTestId('SessionCard.dot').getAttribute('data-state')).toBe('idle')
  })

  it('follows the child live: working → needs you → idle as the store changes', () => {
    setWorld({ session: child({ status: { state: 'running' } as SessionStatus }) })
    renderCard()
    expect(state()).toBe('working')

    act(() =>
      setWorld({
        session: child({
          status: { state: 'running' } as SessionStatus,
          pendingApprovals: [{ requestId: 'a1' } as unknown as PendingApproval]
        })
      })
    )
    expect(state()).toBe('needs-you')
    expect(screen.getByTestId('SessionCard.dot').getAttribute('data-state')).toBe('attention')

    act(() => setWorld({ session: child({ status: { state: 'idle' } as SessionStatus }) }))
    expect(state()).toBe('idle')
  })

  it('says a child that never started failed, and one deleted or detached ended or detached', () => {
    setWorld({ link: link({ state: 'failed' }), session: null })
    renderCard()
    expect(state()).toBe('failed')
    expect(screen.getByTestId('SessionCard.dot').getAttribute('data-state')).toBe('failed')
    // Nothing to open.
    expect(screen.queryByTestId('SessionCard.open')).toBeNull()

    for (const linkState of ['ended', 'detached', 'starting'] as const) {
      cleanup()
      setWorld({ link: link({ state: linkState }) })
      renderCard()
      expect(state()).toBe(linkState)
    }
  })

  it('names the child by the title the sidebar shows now, falling back to the block’s, then the ref', () => {
    setWorld({ title: 'Renamed since' })
    renderCard()
    expect(screen.getByTestId('SessionCard.title').textContent).toBe('Renamed since')

    cleanup()
    setWorld({})
    renderCard()
    expect(screen.getByTestId('SessionCard.title').textContent).toBe('Fix the flaky test')

    cleanup()
    render(
      <MessageBubble
        message={{ ...card, content: [{ ...BLOCK, title: '' }] }}
        pendingApprovals={[]}
        isLastAssistant={false}
      />
    )
    expect(screen.getByTestId('SessionCard.title').textContent).toBe('Session s-kid111')
  })

  it('says so, with Open disabled and a reason, when the child has no sidebar row', () => {
    setWorld({ session: null })
    renderCard()
    expect(state()).toBe('unavailable')
    const open = screen.getByTestId('SessionCard.open') as HTMLButtonElement
    expect(open.disabled).toBe(true)
    expect(open.title).toMatch(/not in the sidebar/)
    // Still the brief's name: the child has no title of its own to prefer yet.
    expect(screen.getByTestId('SessionCard.title').textContent).toBe('Fix the flaky test')
  })

  it('reads as not available when no link is known (an older host)', () => {
    setWorld({ link: null, refs: false, session: null })
    renderCard()
    expect(state()).toBe('unknown')
    expect(screen.queryByTestId('SessionCard.open')).toBeNull()
  })

  it('opens the child: switches to it when its transcript is resident', () => {
    setWorld({})
    const switchSession = vi.fn()
    useSessionStore.setState({ switchSession })
    renderCard()
    fireEvent.click(screen.getByTestId('SessionCard.open'))
    expect(switchSession).toHaveBeenCalledWith('kid-1')
  })

  it('the view says a hand-off differently from a plain start', () => {
    render(
      <SessionCardView
        kind="handoff"
        title="Continue the migration"
        engineId="claude"
        state="idle"
        childRef="s-kid111"
      />
    )
    expect(screen.getByTestId('SessionCard.kind').textContent).toContain('Handed off')
    expect(screen.queryByTestId('SessionCard.open')).toBeNull()
  })
})

describe('SessionLinkBar — continued in / from', () => {
  function world(opts: {
    kind: 'started' | 'handoff'
    active: 'parent' | 'child'
    state?: SessionLinkInfo['state']
  }): void {
    useSessionStore.setState({
      activeSessionId: opts.active === 'parent' ? 'par-1' : 'kid-1',
      sessionLinks: { 's-kid111': link({ kind: opts.kind, state: opts.state ?? 'live' }) },
      sessionRefs: { 'kid-1': 's-kid111', 'par-1': 's-par111' },
      customTitles: { 'par-1': 'The long-running assistant', 'kid-1': 'Migration, part 2' },
      sessions: {},
      directories: []
    })
  }

  it('tells the parent where it continued, and the child where it came from — each opens the other', () => {
    world({ kind: 'handoff', active: 'parent' })
    const switchSession = vi.fn()
    useSessionStore.setState({ switchSession, sessions: { 'kid-1': child() } })
    render(<SessionLinkBar />)
    const into = screen.getByTestId('SessionLinkBar.into')
    expect(into.textContent).toContain('Continued in')
    expect(into.textContent).toContain('Migration, part 2')
    expect(screen.queryByTestId('SessionLinkBar.from')).toBeNull()
    fireEvent.click(into)
    expect(switchSession).toHaveBeenCalledWith('kid-1')

    cleanup()
    world({ kind: 'handoff', active: 'child' })
    useSessionStore.setState({ switchSession, sessions: { 'par-1': child() } })
    render(<SessionLinkBar />)
    const from = screen.getByTestId('SessionLinkBar.from')
    expect(from.textContent).toContain('Continued from')
    expect(from.textContent).toContain('The long-running assistant')
    expect(screen.queryByTestId('SessionLinkBar.into')).toBeNull()
    fireEvent.click(from)
    expect(switchSession).toHaveBeenCalledWith('par-1')
  })

  it('shows nothing for a plain started child, a detached hand-off, or an unlinked session', () => {
    world({ kind: 'started', active: 'parent' })
    const { container, unmount } = render(<SessionLinkBar />)
    expect(container.firstChild).toBeNull()
    unmount()

    world({ kind: 'handoff', active: 'child', state: 'detached' })
    const second = render(<SessionLinkBar />)
    expect(second.container.firstChild).toBeNull()
    second.unmount()

    useSessionStore.setState({ activeSessionId: 'nobody' })
    expect(render(<SessionLinkBar />).container.firstChild).toBeNull()
  })

  it('keeps one marker per hand-off when the parent continued more than once', () => {
    useSessionStore.setState({
      activeSessionId: 'par-1',
      sessionLinks: {
        's-kid111': link({ kind: 'handoff', createdAt: 1 }),
        's-kid222': link({ kind: 'handoff', createdAt: 2 })
      },
      sessionRefs: { 'par-1': 's-par111', 'kid-1': 's-kid111', 'kid-2': 's-kid222' },
      customTitles: { 'kid-1': 'First', 'kid-2': 'Second' },
      sessions: {},
      directories: []
    })
    render(<SessionLinkBar />)
    expect(
      screen.getAllByTestId('SessionLinkBar.into').map((el) => el.getAttribute('data-id'))
    ).toEqual(['kid-1', 'kid-2'])
  })
})
