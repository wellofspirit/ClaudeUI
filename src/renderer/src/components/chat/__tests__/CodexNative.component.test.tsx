import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { chooseSelectMenuOption, selectMenuValue } from '../../../../../test/helpers/select-menu'
import type { ClaudeAPI, EngineModelGroup } from '../../../../../shared/types'
import type { CodexAuthStatus } from '../../../../../shared/codex-types'
import { CodexApprovalCard } from '../CodexApprovalCard'
import { ApprovalButtons } from '../ApprovalButtons'
import { CodexAccount } from '../../SettingsDialog/CodexAccount'

type AccountList = Awaited<ReturnType<ClaudeAPI['listProviderAccounts']>>
const NO_ACCOUNTS: AccountList = { activeId: null, perSession: false, accounts: [] }
const api = {
  getEngineModels: vi.fn(async (): Promise<EngineModelGroup[]> => []),
  codexApproval: vi.fn(async () => {}),
  respondApproval: vi.fn(async () => {}),
  codexAuthStatus: vi.fn(async (): Promise<CodexAuthStatus> => ({
    available: true,
    authenticated: false,
    authKind: null
  })),
  listProviderAccounts: vi.fn(async (): Promise<AccountList> => NO_ACCOUNTS)
}
beforeEach(() => {
  vi.clearAllMocks()
  api.codexAuthStatus.mockResolvedValue({ available: true, authenticated: false, authKind: null })
  api.listProviderAccounts.mockResolvedValue(NO_ACCOUNTS)
  Object.defineProperty(window, 'api', { configurable: true, value: { ...window.api, ...api } })
})

/**
 * Slice 2a guard 7 — the Codex account ROW (ADR-068 §1).
 *
 * The device-code pane, its poller and its three channels are gone: the vault
 * owns the ChatGPT identity, so this row only reports which account Codex runs
 * as and links to where accounts are managed.
 */
describe('native controls', () => {
  const account = (over: Partial<AccountList['accounts'][number]> = {}): AccountList => ({
    activeId: 'acct-one',
    perSession: false,
    accounts: [
      {
        id: 'acct-one',
        email: 'owner@example.test',
        planType: 'pro',
        accountId: 'ws-one',
        expiresAt: 0,
        needsReauth: false,
        ...over
      }
    ]
  })

  it('names the active vault account, its plan and how many exist', async () => {
    api.listProviderAccounts.mockResolvedValue({
      ...account(),
      accounts: [
        ...account().accounts,
        { id: 'acct-two', expiresAt: 0, needsReauth: false, accountId: 'ws-two' }
      ]
    })
    render(<CodexAccount />)
    await waitFor(() =>
      expect(screen.getByTestId('CodexAccount')).toHaveTextContent('ChatGPT · owner@example.test')
    )
    expect(screen.getByTestId('CodexAccount.plan')).toHaveTextContent('pro')
    expect(screen.getByTestId('CodexAccount')).toHaveTextContent('2 accounts available')
    expect(window.api.listProviderAccounts).toHaveBeenCalledWith('chatgpt')
  })

  // Slice J: this label read `active.email ?? 'Account'`, so an EMPTY email
  // rendered `ChatGPT · ` with nothing after the separator. Asserted here
  // rather than only on the helper, because a helper test passes whether or
  // not this call site was converted.
  it('names an account whose email came back EMPTY, never a bare separator', async () => {
    api.listProviderAccounts.mockResolvedValue(account({ email: '', planType: undefined }))
    render(<CodexAccount />)
    await waitFor(() =>
      expect(screen.getByTestId('CodexAccount')).toHaveTextContent('ChatGPT · Account')
    )
  })

  it('says so when Codex is running on its own login', async () => {
    api.codexAuthStatus.mockResolvedValue({
      available: true,
      authenticated: true,
      authKind: 'chatgpt'
    })
    render(<CodexAccount />)
    await waitFor(() =>
      expect(screen.getByTestId('CodexAccount')).toHaveTextContent('Not signed in through ClaudeUI')
    )
    expect(screen.getByTestId('CodexAccount')).toHaveTextContent(
      'Codex is using its own login; sign in here to manage it in ClaudeUI'
    )
  })

  it('offers a sign-in when nothing is signed in anywhere, and starts no login itself', async () => {
    render(<CodexAccount />)
    await waitFor(() =>
      expect(screen.getByTestId('CodexAccount')).toHaveTextContent(
        'Sign in to ChatGPT to run Codex under a ClaudeUI-managed account'
      )
    )
    expect(screen.queryByTestId('CodexAccount.signIn')).toBeNull()
    expect(screen.queryByTestId('CodexAccount.deviceCode')).toBeNull()
  })

  it('sends the deep link to the ChatGPT subscription card (ADR-074 §7)', async () => {
    const opened = vi.fn()
    window.addEventListener('open-settings', opened)
    try {
      api.listProviderAccounts.mockResolvedValue(account())
      render(<CodexAccount />)
      await waitFor(() => expect(screen.getByTestId('CodexAccount.manage')).toBeInTheDocument())
      fireEvent.click(screen.getByTestId('CodexAccount.manage'))
      expect(opened).toHaveBeenCalledOnce()
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
        page: 'models',
        group: 'subscriptions'
      })
    } finally {
      window.removeEventListener('open-settings', opened)
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
})
