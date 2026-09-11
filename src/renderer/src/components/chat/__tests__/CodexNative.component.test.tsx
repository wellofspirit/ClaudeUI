import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { chooseSelectMenuOption, selectMenuValue } from '../../../../../test/helpers/select-menu'
import { useSessionStore } from '../../../stores/session-store'
import type { EngineModelGroup } from '../../../../../shared/types'
import { CodexApprovalCard } from '../CodexApprovalCard'
import { ApprovalButtons } from '../ApprovalButtons'
import { CodexAccount } from '../../SettingsDialog/CodexAccount'

const api = {
  getEngineModels: vi.fn(async (): Promise<EngineModelGroup[]> => []),
  codexSettings: vi.fn(async () => {}),
  codexApproval: vi.fn(async () => {}),
  respondApproval: vi.fn(async () => {}),
  codexAuthStatus: vi.fn(async () => ({ available: true, authenticated: false, authKind: null })),
  codexLoginStatus: vi.fn(async () => ({ status: 'idle' })),
  codexLoginStart: vi.fn(async () => ({
    status: 'waiting',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'FIXTURE'
  })),
  codexLoginCancel: vi.fn(async () => {})
}
beforeEach(() => {
  vi.clearAllMocks()
  api.codexLoginStatus.mockResolvedValue({ status: 'idle' })
  Object.defineProperty(window, 'api', { configurable: true, value: { ...window.api, ...api } })
})

describe('native controls', () => {
  it('refreshes discovered models before a completed login stops its poller', async () => {
    vi.useFakeTimers()
    try {
      await act(async () => {
        render(<CodexAccount />)
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('CodexAccount.signIn'))
      })
      api.codexLoginStatus.mockResolvedValue({ status: 'completed' })
      api.getEngineModels.mockResolvedValue([
        {
          engineId: 'codex',
          vendorId: 'openai',
          vendorName: 'Native',
          models: [
            {
              engineId: 'codex',
              value: 'native-after-login',
              displayName: 'Native',
              description: ''
            }
          ]
        }
      ])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500)
      })
      expect(api.getEngineModels).toHaveBeenCalledOnce()
      expect(
        useSessionStore
          .getState()
          .availableModels.some((model) => model.value === 'native-after-login')
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('uses native question IDs, including cancel without a fabricated answer', async () => {
    render(
      <CodexApprovalCard
        approval={{
          requestId: 'question',
          toolName: 'requestUserInput',
          input: {},
          codex: {
            routingId: 'root',
            decisions: ['cancel'],
            questions: [
              {
                id: 'native-id',
                question: 'Which?',
                header: 'Choice',
                options: [],
                allowOther: true
              }
            ]
          }
        }}
      />
    )
    fireEvent.change(screen.getByTestId('CodexApprovalCard.answer'), {
      target: { value: 'answer' }
    })
    fireEvent.click(screen.getByTestId('CodexApprovalCard.submit'))
    await waitFor(() =>
      expect(api.respondApproval).toHaveBeenCalledWith('root', 'question', 'allow', {
        'native-id': 'answer'
      })
    )
  })
  it('answers a closed native question through the themed picker', async () => {
    render(
      <CodexApprovalCard
        approval={{
          requestId: 'question',
          toolName: 'requestUserInput',
          input: {},
          codex: {
            routingId: 'root',
            decisions: ['cancel'],
            questions: [
              {
                id: 'native-id',
                question: 'Which?',
                header: 'Choice',
                options: [
                  { label: 'first', description: 'the first one' },
                  { label: 'second', description: 'the other one' }
                ],
                allowOther: false
              }
            ]
          }
        }}
      />
    )
    // No free-text box when the question is closed — the picker is the input.
    expect(screen.queryByTestId('CodexApprovalCard.answer')).not.toBeInTheDocument()
    const choice = screen.getByTestId('CodexApprovalCard.choice')
    expect(screen.getByTestId('CodexApprovalCard.submit')).toBeDisabled()
    chooseSelectMenuOption(choice, 'second')
    expect(selectMenuValue(choice)).toBe('second')
    fireEvent.click(screen.getByTestId('CodexApprovalCard.submit'))
    await waitFor(() =>
      expect(api.respondApproval).toHaveBeenCalledWith('root', 'question', 'allow', {
        'native-id': 'second'
      })
    )
  })
  it('renders a codex command approval through the STANDARD card, not a native one', async () => {
    const onApproval = vi.fn(async () => {})
    render(
      <ApprovalButtons
        approval={{
          requestId: 'request',
          toolName: 'commandExecution',
          input: { command: 'git push', cwd: '/repo' },
          decisionReason: 'needs network',
          suggestions: [
            {
              type: 'addRules',
              behavior: 'allow',
              destination: 'userSettings',
              rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }]
            }
          ]
        }}
        permissionMode="default"
        onApproval={onApproval}
      />
    )
    expect(screen.queryByTestId('CodexApprovalCard')).not.toBeInTheDocument()
    expect(screen.getByText('needs network')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ApprovalButtons.allow'))
    await waitFor(() => expect(onApproval).toHaveBeenCalledWith('allow', undefined))
  })

  it('ignores a legacy codex payload that carries no questions', () => {
    render(
      <ApprovalButtons
        approval={{
          requestId: 'legacy',
          toolName: 'commandExecution',
          input: { command: 'git push' },
          // A replica rehydrated from before slice 3 can still carry this.
          codex: { routingId: 'root', decisions: ['accept'] } as never
        }}
        permissionMode="default"
        onApproval={vi.fn(async () => {})}
      />
    )
    expect(screen.queryByTestId('CodexApprovalCard')).not.toBeInTheDocument()
    expect(screen.getByTestId('ApprovalButtons.allow')).toBeInTheDocument()
  })

  it('still hands a native QUESTION to the codex card', () => {
    render(
      <ApprovalButtons
        approval={{
          requestId: 'question',
          toolName: 'requestUserInput',
          input: {},
          codex: {
            routingId: 'root',
            decisions: ['cancel'],
            questions: [
              { id: 'q', question: 'Which?', header: 'Choice', options: [], allowOther: true }
            ]
          }
        }}
        permissionMode="default"
        onApproval={vi.fn(async () => {})}
      />
    )
    expect(screen.getByTestId('CodexApprovalCard')).toBeInTheDocument()
  })

  it('does not initiate login on mount and exposes the explicit device flow', async () => {
    render(<CodexAccount />)
    await waitFor(() => expect(screen.getByTestId('CodexAccount.signIn')).toBeEnabled())
    expect(api.codexLoginStart).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('CodexAccount.signIn'))
    await waitFor(() =>
      expect(screen.getByTestId('CodexAccount.deviceCode')).toHaveTextContent('FIXTURE')
    )
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
  })
})
