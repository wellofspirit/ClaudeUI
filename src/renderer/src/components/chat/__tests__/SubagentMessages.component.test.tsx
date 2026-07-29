/**
 * Layer 2: Component tests for SubagentMessages' persisted thinking blocks.
 *
 * Regression (thinking-order-bug): SubagentMessages defined a private bare
 * <details> ThinkingBlock that was ALWAYS collapsed and never read
 * settings.expandThinking, unlike chat/ThinkingBlock.tsx which seeds its
 * expanded state from that setting. These pin: the persisted thinking block
 * now seeds open/collapsed from settings.expandThinking (seeded once — the
 * user can still toggle the individual block afterwards).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import type { ChatMessage } from '../../../../../shared/types'
import { SubagentMessages } from '../SubagentMessages'

const defaultSettings = useSessionStore.getState().settings

function makeThinkingMsg(text: string): ChatMessage {
  return {
    id: 'm-thinking-1',
    role: 'assistant',
    content: [{ type: 'thinking', text }],
    timestamp: Date.now()
  }
}

describe('SubagentMessages — persisted thinking block honors expandThinking', () => {
  afterEach(() => {
    useSessionStore.setState({ settings: defaultSettings })
  })

  it('expandThinking=false: thinking body starts collapsed', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: false } }))
    render(<SubagentMessages messages={[makeThinkingMsg('a hidden reasoning trace')]} />)

    expect(screen.getByTestId('SubagentMessages.thinkingToggle')).toBeInTheDocument()
    expect(screen.queryByText('a hidden reasoning trace')).not.toBeInTheDocument()
  })

  it('expandThinking=false: clicking the toggle reveals the body', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: false } }))
    render(<SubagentMessages messages={[makeThinkingMsg('a hidden reasoning trace')]} />)

    fireEvent.click(screen.getByTestId('SubagentMessages.thinkingToggle'))
    expect(screen.getByText('a hidden reasoning trace')).toBeInTheDocument()
  })

  it('expandThinking=true: thinking body starts expanded', () => {
    useSessionStore.setState((s) => ({ settings: { ...s.settings, expandThinking: true } }))
    render(<SubagentMessages messages={[makeThinkingMsg('a visible reasoning trace')]} />)

    expect(screen.getByText('a visible reasoning trace')).toBeInTheDocument()
  })
})
