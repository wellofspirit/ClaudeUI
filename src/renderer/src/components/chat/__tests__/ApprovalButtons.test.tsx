/**
 * Unit tests for the extracted <ApprovalButtons> component.
 *
 * Verifies that decision + suggestions wiring is identical to the 3 former
 * sites in ToolCallBlock/View.tsx:
 *   1. Main site: shows decisionReason + AlwaysAllowSection + Deny/Allow
 *   2. Mermaid/mockup sites (showSuggestions=false): shows only Deny/Allow
 *
 * The `onApproval` callback receives the decision and the selected (checked)
 * suggestions, mirroring the exact contract from ToolCallBlock.tsx's
 * handleApproval.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ApprovalButtons } from '../ApprovalButtons'
import type { PendingApproval, PermissionSuggestion } from '../../../../../shared/types'

function makeApproval(overrides?: Partial<PendingApproval>): PendingApproval {
  return {
    requestId: 'req-test',
    toolName: 'Bash',
    input: { command: 'echo hi' },
    ...overrides
  }
}

describe('ApprovalButtons', () => {
  it('renders Deny and Allow buttons', () => {
    const approval = makeApproval()
    render(
      <ApprovalButtons
        approval={approval}
        permissionMode="default"
        onApproval={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(screen.getByText('Deny')).toBeInTheDocument()
    expect(screen.getByText('Allow')).toBeInTheDocument()
  })

  it('calls onApproval with allow decision when Allow clicked', async () => {
    const onApproval = vi.fn().mockResolvedValue(undefined)
    const approval = makeApproval()
    render(<ApprovalButtons approval={approval} permissionMode="default" onApproval={onApproval} />)
    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })
    expect(onApproval).toHaveBeenCalledWith('allow', undefined)
  })

  it('calls onApproval with deny decision when Deny clicked', async () => {
    const onApproval = vi.fn().mockResolvedValue(undefined)
    const approval = makeApproval()
    render(<ApprovalButtons approval={approval} permissionMode="default" onApproval={onApproval} />)
    await act(async () => {
      fireEvent.click(screen.getByText('Deny'))
    })
    expect(onApproval).toHaveBeenCalledWith('deny', undefined)
  })

  it('renders decisionReason when showSuggestions=true (default)', () => {
    const approval = makeApproval({ decisionReason: 'This command modifies files' })
    render(
      <ApprovalButtons
        approval={approval}
        permissionMode="default"
        onApproval={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(screen.getByText('This command modifies files')).toBeInTheDocument()
  })

  it('does NOT render decisionReason when showSuggestions=false (mermaid/mockup)', () => {
    const approval = makeApproval({ decisionReason: 'This command modifies files' })
    render(
      <ApprovalButtons
        approval={approval}
        permissionMode="default"
        onApproval={vi.fn().mockResolvedValue(undefined)}
        showSuggestions={false}
      />
    )
    expect(screen.queryByText('This command modifies files')).not.toBeInTheDocument()
  })

  it('renders AlwaysAllowSection when suggestions present and showSuggestions=true', () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    const approval = makeApproval({ suggestions })
    render(
      <ApprovalButtons
        approval={approval}
        permissionMode="default"
        onApproval={vi.fn().mockResolvedValue(undefined)}
      />
    )
    // AlwaysAllowSection renders "Permission rules" label
    expect(screen.getByText(/Permission rules/i)).toBeInTheDocument()
  })

  it('does NOT render AlwaysAllowSection when showSuggestions=false', () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    const approval = makeApproval({ suggestions })
    render(
      <ApprovalButtons
        approval={approval}
        permissionMode="default"
        onApproval={vi.fn().mockResolvedValue(undefined)}
        showSuggestions={false}
      />
    )
    expect(screen.queryByText(/Permission rules/i)).not.toBeInTheDocument()
  })

  it('forwards checked suggestions on Allow', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      },
      {
        type: 'addRules',
        destination: 'userSettings',
        rules: [{ toolName: 'Read', ruleContent: '/tmp/*' }]
      }
    ]
    const onApproval = vi.fn().mockResolvedValue(undefined)
    const approval = makeApproval({ suggestions })
    render(<ApprovalButtons approval={approval} permissionMode="default" onApproval={onApproval} />)

    // Check the second suggestion checkbox
    const checkboxes = screen.getAllByRole('checkbox')
    await act(async () => {
      fireEvent.click(checkboxes[1])
    })

    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })

    expect(onApproval).toHaveBeenCalledWith('allow', [suggestions[1]])
  })

  it('omits suggestions on Deny even when checkboxes are checked', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    const onApproval = vi.fn().mockResolvedValue(undefined)
    const approval = makeApproval({ suggestions })
    render(<ApprovalButtons approval={approval} permissionMode="default" onApproval={onApproval} />)

    // Check the checkbox
    const checkboxes = screen.getAllByRole('checkbox')
    await act(async () => {
      fireEvent.click(checkboxes[0])
    })

    await act(async () => {
      fireEvent.click(screen.getByText('Deny'))
    })

    expect(onApproval).toHaveBeenCalledWith('deny', undefined)
  })

  it('omits suggestions when none are checked', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    const onApproval = vi.fn().mockResolvedValue(undefined)
    const approval = makeApproval({ suggestions })
    render(<ApprovalButtons approval={approval} permissionMode="default" onApproval={onApproval} />)

    // Leave checkboxes unchecked, click Allow
    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })

    expect(onApproval).toHaveBeenCalledWith('allow', undefined)
  })

  // ADR-091 §3 — ClaudeUI's own judge HOLDS its block for the user: the same
  // one-call override, labelled Keep blocked / Approve anyway, with a
  // live countdown to the host's Keep-blocked expiry.
  describe('held auto-mode block', () => {
    const NOW = 1_700_000_000_000
    const held = (overrides?: Partial<PendingApproval>): PendingApproval =>
      makeApproval({
        toolUseId: 'call-1',
        toolName: 'bash',
        input: { command: 'git push origin main' },
        autoModeBlock: { expiresAt: NOW + 103_000 },
        ...overrides
      })

    afterEach(() => vi.useRealTimers())

    it('renders Keep blocked / Approve anyway and a live countdown, no suggestions', () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
      vi.setSystemTime(NOW)
      const suggestions: PermissionSuggestion[] = [
        {
          type: 'addRules',
          destination: 'projectSettings',
          rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }]
        }
      ]
      render(
        <ApprovalButtons
          approval={held({ suggestions })}
          permissionMode="auto"
          onApproval={vi.fn().mockResolvedValue(undefined)}
        />
      )
      expect(screen.getByTestId('ApprovalButtons.keepBlocked')).toHaveTextContent('Keep blocked')
      expect(screen.getByTestId('ApprovalButtons.approveAnyway')).toHaveTextContent(
        'Approve anyway'
      )
      expect(screen.queryByTestId('ApprovalButtons.allow')).not.toBeInTheDocument()
      expect(screen.queryByTestId('ApprovalButtons.deny')).not.toBeInTheDocument()
      expect(screen.queryByText(/Permission rules/i)).not.toBeInTheDocument()
      expect(screen.getByTestId('ApprovalButtons.holdCountdown')).toHaveTextContent(
        'blocks in 1:43'
      )
      act(() => {
        vi.advanceTimersByTime(4_000)
      })
      expect(screen.getByTestId('ApprovalButtons.holdCountdown')).toHaveTextContent(
        'blocks in 1:39'
      )
      act(() => {
        vi.advanceTimersByTime(200_000)
      })
      expect(screen.getByTestId('ApprovalButtons.holdCountdown')).toHaveTextContent(
        'blocks in 0:00'
      )
    })

    it.each([
      ['ApprovalButtons.approveAnyway', 'allow'],
      ['ApprovalButtons.keepBlocked', 'deny']
    ])('sends %s as the %s decision', async (testid, decision) => {
      const onApproval = vi.fn().mockResolvedValue(undefined)
      render(<ApprovalButtons approval={held()} permissionMode="auto" onApproval={onApproval} />)
      await act(async () => {
        fireEvent.click(screen.getByTestId(testid))
      })
      expect(onApproval).toHaveBeenCalledWith(decision, undefined)
    })
  })
})
