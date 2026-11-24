/**
 * Layer 2: ChatPanel's display-only note toggles (hideTaskNotifications /
 * hideSessionMessages). A hidden `context_note` leaves no row and no empty
 * `MessageBubble`; an untagged or alert note always stays; a chat made only of
 * hidden notes is still a chat (no welcome screen).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import type { ChatMessage, ContentBlock } from '../../../../../../shared/types'
import { ContextNoteBlock } from '../../ContextNoteBlock'

vi.mock('../../../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  useVisualViewportHeight: () => undefined
}))
vi.mock('../TopBar', () => ({ TopBar: () => <div data-testid="TopBar" /> }))
vi.mock('../WelcomeState', () => ({ WelcomeState: () => <div data-testid="WelcomeState" /> }))
vi.mock('../QueuedMessageCard', () => ({ QueuedMessageCard: () => null }))
// A bubble that keeps the real note row, so "no empty MessageBubble" is observable.
vi.mock('../../MessageBubble', () => ({
  MessageBubble: ({ message }: { message: ChatMessage }) => (
    <div data-testid="MessageBubble" data-id={message.id}>
      {message.content.map((b, i) =>
        b.type === 'context_note' ? <ContextNoteBlock key={i} block={b} /> : null
      )}
    </div>
  ),
  TranscriptSessionProvider: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('../../ThinkingBlock', () => ({ ThinkingBlock: () => null }))
vi.mock('../../InputBox', () => ({ InputBox: () => <div data-testid="InputBox" /> }))
vi.mock('../../FloatingApproval', () => ({ FloatingApproval: () => null }))
vi.mock('../../BtwCard', () => ({ BtwCard: () => null }))
vi.mock('../../FloatingError', () => ({ FloatingError: () => null }))
vi.mock('../../SandboxViolationToast', () => ({ SandboxViolationToast: () => null }))
vi.mock('../../ChatSearch', () => ({ ChatSearchOverlay: () => null }))
vi.mock('../../../TodoWidget', () => ({ TodoWidget: () => null }))
vi.mock('../../../SentFilesWidget', () => ({ SentFilesWidget: () => null }))

import { ChatPanel } from '../ChatPanel'

const ROUTE = 'route-hidden-notes'

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const noteMsg = (id: string, extra: Record<string, unknown>): ChatMessage => ({
  id,
  role: 'system',
  content: [
    { type: 'context_note', title: id, fragments: [{ text: 'body' }], ...extra } as ContentBlock
  ],
  timestamp: 1
})

const MESSAGES: ChatMessage[] = [
  noteMsg('n-task', { source: 'task' }),
  noteMsg('n-session', { source: 'session-message' }),
  noteMsg('n-plain', {}),
  noteMsg('n-alert', { source: 'task', alert: true })
]

describe('ChatPanel — hidden context notes', () => {
  let app: TestApp
  const originalMatchMedia = window.matchMedia
  const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  const originalScrollTo = Element.prototype.scrollTo

  beforeEach(async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
    Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo
    window.localStorage.setItem('claudeui.hint.fullscreenDoubleTap', '1')

    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState((state) => ({
      activeSessionId: ROUTE,
      sessions: { ...state.sessions, [ROUTE]: { ...state.sessions[ROUTE], messages: MESSAGES } }
    }))
    // `messages` and `settings` are sealed: without this a projection reverts them.
    mirrorStoreIntoReplica()
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    window.localStorage.clear()
    window.matchMedia = originalMatchMedia
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
    Element.prototype.scrollTo = originalScrollTo
  })

  const ids = (): string[] =>
    screen.queryAllByTestId('MessageBubble').map((el) => el.getAttribute('data-id') ?? '')

  const setToggles = (patch: {
    hideTaskNotifications?: boolean
    hideSessionMessages?: boolean
  }): void =>
    act(() => {
      useSessionStore.setState((s) => ({ settings: { ...s.settings, ...patch } }))
      mirrorStoreIntoReplica()
    })

  it('shows every note by default', async () => {
    await act(async () => {
      render(<ChatPanel />)
    })
    expect(ids()).toEqual(['n-task', 'n-session', 'n-plain', 'n-alert'])
    expect(screen.getAllByTestId('ContextNoteBlock')).toHaveLength(4)
  })

  it('hides task notes, then session notes; untagged and alert notes stay', async () => {
    await act(async () => {
      render(<ChatPanel />)
    })

    setToggles({ hideTaskNotifications: true })
    expect(ids()).toEqual(['n-session', 'n-plain', 'n-alert'])
    expect(screen.getAllByTestId('ContextNoteBlock')).toHaveLength(3)

    setToggles({ hideSessionMessages: true })
    expect(ids()).toEqual(['n-plain', 'n-alert'])
    // No bubble left without a note inside it.
    for (const bubble of screen.getAllByTestId('MessageBubble')) {
      expect(bubble.querySelector('[data-testid="ContextNoteBlock"]')).not.toBeNull()
    }
  })

  it('a chat of only hidden notes does not fall back to the welcome screen', async () => {
    useSessionStore.setState((state) => ({
      settings: { ...state.settings, hideTaskNotifications: true },
      sessions: {
        ...state.sessions,
        [ROUTE]: { ...state.sessions[ROUTE], messages: [noteMsg('only', { source: 'task' })] }
      }
    }))
    mirrorStoreIntoReplica()
    await act(async () => {
      render(<ChatPanel />)
    })
    expect(ids()).toEqual([])
    expect(screen.queryByTestId('WelcomeState')).toBeNull()
  })
})
