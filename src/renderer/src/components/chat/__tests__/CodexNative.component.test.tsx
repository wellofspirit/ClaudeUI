import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  chooseSelectMenuOption,
  openSelectMenu,
  selectMenuOptionValues,
  selectMenuValue
} from '../../../../../test/helpers/select-menu'
import { useSessionStore } from '../../../stores/session-store'
import type { EngineModelGroup } from '../../../../../shared/types'
import { CodexApprovalCard } from '../CodexApprovalCard'
import { CodexPolicyPill } from '../CodexPolicyPill'
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
  it('exposes an explicit idle reset and reconnect without pretending a disconnected policy is current', async () => {
    render(
      <CodexPolicyPill
        routingId="root"
        connected={false}
        onInitialize={async () => {}}
        policy={{
          approvalPolicy: 'untrusted',
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly' },
          activePermissionProfile: null,
          modelProvider: 'openai',
          reasoningEffort: 'ultra',
          effortOptions: [],
          overrides: { approvalPolicy: 'untrusted', effort: 'ultra' }
        }}
      />
    )
    expect(screen.getByTestId('CodexPolicyPill.summary')).toHaveTextContent('Last native policy')
    expect(screen.queryByTestId('CodexPolicyPill.controls')).not.toBeInTheDocument()
    expect(screen.getByTestId('CodexPolicyPill.initialize')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('CodexPolicyPill.reset'))
    await waitFor(() =>
      expect(api.codexSettings).toHaveBeenCalledExactlyOnceWith('root', { reset: true })
    )
  })
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
  it('renders only offered decisions and disables unsupported amendments', async () => {
    render(
      <CodexApprovalCard
        approval={{
          requestId: 'request',
          toolName: 'commandExecution',
          input: { networkApprovalContext: { host: 'example.invalid' } },
          codex: {
            routingId: 'root',
            decisions: ['acceptForSession', 'decline', 'cancel'],
            unsupportedDecisions: ['acceptWithExecpolicyAmendment']
          }
        }}
      />
    )
    expect(screen.queryByTestId('CodexApprovalCard.accept')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /acceptWithExecpolicyAmendment/ })).toBeDisabled()
    fireEvent.click(screen.getByTestId('CodexApprovalCard.cancel'))
    await waitFor(() =>
      expect(api.codexApproval).toHaveBeenCalledExactlyOnceWith('root', 'request', 'cancel')
    )
    expect(api.respondApproval).not.toHaveBeenCalled()
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
            unsupportedDecisions: [],
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
  it('keeps inherited policy visible while requesting a native dynamic effort', async () => {
    render(
      <CodexPolicyPill
        routingId="root"
        policy={{
          approvalPolicy: { granular: { rules: true } },
          approvalsReviewer: 'auto_review',
          sandbox: { type: 'readOnly' },
          activePermissionProfile: null,
          modelProvider: 'openai',
          reasoningEffort: 'high',
          effortOptions: [
            { value: 'high', description: 'High' },
            { value: 'ultra', description: 'Native ultra' }
          ]
        }}
      />
    )
    const effort = screen.getByTestId('CodexPolicyPill.effort')
    chooseSelectMenuOption(effort, 'ultra')
    await waitFor(() =>
      expect(api.codexSettings).toHaveBeenCalledExactlyOnceWith('root', { effort: 'ultra' })
    )
    expect(screen.getByTestId('CodexPolicyPill.effective')).toHaveTextContent('auto_review')
    // The pill displays ACKNOWLEDGED state, so the picker still reads the
    // effort Codex last confirmed — the request above does not move it.
    expect(selectMenuValue(effort)).toBe('high')
    // "Native default" is an offered-but-unselectable label, never a choice
    // (the `<option value="" disabled>` this replaced).
    expect(selectMenuOptionValues(effort)).toEqual(['', 'high', 'ultra'])
    openSelectMenu(effort)
    expect(
      within(effort)
        .getAllByRole('option')
        .find((o) => o.getAttribute('data-id') === '')
    ).toBeDisabled()
  })

  it('never applies an EMPTY policy or sandbox: the placeholder is a label, not an option', async () => {
    // A native select fires no `change` for the entry already selected, so
    // "Keep native policy" was inert. SelectMenu options are real buttons, so
    // the placeholder must not BE one — it is a fallbackLabel.
    render(
      <CodexPolicyPill
        routingId="root"
        policy={{
          approvalPolicy: 'untrusted',
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly' },
          activePermissionProfile: null,
          modelProvider: 'openai',
          reasoningEffort: 'high',
          effortOptions: []
        }}
      />
    )
    const approval = screen.getByTestId('CodexPolicyPill.approval')
    const sandbox = screen.getByTestId('CodexPolicyPill.sandbox')
    expect(approval).toHaveTextContent('Keep native policy')
    expect(sandbox).toHaveTextContent('Keep native sandbox')
    expect(selectMenuOptionValues(approval)).toEqual(['untrusted', 'on-request', 'never'])
    expect(selectMenuOptionValues(sandbox)).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access'
    ])
    chooseSelectMenuOption(approval, 'never')
    await waitFor(() =>
      expect(api.codexSettings).toHaveBeenCalledExactlyOnceWith('root', {
        approvalPolicy: 'never'
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
            unsupportedDecisions: [],
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
